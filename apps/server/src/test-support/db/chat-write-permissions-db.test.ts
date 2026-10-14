import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * Real-SQL baseline for the CHAT WRITE path (workorder 21A, T-33).
 *
 * The read side was migrated to an own-backend repository in the 20 series; the
 * write side (session/message insert, session update, session/message delete) is
 * still enforced by the `authenticated` RLS policies. Before that write path can
 * be migrated, its current behaviour has to be pinned down as facts a later
 * workorder cannot quietly redefine. This file is that baseline and NOTHING else:
 * no production code, no SQL, no migration, no repository is added or changed.
 *
 * Everything below executes real SQL against the full migration chain loaded by
 * `createMigratedDb()`. No statement is mocked, and no expectation is derived
 * from the read ACL: where the answer matters (archived projects, a forged
 * `created_by`, a missing parent), the test lets PostgreSQL decide and asserts
 * what it actually answered.
 *
 * Two shapes of "denied" exist and they are NOT the same thing:
 *
 * - an INSERT refused by a WITH CHECK raises SQLSTATE 42501;
 * - an UPDATE or DELETE filtered out by its USING clause is NOT an error at all
 *   (there is no SQLSTATE to assert) — it reports zero affected rows and the row
 *   survives untouched. This file asserts the row count in that case instead of
 *   pretending an error was raised.
 *
 * Every destructive case builds its own session/message rows (see `seedSession` /
 * `seedMessage`), so no case depends on the order the others ran in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** The two migrations that decide the chat write matrix; asserted to be loaded. */
const CHAT_TABLE_MIGRATION = "20260323000006_chat_sessions.sql";
const CHAT_POLICY_MIGRATION = "20260929000001_hahart_team_workspace_private_rls.sql";

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000e1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000e2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000e3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000e4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000e5";

const TEAM_NAME = "HaHart Chat Write Team";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

const AUTHOR_PROJECT = "aa310000-0000-4000-8000-000000000001";
const MEMBER_PROJECT = "aa310000-0000-4000-8000-000000000002";
const ARCHIVED_PROJECT = "aa310000-0000-4000-8000-000000000003";
const OUTSIDER_PROJECT = "aa310000-0000-4000-8000-000000000004";

const AUTHOR_CANVAS = "bb310000-0000-4000-8000-000000000001";
const MEMBER_CANVAS = "bb310000-0000-4000-8000-000000000002";
const ARCHIVED_CANVAS = "bb310000-0000-4000-8000-000000000003";
const OUTSIDER_CANVAS = "bb310000-0000-4000-8000-000000000004";
const MISSING_CANVAS = "bb310000-0000-4000-8000-00000000000f";

const AUTHOR_SESSION = "cc310000-0000-4000-8000-000000000001";
const MEMBER_SESSION = "cc310000-0000-4000-8000-000000000002";
const ARCHIVED_SESSION = "cc310000-0000-4000-8000-000000000003";
const MISSING_SESSION = "cc310000-0000-4000-8000-00000000000f";

const AUTHOR_MESSAGE = "dd310000-0000-4000-8000-000000000001";
const MEMBER_MESSAGE = "dd310000-0000-4000-8000-000000000002";
const ARCHIVED_MESSAGE = "dd310000-0000-4000-8000-000000000003";

const INSERT_SESSION = `insert into public.chat_sessions (id, canvas_id, title, created_by)
  values ($1, $2, $3, $4)`;
const INSERT_MESSAGE = `insert into public.chat_messages (id, session_id, role, content)
  values ($1, $2, 'user', $3)`;
const UPDATE_SESSION_TITLE = "update public.chat_sessions set title = $2 where id = $1";
const DELETE_SESSION = "delete from public.chat_sessions where id = $1";
const DELETE_MESSAGE = "delete from public.chat_messages where id = $1";

/** The four team roles plus a complete user who is not in the team at all. */
const ACTORS = [
  { label: "the author", id: AUTHOR_ID, writes: true },
  { label: "an admin", id: ADMIN_ID, writes: false },
  { label: "the owner", id: OWNER_ID, writes: false },
  { label: "a plain member", id: MEMBER_ID, writes: false },
  { label: "a non-member", id: OUTSIDER_ID, writes: false },
] as const;

type Denial = { code: string; message: string; severity: string };

let db: PGlite;
let applied: string[] = [];
let teamWorkspaceId = "";

/** Deterministic fresh uuids, so destructive cases never share a row. */
let idCounter = 0;
function nextUuid(group: string): string {
  idCounter += 1;
  return `${group}-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** Run `statement` and return the SQLSTATE/message it was denied with. */
async function denial(statement: () => Promise<unknown>): Promise<Denial> {
  try {
    await statement();
  } catch (error) {
    const denials = error as { code?: unknown; message?: unknown; severity?: unknown };
    return {
      code: String(denials.code),
      message: String(denials.message),
      severity: String(denials.severity),
    };
  }
  throw new Error("expected the statement to be denied, but it succeeded");
}

/** The exact shape a WITH CHECK refusal has: 42501, never a missing GRANT. */
function expectRlsDenial(result: Denial, table: "chat_sessions" | "chat_messages"): void {
  expect(result.code).toBe("42501");
  expect(result.severity).toBe("ERROR");
  expect(result.message).toBe(`new row violates row-level security policy for table "${table}"`);
  expect(result.message).not.toMatch(/permission denied/);
  expect(result.message).not.toMatch(/foreign key/);
}

/** Seeded as the database owner, so the fixture itself is never blocked by RLS. */
async function seedSession(
  canvasId: string,
  title: string,
  createdBy: string | null = AUTHOR_ID,
): Promise<string> {
  const id = nextUuid("c1310000");
  await db.query(INSERT_SESSION, [id, canvasId, title, createdBy]);
  return id;
}

async function seedMessage(sessionId: string, content: string): Promise<string> {
  const id = nextUuid("d1310000");
  await db.query(INSERT_MESSAGE, [id, sessionId, content]);
  return id;
}

async function totalSessions(): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>("select count(*)::int as n from public.chat_sessions")).rows,
  ).n;
}

async function totalMessages(): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>("select count(*)::int as n from public.chat_messages")).rows,
  ).n;
}

async function sessionExists(id: string): Promise<boolean> {
  return (
    (await db.query<{ id: string }>("select id from public.chat_sessions where id = $1", [id]))
      .rows.length === 1
  );
}

async function messageExists(id: string): Promise<boolean> {
  return (
    (await db.query<{ id: string }>("select id from public.chat_messages where id = $1", [id]))
      .rows.length === 1
  );
}

async function sessionTitle(id: string): Promise<string | null> {
  const rows = (
    await db.query<{ title: string }>("select title from public.chat_sessions where id = $1", [id])
  ).rows;
  return rows[0]?.title ?? null;
}

/** `created_by` is nullable, so a missing column and an explicit null differ. */
async function sessionCreatedBy(id: string): Promise<string | null> {
  const row = firstRow(
    (
      await db.query<{ created_by: string | null }>(
        "select created_by from public.chat_sessions where id = $1",
        [id],
      )
    ).rows,
  );
  if (!Object.prototype.hasOwnProperty.call(row, "created_by")) {
    throw new Error("created_by is missing from the selected row");
  }
  return row.created_by;
}

async function messagesOf(sessionId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.chat_messages where session_id = $1",
        [sessionId],
      )
    ).rows,
  ).n;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, AUTHOR_ID, "chat-write-author@hahart.test");
  await createUser(db, ADMIN_ID, "chat-write-admin@hahart.test");
  await createUser(db, OWNER_ID, "chat-write-owner@hahart.test");
  await createUser(db, MEMBER_ID, "chat-write-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "chat-write-outsider@hahart.test");

  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2) returning id`,
        [TEAM_NAME, OWNER_ID],
      )
    ).rows,
  ).id;

  for (const [userId, role] of [
    [AUTHOR_ID, "member"],
    [ADMIN_ID, "admin"],
    [OWNER_ID, "owner"],
    [MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  const insertProject = async (
    id: string,
    name: string,
    createdBy: string,
    archivedAt: string | null,
  ) =>
    db.query(
      `insert into public.projects (
         id, workspace_id, name, slug, description, created_by,
         archived_at, created_at, updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [id, teamWorkspaceId, name, id, `description of ${name}`, createdBy, archivedAt, "2026-01-01T00:00:00.000Z"],
    );

  const insertCanvas = async (id: string, projectId: string, name: string, createdBy: string) =>
    db.query(
      `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
       values ($1, $2, $3, false, $4, '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
      [id, projectId, name, createdBy],
    );

  await insertProject(AUTHOR_PROJECT, "Author project", AUTHOR_ID, null);
  await insertProject(MEMBER_PROJECT, "Member project", MEMBER_ID, null);
  await insertProject(ARCHIVED_PROJECT, "Archived project", AUTHOR_ID, ARCHIVED_AT);
  await insertProject(OUTSIDER_PROJECT, "Outsider project", OUTSIDER_ID, null);

  await insertCanvas(AUTHOR_CANVAS, AUTHOR_PROJECT, "Author canvas", AUTHOR_ID);
  await insertCanvas(MEMBER_CANVAS, MEMBER_PROJECT, "Member canvas", MEMBER_ID);
  await insertCanvas(ARCHIVED_CANVAS, ARCHIVED_PROJECT, "Archived canvas", AUTHOR_ID);
  await insertCanvas(OUTSIDER_CANVAS, OUTSIDER_PROJECT, "Outsider canvas", OUTSIDER_ID);

  await db.query(INSERT_SESSION, [AUTHOR_SESSION, AUTHOR_CANVAS, "Author chat", AUTHOR_ID]);
  await db.query(INSERT_SESSION, [MEMBER_SESSION, MEMBER_CANVAS, "Member chat", MEMBER_ID]);
  await db.query(INSERT_SESSION, [ARCHIVED_SESSION, ARCHIVED_CANVAS, "Archived chat", AUTHOR_ID]);

  await db.query(INSERT_MESSAGE, [AUTHOR_MESSAGE, AUTHOR_SESSION, "author hello"]);
  await db.query(INSERT_MESSAGE, [MEMBER_MESSAGE, MEMBER_SESSION, "member hello"]);
  await db.query(INSERT_MESSAGE, [ARCHIVED_MESSAGE, ARCHIVED_SESSION, "archived hello"]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("chat write permissions: the schema the baseline is measured against", () => {
  it("case 1: the whole migration chain loads, including the chat table and chat policy migrations", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

    // Not a subset: every migration on disk really ran, in filename order.
    expect(applied).toEqual(files.sort());
    expect(applied).toContain(CHAT_TABLE_MIGRATION);
    expect(applied).toContain(CHAT_POLICY_MIGRATION);

    // The policy migration is the later word on the subject, which is why the
    // 2026-03 policy set cannot be the one in force below.
    expect(applied.indexOf(CHAT_POLICY_MIGRATION)).toBeGreaterThan(
      applied.indexOf(CHAT_TABLE_MIGRATION),
    );
  });

  it("case 2: the live chat policies defer to can_write_project / can_read_project", async () => {
    const policies = await db.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, cmd, qual, with_check
         from pg_policies
        where tablename in ('chat_sessions', 'chat_messages')`,
    );

    // 4 session policies + 3 message policies: the superseded 2026-03 set is
    // gone, so this count is the guard against silently running an old schema.
    expect(policies.rows).toHaveLength(7);
    const sessions = policies.rows.filter((row) => row.tablename === "chat_sessions");
    const messages = policies.rows.filter((row) => row.tablename === "chat_messages");
    expect(sessions).toHaveLength(4);
    expect(messages).toHaveLength(3);

    for (const row of policies.rows) {
      const expression = `${row.qual ?? ""} ${row.with_check ?? ""}`;
      const expected = row.cmd === "SELECT" ? "can_read_project" : "can_write_project";
      expect(expression).toContain(expected);
    }

    // `can_write_project` is the definition the archived-project case below
    // measures: created_by = caller AND caller is a workspace member, with no
    // archived_at filter anywhere.
    const definition = firstRow(
      (
        await db.query<{ d: string }>(
          "select pg_get_functiondef('private.can_write_project(uuid)'::regprocedure) as d",
        )
      ).rows,
    ).d;
    expect(definition).toContain("is_workspace_member");
    expect(definition).toContain("created_by");
    expect(definition).not.toContain("archived");
  });
});

describe("chat write permissions: the author's own project", () => {
  it("case 3: the author creates a session in their own canvas and reads it back", async () => {
    const id = nextUuid("c2310000");

    const inserted = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [id, AUTHOR_CANVAS, "Author new chat", AUTHOR_ID]),
    );
    expect(inserted.affectedRows ?? 0).toBe(1);
    expect(await sessionExists(id)).toBe(true);

    const readBack = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query<{ id: string; title: string }>(
        "select id, title from public.chat_sessions where id = $1",
        [id],
      ),
    );
    expect(readBack.rows).toEqual([{ id, title: "Author new chat" }]);
  });

  it("case 4: the author creates a message in their own session", async () => {
    const id = nextUuid("d2310000");

    const inserted = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_MESSAGE, [id, AUTHOR_SESSION, "author writes"]),
    );
    expect(inserted.affectedRows ?? 0).toBe(1);
    expect(await messageExists(id)).toBe(true);

    // The seeded message is still readable by the author under the read policy.
    const readable = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query<{ id: string }>("select id from public.chat_messages where session_id = $1", [
        AUTHOR_SESSION,
      ]),
    );
    expect(readable.rows.map((row) => row.id)).toContain(AUTHOR_MESSAGE);
  });

  it("case 5: the author renames their own session and the new title is stored", async () => {
    const id = await seedSession(AUTHOR_CANVAS, "before rename");

    const updated = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(UPDATE_SESSION_TITLE, [id, "after rename"]),
    );
    expect(updated.affectedRows ?? 0).toBe(1);
    expect(await sessionTitle(id)).toBe("after rename");
  });

  it("case 6: the author deletes their own message", async () => {
    const sessionId = await seedSession(AUTHOR_CANVAS, "delete message session");
    const messageId = await seedMessage(sessionId, "doomed");

    const deleted = await asUser(db, AUTHOR_ID, (tx) => tx.query(DELETE_MESSAGE, [messageId]));
    expect(deleted.affectedRows ?? 0).toBe(1);
    expect(await messageExists(messageId)).toBe(false);
  });

  it("case 7: the author deletes their own session and its messages go with it", async () => {
    const sessionId = await seedSession(AUTHOR_CANVAS, "delete session");
    await seedMessage(sessionId, "first");
    await seedMessage(sessionId, "second");
    expect(await messagesOf(sessionId)).toBe(2);

    const deleted = await asUser(db, AUTHOR_ID, (tx) => tx.query(DELETE_SESSION, [sessionId]));
    expect(deleted.affectedRows ?? 0).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
    // The cascade removes the children even though chat_messages has its own
    // DELETE policy: the referential action is not filtered by that policy.
    expect(await messagesOf(sessionId)).toBe(0);
  });
});

describe("chat write permissions: every actor against the author's project", () => {
  it("case 8: only the author can insert a session", async () => {
    const before = await totalSessions();

    for (const actor of ACTORS) {
      const id = nextUuid("c8310000");
      if (actor.writes) {
        const inserted = await asUser(db, actor.id, (tx) =>
          tx.query(INSERT_SESSION, [id, AUTHOR_CANVAS, `by ${actor.label}`, actor.id]),
        );
        expect(inserted.affectedRows ?? 0).toBe(1);
        expect(await sessionExists(id)).toBe(true);
      } else {
        const refused = await denial(() =>
          asUser(db, actor.id, (tx) =>
            tx.query(INSERT_SESSION, [id, AUTHOR_CANVAS, `by ${actor.label}`, actor.id]),
          ),
        );
        expectRlsDenial(refused, "chat_sessions");
        expect(await sessionExists(id)).toBe(false);
      }
    }

    // Exactly one of the five attempts reached the table.
    expect(await totalSessions()).toBe(before + 1);
  });

  it("case 9: only the author can insert a message", async () => {
    const before = await totalMessages();

    for (const actor of ACTORS) {
      const id = nextUuid("d9310000");
      if (actor.writes) {
        const inserted = await asUser(db, actor.id, (tx) =>
          tx.query(INSERT_MESSAGE, [id, AUTHOR_SESSION, `message by ${actor.label}`]),
        );
        expect(inserted.affectedRows ?? 0).toBe(1);
        expect(await messageExists(id)).toBe(true);
      } else {
        const refused = await denial(() =>
          asUser(db, actor.id, (tx) =>
            tx.query(INSERT_MESSAGE, [id, AUTHOR_SESSION, `message by ${actor.label}`]),
          ),
        );
        expectRlsDenial(refused, "chat_messages");
        expect(await messageExists(id)).toBe(false);
      }
    }

    expect(await totalMessages()).toBe(before + 1);
  });

  it("case 10: only the author can update a session; everyone else gets zero rows, not an error", async () => {
    for (const actor of ACTORS) {
      const id = await seedSession(AUTHOR_CANVAS, "before update");

      const updated = await asUser(db, actor.id, (tx) =>
        tx.query(UPDATE_SESSION_TITLE, [id, `changed by ${actor.label}`]),
      );

      if (actor.writes) {
        expect(updated.affectedRows ?? 0).toBe(1);
        expect(await sessionTitle(id)).toBe(`changed by ${actor.label}`);
      } else {
        // A USING-filtered UPDATE is not an error: no SQLSTATE is raised at all,
        // the denial is the row count.
        expect(updated.affectedRows ?? 0).toBe(0);
        expect(await sessionTitle(id)).toBe("before update");
      }
    }
  });

  it("case 11: only the author can delete a session; everyone else gets zero rows", async () => {
    for (const actor of ACTORS) {
      const id = await seedSession(AUTHOR_CANVAS, "before delete");
      const messageId = await seedMessage(id, "child of a survived session");

      const deleted = await asUser(db, actor.id, (tx) => tx.query(DELETE_SESSION, [id]));

      if (actor.writes) {
        expect(deleted.affectedRows ?? 0).toBe(1);
        expect(await sessionExists(id)).toBe(false);
        expect(await messagesOf(id)).toBe(0);
      } else {
        expect(deleted.affectedRows ?? 0).toBe(0);
        expect(await sessionExists(id)).toBe(true);
        expect(await messageExists(messageId)).toBe(true);
      }
    }
  });

  it("case 12: only the author can delete a message; everyone else gets zero rows", async () => {
    for (const actor of ACTORS) {
      const sessionId = await seedSession(AUTHOR_CANVAS, "message delete target");
      const messageId = await seedMessage(sessionId, "before message delete");

      const deleted = await asUser(db, actor.id, (tx) => tx.query(DELETE_MESSAGE, [messageId]));

      if (actor.writes) {
        expect(deleted.affectedRows ?? 0).toBe(1);
        expect(await messageExists(messageId)).toBe(false);
      } else {
        expect(deleted.affectedRows ?? 0).toBe(0);
        expect(await messageExists(messageId)).toBe(true);
      }
    }
  });

  it("case 13: an anonymous request cannot insert anything", async () => {
    const sessionId = nextUuid("c3310000");
    const sessionDenial = await denial(() =>
      asUser(db, null, (tx) => tx.query(INSERT_SESSION, [sessionId, AUTHOR_CANVAS, "anon", null])),
    );
    expectRlsDenial(sessionDenial, "chat_sessions");
    expect(await sessionExists(sessionId)).toBe(false);

    const messageId = nextUuid("d3310000");
    const messageDenial = await denial(() =>
      asUser(db, null, (tx) => tx.query(INSERT_MESSAGE, [messageId, AUTHOR_SESSION, "anon"])),
    );
    expectRlsDenial(messageDenial, "chat_messages");
    expect(await messageExists(messageId)).toBe(false);
  });
});

describe("chat write permissions: missing parents and other projects", () => {
  it("case 14: a session cannot be inserted under a canvas that does not exist", async () => {
    const before = await totalSessions();
    const id = nextUuid("c4310000");

    const refused = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) =>
        tx.query(INSERT_SESSION, [id, MISSING_CANVAS, "missing canvas", AUTHOR_ID]),
      ),
    );

    // Decided by the write policy, not by the foreign key: the RLS check runs
    // first and the canvas lookup answers null, so can_write_project is false.
    expectRlsDenial(refused, "chat_sessions");
    expect(refused.message).not.toMatch(/violates foreign key constraint/);
    expect(await sessionExists(id)).toBe(false);
    expect(await totalSessions()).toBe(before);
  });

  it("case 15: a message cannot be inserted under a session that does not exist", async () => {
    const before = await totalMessages();
    const id = nextUuid("d4310000");

    const refused = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) => tx.query(INSERT_MESSAGE, [id, MISSING_SESSION, "missing"])),
    );

    expectRlsDenial(refused, "chat_messages");
    expect(await messageExists(id)).toBe(false);
    expect(await totalMessages()).toBe(before);
  });

  it("case 16: a project author cannot write into another member's project", async () => {
    const sessionsBefore = await totalSessions();
    const messagesBefore = await totalMessages();

    const sessionId = nextUuid("c5310000");
    const sessionRefused = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) =>
        tx.query(INSERT_SESSION, [sessionId, MEMBER_CANVAS, "cross project", AUTHOR_ID]),
      ),
    );
    expectRlsDenial(sessionRefused, "chat_sessions");
    expect(await sessionExists(sessionId)).toBe(false);

    const messageId = nextUuid("d5310000");
    const messageRefused = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) => tx.query(INSERT_MESSAGE, [messageId, MEMBER_SESSION, "cross"])),
    );
    expectRlsDenial(messageRefused, "chat_messages");
    expect(await messageExists(messageId)).toBe(false);

    // The member's own rows are untouched, and so is the row count.
    expect(await sessionExists(MEMBER_SESSION)).toBe(true);
    expect(await messageExists(MEMBER_MESSAGE)).toBe(true);
    expect(await totalSessions()).toBe(sessionsBefore);
    expect(await totalMessages()).toBe(messagesBefore);
  });

  it("case 17: a non-member cannot write into their own project either; membership is the gate", async () => {
    // The outsider owns this project, so `created_by` matches — and the write is
    // still refused, because can_write_project also demands workspace membership.
    const asCaller = await asUser(db, OUTSIDER_ID, (tx) =>
      tx.query<{ ok: boolean }>("select private.can_write_project($1::uuid) as ok", [
        OUTSIDER_PROJECT,
      ]),
    );
    expect(firstRow(asCaller.rows).ok).toBe(false);

    const id = nextUuid("c6310000");
    const refused = await denial(() =>
      asUser(db, OUTSIDER_ID, (tx) =>
        tx.query(INSERT_SESSION, [id, OUTSIDER_CANVAS, "own project", OUTSIDER_ID]),
      ),
    );
    expectRlsDenial(refused, "chat_sessions");
    expect(await sessionExists(id)).toBe(false);
  });

  it("case 18: a session cannot be moved out of the project the author can write", async () => {
    const id = await seedSession(AUTHOR_CANVAS, "stays put");

    const moved = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) =>
        tx.query("update public.chat_sessions set canvas_id = $2 where id = $1", [
          id,
          MEMBER_CANVAS,
        ]),
      ),
    );
    expectRlsDenial(moved, "chat_sessions");

    const toMissing = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) =>
        tx.query("update public.chat_sessions set canvas_id = $2 where id = $1", [
          id,
          MISSING_CANVAS,
        ]),
      ),
    );
    expectRlsDenial(toMissing, "chat_sessions");

    // The update policy carries no separate WITH CHECK, so its USING expression
    // is re-evaluated against the new row — which is what refuses both moves.
    expect(
      firstRow(
        (
          await db.query<{ canvas_id: string }>(
            "select canvas_id from public.chat_sessions where id = $1",
            [id],
          )
        ).rows,
      ).canvas_id,
    ).toBe(AUTHOR_CANVAS);
  });
});

describe("chat write permissions: an archived project", () => {
  it("case 19: the author can still create a session and a message in the archived project", async () => {
    const sessionId = nextUuid("c7310000");

    const session = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [sessionId, ARCHIVED_CANVAS, "archived new chat", AUTHOR_ID]),
    );
    expect(session.affectedRows ?? 0).toBe(1);
    expect(await sessionExists(sessionId)).toBe(true);

    const messageId = nextUuid("d7310000");
    const message = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_MESSAGE, [messageId, ARCHIVED_SESSION, "archived write"]),
    );
    expect(message.affectedRows ?? 0).toBe(1);
    expect(await messageExists(messageId)).toBe(true);

    // Measured, not assumed: archiving does NOT close the chat write path,
    // because can_write_project never looks at archived_at.
    const archived = firstRow(
      (
        await db.query<{ archived_at: string | null }>(
          "select archived_at from public.projects where id = $1",
          [ARCHIVED_PROJECT],
        )
      ).rows,
    );
    expect(archived.archived_at).not.toBeNull();

    // The same policy still keeps an admin out of it.
    const adminSessionId = nextUuid("c8310000");
    const byAdmin = await denial(() =>
      asUser(db, ADMIN_ID, (tx) =>
        tx.query(INSERT_SESSION, [adminSessionId, ARCHIVED_CANVAS, "admin", ADMIN_ID]),
      ),
    );
    expectRlsDenial(byAdmin, "chat_sessions");
    expect(await sessionExists(adminSessionId)).toBe(false);
  });

  it("case 20: the author can also update and delete chat rows in the archived project", async () => {
    const sessionId = await seedSession(ARCHIVED_CANVAS, "archived before");
    const messageId = await seedMessage(sessionId, "archived doomed");

    const updated = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(UPDATE_SESSION_TITLE, [sessionId, "archived after"]),
    );
    expect(updated.affectedRows ?? 0).toBe(1);
    expect(await sessionTitle(sessionId)).toBe("archived after");

    const deletedMessage = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(DELETE_MESSAGE, [messageId]),
    );
    expect(deletedMessage.affectedRows ?? 0).toBe(1);
    expect(await messageExists(messageId)).toBe(false);

    const deletedSession = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(DELETE_SESSION, [sessionId]),
    );
    expect(deletedSession.affectedRows ?? 0).toBe(1);
    expect(await sessionExists(sessionId)).toBe(false);
  });
});

describe("chat write permissions: session created_by", () => {
  it("case 21: inserting a session with someone else's created_by is accepted and stored verbatim", async () => {
    const asMember = nextUuid("c9310000");
    const memberInsert = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [asMember, AUTHOR_CANVAS, "forged to member", MEMBER_ID]),
    );
    expect(memberInsert.affectedRows ?? 0).toBe(1);
    // The current policy checks the CALLER against the project, never the
    // created_by being written — so 21B cannot assume the database refuses this.
    expect(await sessionCreatedBy(asMember)).toBe(MEMBER_ID);

    const asOutsider = nextUuid("c9310000");
    await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [asOutsider, AUTHOR_CANVAS, "forged to outsider", OUTSIDER_ID]),
    );
    expect(await sessionCreatedBy(asOutsider)).toBe(OUTSIDER_ID);

    const asNobody = nextUuid("c9310000");
    await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [asNobody, AUTHOR_CANVAS, "no author", null]),
    );
    // The column is nullable and stays null: distinct from "the column is absent".
    expect(await sessionCreatedBy(asNobody)).toBeNull();
  });

  it("case 22: transferring created_by to another user gives that user no write authority", async () => {
    const id = await seedSession(AUTHOR_CANVAS, "handover");

    const handedOver = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query("update public.chat_sessions set created_by = $2 where id = $1", [id, MEMBER_ID]),
    );
    expect(handedOver.affectedRows ?? 0).toBe(1);
    expect(await sessionCreatedBy(id)).toBe(MEMBER_ID);

    // Authority follows the project author, not the row's created_by: the new
    // "owner" is still refused, and the project author still writes it.
    const byNewOwner = await asUser(db, MEMBER_ID, (tx) =>
      tx.query(UPDATE_SESSION_TITLE, [id, "changed by new owner"]),
    );
    expect(byNewOwner.affectedRows ?? 0).toBe(0);
    expect(await sessionTitle(id)).toBe("handover");

    const byAuthor = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(UPDATE_SESSION_TITLE, [id, "changed by project author"]),
    );
    expect(byAuthor.affectedRows ?? 0).toBe(1);
    expect(await sessionTitle(id)).toBe("changed by project author");
  });
});

describe("chat write permissions: denial shape and transaction recovery", () => {
  it("case 23: every refused insert reports SQLSTATE 42501 with the RLS message", async () => {
    const classes: Array<{ table: "chat_sessions" | "chat_messages"; run: () => Promise<unknown> }> =
      [
        {
          table: "chat_sessions",
          run: () =>
            asUser(db, ADMIN_ID, (tx) =>
              tx.query(INSERT_SESSION, [nextUuid("ca310000"), AUTHOR_CANVAS, "x", ADMIN_ID]),
            ),
        },
        {
          table: "chat_messages",
          run: () =>
            asUser(db, MEMBER_ID, (tx) =>
              tx.query(INSERT_MESSAGE, [nextUuid("da310000"), AUTHOR_SESSION, "x"]),
            ),
        },
        {
          table: "chat_sessions",
          run: () =>
            asUser(db, AUTHOR_ID, (tx) =>
              tx.query(INSERT_SESSION, [nextUuid("ca310000"), MISSING_CANVAS, "x", AUTHOR_ID]),
            ),
        },
        {
          table: "chat_messages",
          run: () =>
            asUser(db, AUTHOR_ID, (tx) =>
              tx.query(INSERT_MESSAGE, [nextUuid("da310000"), MISSING_SESSION, "x"]),
            ),
        },
        {
          table: "chat_sessions",
          run: () =>
            asUser(db, AUTHOR_ID, (tx) =>
              tx.query(INSERT_SESSION, [nextUuid("ca310000"), MEMBER_CANVAS, "x", AUTHOR_ID]),
            ),
        },
        {
          table: "chat_messages",
          run: () =>
            asUser(db, AUTHOR_ID, (tx) =>
              tx.query(INSERT_MESSAGE, [nextUuid("da310000"), MEMBER_SESSION, "x"]),
            ),
        },
      ];

    for (const denialClass of classes) {
      expectRlsDenial(await denial(denialClass.run), denialClass.table);
    }
  });

  it("case 24: a refused insert aborts the transaction, and ROLLBACK restores the connection", async () => {
    await db.exec("begin");
    try {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN_ID]);

      const refused = await denial(() =>
        db.query(INSERT_SESSION, [nextUuid("cb310000"), AUTHOR_CANVAS, "aborted", ADMIN_ID]),
      );
      expectRlsDenial(refused, "chat_sessions");

      // The failure really did abort the block: the next statement is refused
      // with 25P02 instead of running.
      const aborted = await denial(() => db.query("select 1 as one"));
      expect(aborted.code).toBe("25P02");
      expect(aborted.message).toMatch(/current transaction is aborted/);
    } finally {
      await db.exec("rollback");
    }

    // The same connection (PGlite has exactly one session) is usable again, and
    // the identity set with `set local role` is gone with the transaction.
    expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
    expect(
      firstRow(
        (
          await db.query<{ r: string }>("select current_user as r")
        ).rows,
      ).r,
    ).not.toBe("authenticated");

    // And a real write through asUser still works on that connection.
    const after = nextUuid("cb310000");
    const inserted = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [after, AUTHOR_CANVAS, "after rollback", AUTHOR_ID]),
    );
    expect(inserted.affectedRows ?? 0).toBe(1);
    expect(await sessionExists(after)).toBe(true);
  });

  it("case 25: a zero-row UPDATE is not an error and does not abort the transaction", async () => {
    const id = await seedSession(AUTHOR_CANVAS, "survives");

    await db.exec("begin");
    try {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN_ID]);

      const updated = await db.query(UPDATE_SESSION_TITLE, [id, "refused silently"]);
      expect(updated.affectedRows ?? 0).toBe(0);

      // No 25P02 here: the statement succeeded and matched nothing.
      expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }

    expect(await sessionTitle(id)).toBe("survives");
    expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
  });

  it("case 26: after a refused statement the same connection still serves the author's own writes", async () => {
    const refusedId = nextUuid("cc310000");
    const refused = await denial(() =>
      asUser(db, AUTHOR_ID, (tx) =>
        tx.query(INSERT_SESSION, [refusedId, MEMBER_CANVAS, "refused", AUTHOR_ID]),
      ),
    );
    expectRlsDenial(refused, "chat_sessions");

    const sessionId = nextUuid("cc310000");
    const inserted = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_SESSION, [sessionId, AUTHOR_CANVAS, "allowed after refusal", AUTHOR_ID]),
    );
    expect(inserted.affectedRows ?? 0).toBe(1);

    const messageId = nextUuid("dd310000");
    const message = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query(INSERT_MESSAGE, [messageId, sessionId, "allowed after refusal"]),
    );
    expect(message.affectedRows ?? 0).toBe(1);

    const read = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query<{ id: string }>("select id from public.chat_sessions where id = $1", [sessionId]),
    );
    expect(read.rows.map((row) => row.id)).toEqual([sessionId]);
  });
});
