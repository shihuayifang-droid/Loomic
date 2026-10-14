import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import type {
  TransactionConnection,
  TransactionPool,
} from "../../db/transaction.js";

/** `src/test-support/db` -> repo root is five levels up. No drive letter hardcoded. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
const STUBS_FILE = join(HERE, "supabase-stubs.sql");

/**
 * Supabase ships these extensions; PGlite cannot load them.
 * This is the ONLY edit applied to migration SQL — everything else is verbatim.
 */
const CREATE_EXTENSION = /^\s*create\s+extension[^;]*;/gim;

/**
 * Fresh in-memory database -> supabase-stubs.sql -> supabase/migrations/*.sql by
 * ascending filename. Throws on the first failing migration, naming the file.
 */
export async function createMigratedDb(): Promise<{ db: PGlite; applied: string[] }> {
  const db = new PGlite();

  await db.exec(readFileSync(STUBS_FILE, "utf8"));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8").replace(
      CREATE_EXTENSION,
      "",
    );
    try {
      await db.exec(sql);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${name} failed: ${detail}`);
    }
    applied.push(name);
  }

  return { db, applied };
}

/** Insert auth.users as the superuser; the signup trigger creates the personal workspace. */
export async function createUser(db: PGlite, id: string, email: string): Promise<void> {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
}

/**
 * Run `fn` inside one transaction as a given identity.
 *
 * userId === null -> `set local role anon`; otherwise `set local role authenticated`
 * plus a transaction-local `request.jwt.claim.sub`. Both revert when the transaction
 * ends, so identity never leaks into the next case.
 */
export async function asUser<T>(
  db: PGlite,
  userId: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (userId === null) {
      await tx.exec("set local role anon");
    } else {
      await tx.exec("set local role authenticated");
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    }
    return fn(tx);
  });
}

/**
 * Test-only adapter: expose one PGlite instance as the `TransactionPool` of
 * `src/db/transaction.ts`, so the real repository can run its real SQL against
 * a real PostgreSQL parser without a server, a socket or `DATABASE_URL`.
 *
 * Two properties matter and are easy to break:
 *
 * - `withTransaction` issues `BEGIN` / `COMMIT` / `ROLLBACK` itself, so this
 *   adapter must NOT wrap the callback in `db.transaction()`: that would open a
 *   second, nested transaction and the transaction-local settings written with
 *   `set_config(..., true)` would stop meaning what they mean in production.
 *   PGlite keeps one session, so plain `BEGIN` ... `COMMIT` statements carry
 *   across separate `query()` calls.
 * - `release()` is deliberately a no-op. Closing the database here would tear it
 *   down for every later case in the same file; the lifetime belongs to the test
 *   file, which calls `db.close()` once in `afterAll`.
 *
 * Never import this from production code: it exists so tests can drive the
 * `TransactionPool` contract, not so the application can run on PGlite.
 */
export function createPGliteTransactionPool(db: PGlite): TransactionPool {
  return {
    async connect(): Promise<TransactionConnection> {
      return {
        async query(
          sql: string,
          params?: readonly unknown[],
        ): Promise<{ rows: unknown[] }> {
          const result = await db.query(sql, params ? [...params] : undefined);
          return { rows: result.rows };
        },
        release() {
          // Intentionally empty: see the note above.
        },
      };
    },
  };
}
