import pg from "pg";

import type { ServerEnv } from "../config/env.js";
import { createNativeQueueClient } from "./native-queue-client.js";
import { createPgmqClient, type PgmqClient } from "./pgmq-client.js";

/**
 * 43L: the one place that decides which queue client the API process and the
 * worker build.
 *
 * `pgmq` is the default and what every unset install keeps: the expression here
 * is the one app.ts used to inline - with `SUPABASE_DB_URL` set it builds the
 * extension-backed client, without it the job service is left off exactly as
 * before. `native` builds 43K's plain-table client against `DATABASE_URL` (the
 * new database) with the same pool settings and the same "log it, do not crash"
 * error listener the pgmq client has, because a transient blip must not take a
 * worker down.
 */
const NATIVE_POOL_MAX = 5;

export function createQueueClient(env: ServerEnv): PgmqClient | undefined {
  if (env.queueProvider === "native") {
    if (!env.databaseUrl) {
      return undefined;
    }

    const pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: NATIVE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    });

    // Same policy as the pgmq client: a pool error is logged, never fatal.
    pool.on("error", (err) => {
      console.error(
        "[queue-client-factory] Pool error (non-fatal):",
        err.message,
      );
    });

    return createNativeQueueClient({
      query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
      end: () => pool.end(),
    });
  }

  return env.supabaseDbUrl ? createPgmqClient(env.supabaseDbUrl) : undefined;
}

/**
 * 43L: the message a worker prints when it cannot reach the queue its selected
 * provider needs. The pgmq wording is the worker's own historical line (E-028);
 * the native wording names the variable the new database uses.
 */
export function queueConnectionMissingMessage(env: ServerEnv): string | null {
  if (env.queueProvider === "native") {
    return env.databaseUrl
      ? null
      : "DATABASE_URL is required for the native queue.";
  }

  return env.supabaseDbUrl
    ? null
    : "SUPABASE_DB_URL is required for worker process.";
}
