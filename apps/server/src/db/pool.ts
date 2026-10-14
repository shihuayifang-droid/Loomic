import pg, { type Pool } from "pg";

import { loadServerEnv } from "../config/env.js";

import type { TransactionPool } from "./transaction.js";

/**
 * Pure `pg` pool foundation (ADR-0001, migration step 1).
 *
 * Scope rules for this module:
 *
 * - It only creates and closes a `pg.Pool`. It owns no query helpers and no
 *   business logic, so later tickets can build repositories on top of it
 *   without inheriting behaviour from here.
 * - The pool is created lazily on the first `getDatabasePool()` call. Importing
 *   this module never reads a connection string and never opens a socket.
 * - A missing or blank `DATABASE_URL` fails loud at that first call instead of
 *   silently degrading to an undefined connection.
 */

export const DATABASE_URL_ENV_KEY = "DATABASE_URL";

let sharedPool: Pool | null = null;

/**
 * Resolve the canonical connection string through the server env loader, so
 * `DATABASE_URL` has exactly one definition in the codebase.
 */
export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { databaseUrl } = loadServerEnv({}, env);

  if (!databaseUrl) {
    throw new Error(
      `${DATABASE_URL_ENV_KEY} is required to open a PostgreSQL pool ` +
        "(ADR-0001 self-hosted backend). Set it before calling getDatabasePool().",
    );
  }

  return databaseUrl;
}

/**
 * Build a pool object without connecting. `pg.Pool` is lazy by design: no
 * socket is opened until the first `connect()`/`query()`.
 */
export function createDatabasePool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });

  // A pool-level error must not take the process down on a transient blip.
  pool.on("error", (error) => {
    console.error("[db/pool] idle client error (non-fatal):", error.message);
  });

  return pool;
}

/**
 * Lazily create (once) and return the shared pool. Throws when `DATABASE_URL`
 * is absent — the caller decides whether that is fatal.
 */
export function getDatabasePool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (sharedPool) return sharedPool;

  sharedPool = createDatabasePool(resolveDatabaseUrl(env));
  return sharedPool;
}

export function hasDatabasePool(): boolean {
  return sharedPool !== null;
}

/**
 * Close the shared pool if one was created. Safe to call repeatedly; a pooled
 * connection is never opened by this call alone.
 */
export async function closeDatabasePool(): Promise<void> {
  const closing = sharedPool;
  if (!closing) return;

  sharedPool = null;
  await closing.end();
}

/**
 * Bridge for `src/db/transaction.ts`, which stays driver-agnostic so it can be
 * unit tested without a database. This is the only place where the `pg`
 * connection object is re-typed for the transaction entry point.
 */
export function getTransactionPool(
  env: NodeJS.ProcessEnv = process.env,
): TransactionPool {
  const pool = getDatabasePool(env);

  return {
    connect: async () => {
      const client = await pool.connect();
      return client;
    },
  };
}
