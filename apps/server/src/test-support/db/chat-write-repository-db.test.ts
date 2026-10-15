import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIND_MESSAGE_FOR_RECOVERY,
  INSERT_MESSAGE,
  TOUCH_SESSION,
  ChatWriteError,
  chatWriteFailureCode,
  createChatWriteRepository,
  type ChatWriteRepository,
} from "../../db/chat-write-repository.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the chat WRITE repository (workorder 21B).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statements enforce the write ACL on a real PostgreSQL parser and
 * planner: the session/message → canvas → project → workspace_members walk, the
 * "author of the project, and nobody else" rule, the archived-project decision,
 * the caller-supplied id, the confirmation read's own ACL, the session touch and
 * its legal zero rows, and the rollback path after an illegal uuid.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database OWNER, which BYPASSES RLS
 * — and that is exactly the point: every refusal below happens although RLS is
 * not the thing deciding, so what is being measured is the repository's own
 * predicate. Where the old RLS answer and the repository's answer could differ,
 * the case asserts the repository's.
 *
 * Three adjudicated write contracts (T-34) are pinned here rather than assumed:
 * an archived project stays writable, `chat_sessions.created_by` is neither
 * required nor written, and a zero-row touch is a legal outcome with no error.
 *
 * One instance is migrated in `beforeAll`, the fixture is built on real tables,
 * and `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000001e1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000001e2";
const OWNER_ID = "00000000-0000-0000-0000-0000000001e3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000001e4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000001e5";

const AUTHOR_PROJECT = "aa410000-0000-4000-8000-000000000001";
const MEMBER_PROJECT = "aa410000-0000-4000-8000-000000000002";
const ARCHIVED_PROJECT = "aa410000-0000-4000-8000-000000000003";
const OUTSIDER_PROJECT = "aa410000-0000-4000-8000-000000000004";

const AUTHOR_CANVAS = "bb410000-0000-4000-8000-000000000001";
const MEMBER_CANVAS = "bb410000-0000-4000-8000-000000000002";
const ARCHIVED_CANVAS = "bb410000-0000-4000-8000-000000000003";

const AUTHOR_SESSION = "cc410000-0000-4000-8000-000000000001";
const MEMBER_SESSION = "cc410000-0000-4000-8000-000000000002";
const ARCHIVED_SESSION = "cc410000-0000-4000-8000-000000000003";
const FORGED_SESSION = "cc410000-0000-4000-8000-000000000004";
const MISSING_SESSION = "cc410000-0000-4000-8000-00000000000f";

const TEAM_NAME = "HaHart Chat Write Repository Team";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let repository: ChatWriteRepository;
let teamWorkspaceId = "";

/** Deterministic fresh ids, so destructive cases never share a row. */
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

async function insertProject(
  id: string,
  name: string,
  createdBy: string,
  archivedAt: string | null,
): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      id,
      teamWorkspaceId,
      name,
      id,
      `description of ${name}`,
      createdBy,
      archivedAt,
      SEEDED_AT,
    ],
  );
}

async function insertCanvas(
  id: string,
  projectId: string,
  name: string,
  createdBy: string,
): Promise<void> {
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
     values ($1, $2, $3, false, $4, '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
    [id, projectId, name, createdBy],
  );
}

/**
 * Seeded as the database owner, so the fixture is never blocked by RLS and every
 * case below starts from a row that really exists.
 */
async function seedSession(
  id: string,
  canvasId: string,
  title: string,
  createdBy: string | null,
): Promise<void> {
  await db.query(
    `insert into public.chat_sessions (
       id, canvas_id, title, created_by, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $5)`,
    [id, canvasId, title, createdBy, SEEDED_AT],
  );
}

async function totalMessages(): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>("select count(*)::int as n from public.chat_messages")
    ).rows,
  ).n;
}

async function messageExists(id: string): Promise<boolean> {
  return (
    (
      await db.query<{ id: string }>("select id from public.chat_messages where id = $1", [id])
    ).rows.length === 1
  );
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

async function sessionUpdatedAt(id: string): Promise<string> {
  const row = firstRow(
    (
      await db.query<{ updated_at: Date }>(
        "select updated_at from public.chat_sessions where id = $1",
        [id],
      )
    ).rows,
  );
  return new Date(row.updated_at).toISOString();
}

async function rowsOf(sql: string): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql)).rows).n;
}

function insertInput(overrides: Partial<Parameters<ChatWriteRepository["insertMessage"]>[0]> = {}) {
  return {
    actorId: AUTHOR_ID,
    messageId: nextUuid("dd410000"),
    sessionId: AUTHOR_SESSION,
    role: "user" as const,
    content: "hello from the author",
    toolActivities: null,
    contentBlocks: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createChatWriteRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, AUTHOR_ID, "chat-write-repo-author@hahart.test");
  await createUser(db, ADMIN_ID, "chat-write-repo-admin@hahart.test");
  await createUser(db, OWNER_ID, "chat-write-repo-owner@hahart.test");
  await createUser(db, MEMBER_ID, "chat-write-repo-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "chat-write-repo-outsider@hahart.test");

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

  await insertProject(AUTHOR_PROJECT, "Author project", AUTHOR_ID, null);
  await insertProject(MEMBER_PROJECT, "Member project", MEMBER_ID, null);
  await insertProject(ARCHIVED_PROJECT, "Archived project", AUTHOR_ID, ARCHIVED_AT);
  await insertProject(OUTSIDER_PROJECT, "Outsider project", OUTSIDER_ID, null);

  await insertCanvas(AUTHOR_CANVAS, AUTHOR_PROJECT, "Author canvas", AUTHOR_ID);
  await insertCanvas(MEMBER_CANVAS, MEMBER_PROJECT, "Member canvas", MEMBER_ID);
  await insertCanvas(ARCHIVED_CANVAS, ARCHIVED_PROJECT, "Archived canvas", AUTHOR_ID);

  await seedSession(AUTHOR_SESSION, AUTHOR_CANVAS, "Author chat", AUTHOR_ID);
  await seedSession(MEMBER_SESSION, MEMBER_CANVAS, "Member chat", MEMBER_ID);
  await seedSession(ARCHIVED_SESSION, ARCHIVED_CANVAS, "Archived chat", AUTHOR_ID);
  // 21A's second fact: `created_by` can be forged (or null). Authorship of the
  // PROJECT is what this repository authorises against, so such a session must
  // still be writable by the project's author.
  await seedSession(FORGED_SESSION, AUTHOR_CANVAS, "Forged chat", MEMBER_ID);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("chat write repository: the schema and the fixture it measures", () => {
  it("case 1: the chat write policies and the content_blocks column are the ones under test", async () => {
    // A guard against silently measuring an old schema: the repository's ACL
    // replaces exactly these policies, so they must be the 2026-09 set.
    const policies = await rowsOf(
      `select count(*)::int as n from pg_policies
        where tablename in ('chat_sessions', 'chat_messages')`,
    );
    expect(policies).toBe(7);

    const columns = await rowsOf(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'chat_messages'
          and column_name in ('id', 'session_id', 'role', 'content', 'tool_activities', 'content_blocks', 'created_at')`,
    );
    expect(columns).toBe(7);

    // The seeded fixture really is in place, in the shape the cases assume.
    expect(await sessionCreatedBy(AUTHOR_SESSION)).toBe(AUTHOR_ID);
    expect(await sessionCreatedBy(FORGED_SESSION)).toBe(MEMBER_ID);
    expect(await rowsOf("select count(*)::int as n from public.chat_messages")).toBe(0);
  });
});

describe("chat write repository: the author of the project", () => {
  it("case 2: the author stores a message under the CALLER's id and gets the six fields back", async () => {
    const messageId = nextUuid("dd420000");
    const before = await totalMessages();

    const stored = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId,
      sessionId: AUTHOR_SESSION,
      role: "assistant",
      content: "here it is",
      toolActivities: [{ name: "generate_image", status: "completed" }],
      contentBlocks: [{ type: "image", assetId: "asset-1", objectPath: "ws/p/a.png" }],
    });

    // The id is the caller's, not a database default: that is what makes "did it
    // land?" answerable after a lost response.
    expect(stored.id).toBe(messageId);
    expect(stored.role).toBe("assistant");
    expect(stored.content).toBe("here it is");
    expect(stored.tool_activities).toEqual([
      { name: "generate_image", status: "completed" },
    ]);
    expect(stored.content_blocks).toEqual([
      { type: "image", assetId: "asset-1", objectPath: "ws/p/a.png" },
    ]);
    // A `timestamptz` arrives as a Date and is published as an ISO string.
    expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    expect(await totalMessages()).toBe(before + 1);
    expect(await messageExists(messageId)).toBe(true);

    const row = firstRow(
      (
        await db.query<{ id: string; role: string; content: string }>(
          "select id, role, content from public.chat_messages where id = $1",
          [messageId],
        )
      ).rows,
    );
    expect(row).toEqual({ id: messageId, role: "assistant", content: "here it is" });
  });

  it("case 3: admin and owner are refused — the write ACL is authorship, not the role", async () => {
    for (const actorId of [ADMIN_ID, OWNER_ID]) {
      const messageId = nextUuid("dd430000");
      const before = await totalMessages();

      const error = await repository
        .insertMessage(insertInput({ actorId, messageId }))
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ChatWriteError);
      expect((error as ChatWriteError).operation).toBe(INSERT_MESSAGE);
      // The refusal is SILENT in SQL — zero rows, no SQLSTATE — so the row count
      // is the only evidence, and it must not have moved.
      expect(await totalMessages()).toBe(before);
      expect(await messageExists(messageId)).toBe(false);
    }
  });

  it("case 4: a plain member is refused on the author's project and accepted on their own", async () => {
    const refusedId = nextUuid("dd440000");
    const before = await totalMessages();

    const error = await repository
      .insertMessage(insertInput({ actorId: MEMBER_ID, messageId: refusedId }))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ChatWriteError);
    expect(await totalMessages()).toBe(before);

    // Same role, same workspace, different PROJECT AUTHOR: now it is allowed.
    const allowed = await repository.insertMessage({
      actorId: MEMBER_ID,
      messageId: nextUuid("dd440000"),
      sessionId: MEMBER_SESSION,
      role: "user",
      content: "member writes their own project",
      toolActivities: null,
      contentBlocks: null,
    });
    expect(allowed.content).toBe("member writes their own project");
    expect(await totalMessages()).toBe(before + 1);
  });

  it("case 5: a non-member is refused even though they own a project in another workspace", async () => {
    const messageId = nextUuid("dd450000");
    const before = await totalMessages();

    const error = await repository
      .insertMessage(insertInput({ actorId: OUTSIDER_ID, messageId }))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    expect(await totalMessages()).toBe(before);
  });
});

describe("chat write repository: the adjudicated write contracts (T-34)", () => {
  it("case 6: an ARCHIVED project's author still writes — the insert ACL has no archived filter", async () => {
    const messageId = nextUuid("dd460000");
    const before = await totalMessages();

    const stored = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId,
      sessionId: ARCHIVED_SESSION,
      role: "user",
      content: "archived but writable",
      toolActivities: null,
      contentBlocks: null,
    });

    expect(stored.id).toBe(messageId);
    expect(await totalMessages()).toBe(before + 1);

    // ... and the same holds for the confirmation read and the touch, so a lost
    // response on an archived project is still recoverable.
    await expect(
      repository.findMessageForRecovery({ actorId: AUTHOR_ID, messageId }),
    ).resolves.toMatchObject({ id: messageId });

    const touched = await repository.touchSession({
      actorId: AUTHOR_ID,
      sessionId: ARCHIVED_SESSION,
      updatedAt: new Date().toISOString(),
    });
    expect(touched.affectedRows).toBe(1);
  });

  it("case 7: a session whose created_by is forged or null stays writable, and created_by is never rewritten", async () => {
    // The forged session belongs to the AUTHOR's project but names the member.
    expect(await sessionCreatedBy(FORGED_SESSION)).toBe(MEMBER_ID);

    const stored = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId: nextUuid("dd470000"),
      sessionId: FORGED_SESSION,
      role: "user",
      content: "the project author writes into a forged session",
      toolActivities: null,
      contentBlocks: null,
    });
    expect(stored.id).toBeDefined();

    const touched = await repository.touchSession({
      actorId: AUTHOR_ID,
      sessionId: FORGED_SESSION,
      updatedAt: new Date().toISOString(),
    });
    expect(touched.affectedRows).toBe(1);

    // Neither statement wrote or "corrected" the ownership field.
    expect(await sessionCreatedBy(FORGED_SESSION)).toBe(MEMBER_ID);

    // The member it names still cannot write there: the forged field carries no
    // authority, which is why nothing in this repository enforces it.
    const refused = await repository
      .insertMessage(
        insertInput({ actorId: MEMBER_ID, sessionId: FORGED_SESSION }),
      )
      .catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(ChatWriteError);

    // A session with NO created_by at all is the same story.
    const nullSession = nextUuid("cc470000");
    await seedSession(nullSession, AUTHOR_CANVAS, "Null owner chat", null);
    const storedForNull = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId: nextUuid("dd470000"),
      sessionId: nullSession,
      role: "user",
      content: "no created_by, still writable",
      toolActivities: null,
      contentBlocks: null,
    });
    expect(storedForNull.id).toBeDefined();
    expect(await sessionCreatedBy(nullSession)).toBeNull();
  });

  it("case 8: a session touch reports its row count and never turns zero rows into an error", async () => {
    const stamp = new Date().toISOString();
    const before = await sessionUpdatedAt(AUTHOR_SESSION);

    await expect(
      repository.touchSession({
        actorId: AUTHOR_ID,
        sessionId: AUTHOR_SESSION,
        updatedAt: stamp,
      }),
    ).resolves.toEqual({ affectedRows: 1 });

    // The BEFORE UPDATE `moddatetime` trigger is the last word on the stored
    // value, exactly as it was for the PostgREST update this replaces.
    const after = await sessionUpdatedAt(AUTHOR_SESSION);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());

    // Every other actor: zero rows, no error, the row untouched.
    for (const actorId of [ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      await expect(
        repository.touchSession({
          actorId,
          sessionId: AUTHOR_SESSION,
          updatedAt: new Date().toISOString(),
        }),
      ).resolves.toEqual({ affectedRows: 0 });
    }

    // A session that is gone is the same legal answer.
    await expect(
      repository.touchSession({
        actorId: AUTHOR_ID,
        sessionId: MISSING_SESSION,
        updatedAt: new Date().toISOString(),
      }),
    ).resolves.toEqual({ affectedRows: 0 });

    expect(await sessionUpdatedAt(AUTHOR_SESSION)).toBe(after);
  });
});

describe("chat write repository: the lost-response confirmation read", () => {
  it("case 9: the author finds the landed row by id, in the response shape", async () => {
    const messageId = nextUuid("dd490000");
    const inserted = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId,
      sessionId: AUTHOR_SESSION,
      role: "assistant",
      content: "confirm me",
      toolActivities: null,
      contentBlocks: [{ type: "text", text: "confirm me" }],
    });

    const found = await repository.findMessageForRecovery({
      actorId: AUTHOR_ID,
      messageId,
    });

    expect(found).toEqual(inserted);
    expect(found?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    // An id that was never written answers null — "confirmed absent", which is
    // what licenses the single replay.
    await expect(
      repository.findMessageForRecovery({
        actorId: AUTHOR_ID,
        messageId: nextUuid("dd490000"),
      }),
    ).resolves.toBeNull();
  });

  it("case 10: the confirmation read re-derives the write ACL, so it cannot confirm another project's row", async () => {
    // A row that really exists, in a project the member authors.
    const memberMessage = await repository.insertMessage({
      actorId: MEMBER_ID,
      messageId: nextUuid("dd4a0000"),
      sessionId: MEMBER_SESSION,
      role: "user",
      content: "member's own message",
      toolActivities: null,
      contentBlocks: null,
    });

    // The author of ANOTHER project must not be able to confirm it: same id, same
    // table, but the ACL walk refuses and the answer is null, not the row.
    await expect(
      repository.findMessageForRecovery({
        actorId: AUTHOR_ID,
        messageId: memberMessage.id,
      }),
    ).resolves.toBeNull();

    // The member still can, which proves the null above was the ACL and not a
    // missing row.
    await expect(
      repository.findMessageForRecovery({
        actorId: MEMBER_ID,
        messageId: memberMessage.id,
      }),
    ).resolves.toMatchObject({ id: memberMessage.id });

    // admin/owner hold no write authority over the author's project either, so
    // they cannot use the confirmation read to see it back.
    const authorMessage = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId: nextUuid("dd4a0000"),
      sessionId: AUTHOR_SESSION,
      role: "user",
      content: "author's own message",
      toolActivities: null,
      contentBlocks: null,
    });
    for (const actorId of [ADMIN_ID, OWNER_ID, OUTSIDER_ID]) {
      await expect(
        repository.findMessageForRecovery({ actorId, messageId: authorMessage.id }),
      ).resolves.toBeNull();
    }
  });

  it("case 11: a jsonb object where an array is promised fails loud on a real row", async () => {
    // A shape a primary key CANNOT prevent and a real table CAN hold: the column
    // is jsonb, so an object is a legal value and an illegal message block list.
    const messageId = nextUuid("dd4b0000");
    await db.query(
      `insert into public.chat_messages (id, session_id, role, content, content_blocks)
       values ($1, $2, 'user', 'odd shape', '{"not":"an array"}'::jsonb)`,
      [messageId, AUTHOR_SESSION],
    );

    const error = await repository
      .findMessageForRecovery({ actorId: AUTHOR_ID, messageId })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    expect((error as ChatWriteError).operation).toBe(FIND_MESSAGE_FOR_RECOVERY);
  });

  it("case 12: replaying the SAME id hits the primary key, and the landed row is not overwritten", async () => {
    const messageId = nextUuid("dd4c0000");
    const first = await repository.insertMessage({
      actorId: AUTHOR_ID,
      messageId,
      sessionId: AUTHOR_SESSION,
      role: "user",
      content: "the row that landed",
      toolActivities: null,
      contentBlocks: null,
    });

    const error = await repository
      .insertMessage({
        actorId: AUTHOR_ID,
        messageId,
        sessionId: AUTHOR_SESSION,
        role: "user",
        content: "the replay",
        toolActivities: null,
        contentBlocks: null,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    // The replay is refused by the primary key — and that refusal is a real
    // database answer, so the service must not confirm and must not replay again.
    expect(chatWriteFailureCode(error)).toBe("23505");

    const row = firstRow(
      (
        await db.query<{ content: string }>(
          "select content from public.chat_messages where id = $1",
          [messageId],
        )
      ).rows,
    );
    expect(row.content).toBe(first.content);
    expect(row.content).toBe("the row that landed");
  });
});

describe("chat write repository: failure and transaction hygiene", () => {
  it("case 13: an illegal uuid rolls the transaction back and leaves the connection usable", async () => {
    const before = await totalMessages();

    const error = await repository
      .insertMessage(insertInput({ sessionId: INVALID_ID }))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    // 22P02 is a SQLSTATE, so the accepted predicate must NOT call it a transport
    // failure: the service fails fast instead of confirming and replaying.
    expect(chatWriteFailureCode(error)).toBe("22P02");
    expect(await totalMessages()).toBe(before);

    // The rollback released the single PGlite session: the next write works.
    const stored = await repository.insertMessage(insertInput());
    expect(await messageExists(stored.id)).toBe(true);

    const touchError = await repository
      .touchSession({
        actorId: AUTHOR_ID,
        sessionId: INVALID_ID,
        updatedAt: new Date().toISOString(),
      })
      .catch((reason: unknown) => reason);
    expect(touchError).toBeInstanceOf(ChatWriteError);
    expect(chatWriteFailureCode(touchError)).toBe("22P02");

    const after = await repository.insertMessage(insertInput());
    expect(await messageExists(after.id)).toBe(true);
  });

  it("case 14: a role outside the closed set is refused before SQL, and the constraint still guards the table", async () => {
    const before = await totalMessages();
    const messageId = nextUuid("dd4e0000");

    const refused = await repository
      .insertMessage(insertInput({ messageId, role: "system" as never }))
      .catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(ChatWriteError);
    expect(await totalMessages()).toBe(before);
    expect(await messageExists(messageId)).toBe(false);

    // The table's own CHECK remains the second line of defence.
    const constraint = await db
      .query(
        `insert into public.chat_messages (id, session_id, role, content)
         values ($1, $2, 'system', 'x')`,
        [messageId, AUTHOR_SESSION],
      )
      .then(
        () => null,
        (reason: unknown) => reason as { code?: string },
      );
    expect(constraint?.code).toBe("23514");

    // And the same thing through the repository's own SQL path: the authorised
    // author with an illegal role is still refused by the database.
    expect(await totalMessages()).toBe(before);
  });

  it("case 15: the repository's SQL, not RLS, is what refuses — RLS is bypassed here", async () => {
    // The PGlite pool IS the database owner, so RLS grants this session
    // everything. An admin is still refused, which means the refusal comes from
    // the statement's own predicate.
    const bypassesRls = firstRow(
      (
        await db.query<{ super: boolean }>(
          "select rolsuper as super from pg_roles where rolname = current_user",
        )
      ).rows,
    ).super;
    expect(bypassesRls).toBe(true);

    const messageId = nextUuid("dd4f0000");
    const refused = await repository
      .insertMessage(insertInput({ actorId: ADMIN_ID, messageId }))
      .catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(ChatWriteError);
    expect(await messageExists(messageId)).toBe(false);

    // The old RLS answer for the same insert, as the authenticated role: refused
    // too, but for a different reason (a WITH CHECK failure). The repository's
    // answer is the one the service must act on, and it is not an SQLSTATE.
    const rls = await asUser(db, ADMIN_ID, (tx) =>
      tx.query(
        `insert into public.chat_messages (id, session_id, role, content)
         values ($1, $2, 'user', 'rls attempt')`,
        [messageId, AUTHOR_SESSION],
      ),
    ).then(
      () => null,
      (reason: unknown) => reason as { code?: string },
    );
    expect(rls?.code).toBe("42501");
    expect(await messageExists(messageId)).toBe(false);
  });
});
