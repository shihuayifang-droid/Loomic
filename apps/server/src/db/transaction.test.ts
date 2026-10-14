import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabasePool,
  createDatabasePool,
  getDatabasePool,
  getTransactionPool,
  hasDatabasePool,
  resolveDatabaseUrl,
} from "./pool.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_SETTING_ORDER,
  TRANSACTION_STATEMENTS,
  buildContextValues,
  withPrivilegedTransaction,
  withTransaction,
  type TransactionConnection,
} from "./transaction.js";

type QueryRecord = {
  sql: string;
  params?: readonly unknown[];
};

type FakeClient = TransactionConnection & {
  queries: QueryRecord[];
  releases: (Error | boolean | undefined)[];
};

function createFakeClient(
  onQuery?: (sql: string, call: number) => void | Promise<void>,
): FakeClient {
  const queries: QueryRecord[] = [];
  const releases: (Error | boolean | undefined)[] = [];

  return {
    queries,
    releases,
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });
      await onQuery?.(sql, queries.length);
      return { rows: [] };
    },
    release(err?: Error | boolean) {
      releases.push(err);
    },
  };
}

function createFakePool(client: FakeClient) {
  const connects: number[] = [];

  return {
    connects,
    async connect() {
      connects.push(connects.length + 1);
      return client;
    },
  };
}

function createFailingConnectPool(error: Error) {
  return {
    async connect(): Promise<TransactionConnection> {
      throw error;
    },
  };
}

function configCalls(client: FakeClient): QueryRecord[] {
  return client.queries.filter(
    (entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting,
  );
}

const ACTOR = { userId: "user-1", workspaceId: "ws-1", role: "owner" };

afterEach(async () => {
  await closeDatabasePool();
});

describe("withTransaction: session context", () => {
  it("writes all four session settings in a fixed order around the callback", async () => {
    const client = createFakeClient();
    const pool = createFakePool(client);

    await withTransaction(pool, ACTOR, async () => undefined);

    expect(client.queries.map((entry) => entry.sql)).toEqual([
      TRANSACTION_STATEMENTS.begin,
      TRANSACTION_STATEMENTS.setLocalSetting,
      TRANSACTION_STATEMENTS.setLocalSetting,
      TRANSACTION_STATEMENTS.setLocalSetting,
      TRANSACTION_STATEMENTS.setLocalSetting,
      TRANSACTION_STATEMENTS.commit,
    ]);
    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", "user-1"],
      ["app.workspace_id", "ws-1"],
      ["app.role", "owner"],
      ["app.execution_mode", "user"],
    ]);
  });

  it("keeps the setting-name tuple aligned with the parameter order", () => {
    expect(TRANSACTION_SETTING_ORDER).toEqual([
      "app.user_id",
      "app.workspace_id",
      "app.role",
      "app.execution_mode",
    ]);
    expect(TRANSACTION_SETTING_ORDER).toEqual([
      TRANSACTION_SETTING_NAMES.userId,
      TRANSACTION_SETTING_NAMES.workspaceId,
      TRANSACTION_SETTING_NAMES.role,
      TRANSACTION_SETTING_NAMES.executionMode,
    ]);
  });

  it("normalises null actor fields to empty strings", async () => {
    const client = createFakeClient();

    await withTransaction(
      createFakePool(client),
      { userId: null, workspaceId: null, role: null },
      async () => undefined,
    );

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", ""],
      ["app.workspace_id", ""],
      ["app.role", ""],
      ["app.execution_mode", "user"],
    ]);
  });

  it("normalises missing actor fields to empty strings", async () => {
    const client = createFakeClient();

    await withTransaction(createFakePool(client), {}, async () => undefined);

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", ""],
      ["app.workspace_id", ""],
      ["app.role", ""],
      ["app.execution_mode", "user"],
    ]);
  });

  it("normalises a partial actor to empty strings for the missing fields", async () => {
    const client = createFakeClient();

    await withTransaction(
      createFakePool(client),
      { userId: "user-7" },
      async () => undefined,
    );

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", "user-7"],
      ["app.workspace_id", ""],
      ["app.role", ""],
      ["app.execution_mode", "user"],
    ]);
  });

  it("passes non-empty actor fields through verbatim", () => {
    expect(buildContextValues(ACTOR, "user")).toEqual([
      "user-1",
      "ws-1",
      "owner",
      "user",
    ]);
  });

  it("defaults the execution mode to the non-privileged label", () => {
    expect(buildContextValues(ACTOR)).toEqual([
      "user-1",
      "ws-1",
      "owner",
      "user",
    ]);
  });

  it("returns the callback result after COMMIT", async () => {
    const client = createFakeClient();

    const result = await withTransaction(
      createFakePool(client),
      ACTOR,
      async () => ({ id: "row-1" }),
    );

    expect(result).toEqual({ id: "row-1" });
    expect(client.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("hands the pooled client to the callback", async () => {
    const client = createFakeClient();
    let received: TransactionConnection | null = null;

    await withTransaction(createFakePool(client), ACTOR, async (tx) => {
      received = tx;
      return undefined;
    });

    expect(received).toBe(client);
  });
});

describe("withTransaction: explicit privileged mode", () => {
  it("labels the transaction privileged and keeps all three actor settings", async () => {
    const client = createFakeClient();

    await withTransaction(
      createFakePool(client),
      ACTOR,
      async () => undefined,
      { mode: "privileged" },
    );

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", "user-1"],
      ["app.workspace_id", "ws-1"],
      ["app.role", "owner"],
      ["app.execution_mode", "privileged"],
    ]);
  });

  it("keeps the actor settings verbatim in the context tuple", () => {
    expect(buildContextValues(ACTOR, "privileged")).toEqual([
      "user-1",
      "ws-1",
      "owner",
      "privileged",
    ]);
  });

  it("keeps a system privileged transaction with a null actor empty", async () => {
    const client = createFakeClient();

    await withTransaction(
      createFakePool(client),
      null,
      async () => undefined,
      { mode: "privileged" },
    );

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", ""],
      ["app.workspace_id", ""],
      ["app.role", ""],
      ["app.execution_mode", "privileged"],
    ]);
  });

  it("is reachable through the dedicated withPrivilegedTransaction entry", async () => {
    const client = createFakeClient();

    await withPrivilegedTransaction(
      createFakePool(client),
      null,
      async () => "done",
    );

    expect(configCalls(client).at(-1)?.params).toEqual([
      "app.execution_mode",
      "privileged",
    ]);
  });

  it("carries the acting administrator through withPrivilegedTransaction", async () => {
    const client = createFakeClient();

    await withPrivilegedTransaction(
      createFakePool(client),
      ACTOR,
      async () => "done",
    );

    expect(configCalls(client).map((entry) => entry.params)).toEqual([
      ["app.user_id", "user-1"],
      ["app.workspace_id", "ws-1"],
      ["app.role", "owner"],
      ["app.execution_mode", "privileged"],
    ]);
  });

  it("does not treat an empty userId in user mode as privileged", async () => {
    const client = createFakeClient();

    await withTransaction(
      createFakePool(client),
      { userId: "" },
      async () => undefined,
    );

    expect(configCalls(client).at(-1)?.params).toEqual([
      "app.execution_mode",
      "user",
    ]);
  });
});

describe("withTransaction: failure handling", () => {
  it("rolls back and rethrows the original error when the callback fails", async () => {
    const failure = new Error("callback exploded");
    const client = createFakeClient((sql) => {
      if (sql === TRANSACTION_STATEMENTS.commit) throw new Error("never");
    });

    await expect(
      withTransaction(createFakePool(client), ACTOR, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(client.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("does not issue COMMIT when the callback fails", async () => {
    const client = createFakeClient();

    await expect(
      withTransaction(createFakePool(client), ACTOR, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(
      client.queries.some(
        (entry) => entry.sql === TRANSACTION_STATEMENTS.commit,
      ),
    ).toBe(false);
  });

  it("rethrows the COMMIT failure after rolling back", async () => {
    const commitFailure = new Error("commit failed");
    const client = createFakeClient((sql) => {
      if (sql === TRANSACTION_STATEMENTS.commit) throw commitFailure;
    });

    await expect(
      withTransaction(createFakePool(client), ACTOR, async () => undefined),
    ).rejects.toBe(commitFailure);

    expect(client.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(client.releases).toEqual([undefined]);
  });

  it("keeps the original error when ROLLBACK also fails and destroys the client", async () => {
    const failure = new Error("callback exploded");
    const rollbackFailure = new Error("rollback failed");
    const client = createFakeClient((sql) => {
      if (sql === TRANSACTION_STATEMENTS.rollback) throw rollbackFailure;
    });

    let thrown: unknown = null;
    try {
      await withTransaction(createFakePool(client), ACTOR, async () => {
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(failure);
    expect((thrown as { rollbackError?: unknown }).rollbackError).toBe(
      rollbackFailure,
    );
    expect(client.releases).toEqual([true]);
  });

  it("destroys the client when BEGIN fails and issues no ROLLBACK", async () => {
    const beginFailure = new Error("begin failed");
    const client = createFakeClient((sql) => {
      if (sql === TRANSACTION_STATEMENTS.begin) throw beginFailure;
    });

    await expect(
      withTransaction(createFakePool(client), ACTOR, async () => undefined),
    ).rejects.toBe(beginFailure);

    expect(client.queries.map((entry) => entry.sql)).toEqual([
      TRANSACTION_STATEMENTS.begin,
    ]);
    expect(client.releases).toEqual([true]);
  });

  it("releases the client exactly once without a destroy flag on success", async () => {
    const client = createFakeClient();

    await withTransaction(createFakePool(client), ACTOR, async () => undefined);

    expect(client.releases).toEqual([undefined]);
  });

  it("propagates a connect failure without attempting to release a client", async () => {
    const connectFailure = new Error("connect failed");

    await expect(
      withTransaction(
        createFailingConnectPool(connectFailure),
        ACTOR,
        async () => undefined,
      ),
    ).rejects.toBe(connectFailure);
  });

  it("never concatenates actor values into SQL", async () => {
    const client = createFakeClient();
    const actor = {
      userId: "user-1' OR 1=1 --",
      workspaceId: "ws-1",
      role: "owner",
    };

    await withTransaction(createFakePool(client), actor, async () => undefined);

    const statements = new Set<string>(Object.values(TRANSACTION_STATEMENTS));
    for (const entry of client.queries) {
      expect(statements.has(entry.sql)).toBe(true);
      expect(entry.sql).not.toContain("user-1");
    }
    expect(configCalls(client)[0]?.params).toEqual([
      "app.user_id",
      "user-1' OR 1=1 --",
    ]);
  });
});

describe("pg pool foundation", () => {
  it("fails loud when DATABASE_URL is missing or blank", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "   " })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("reads DATABASE_URL through the server env loader", () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL: "  postgres://u:p@127.0.0.1:5432/db " }),
    ).toBe("postgres://u:p@127.0.0.1:5432/db");
  });

  it("creates a pool object without opening a connection", async () => {
    const pool = createDatabasePool("postgres://u:p@127.0.0.1:5432/db");

    try {
      expect(pool.options.connectionString).toBe(
        "postgres://u:p@127.0.0.1:5432/db",
      );
      expect(pool.totalCount).toBe(0);
      expect(pool.idleCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("creates the shared pool lazily and resets it on close", async () => {
    expect(hasDatabasePool()).toBe(false);
    expect(() => getDatabasePool({})).toThrow(/DATABASE_URL/);
    expect(hasDatabasePool()).toBe(false);

    const pool = getDatabasePool({
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
    });

    expect(hasDatabasePool()).toBe(true);
    expect(pool.totalCount).toBe(0);

    await closeDatabasePool();

    expect(hasDatabasePool()).toBe(false);
    await closeDatabasePool();
  });

  it("bridges the shared pool to the transaction entry point", async () => {
    await closeDatabasePool();

    expect(() => getTransactionPool({})).toThrow(/DATABASE_URL/);

    const transactionPool = getTransactionPool({
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
    });

    expect(typeof transactionPool.connect).toBe("function");

    await closeDatabasePool();
  });
});
