import { describe, expect, it } from "vitest";

import {
  CREATE_SESSION,
  DELETE_SESSION,
  UPDATE_SESSION_TITLE,
  ChatSessionWriteError,
  chatSessionWriteCause,
  chatSessionWriteFailureCode,
  createChatSessionWriteRepository,
  type ChatSessionWriteRepository,
} from "./chat-session-write-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real session write repository against a recording fake
 * pool. No database and no `DATABASE_URL` are involved: the point is the
 * statement the repository issues, the actor it carries, how it binds every
 * value, and how it classifies each way a write can fail.
 *
 * The SQL assertions are deliberately about AUTHORIZATION and about the
 * adjudicated write contracts (T-34) rather than about a happy path:
 *
 * - the canvas/session → project → workspace_members walk plus
 *   `projects.created_by = actor` — the author, and nobody else;
 * - the ABSENCE of an `archived_at` filter (an archived project stays writable);
 * - `created_by` written VERBATIM: the actor's id, somebody else's id and `null`
 *   all reach the driver unchanged, and no predicate forces it to the actor;
 * - a 0-row UPDATE/DELETE reported as a row count instead of becoming an error;
 * - a DELETE that touches `chat_sessions` only, leaving the message cascade to
 *   the schema's own foreign key.
 *
 * Row-shape failures are asserted here against rows a primary key cannot produce;
 * the same behaviour on a real table is exercised in
 * `test-support/db/chat-session-write-repository-db.test.ts`.
 */

const ACTOR_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "12121212-1212-1212-1212-121212121212";
const CANVAS_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";
const THREAD_ID = "thread-0001";
const TITLE = "Renamed chat";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (sql === TRANSACTION_STATEMENTS.setLocalSetting) return { rows: [] };
      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;
        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

function repositoryFor(harness: Harness): ChatSessionWriteRepository {
  return createChatSessionWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one domain statement of a call; BEGIN/COMMIT/set_config are not it. */
function domainCall(queries: readonly QueryRecord[]): QueryRecord {
  const entry = queries.find((record) => record.sql.includes("public.chat_sessions"));
  if (!entry) throw new Error("no domain statement was issued");
  return entry;
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql.trim());
}

function contextParams(queries: readonly QueryRecord[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const entry of queries) {
    if (entry.sql !== TRANSACTION_STATEMENTS.setLocalSetting) continue;
    values.set(String(entry.params?.[0]), entry.params?.[1]);
  }
  return values;
}

/** The parenthesised column list of the insert, so its fields can be asserted. */
function insertedColumns(sql: string): string {
  const match = /insert into public\.chat_sessions \(([^)]*)\)/.exec(sql);
  if (!match?.[1]) throw new Error("the insert column list is missing");
  return match[1];
}

const SESSION_ROW = {
  id: SESSION_ID,
  title: "New Chat",
  updated_at: new Date(CREATED_AT),
};

const CREATE_INPUT = {
  actorId: ACTOR_ID,
  canvasId: CANVAS_ID,
  threadId: THREAD_ID,
  title: TITLE,
  createdBy: ACTOR_ID,
};

describe("chat session write repository: the create statement", () => {
  it("case 1: the insert walks canvas → project → members, requires the author, and returns the row", async () => {
    const harness = createHarness(() => [SESSION_ROW]);

    await expect(repositoryFor(harness).createSession(CREATE_INPUT)).resolves.toEqual({
      id: SESSION_ID,
      title: "New Chat",
      updatedAt: CREATED_AT,
    });

    const { sql, params } = domainCall(harness.queries);

    // The ACL is the statement's own predicate. Every hop has to be there, or a
    // caller could open a conversation on somebody else's canvas.
    expect(sql).toContain("insert into public.chat_sessions");
    expect(sql).toContain("from public.canvases as c");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.user_id = $1::uuid");
    expect(sql).toContain("p.created_by = $1::uuid");
    // ... and it is the AUTHOR, never the role: admin/owner widen reads only.
    expect(sql).not.toContain("admin");
    expect(sql).not.toContain("owner");

    // T-34: an archived project stays writable, so the write ACL must not filter.
    expect(sql).not.toContain("archived_at");

    expect(sql).toContain("returning");
    expect(params).toEqual([ACTOR_ID, CANVAS_ID, ACTOR_ID, THREAD_ID, TITLE]);
  });

  it("case 2: the actor rides the transaction and the mode is the explicit privileged one", async () => {
    const harness = createHarness(() => [SESSION_ROW]);

    await repositoryFor(harness).createSession(CREATE_INPUT);

    const context = contextParams(harness.queries);
    expect(context.get(TRANSACTION_SETTING_NAMES.userId)).toBe(ACTOR_ID);
    expect(context.get(TRANSACTION_SETTING_NAMES.executionMode)).toBe("privileged");

    const issued = statements(harness.queries);
    expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(issued).toContain(TRANSACTION_STATEMENTS.commit);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 3: a named title is a bound parameter on the statement that carries the column", async () => {
    const harness = createHarness(() => [SESSION_ROW]);

    await repositoryFor(harness).createSession({ ...CREATE_INPUT, title: TITLE });

    const { sql, params } = domainCall(harness.queries);
    expect(insertedColumns(sql)).toContain("title");
    expect(sql).toContain("$5::text");
    expect(params?.[4]).toBe(TITLE);
  });

  it("case 4: a null title omits the column entirely, so the schema's DEFAULT decides", async () => {
    // `chat_sessions.title` is `text NOT NULL DEFAULT 'New Chat'`. Binding a NULL
    // would turn a create that used to succeed into a 23502, so the column must be
    // left out of the statement — the shape `...(title ? {title} : {})` had.
    const harness = createHarness(() => [SESSION_ROW]);

    await expect(
      repositoryFor(harness).createSession({ ...CREATE_INPUT, title: null }),
    ).resolves.toEqual({ id: SESSION_ID, title: "New Chat", updatedAt: CREATED_AT });

    const { sql, params } = domainCall(harness.queries);
    expect(insertedColumns(sql)).not.toContain("title");
    expect(sql).not.toContain("$5");
    // Four binds, not five: there is no title value to send.
    expect(params).toEqual([ACTOR_ID, CANVAS_ID, ACTOR_ID, THREAD_ID]);
  });

  it("case 5: created_by is written verbatim — the actor, somebody else and null all pass through", async () => {
    for (const createdBy of [ACTOR_ID, OTHER_ID, null]) {
      const harness = createHarness(() => [SESSION_ROW]);

      await repositoryFor(harness).createSession({ ...CREATE_INPUT, createdBy });

      const { sql, params } = domainCall(harness.queries);
      // The only `created_by` COMPARISON in the statement is the project's author
      // (`p.created_by = $1::uuid`); the other mention is the insert's column
      // list. Nothing constrains the value being stored, and no predicate ties it
      // to the actor — the write authority is the project's author alone.
      expect(sql.match(/created_by/g) ?? []).toHaveLength(2);
      expect(sql).toContain("p.created_by = $1::uuid");
      expect(sql).not.toMatch(/s\.created_by\s*=/);
      expect(params?.[2]).toBe(createdBy);
    }
  });

  it("case 6: the write ACL's silent zero rows is a failure, never a created session", async () => {
    // `insert ... select ... where exists` on a canvas the actor does not author
    // inserts no row and raises nothing: PostgreSQL has no error to give. The
    // verdict is the row count, so the repository has to turn it into one.
    const harness = createHarness(() => []);
    const error = await repositoryFor(harness)
      .createSession(CREATE_INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect((error as ChatSessionWriteError).operation).toBe(CREATE_SESSION);
    // Nothing is returned to the caller pretending the session exists.
    expect(chatSessionWriteFailureCode(error)).toBeNull();
  });

  it("case 7: a driver failure keeps its code and its cause, and leaks neither into the message", async () => {
    const driver = Object.assign(new Error('relation "public.chat_sessions" does not exist'), {
      code: "42P01",
    });
    const harness = createHarness(() => {
      throw driver;
    });

    const error = await repositoryFor(harness)
      .createSession(CREATE_INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect((error as ChatSessionWriteError).message).toBe(
      `chat session write failed (${CREATE_SESSION})`,
    );
    // The driver's text carries the statement; it must not reach the message.
    expect((error as ChatSessionWriteError).message).not.toContain("does not exist");
    expect((error as ChatSessionWriteError).message).not.toContain("public.chat_sessions");
    // ... but the caller can still classify it.
    expect(chatSessionWriteCause(error)).toBe(driver);
    expect(chatSessionWriteFailureCode(error)).toBe("42P01");

    const issued = statements(harness.queries);
    expect(issued).toContain(TRANSACTION_STATEMENTS.rollback);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.commit);
  });

  it("case 8: an unusable create argument never opens a connection", async () => {
    const harness = createHarness(() => [SESSION_ROW]);
    const repository = repositoryFor(harness);

    const bad = [
      { actorId: "" },
      { canvasId: "" },
      { threadId: "" },
      { createdBy: undefined as never },
      { createdBy: "" as never },
      { createdBy: 7 as never },
      { title: undefined as never },
      { title: 7 as never },
    ];

    for (const override of bad) {
      const error = await repository
        .createSession({ ...CREATE_INPUT, ...override })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatSessionWriteError);
      expect((error as ChatSessionWriteError).operation).toBe(CREATE_SESSION);
    }

    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 9: a row that is not the promised shape fails loud instead of answering", async () => {
    // `title` dropped from RETURNING: a missing column is a disagreement with the
    // statement, not "this session has no title".
    const missing = createHarness(() => [{ id: SESSION_ID, updated_at: new Date(CREATED_AT) }]);
    await expect(repositoryFor(missing).createSession(CREATE_INPUT)).rejects.toBeInstanceOf(
      ChatSessionWriteError,
    );

    // `title` present but not a string and not null.
    const wrongTitle = createHarness(() => [
      { id: SESSION_ID, title: 42, updated_at: new Date(CREATED_AT) },
    ]);
    await expect(
      repositoryFor(wrongTitle).createSession(CREATE_INPUT),
    ).rejects.toBeInstanceOf(ChatSessionWriteError);

    // An explicit `undefined` is a shape failure too, not a business null.
    const undefinedTitle = createHarness(() => [
      { id: SESSION_ID, title: undefined, updated_at: new Date(CREATED_AT) },
    ]);
    await expect(
      repositoryFor(undefinedTitle).createSession(CREATE_INPUT),
    ).rejects.toBeInstanceOf(ChatSessionWriteError);

    // A timestamptz that is neither a Date nor an ISO string.
    const wrongStamp = createHarness(() => [
      { id: SESSION_ID, title: "New Chat", updated_at: "yesterday" },
    ]);
    await expect(
      repositoryFor(wrongStamp).createSession(CREATE_INPUT),
    ).rejects.toBeInstanceOf(ChatSessionWriteError);

    // A row that is not an object at all.
    const notARow = createHarness(() => ["nope"]);
    await expect(repositoryFor(notARow).createSession(CREATE_INPUT)).rejects.toBeInstanceOf(
      ChatSessionWriteError,
    );
  });

  it("case 10: a null title really does arrive as the database's answer, not as a repair", async () => {
    // The contract is `string | null`: the repository reports what the row said
    // and never invents a title of its own.
    const harness = createHarness(() => [
      { id: SESSION_ID, title: null, updated_at: new Date(CREATED_AT) },
    ]);

    await expect(repositoryFor(harness).createSession(CREATE_INPUT)).resolves.toEqual({
      id: SESSION_ID,
      title: null,
      updatedAt: CREATED_AT,
    });
  });
});

describe("chat session write repository: the title update", () => {
  it("case 11: the update re-walks session → canvas → project and binds the new title", async () => {
    const harness = createHarness(() => [{ id: SESSION_ID }]);

    await expect(
      repositoryFor(harness).updateSessionTitle({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        title: TITLE,
      }),
    ).resolves.toEqual({ affectedRows: 1 });

    const { sql, params } = domainCall(harness.queries);
    expect(sql).toContain("update public.chat_sessions as s");
    expect(sql).toContain("set title = $3::text");
    expect(sql).toContain("from public.canvases as c");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.user_id = $1::uuid");
    expect(sql).toContain("p.created_by = $1::uuid");
    expect(sql).toContain("c.id = s.canvas_id");
    expect(sql).toContain("returning s.id as id");
    expect(sql).not.toContain("archived_at");
    expect(sql).not.toContain("admin");
    expect(params).toEqual([ACTOR_ID, SESSION_ID, TITLE]);
  });

  it("case 12: zero rows is a legal answer, reported as a count and never as an error", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).updateSessionTitle({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        title: TITLE,
      }),
    ).resolves.toEqual({ affectedRows: 0 });

    // A silent zero is not a failure: the transaction still commits and nothing
    // is rolled back — the caller decides what 0 means (T-34).
    const issued = statements(harness.queries);
    expect(issued).toContain(TRANSACTION_STATEMENTS.commit);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 13: an unusable update argument never reaches the database", async () => {
    const harness = createHarness(() => [{ id: SESSION_ID }]);
    const repository = repositoryFor(harness);

    for (const input of [
      { actorId: "", sessionId: SESSION_ID, title: TITLE },
      { actorId: ACTOR_ID, sessionId: "", title: TITLE },
      { actorId: ACTOR_ID, sessionId: SESSION_ID, title: undefined as never },
      { actorId: ACTOR_ID, sessionId: SESSION_ID, title: 7 as never },
    ]) {
      const error = await repository
        .updateSessionTitle(input)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatSessionWriteError);
      expect((error as ChatSessionWriteError).operation).toBe(UPDATE_SESSION_TITLE);
    }

    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 14: a driver failure is wrapped and rolls the transaction back", async () => {
    const driver = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const harness = createHarness(() => {
      throw driver;
    });

    const error = await repositoryFor(harness)
      .updateSessionTitle({ actorId: ACTOR_ID, sessionId: SESSION_ID, title: TITLE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect(chatSessionWriteFailureCode(error)).toBe("40P01");
    expect(statements(harness.queries)).toContain(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("chat session write repository: the delete", () => {
  it("case 15: the delete removes the session row and leaves the cascade to the schema", async () => {
    const harness = createHarness(() => [{ id: SESSION_ID }]);

    await expect(
      repositoryFor(harness).deleteSession({ actorId: ACTOR_ID, sessionId: SESSION_ID }),
    ).resolves.toEqual({ affectedRows: 1 });

    const { sql, params } = domainCall(harness.queries);
    expect(sql).toContain("delete from public.chat_sessions as s");
    expect(sql).toContain("p.created_by = $1::uuid");
    expect(sql).toContain("m.user_id = $1::uuid");
    expect(sql).toContain("returning s.id as id");
    expect(sql).not.toContain("archived_at");
    expect(params).toEqual([ACTOR_ID, SESSION_ID]);

    // The message rows are NOT deleted here: `chat_messages.session_id` is
    // `ON DELETE CASCADE`, and a second copy of that rule would drift.
    expect(statements(harness.queries).join("\n")).not.toContain("chat_messages");
  });

  it("case 16: deleting nothing is a legal answer, not a 404 from the repository", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).deleteSession({ actorId: ACTOR_ID, sessionId: SESSION_ID }),
    ).resolves.toEqual({ affectedRows: 0 });

    const issued = statements(harness.queries);
    expect(issued).toContain(TRANSACTION_STATEMENTS.commit);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 17: an unusable delete argument never reaches the database, and a driver failure is wrapped", async () => {
    const harness = createHarness(() => [{ id: SESSION_ID }]);
    const repository = repositoryFor(harness);

    for (const input of [
      { actorId: "", sessionId: SESSION_ID },
      { actorId: ACTOR_ID, sessionId: "" },
    ]) {
      const error = await repository.deleteSession(input).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatSessionWriteError);
      expect((error as ChatSessionWriteError).operation).toBe(DELETE_SESSION);
    }
    expect(harness.connectAttempts()).toBe(0);

    const failing = createHarness(() => {
      throw Object.assign(new Error("permission denied for table chat_sessions"), {
        code: "42501",
      });
    });

    const error = await repositoryFor(failing)
      .deleteSession({ actorId: ACTOR_ID, sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ChatSessionWriteError);
    expect(chatSessionWriteFailureCode(error)).toBe("42501");
    expect(statements(failing.queries)).toContain(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("chat session write repository: wiring", () => {
  it("case 18: the pool is reached lazily, and without one every write fails closed", async () => {
    const harness = createHarness(() => [SESSION_ROW]);
    let getterCalls = 0;
    const repository = createChatSessionWriteRepository({
      getTransactionPool: () => {
        getterCalls += 1;
        return harness.pool;
      },
    });

    // Building the repository connects to nothing and reads no configuration.
    expect(getterCalls).toBe(0);
    expect(harness.connectAttempts()).toBe(0);

    // A getter that cannot produce a pool is a write failure — never a fallback
    // to another transport.
    const noPool = createChatSessionWriteRepository({
      getTransactionPool: () => {
        throw new Error("DATABASE_URL is not set");
      },
    });

    for (const call of [
      () => noPool.createSession(CREATE_INPUT),
      () =>
        noPool.updateSessionTitle({
          actorId: ACTOR_ID,
          sessionId: SESSION_ID,
          title: TITLE,
        }),
      () => noPool.deleteSession({ actorId: ACTOR_ID, sessionId: SESSION_ID }),
    ]) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatSessionWriteError);
      // The message stays fixed text: no connection string, no host.
      expect((error as ChatSessionWriteError).message).not.toContain("DATABASE_URL");
    }
  });
});
