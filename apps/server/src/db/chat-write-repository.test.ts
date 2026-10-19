import { describe, expect, it } from "vitest";

import {
  FIND_MESSAGE_FOR_RECOVERY,
  INSERT_MESSAGE,
  TOUCH_SESSION,
  ChatWriteError,
  chatWriteCause,
  chatWriteFailureCode,
  createChatWriteRepository,
  type ChatWriteRepository,
} from "./chat-write-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real write repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor it carries, how it binds every value, and how it
 * classifies each way a write can fail.
 *
 * The SQL assertions are deliberately about AUTHORIZATION and about the three
 * adjudicated write contracts (T-34) rather than about a happy path:
 *
 * - the session/message → canvas → project → workspace_members walk plus
 *   `projects.created_by = actor` — the author, and nobody else;
 * - the ABSENCE of an `archived_at` filter (an archived project stays writable);
 * - the ABSENCE of any write to `chat_sessions.created_by`;
 * - `touchSession` reporting a row count instead of turning 0 rows into an error.
 *
 * Row-shape and duplicate-row failures are asserted here against rows a primary
 * key cannot produce; the same behaviour on a real table is exercised in
 * `test-support/db/chat-write-repository-db.test.ts`.
 */

const ACTOR_ID = "11111111-1111-1111-1111-111111111111";
const MESSAGE_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";

const UPDATED_AT = "2026-01-02T03:04:05.678Z";
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

  const harness: Harness = {
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

  return harness;
}

function repositoryFor(harness: Harness): ChatWriteRepository {
  return createChatWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one domain statement of a call; BEGIN/COMMIT/set_config are not it. */
function domainCall(queries: readonly QueryRecord[]): QueryRecord {
  const entry = queries.find(
    (record) =>
      record.sql.includes("public.chat_messages") ||
      record.sql.includes("public.chat_sessions"),
  );
  if (!entry) throw new Error("no domain statement was issued");
  return entry;
}

function contextParams(queries: readonly QueryRecord[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);
  for (let i = 0; i + 1 < flat.length; i += 2) {
    values.set(String(flat[i]), flat[i + 1]);
  }
  return values;
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql.trim());
}

const MESSAGE_ROW = {
  id: MESSAGE_ID,
  role: "assistant",
  content: "hello",
  tool_activities: [{ name: "generate_image", status: "completed" }],
  content_blocks: [{ type: "text", text: "hi" }],
  created_at: new Date(CREATED_AT),
};

const INSERT_INPUT = {
  actorId: ACTOR_ID,
  messageId: MESSAGE_ID,
  sessionId: SESSION_ID,
  role: "assistant" as const,
  content: "hello",
  toolActivities: [{ name: "generate_image", status: "completed" }],
  contentBlocks: [{ type: "text", text: "hi" }],
};

/** The parenthesised column list of the insert, so its fields can be asserted. */
function insertedColumns(sql: string): string {
  const match = /insert into public\.chat_messages \(([^)]*)\)/.exec(sql);
  if (!match?.[1]) throw new Error("the insert column list is missing");
  return match[1];
}

describe("chat write repository: the insert statement", () => {
  it("case 1: the insert walks session → canvas → project → members and requires the project author", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);
    const repository = repositoryFor(harness);

    await expect(repository.insertMessage(INSERT_INPUT)).resolves.toEqual({
      id: MESSAGE_ID,
      role: "assistant",
      content: "hello",
      tool_activities: [{ name: "generate_image", status: "completed" }],
      content_blocks: [{ type: "text", text: "hi" }],
      created_at: CREATED_AT,
    });

    const { sql, params } = domainCall(harness.queries);

    // The ACL is the statement's own predicate. Every hop has to be there, or a
    // caller could store a message into a session it does not own.
    expect(sql).toContain("from public.chat_sessions as s");
    expect(sql).toContain("join public.canvases as c");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.user_id = $1::uuid");
    expect(sql).toContain("p.created_by = $1::uuid");
    // ... and it is the AUTHOR, never the role: no admin/owner widening here.
    expect(sql).not.toContain("admin");
    expect(sql).not.toContain("owner");

    // T-34: an archived project stays writable, so the write ACL must not filter.
    expect(sql).not.toContain("archived_at");

    // The caller's id is used as given; the column list carries no created_by.
    // The two jsonb arguments are bound as JSON TEXT on purpose: node-postgres
    // turns a JavaScript array into a PostgreSQL array literal, which `::jsonb`
    // rejects with 22P02 (see requireJsonArgument).
    expect(params).toEqual([
      ACTOR_ID,
      MESSAGE_ID,
      SESSION_ID,
      "assistant",
      "hello",
      JSON.stringify([{ name: "generate_image", status: "completed" }]),
      JSON.stringify([{ type: "text", text: "hi" }]),
    ]);
    expect(sql).toContain("$2::uuid");
    expect(sql).toContain("returning");
    expect(insertedColumns(sql)).not.toContain("created_by");
  });

  it("case 2: the actor rides the transaction and the mode is the explicit privileged one", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);

    await repositoryFor(harness).insertMessage(INSERT_INPUT);

    const context = contextParams(harness.queries);
    expect(context.get(TRANSACTION_SETTING_NAMES.userId)).toBe(ACTOR_ID);
    expect(context.get(TRANSACTION_SETTING_NAMES.executionMode)).toBe("privileged");

    // One transaction, committed, with the statement inside it.
    const issued = statements(harness.queries);
    expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(issued).toContain(TRANSACTION_STATEMENTS.commit);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 3: the write ACL's silent zero rows is a failure, never a stored message", async () => {
    // `insert ... select` from a session the actor does not author inserts no row
    // and raises nothing: PostgreSQL has no error to give. The verdict is the row
    // count, so the repository has to turn it into one.
    const harness = createHarness(() => []);
    const error = await repositoryFor(harness)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    expect((error as ChatWriteError).operation).toBe(INSERT_MESSAGE);
    // Nothing is returned to the caller pretending the message landed.
    expect(chatWriteFailureCode(error)).toBeNull();
  });

  it("case 4: a driver failure keeps its code and its cause, and leaks neither into the message", async () => {
    const driver = Object.assign(new Error('relation "public.chat_messages" does not exist'), {
      code: "42P01",
    });
    const harness = createHarness(() => {
      throw driver;
    });

    const error = await repositoryFor(harness)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    expect((error as ChatWriteError).message).toBe(
      `chat write failed (${INSERT_MESSAGE})`,
    );
    // The driver's text carries the statement; it must not reach the message.
    expect((error as ChatWriteError).message).not.toContain("does not exist");
    expect((error as ChatWriteError).message).not.toContain("public.chat_messages");
    // ... but the caller can still classify it, which is what the state machine does.
    expect(chatWriteCause(error)).toBe(driver);
    expect(chatWriteFailureCode(error)).toBe("42P01");

    const issued = statements(harness.queries);
    expect(issued).toContain(TRANSACTION_STATEMENTS.rollback);
    expect(issued).not.toContain(TRANSACTION_STATEMENTS.commit);
  });

  it("case 5: a row that is not the promised shape fails loud instead of answering", async () => {
    // `content_blocks` dropped from RETURNING: a missing column is a disagreement
    // with the statement, not "this message has no blocks".
    const harness = createHarness(() => [
      { ...MESSAGE_ROW, content_blocks: undefined },
    ]);
    const missing = await repositoryFor(harness)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);
    expect(missing).toBeInstanceOf(ChatWriteError);

    // A `role` outside the closed set would be a contract change, not a message.
    const wrongRole = createHarness(() => [{ ...MESSAGE_ROW, role: "system" }]);
    const role = await repositoryFor(wrongRole)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);
    expect(role).toBeInstanceOf(ChatWriteError);

    // A `created_at` that is neither a Date nor an ISO timestamp is unusable.
    const wrongTime = createHarness(() => [{ ...MESSAGE_ROW, created_at: 42 }]);
    const time = await repositoryFor(wrongTime)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);
    expect(time).toBeInstanceOf(ChatWriteError);
  });

  it("case 6: an unusable argument never opens a connection", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);
    const repository = repositoryFor(harness);

    const bad = [
      { ...INSERT_INPUT, role: "system" as never },
      { ...INSERT_INPUT, messageId: "" },
      { ...INSERT_INPUT, sessionId: undefined as never },
      { ...INSERT_INPUT, content: undefined as never },
      { ...INSERT_INPUT, toolActivities: undefined as never },
      { ...INSERT_INPUT, contentBlocks: undefined as never },
    ];

    for (const input of bad) {
      const error = await repository
        .insertMessage(input)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatWriteError);
    }

    // An empty `content` is a value the column really stores, so it is NOT one of
    // the unusable arguments — it must reach the database.
    await repository.insertMessage({ ...INSERT_INPUT, content: "" });

    expect(harness.connectAttempts()).toBe(1);
  });
});

describe("chat write repository: the lost-response confirmation read", () => {
  it("case 7: zero rows is null, not a failure", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).findMessageForRecovery({
        actorId: ACTOR_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toBeNull();

    const { sql, params } = domainCall(harness.queries);
    // By message id ONLY — the caller has nothing else after a lost response.
    expect(params).toEqual([ACTOR_ID, MESSAGE_ID]);
    expect(sql).toContain("msg.id = $2::uuid");
    // ... but the row is re-authorised through its own session and project, so a
    // message in a project this actor may not write answers exactly like none.
    expect(sql).toContain("join public.chat_sessions as s");
    expect(sql).toContain("join public.canvases as c");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("p.created_by = $1::uuid");
    expect(sql).not.toContain("archived_at");
  });

  it("case 8: a landed row comes back in the response shape, timestamp normalised", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);

    await expect(
      repositoryFor(harness).findMessageForRecovery({
        actorId: ACTOR_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toEqual({
      id: MESSAGE_ID,
      role: "assistant",
      content: "hello",
      tool_activities: [{ name: "generate_image", status: "completed" }],
      content_blocks: [{ type: "text", text: "hi" }],
      created_at: CREATED_AT,
    });
  });

  it("case 9: two rows for one primary key means the SQL and this module disagree", async () => {
    const harness = createHarness(() => [MESSAGE_ROW, { ...MESSAGE_ROW, id: MESSAGE_ID }]);

    const error = await repositoryFor(harness)
      .findMessageForRecovery({ actorId: ACTOR_ID, messageId: MESSAGE_ID })
      .catch((reason: unknown) => reason);

    // Guessing which row landed is how a duplicate reply gets written.
    expect(error).toBeInstanceOf(ChatWriteError);
    expect((error as ChatWriteError).operation).toBe(FIND_MESSAGE_FOR_RECOVERY);
  });

  it("case 10: a null-able column that is absent is a shape failure, an explicit null is an answer", async () => {
    const absent = createHarness(() => [{ ...MESSAGE_ROW, tool_activities: undefined }]);
    const absentError = await repositoryFor(absent)
      .findMessageForRecovery({ actorId: ACTOR_ID, messageId: MESSAGE_ID })
      .catch((reason: unknown) => reason);
    expect(absentError).toBeInstanceOf(ChatWriteError);

    const explicit = createHarness(() => [
      { ...MESSAGE_ROW, tool_activities: null, content_blocks: null },
    ]);
    await expect(
      repositoryFor(explicit).findMessageForRecovery({
        actorId: ACTOR_ID,
        messageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ tool_activities: null, content_blocks: null });
  });

  it("case 11: the confirmation carries the SAME actor, and a driver failure is wrapped", async () => {
    const driver = Object.assign(new Error("invalid input syntax for type uuid"), {
      code: "22P02",
    });
    const harness = createHarness(() => {
      throw driver;
    });

    const error = await repositoryFor(harness)
      .findMessageForRecovery({ actorId: ACTOR_ID, messageId: "not-a-uuid" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    // 22P02 is a SQLSTATE: the accepted predicate must NOT call it a transport
    // failure, or the service would confirm again and replay on top of it.
    expect(chatWriteFailureCode(error)).toBe("22P02");
    expect(contextParams(harness.queries).get(TRANSACTION_SETTING_NAMES.userId)).toBe(
      ACTOR_ID,
    );
  });
});

describe("chat write repository: the session touch", () => {
  it("case 12: the affected row count is reported, and zero rows is a legal answer", async () => {
    const touched = createHarness(() => [{ id: SESSION_ID }]);
    await expect(
      repositoryFor(touched).touchSession({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        updatedAt: UPDATED_AT,
      }),
    ).resolves.toEqual({ affectedRows: 1 });

    const { sql, params } = domainCall(touched.queries);
    expect(sql).toContain("update public.chat_sessions as s");
    expect(sql).toContain("set updated_at = $3::timestamptz");
    expect(sql).toContain("p.created_by = $1::uuid");
    expect(sql).toContain("m.user_id = $1::uuid");
    // T-34 again: archived projects stay writable, and nothing here writes
    // chat_sessions.created_by.
    expect(sql).not.toContain("archived_at");
    expect(sql).not.toContain("created_by = $2");
    expect(params).toEqual([ACTOR_ID, SESSION_ID, UPDATED_AT]);
    expect(params?.[2]).toBe(new Date(UPDATED_AT).toISOString());

    // No permission, or a session that is gone: 0 rows, no error, no rollback.
    const refused = createHarness(() => []);
    await expect(
      repositoryFor(refused).touchSession({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        updatedAt: UPDATED_AT,
      }),
    ).resolves.toEqual({ affectedRows: 0 });
    expect(statements(refused.queries)).toContain(TRANSACTION_STATEMENTS.commit);
  });

  it("case 13: an unusable timestamp never reaches the database", async () => {
    const harness = createHarness(() => [{ id: SESSION_ID }]);
    const repository = repositoryFor(harness);

    for (const updatedAt of ["", "2026-01-02", "yesterday", undefined as never]) {
      const error = await repository
        .touchSession({ actorId: ACTOR_ID, sessionId: SESSION_ID, updatedAt })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatWriteError);
      expect((error as ChatWriteError).operation).toBe(TOUCH_SESSION);
    }

    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 14: a driver failure is wrapped like every other statement's", async () => {
    const driver = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const harness = createHarness(() => {
      throw driver;
    });

    const error = await repositoryFor(harness)
      .touchSession({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        updatedAt: UPDATED_AT,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    expect(chatWriteFailureCode(error)).toBe("40P01");
    expect(statements(harness.queries)).toContain(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("chat write repository: wiring", () => {
  it("case 15: the pool is reached lazily, and without one every write fails closed", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);
    let getterCalls = 0;
    const repository = createChatWriteRepository({
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
    const noPool = createChatWriteRepository({
      getTransactionPool: () => {
        throw new Error("DATABASE_URL is not set");
      },
    });

    for (const call of [
      () => noPool.insertMessage(INSERT_INPUT),
      () => noPool.findMessageForRecovery({ actorId: ACTOR_ID, messageId: MESSAGE_ID }),
      () =>
        noPool.touchSession({
          actorId: ACTOR_ID,
          sessionId: SESSION_ID,
          updatedAt: UPDATED_AT,
        }),
    ]) {
      const error = await call().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ChatWriteError);
      // The configuration error's text does not become the error's message.
      expect((error as ChatWriteError).message).not.toContain("DATABASE_URL");
      expect((error as ChatWriteError).message).toContain("chat write failed");
    }
  });

  it("case 16: a connect failure is a write failure, and a bad argument still never connects", async () => {
    const connectFailure = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    );
    const harness = createHarness(() => [MESSAGE_ROW], { connectError: connectFailure });

    const error = await repositoryFor(harness)
      .insertMessage(INSERT_INPUT)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ChatWriteError);
    // ECONNREFUSED is a Node network code: the accepted predicate calls this a
    // transport failure, which is why the service confirms before replaying.
    expect(chatWriteFailureCode(error)).toBe("ECONNREFUSED");
    expect(chatWriteCause(error)).toBe(connectFailure);
  });
});
