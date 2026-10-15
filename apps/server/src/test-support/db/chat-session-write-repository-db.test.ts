import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CREATE_SESSION,
  DELETE_SESSION,
  UPDATE_SESSION_TITLE,
  ChatSessionWriteError,
  chatSessionWriteFailureCode,
  createChatSessionWriteRepository,
  type ChatSessionWriteRepository,
} from "../../db/chat-session-write-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the chat SESSION write repository (workorder 21C).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the three statements enforce the write ACL on a real PostgreSQL parser
 * and planner: the canvas/session → project → workspace_members walk, the
 * "author of the project, and nobody else" rule, the archived-project decision,
 * the caller-supplied `created_by`, the legal zero rows of update and delete, the
 * message cascade owned by the schema's foreign key, and the rollback path after
 * an illegal uuid.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database OWNER, which BYPASSES RLS
 * — and that is exactly the point: every refusal below happens although RLS is
 * not the thing deciding, so what is being measured is the repository's own
 * predicate.
 *
 * Three adjudicated write contracts (T-34) are pinned here rather than assumed:
 * an archived project stays writable, `chat_sessions.created_by` is stored
 * exactly as the caller passed it (actor, a third party, or null) and is never
 * enforced against the actor, and a zero-row update/delete is a legal outcome
 * with no error.
 *
 * One instance is migrated in `beforeAll`, the fixture is built on real tables,
 * and `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000002a1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000002a2";
const OWNER_ID = "00000000-0000-0000-0000-0000000002a3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000002a4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000002a5";

const AUTHOR_PROJECT = "aa4c0000-0000-4000-8000-000000000001";
const MEMBER_PROJECT = "aa4c0000-0000-4000-8000-000000000002";
const ARCHIVED_PROJECT = "aa4c0000-0000-4000-8000-000000000003";

const AUTHOR_CANVAS = "bb4c0000-0000-4000-8000-000000000001";
const MEMBER_CANVAS = "bb4c0000-0000-4000-8000-000000000002";
const ARCHIVED_CANVAS = "bb4c0000-0000-4000-8000-000000000003";

const MISSING_CANVAS = "bb4c0000-0000-4000-8000-00000000000f";
const MISSING_SESSION = "cc4c0000-0000-4000-8000-00000000000f";

const TEAM_NAME = "HaHart Chat Session Write Repository Team";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let repository: ChatSessionWriteRepository;
let teamWorkspaceId = "";

/** Deterministic fresh ids, so destructive cases never share a row. */
let idCounter = 0;
function nextUuid(group: string): string {
  idCounter += 1;
  return `${group}-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

/** `thread_id` carries a UNIQUE index, so every created session needs its own. */
function nextThreadId(): string {
  idCounter += 1;
  return `thread-21c-${String(idCounter).padStart(4, "0")}`;
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
    [id, teamWorkspaceId, name, id, `description of ${name}`, createdBy, archivedAt, SEEDED_AT],
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

async function sessionExists(id: string): Promise<boolean> {
  return (
    (
      await db.query<{ id: string }>("select id from public.chat_sessions where id = $1", [id])
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

async function sessionTitle(id: string): Promise<string | null> {
  const row = firstRow(
    (
      await db.query<{ title: string | null }>(
        "select title from public.chat_sessions where id = $1",
        [id],
      )
    ).rows,
  );
  return row.title;
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

async function rowsOf(sql: string): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql)).rows).n;
}

function createInput(
  overrides: Partial<Parameters<ChatSessionWriteRepository["createSession"]>[0]> = {},
) {
  return {
    actorId: AUTHOR_ID,
    canvasId: AUTHOR_CANVAS,
    threadId: nextThreadId(),
    title: null,
    createdBy: AUTHOR_ID,
    ...overrides,
  };
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createChatSessionWriteRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, AUTHOR_ID, "chat-session-repo-author@hahart.test");
  await createUser(db, ADMIN_ID, "chat-session-repo-admin@hahart.test");
  await createUser(db, OWNER_ID, "chat-session-repo-owner@hahart.test");
  await createUser(db, MEMBER_ID, "chat-session-repo-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "chat-session-repo-outsider@hahart.test");

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

  await insertCanvas(AUTHOR_CANVAS, AUTHOR_PROJECT, "Author canvas", AUTHOR_ID);
  await insertCanvas(MEMBER_CANVAS, MEMBER_PROJECT, "Member canvas", MEMBER_ID);
  await insertCanvas(ARCHIVED_CANVAS, ARCHIVED_PROJECT, "Archived canvas", AUTHOR_ID);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("chat session write repository: the schema and the fixture it measures", () => {
  it("case 1: the session policies, the title default and the message cascade are the ones under test", async () => {
    // A guard against silently measuring an old schema: the repository's ACL
    // replaces exactly these policies, so they must be the 2026-09 set.
    const policies = await rowsOf(
      `select count(*)::int as n from pg_policies where tablename = 'chat_sessions'`,
    );
    expect(policies).toBe(4);

    // The DEFAULT the no-title insert relies on, read from the catalogue rather
    // than assumed: if it changes, this case is what says so.
    const defaultTitle = firstRow(
      (
        await db.query<{ d: string | null }>(
          `select column_default as d from information_schema.columns
            where table_schema = 'public' and table_name = 'chat_sessions'
              and column_name = 'title'`,
        )
      ).rows,
    ).d;
    expect(defaultTitle).toContain("New Chat");

    // `chat_messages` follows its session because the FOREIGN KEY says so — the
    // repository deletes nothing but the session row, and this is the other half
    // of that decision.
    const cascade = firstRow(
      (
        await db.query<{ rule: string }>(
          `select confdeltype as rule from pg_constraint
            where conrelid = 'public.chat_messages'::regclass
              and contype = 'f'
              and confrelid = 'public.chat_sessions'::regclass`,
        )
      ).rows,
    ).rule;
    expect(cascade).toBe("c");

    // The fixture really is in place, in the shape the cases assume.
    expect(
      await rowsOf("select count(*)::int as n from public.chat_sessions"),
    ).toBe(0);
  });
});

describe("chat session write repository: the author of the project", () => {
  it("case 2: the author opens a session and gets id, title and updated_at back", async () => {
    const threadId = nextThreadId();
    const before = await rowsOf("select count(*)::int as n from public.chat_sessions");

    const created = await repository.createSession({
      actorId: AUTHOR_ID,
      canvasId: AUTHOR_CANVAS,
      threadId,
      title: null,
      createdBy: AUTHOR_ID,
    });

    // The id is the database's (the old insert never supplied one either), and
    // the no-title insert was decided by the schema's DEFAULT.
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe("New Chat");
    // A `timestamptz` arrives as a Date and is published as an ISO string.
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    expect(await sessionExists(created.id)).toBe(true);
    expect(await sessionTitle(created.id)).toBe("New Chat");
    expect(await sessionCreatedBy(created.id)).toBe(AUTHOR_ID);
    expect(
      await rowsOf("select count(*)::int as n from public.chat_sessions"),
    ).toBe(before + 1);

    // The thread id is the caller's, stored as given: the repository mints none.
    const thread = firstRow(
      (
        await db.query<{ thread_id: string | null }>(
          "select thread_id from public.chat_sessions where id = $1",
          [created.id],
        )
      ).rows,
    ).thread_id;
    expect(thread).toBe(threadId);
  });

  it("case 3: a named title is written as given, and the updated_at trigger still fires", async () => {
    const created = await repository.createSession(
      createInput({ title: "Named on creation" }),
    );
    expect(created.title).toBe("Named on creation");
    expect(await sessionTitle(created.id)).toBe("Named on creation");

    const before = await sessionUpdatedAt(created.id);
    // The trigger's `now()` is the TRANSACTION timestamp and the clock under it
    // has a coarse tick, so the second transaction must start measurably later.
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(
      repository.updateSessionTitle({
        actorId: AUTHOR_ID,
        sessionId: created.id,
        title: "Renamed by the author",
      }),
    ).resolves.toEqual({ affectedRows: 1 });

    expect(await sessionTitle(created.id)).toBe("Renamed by the author");
    // `chat_sessions` carries a BEFORE UPDATE `moddatetime` trigger, so a rename
    // refreshes the timestamp exactly as the PostgREST update did.
    expect(new Date(await sessionUpdatedAt(created.id)).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });

  it("case 4: the author deletes a session, and the row is gone", async () => {
    const created = await repository.createSession(createInput());

    await expect(
      repository.deleteSession({ actorId: AUTHOR_ID, sessionId: created.id }),
    ).resolves.toEqual({ affectedRows: 1 });

    expect(await sessionExists(created.id)).toBe(false);
  });

  it("case 5: the messages follow the session through the schema's own cascade", async () => {
    const created = await repository.createSession(createInput());
    await db.query(
      `insert into public.chat_messages (session_id, role, content)
       values ($1, 'user', 'first'), ($1, 'assistant', 'second')`,
      [created.id],
    );
    expect(await messagesOf(created.id)).toBe(2);

    await expect(
      repository.deleteSession({ actorId: AUTHOR_ID, sessionId: created.id }),
    ).resolves.toEqual({ affectedRows: 1 });

    // The repository deleted the session row ONLY; the messages went because the
    // foreign key says `ON DELETE CASCADE`, which is the one place that rule lives.
    expect(await sessionExists(created.id)).toBe(false);
    expect(await messagesOf(created.id)).toBe(0);
  });
});

describe("chat session write repository: created_by is the caller's value (T-34)", () => {
  it("case 6: actor, a third party and null are each stored verbatim", async () => {
    for (const createdBy of [AUTHOR_ID, MEMBER_ID, null]) {
      const created = await repository.createSession(createInput({ createdBy }));
      expect(await sessionCreatedBy(created.id)).toBe(createdBy);
    }

    // The one thing the column must never be is "corrected": the author's own id
    // is NOT substituted for a null or for somebody else's value.
    const forged = await repository.createSession(createInput({ createdBy: MEMBER_ID }));
    expect(await sessionCreatedBy(forged.id)).toBe(MEMBER_ID);
    expect(await sessionCreatedBy(forged.id)).not.toBe(AUTHOR_ID);
  });

  it("case 7: a session naming somebody else stays writable by the project's author", async () => {
    const forged = await repository.createSession(createInput({ createdBy: MEMBER_ID }));

    // Rename and delete are authorised by the PROJECT's author, not by the row's
    // `created_by` — which is precisely why the column is not enforced.
    await expect(
      repository.updateSessionTitle({
        actorId: AUTHOR_ID,
        sessionId: forged.id,
        title: "Renamed although created_by is the member",
      }),
    ).resolves.toEqual({ affectedRows: 1 });
    expect(await sessionTitle(forged.id)).toBe("Renamed although created_by is the member");
    expect(await sessionCreatedBy(forged.id)).toBe(MEMBER_ID);

    await expect(
      repository.deleteSession({ actorId: AUTHOR_ID, sessionId: forged.id }),
    ).resolves.toEqual({ affectedRows: 1 });
  });

  it("case 8: the member the row names still has no authority over it", async () => {
    const forged = await repository.createSession(createInput({ createdBy: MEMBER_ID }));

    for (const call of [
      () =>
        repository.updateSessionTitle({
          actorId: MEMBER_ID,
          sessionId: forged.id,
          title: "the member tries",
        }),
      () => repository.deleteSession({ actorId: MEMBER_ID, sessionId: forged.id }),
    ]) {
      await expect(call()).resolves.toEqual({ affectedRows: 0 });
    }

    expect(await sessionTitle(forged.id)).toBe("New Chat");
    expect(await sessionExists(forged.id)).toBe(true);
  });
});

describe("chat session write repository: the write ACL is authorship, not the role", () => {
  it("case 9: admin, owner, member and outsider are all refused a create", async () => {
    for (const actorId of [ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      const before = await rowsOf("select count(*)::int as n from public.chat_sessions");
      const threadId = nextThreadId();

      const error = await repository
        .createSession(
          createInput({ actorId, canvasId: AUTHOR_CANVAS, threadId }),
        )
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ChatSessionWriteError);
      expect((error as ChatSessionWriteError).operation).toBe(CREATE_SESSION);
      // The refusal is SILENT in SQL — zero rows, no SQLSTATE — so the row count
      // is the only evidence, and it must not have moved.
      expect(
        await rowsOf("select count(*)::int as n from public.chat_sessions"),
      ).toBe(before);
      expect(
        (
          await db.query<{ id: string }>(
            "select id from public.chat_sessions where thread_id = $1",
            [threadId],
          )
        ).rows.length,
      ).toBe(0);
    }
  });

  it("case 10: admin and owner are refused a rename, and the title does not move", async () => {
    const created = await repository.createSession(createInput({ title: "Author only" }));

    for (const actorId of [ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      await expect(
        repository.updateSessionTitle({
          actorId,
          sessionId: created.id,
          title: `renamed by ${actorId}`,
        }),
      ).resolves.toEqual({ affectedRows: 0 });
    }

    // Zero rows is legal and SILENT: no error, and nothing was written.
    expect(await sessionTitle(created.id)).toBe("Author only");
  });

  it("case 11: admin, owner, member and outsider are refused a delete, and the row survives", async () => {
    const created = await repository.createSession(createInput());

    for (const actorId of [ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      await expect(
        repository.deleteSession({ actorId, sessionId: created.id }),
      ).resolves.toEqual({ affectedRows: 0 });
    }

    expect(await sessionExists(created.id)).toBe(true);
  });

  it("case 12: the same roles are accepted on a project THEY author", async () => {
    // Same workspace, same roles, different PROJECT AUTHOR: now it is allowed.
    const created = await repository.createSession(
      createInput({ actorId: MEMBER_ID, canvasId: MEMBER_CANVAS, createdBy: MEMBER_ID }),
    );
    expect(await sessionExists(created.id)).toBe(true);

    await expect(
      repository.updateSessionTitle({
        actorId: MEMBER_ID,
        sessionId: created.id,
        title: "the member renames their own project's session",
      }),
    ).resolves.toEqual({ affectedRows: 1 });

    await expect(
      repository.deleteSession({ actorId: MEMBER_ID, sessionId: created.id }),
    ).resolves.toEqual({ affectedRows: 1 });
  });

  it("case 13: the repository's SQL, not RLS, is what refuses — RLS is bypassed here", async () => {
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

    const threadId = nextThreadId();
    const error = await repository
      .createSession(createInput({ actorId: ADMIN_ID, threadId }))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect(chatSessionWriteFailureCode(error)).toBeNull();
  });
});

describe("chat session write repository: the adjudicated archived contract (T-34)", () => {
  it("case 14: an ARCHIVED project's author can still create, rename and delete", async () => {
    // The read repository filters archived projects; this one must not, or
    // archiving a project would freeze its conversations.
    const created = await repository.createSession(
      createInput({ canvasId: ARCHIVED_CANVAS, title: "Archived but writable" }),
    );
    expect(created.title).toBe("Archived but writable");
    expect(await sessionExists(created.id)).toBe(true);

    await expect(
      repository.updateSessionTitle({
        actorId: AUTHOR_ID,
        sessionId: created.id,
        title: "still renameable",
      }),
    ).resolves.toEqual({ affectedRows: 1 });
    expect(await sessionTitle(created.id)).toBe("still renameable");

    await expect(
      repository.deleteSession({ actorId: AUTHOR_ID, sessionId: created.id }),
    ).resolves.toEqual({ affectedRows: 1 });
    expect(await sessionExists(created.id)).toBe(false);
  });

  it("case 15: an archived project still refuses everybody who is not its author", async () => {
    for (const actorId of [ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      const error = await repository
        .createSession(
          createInput({ actorId, canvasId: ARCHIVED_CANVAS, threadId: nextThreadId() }),
        )
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatSessionWriteError);
    }
  });
});

describe("chat session write repository: legality of zero rows and missing parents", () => {
  it("case 16: a 0-row update is legal and silent, and the row is untouched", async () => {
    const missing = await repository.updateSessionTitle({
      actorId: AUTHOR_ID,
      sessionId: MISSING_SESSION,
      title: "nobody is listening",
    });
    expect(missing).toEqual({ affectedRows: 0 });

    // ... and the same statement on a session that exists but is not this
    // actor's, which is the same answer and the same silence.
    const created = await repository.createSession(createInput({ title: "untouched" }));
    const refused = await repository.updateSessionTitle({
      actorId: ADMIN_ID,
      sessionId: created.id,
      title: "refused",
    });
    expect(refused).toEqual({ affectedRows: 0 });
    expect(await sessionTitle(created.id)).toBe("untouched");
  });

  it("case 17: a 0-row delete is legal and silent, for a missing session and for a foreign one", async () => {
    await expect(
      repository.deleteSession({ actorId: AUTHOR_ID, sessionId: MISSING_SESSION }),
    ).resolves.toEqual({ affectedRows: 0 });

    const created = await repository.createSession(createInput());
    await expect(
      repository.deleteSession({ actorId: OUTSIDER_ID, sessionId: created.id }),
    ).resolves.toEqual({ affectedRows: 0 });
    expect(await sessionExists(created.id)).toBe(true);
  });

  it("case 18: a create on a missing canvas is refused, and nothing is written", async () => {
    const before = await rowsOf("select count(*)::int as n from public.chat_sessions");
    const threadId = nextThreadId();

    const error = await repository
      .createSession(
        createInput({ canvasId: MISSING_CANVAS, threadId }),
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect((error as ChatSessionWriteError).operation).toBe(CREATE_SESSION);
    // The canvas is absent, not forbidden — and the answer is the same silent
    // zero rows, which is why the caller sees a fixed failure and no row.
    expect(chatSessionWriteFailureCode(error)).toBeNull();
    expect(await rowsOf("select count(*)::int as n from public.chat_sessions")).toBe(before);
    expect(
      (
        await db.query<{ id: string }>(
          "select id from public.chat_sessions where thread_id = $1",
          [threadId],
        )
      ).rows.length,
    ).toBe(0);
  });

  it("case 19: a canvas in ANOTHER workspace is refused for a non-member", async () => {
    // The outsider owns the personal workspace every signup creates, so their
    // membership is real — just not in THIS project's workspace.
    const error = await repository
      .createSession(
        createInput({
          actorId: OUTSIDER_ID,
          canvasId: AUTHOR_CANVAS,
          threadId: nextThreadId(),
        }),
      )
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ChatSessionWriteError);
  });
});

describe("chat session write repository: failure and transaction hygiene", () => {
  it("case 20: an illegal uuid rolls the transaction back and leaves the connection usable", async () => {
    const before = await rowsOf("select count(*)::int as n from public.chat_sessions");

    const createError = await repository
      .createSession(createInput({ canvasId: INVALID_ID }))
      .catch((reason: unknown) => reason);
    expect(createError).toBeInstanceOf(ChatSessionWriteError);
    // 22P02 is a SQLSTATE, so the accepted predicate must NOT call it a transport
    // failure: the service fails fast instead of retrying.
    expect(chatSessionWriteFailureCode(createError)).toBe("22P02");

    const updateError = await repository
      .updateSessionTitle({ actorId: AUTHOR_ID, sessionId: INVALID_ID, title: "x" })
      .catch((reason: unknown) => reason);
    expect(updateError).toBeInstanceOf(ChatSessionWriteError);
    expect(chatSessionWriteFailureCode(updateError)).toBe("22P02");

    const deleteError = await repository
      .deleteSession({ actorId: AUTHOR_ID, sessionId: INVALID_ID })
      .catch((reason: unknown) => reason);
    expect(deleteError).toBeInstanceOf(ChatSessionWriteError);
    expect(chatSessionWriteFailureCode(deleteError)).toBe("22P02");

    expect(await rowsOf("select count(*)::int as n from public.chat_sessions")).toBe(before);

    // The rollback released the single PGlite session: the next write works.
    const created = await repository.createSession(createInput({ title: "after rollbacks" }));
    expect(await sessionExists(created.id)).toBe(true);
    expect(await sessionTitle(created.id)).toBe("after rollbacks");
  });

  it("case 21: an unusable argument is refused before SQL, and the row is untouched", async () => {
    const created = await repository.createSession(createInput({ title: "guard me" }));

    const refused = await repository
      .createSession(createInput({ threadId: "" }))
      .catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(ChatSessionWriteError);
    expect((refused as ChatSessionWriteError).operation).toBe(CREATE_SESSION);

    const renameRefused = await repository
      .updateSessionTitle({ actorId: AUTHOR_ID, sessionId: created.id, title: undefined as never })
      .catch((reason: unknown) => reason);
    expect(renameRefused).toBeInstanceOf(ChatSessionWriteError);
    expect((renameRefused as ChatSessionWriteError).operation).toBe(UPDATE_SESSION_TITLE);

    const deleteRefused = await repository
      .deleteSession({ actorId: AUTHOR_ID, sessionId: "" })
      .catch((reason: unknown) => reason);
    expect(deleteRefused).toBeInstanceOf(ChatSessionWriteError);
    expect((deleteRefused as ChatSessionWriteError).operation).toBe(DELETE_SESSION);

    // Nothing reached the database, so the session still carries its title.
    expect(await sessionTitle(created.id)).toBe("guard me");
  });

  it("case 22: the driver's own row passes the shape guard, and an empty title is reported as stored", async () => {
    // A real RETURNING row on a real table: `updated_at` is a Date from the
    // driver, `title` is the text the row carries. The mapper normalises the
    // first and must never "repair" the second.
    const created = await repository.createSession(createInput({ title: "plain" }));
    const row = firstRow(
      (
        await db.query<{ id: string; title: string; updated_at: Date }>(
          "select id, title, updated_at from public.chat_sessions where id = $1",
          [created.id],
        )
      ).rows,
    );
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(created.updatedAt).toBe(row.updated_at.toISOString());

    // An empty title is a value the caller chose and the table can hold: the
    // repository reports `''` rather than substituting the schema's default.
    const empty = await repository.createSession(createInput({ title: "" }));
    expect(empty.title).toBe("");
    expect(await sessionTitle(empty.id)).toBe("");
  });
});
