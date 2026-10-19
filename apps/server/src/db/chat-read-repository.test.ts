import { describe, expect, it } from "vitest";

import {
  FIND_READABLE_SESSION_THREAD,
  LIST_READABLE_MESSAGES,
  LIST_READABLE_SESSION_ASSETS,
  LIST_READABLE_SESSIONS,
  ChatReadError,
  createChatReadRepository,
  type ChatReadRepository,
} from "./chat-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor it carries, how it binds values — including the
 * `uuid[]` behind the asset read — and how it classifies every way a read can
 * fail.
 *
 * The SQL assertions are deliberately about the AUTHORIZATION predicates and the
 * ownership proof (the session → canvas → project → workspace_members walk, the
 * author/admin/owner clause, the archived filter,
 * `asset_objects.project_id = <project>`), not about a happy path that merely
 * returns rows. The `null` versus `[]` split is asserted through the CTE +
 * LEFT JOIN shape the statements have to keep.
 */

const ACTOR_ID = "00000000-0000-0000-0000-00000000000a";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-00000000000b";
const CANVAS_ID = "55555555-5555-5555-5555-555555555555";
const SESSION_ID = "66666666-6666-6666-6666-666666666666";
const OTHER_SESSION_ID = "66666666-6666-6666-6666-666666666667";
const MESSAGE_ID = "77777777-7777-7777-7777-777777777777";
const ASSET_ID = "88888888-8888-8888-8888-888888888888";
const OTHER_ASSET_ID = "88888888-8888-8888-8888-888888888889";
const BUCKET = "project-assets";
const OBJECT_PATH = "ws-team/project-1/pic.png";

const UPDATED_AT = new Date("2026-01-02T03:04:05.678Z");
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const INVALID_ID = "not-a-uuid";

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

/** Only the four domain statements touch these tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) =>
      entry.sql.includes("public.chat_sessions") ||
      entry.sql.includes("public.chat_messages") ||
      entry.sql.includes("public.asset_objects"),
  );
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);
  const pairs: unknown[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]]);
  }
  return pairs;
}

function repositoryFor(harness: Harness): ChatReadRepository {
  return createChatReadRepository({ getTransactionPool: () => harness.pool });
}

const SESSION_ROW = {
  parent_id: CANVAS_ID,
  id: SESSION_ID,
  title: "First chat",
  updated_at: UPDATED_AT,
};

const MESSAGE_ROW = {
  parent_id: SESSION_ID,
  id: MESSAGE_ID,
  role: "assistant",
  content: "hello",
  tool_activities: [{ name: "generate_image", status: "completed" }],
  content_blocks: [{ type: "text", text: "hi" }],
  created_at: CREATED_AT,
};

const ASSET_ROW = {
  id: ASSET_ID,
  object_path: OBJECT_PATH,
  bucket: BUCKET,
};

/**
 * A message row as a statement that dropped a column returns it: the field is
 * simply not on the object. That is a different answer from SQL `NULL`, which
 * arrives as the field being present and `null`.
 */
function messageRowWithout(...fields: readonly string[]): Record<string, unknown> {
  const row: Record<string, unknown> = { ...MESSAGE_ROW };
  for (const field of fields) delete row[field];
  return row;
}

/** The ACL walk every statement must contain, whatever else it selects. */
function expectAclPredicates(sql: string): void {
  expect(sql).toContain("public.workspace_members");
  expect(sql).toContain("m.user_id = $1");
  expect(sql).toContain("p.archived_at is null");
  expect(sql).toContain("(p.created_by = $1 or m.role in ('admin', 'owner'))");
  // Never authorized by the diagnostic label.
  expect(sql).not.toContain("execution_mode");
}

describe("chat-read-repository: listReadableSessions", () => {
  it("case 1: reads inside one privileged transaction that carries the actor and binds both values", async () => {
    const harness = createHarness(() => [SESSION_ROW]);

    const sessions = await repositoryFor(harness).listReadableSessions({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    const actorSetting = contextParams(harness.queries).find(
      (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
    );
    expect(actorSetting).toEqual([TRANSACTION_SETTING_NAMES.userId, ACTOR_ID]);
    expect(contextParams(harness.queries)).toHaveLength(4);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([ACTOR_ID, CANVAS_ID]);
    expect(calls[0]?.sql).toContain("public.canvases");
    expect(calls[0]?.sql).toContain("public.projects");
    expect(calls[0]?.sql).toContain("public.chat_sessions");
    expect(calls[0]?.sql).toContain("s.canvas_id = rp.parent_id");
    expectAclPredicates(calls[0]?.sql ?? "");

    expect(sessions).toEqual([
      { id: SESSION_ID, title: "First chat", updated_at: UPDATED_AT.toISOString() },
    ]);
  });

  it("case 2: the statement keeps the readable parent when it has no sessions", async () => {
    const harness = createHarness(() => [{ ...SESSION_ROW, id: null, title: null, updated_at: null }]);

    const sessions = await repositoryFor(harness).listReadableSessions({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    // The CTE + LEFT JOIN is the only reason `[]` and `null` can be told apart:
    // a plain inner join would return zero rows in both cases.
    expect(sql).toContain("with readable_parent as (");
    expect(sql).toContain("left join public.chat_sessions as s");
    expect(sessions).toEqual([]);
  });

  it("case 3: an unreadable or missing canvas is null, not an empty list", async () => {
    const harness = createHarness(() => []);

    const sessions = await repositoryFor(harness).listReadableSessions({
      actorId: OTHER_ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    expect(sessions).toBeNull();
  });

  it("case 4: sessions keep the statement's most-recently-updated-first order", async () => {
    const harness = createHarness(() => [
      SESSION_ROW,
      {
        ...SESSION_ROW,
        id: OTHER_SESSION_ID,
        title: "Older chat",
        updated_at: new Date("2025-12-31T00:00:00.000Z"),
      },
    ]);

    const sessions = await repositoryFor(harness).listReadableSessions({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    expect(domainCalls(harness.queries)[0]?.sql).toContain(
      "order by s.updated_at desc",
    );
    expect(sessions?.map((row) => row.id)).toEqual([SESSION_ID, OTHER_SESSION_ID]);
  });

  it("case 5: a duplicate session id, a missing title and a bad timestamp all fail loud", async () => {
    const duplicate = createHarness(() => [SESSION_ROW, SESSION_ROW]);
    const duplicateError = await repositoryFor(duplicate)
      .listReadableSessions({ actorId: ACTOR_ID, canvasId: CANVAS_ID })
      .catch((reason: unknown) => reason);

    expect(duplicateError).toBeInstanceOf(ChatReadError);
    expect((duplicateError as ChatReadError).operation).toBe(
      LIST_READABLE_SESSIONS,
    );

    const noTitle = createHarness(() => [{ ...SESSION_ROW, title: null }]);
    await expect(
      repositoryFor(noTitle).listReadableSessions({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);

    const badTimestamp = createHarness(() => [
      { ...SESSION_ROW, updated_at: "yesterday" },
    ]);
    await expect(
      repositoryFor(badTimestamp).listReadableSessions({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);
  });
});

describe("chat-read-repository: listReadableMessages", () => {
  it("case 6: the message ACL is re-derived through the session's canvas and project", async () => {
    const harness = createHarness(() => [MESSAGE_ROW]);

    const messages = await repositoryFor(harness).listReadableMessages({
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([ACTOR_ID, SESSION_ID]);
    expectAclPredicates(calls[0]?.sql ?? "");
    expect(calls[0]?.sql).toContain("s.id = $2");
    expect(calls[0]?.sql).toContain("left join public.chat_messages as msg");
    expect(calls[0]?.sql).toContain("msg.session_id = rp.parent_id");
    expect(calls[0]?.sql).toContain("order by msg.created_at asc");

    expect(messages).toEqual([
      {
        id: MESSAGE_ID,
        role: "assistant",
        content: "hello",
        tool_activities: [{ name: "generate_image", status: "completed" }],
        content_blocks: [{ type: "text", text: "hi" }],
        created_at: CREATED_AT.toISOString(),
      },
    ]);
  });

  it("case 7: empty content and null jsonb stay legal, an unusable role or jsonb does not", async () => {
    const harness = createHarness(() => [
      {
        ...MESSAGE_ROW,
        content: "",
        tool_activities: null,
        content_blocks: null,
      },
    ]);

    await expect(
      repositoryFor(harness).listReadableMessages({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual([
      {
        id: MESSAGE_ID,
        role: "assistant",
        content: "",
        tool_activities: null,
        content_blocks: null,
        created_at: CREATED_AT.toISOString(),
      },
    ]);

    const badRole = createHarness(() => [{ ...MESSAGE_ROW, role: "system" }]);
    await expect(
      repositoryFor(badRole).listReadableMessages({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);

    const badJson = createHarness(() => [
      { ...MESSAGE_ROW, content_blocks: { type: "text" } },
    ]);
    await expect(
      repositoryFor(badJson).listReadableMessages({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);
  });

  it("case 8: a readable session with no messages is [], an unreadable session is null", async () => {
    const empty = createHarness(() => [
      {
        ...MESSAGE_ROW,
        id: null,
        role: null,
        content: null,
        tool_activities: null,
        content_blocks: null,
        created_at: null,
      },
    ]);

    await expect(
      repositoryFor(empty).listReadableMessages({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual([]);

    const missing = createHarness(() => []);
    await expect(
      repositoryFor(missing).listReadableMessages({
        actorId: OTHER_ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toBeNull();
  });

  it("case 18: present null jsonb columns stay legal, a missing or undefined one fails loud", async () => {
    // Both jsonb columns present and null: the SQL said NULL, which is legal.
    const presentNulls = createHarness(() => [
      { ...MESSAGE_ROW, tool_activities: null, content_blocks: null },
    ]);

    await expect(
      repositoryFor(presentNulls).listReadableMessages({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual([
      {
        id: MESSAGE_ID,
        role: "assistant",
        content: "hello",
        tool_activities: null,
        content_blocks: null,
        created_at: CREATED_AT.toISOString(),
      },
    ]);

    // Each column is checked on its own: dropping one must not be served as
    // "this message has no such column".
    const droppedColumns = [
      ["tool_activities"],
      ["content_blocks"],
      ["tool_activities", "content_blocks"],
    ] as const;

    for (const dropped of droppedColumns) {
      const harness = createHarness(() => [messageRowWithout(...dropped)]);
      const error = await repositoryFor(harness)
        .listReadableMessages({ actorId: ACTOR_ID, sessionId: SESSION_ID })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ChatReadError);
      expect((error as ChatReadError).operation).toBe(LIST_READABLE_MESSAGES);
      expect((error as ChatReadError).message).toBe(
        `chat read failed (${LIST_READABLE_MESSAGES})`,
      );
    }

    const undefinedColumns = [
      { ...MESSAGE_ROW, tool_activities: undefined },
      { ...MESSAGE_ROW, content_blocks: undefined },
      {
        ...MESSAGE_ROW,
        tool_activities: undefined,
        content_blocks: undefined,
      },
    ];

    for (const row of undefinedColumns) {
      const harness = createHarness(() => [row]);
      const error = await repositoryFor(harness)
        .listReadableMessages({ actorId: ACTOR_ID, sessionId: SESSION_ID })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ChatReadError);
      expect((error as ChatReadError).operation).toBe(LIST_READABLE_MESSAGES);
    }
  });
});

describe("chat-read-repository: listReadableSessionAssets", () => {
  it("case 9: an empty id list answers [] without opening a connection", async () => {
    let getterCalls = 0;
    const repository = createChatReadRepository({
      getTransactionPool: () => {
        getterCalls += 1;
        throw new Error("the pool must not be required for an empty id list");
      },
    });

    await expect(
      repository.listReadableSessionAssets({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        assetIds: [],
      }),
    ).resolves.toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it("case 10: ids are bound as one deduped uuid[] and matched against the session's own project", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    const rows = await repositoryFor(harness).listReadableSessionAssets({
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      assetIds: [ASSET_ID, ASSET_ID, OTHER_ASSET_ID],
    });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([
      ACTOR_ID,
      SESSION_ID,
      [ASSET_ID, OTHER_ASSET_ID],
    ]);
    expectAclPredicates(calls[0]?.sql ?? "");
    // Ownership is proven by the project column, never guessed from the key.
    expect(calls[0]?.sql).toContain("a.project_id = rp.project_id");
    expect(calls[0]?.sql).toContain("unnest($3::uuid[])");
    expect(calls[0]?.sql).toContain("r.id = a.id");

    expect(rows).toEqual([
      { id: ASSET_ID, object_path: OBJECT_PATH, bucket: BUCKET },
    ]);
  });

  it("case 11: a half-formed id fails loud, a duplicated row and a bad shape fail loud", async () => {
    const harness = createHarness(() => [ASSET_ROW]);
    await expect(
      repositoryFor(harness).listReadableSessionAssets({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        assetIds: [""],
      }),
    ).rejects.toBeInstanceOf(ChatReadError);
    expect(harness.connectAttempts()).toBe(0);

    const duplicate = createHarness(() => [ASSET_ROW, ASSET_ROW]);
    await expect(
      repositoryFor(duplicate).listReadableSessionAssets({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        assetIds: [ASSET_ID],
      }),
    ).rejects.toBeInstanceOf(ChatReadError);

    const badShape = createHarness(() => [{ ...ASSET_ROW, bucket: null }]);
    const shapeError = await repositoryFor(badShape)
      .listReadableSessionAssets({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
        assetIds: [ASSET_ID],
      })
      .catch((reason: unknown) => reason);

    expect(shapeError).toBeInstanceOf(ChatReadError);
    expect((shapeError as ChatReadError).operation).toBe(
      LIST_READABLE_SESSION_ASSETS,
    );
  });
});

describe("chat-read-repository: findReadableSessionThread", () => {
  it("case 12: binds the actor and the session, and keeps a null thread as a real answer", async () => {
    const withThread = createHarness(() => [
      { id: SESSION_ID, thread_id: "thread_abc" },
    ]);

    const bound = await repositoryFor(withThread).findReadableSessionThread({
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
    });

    const calls = domainCalls(withThread.queries);
    expect(calls[0]?.params).toEqual([ACTOR_ID, SESSION_ID]);
    expectAclPredicates(calls[0]?.sql ?? "");
    expect(bound).toEqual({ id: SESSION_ID, threadId: "thread_abc" });

    const withoutThread = createHarness(() => [
      { id: SESSION_ID, thread_id: null },
    ]);
    await expect(
      repositoryFor(withoutThread).findReadableSessionThread({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({ id: SESSION_ID, threadId: null });
  });

  it("case 13: an unreadable session is null, a duplicated row fails loud", async () => {
    const missing = createHarness(() => []);
    await expect(
      repositoryFor(missing).findReadableSessionThread({
        actorId: OTHER_ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toBeNull();

    const duplicate = createHarness(() => [
      { id: SESSION_ID, thread_id: "thread_abc" },
      { id: SESSION_ID, thread_id: "thread_abc" },
    ]);
    const duplicateError = await repositoryFor(duplicate)
      .findReadableSessionThread({ actorId: ACTOR_ID, sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(duplicateError).toBeInstanceOf(ChatReadError);
    expect((duplicateError as ChatReadError).operation).toBe(
      FIND_READABLE_SESSION_THREAD,
    );
  });

  it("case 17: a present null thread stays an answer, a missing or undefined thread fails loud", async () => {
    // The nullable half of the row-shape rule: `thread_id` present and null is
    // the legacy "no thread yet" the caller turns into a 409.
    const presentNull = createHarness(() => [{ id: SESSION_ID, thread_id: null }]);
    await expect(
      repositoryFor(presentNull).findReadableSessionThread({
        actorId: ACTOR_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({ id: SESSION_ID, threadId: null });

    // The column is gone from the row: a dropped select, a drifting alias or a
    // half-built driver row. It must not be served as "no thread yet".
    const missingField = createHarness(() => [{ id: SESSION_ID }]);
    const missingError = await repositoryFor(missingField)
      .findReadableSessionThread({ actorId: ACTOR_ID, sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(missingError).toBeInstanceOf(ChatReadError);
    expect((missingError as ChatReadError).operation).toBe(
      FIND_READABLE_SESSION_THREAD,
    );
    expect((missingError as ChatReadError).message).toBe(
      `chat read failed (${FIND_READABLE_SESSION_THREAD})`,
    );
    expect((missingError as ChatReadError).message).not.toMatch(
      /select|public\.|join|postgres:\/\//i,
    );

    // Present but explicitly `undefined` is the same disagreement as missing.
    const undefinedField = createHarness(() => [
      { id: SESSION_ID, thread_id: undefined },
    ]);
    const undefinedError = await repositoryFor(undefinedField)
      .findReadableSessionThread({ actorId: ACTOR_ID, sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(undefinedError).toBeInstanceOf(ChatReadError);
    expect((undefinedError as ChatReadError).operation).toBe(
      FIND_READABLE_SESSION_THREAD,
    );
  });
});

describe("chat-read-repository: failure classification", () => {
  it("case 14: connect, SQL and shape failures all become ChatReadError with a fixed message", async () => {
    const connect = createHarness(() => [], {
      connectError: new Error(
        "ECONNREFUSED postgres://user:secret@10.210.134.37:5432/db",
      ),
    });
    const connectError = await repositoryFor(connect)
      .listReadableSessions({ actorId: ACTOR_ID, canvasId: CANVAS_ID })
      .catch((reason: unknown) => reason);

    expect(connectError).toBeInstanceOf(ChatReadError);
    expect((connectError as ChatReadError).operation).toBe(
      LIST_READABLE_SESSIONS,
    );
    expect((connectError as ChatReadError).message).toBe(
      `chat read failed (${LIST_READABLE_SESSIONS})`,
    );
    expect((connectError as ChatReadError).message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(((connectError as ChatReadError).cause as Error).message).toContain(
      "ECONNREFUSED",
    );

    // A real database answer (invalid uuid) carries the same fixed message under
    // the operation that failed.
    const sqlFailure = createHarness(() => {
      throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
    });
    const sqlError = await repositoryFor(sqlFailure)
      .listReadableMessages({ actorId: ACTOR_ID, sessionId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(sqlError).toBeInstanceOf(ChatReadError);
    expect((sqlError as ChatReadError).operation).toBe(LIST_READABLE_MESSAGES);
    expect((sqlError as ChatReadError).message).not.toContain("uuid");

    const shapeFailure = createHarness(() => [{ id: "", title: "x" }]);
    await expect(
      repositoryFor(shapeFailure).listReadableSessions({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toBeInstanceOf(ChatReadError);
  });

  it("case 15: every read runs privileged for the actor, and no read invents one", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).listReadableMessages({
      actorId: OTHER_ACTOR_ID,
      sessionId: SESSION_ID,
    });

    const actorSetting = contextParams(harness.queries).find(
      (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
    );
    expect(actorSetting).toEqual([
      TRANSACTION_SETTING_NAMES.userId,
      OTHER_ACTOR_ID,
    ]);
    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      OTHER_ACTOR_ID,
      SESSION_ID,
    ]);
  });

  it("case 16: building the repository touches no pool, reads no env and connects to nothing", () => {
    let getterCalls = 0;
    const repository = createChatReadRepository({
      getTransactionPool: () => {
        getterCalls += 1;
        throw new Error("the pool must not be required to build the repository");
      },
    });

    expect(repository).toBeDefined();
    expect(getterCalls).toBe(0);
  });
});
