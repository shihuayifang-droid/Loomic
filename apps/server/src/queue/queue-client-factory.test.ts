import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../config/env.js";
import type { PgmqClient } from "./pgmq-client.js";

/**
 * 43L: the queue switch. What matters is WHICH client gets built and WHICH
 * connection string it is built from, so `pg` and the pgmq factory are stand-ins
 * that record their arguments and the native client (43K) is the real one, driven
 * by the stand-in pool. Nothing here reaches a database.
 */
const mocks = vi.hoisted(() => {
  const pool = {
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ msg_id: 7 }] as unknown[],
    })),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };

  return {
    pool,
    poolCtor: vi.fn((_config: unknown) => pool),
    createPgmqClient: vi.fn((_databaseUrl: string) => ({ kind: "pgmq" })),
  };
});

vi.mock("pg", () => ({ default: { Pool: mocks.poolCtor } }) as never);
vi.mock("./pgmq-client.js", () => ({ createPgmqClient: mocks.createPgmqClient }) as never);

import {
  createQueueClient,
  queueConnectionMissingMessage,
} from "./queue-client-factory.js";

/** The fields every `ServerEnv` carries; the queue wiring reads only two more. */
const BASE_ENV: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "claude-sonnet-5",
  port: 3001,
  version: "0.0.0-test",
  webOrigin: "http://localhost:3000",
};

/** `PgmqClient` has exactly these seven methods; the native client must supply all. */
const CLIENT_METHODS = [
  "archive",
  "deleteMsg",
  "read",
  "readWithPoll",
  "send",
  "setVt",
  "shutdown",
];

describe("43L createQueueClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("43L: the default provider builds the pgmq client from SUPABASE_DB_URL", () => {
    const client = createQueueClient({
      ...BASE_ENV,
      supabaseDbUrl: "postgres://pgmq-host/hahart",
    });

    expect(mocks.createPgmqClient).toHaveBeenCalledTimes(1);
    expect(mocks.createPgmqClient).toHaveBeenCalledWith(
      "postgres://pgmq-host/hahart",
    );
    expect(client).toBe(mocks.createPgmqClient.mock.results[0]?.value);
    expect(mocks.poolCtor).not.toHaveBeenCalled();
  });

  it("43L: the default provider without SUPABASE_DB_URL builds nothing", () => {
    const client = createQueueClient({ ...BASE_ENV });

    expect(client).toBeUndefined();
    expect(mocks.createPgmqClient).not.toHaveBeenCalled();
    expect(mocks.poolCtor).not.toHaveBeenCalled();
  });

  it("43L: an explicit pgmq provider matches the default", () => {
    createQueueClient({
      ...BASE_ENV,
      queueProvider: "pgmq",
      supabaseDbUrl: "postgres://pgmq-host/hahart",
      databaseUrl: "postgres://native-host/hahart",
    });

    expect(mocks.createPgmqClient).toHaveBeenCalledWith(
      "postgres://pgmq-host/hahart",
    );
    expect(mocks.poolCtor).not.toHaveBeenCalled();
  });

  it("43L: native builds one pool on DATABASE_URL and the native client", () => {
    const client = createQueueClient({
      ...BASE_ENV,
      queueProvider: "native",
      databaseUrl: "postgres://native-host/hahart",
      supabaseDbUrl: "postgres://pgmq-host/hahart",
    }) as PgmqClient;

    expect(mocks.createPgmqClient).not.toHaveBeenCalled();
    expect(mocks.poolCtor).toHaveBeenCalledTimes(1);
    expect(mocks.poolCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgres://native-host/hahart",
        max: 5,
      }),
    );

    expect(client).toBeDefined();
    for (const method of CLIENT_METHODS) {
      expect(typeof client[method as keyof PgmqClient]).toBe("function");
    }
    expect(Object.keys(client).sort()).toEqual(CLIENT_METHODS);
  });

  it("43L: native without DATABASE_URL builds nothing", () => {
    const client = createQueueClient({
      ...BASE_ENV,
      queueProvider: "native",
      supabaseDbUrl: "postgres://pgmq-host/hahart",
    });

    expect(client).toBeUndefined();
    expect(mocks.poolCtor).not.toHaveBeenCalled();
    expect(mocks.createPgmqClient).not.toHaveBeenCalled();
  });

  it("43L: the native client queries and ends through its pool", async () => {
    const client = createQueueClient({
      ...BASE_ENV,
      queueProvider: "native",
      databaseUrl: "postgres://native-host/hahart",
    }) as PgmqClient;

    await expect(client.send("jobs", { jobId: "job-1" })).resolves.toBe(7);
    expect(mocks.pool.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into hahart_queue.messages"),
      ["jobs", '{"jobId":"job-1"}', 0],
    );

    await client.shutdown();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });
});

describe("43L queueConnectionMissingMessage", () => {
  it("43L: pgmq without SUPABASE_DB_URL keeps the worker's own wording", () => {
    expect(queueConnectionMissingMessage({ ...BASE_ENV })).toBe(
      "SUPABASE_DB_URL is required for worker process.",
    );
  });

  it("43L: pgmq with SUPABASE_DB_URL has nothing missing", () => {
    expect(
      queueConnectionMissingMessage({
        ...BASE_ENV,
        supabaseDbUrl: "postgres://pgmq-host/hahart",
      }),
    ).toBeNull();
  });

  it("43L: native without DATABASE_URL names DATABASE_URL", () => {
    expect(
      queueConnectionMissingMessage({ ...BASE_ENV, queueProvider: "native" }),
    ).toBe("DATABASE_URL is required for the native queue.");
  });

  it("43L: native with DATABASE_URL has nothing missing", () => {
    expect(
      queueConnectionMissingMessage({
        ...BASE_ENV,
        queueProvider: "native",
        databaseUrl: "postgres://native-host/hahart",
      }),
    ).toBeNull();
  });
});
