/**
 * Canonical test fixtures: a bare PGlite instance migrated with
 * `apps/server/db/canonical/*.sql` only.
 *
 * This is NOT `createMigratedDb()` from `pglite-db.ts`: that one replays the
 * retired `supabase/migrations` baseline plus the Supabase stubs. The canonical
 * schema has to stand on its own on an empty database, so this fixture applies no
 * stubs and no Supabase emulation.
 */

import { PGlite } from "@electric-sql/pglite";

import { runCanonicalMigrations } from "../../db/canonical-migrations.js";

/**
 * Fresh in-memory database -> canonical migrations by ascending file name.
 * `applied` lists the file names this call executed.
 */
export async function createCanonicalDb(): Promise<{
  db: PGlite;
  applied: string[];
}> {
  const db = new PGlite();

  const result = await runCanonicalMigrations({
    async query(sql: string, params?: readonly unknown[]): Promise<{ rows: any[] }> {
      const result = await db.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as any[] };
    },
    async exec(sql: string): Promise<unknown> {
      return db.exec(sql);
    },
  });

  return { db, applied: result.applied };
}

/**
 * Insert one active user into `hahart_auth.users`.
 *
 * Later tickets extend this fixture (e.g. a `bootstrap_viewer` call); for now it
 * only inserts the row so tests can start from a known identity.
 */
export async function createCanonicalUser(
  db: PGlite,
  id: string,
  email: string,
): Promise<void> {
  await db.query(
    "insert into hahart_auth.users (id, email, status) values ($1, $2, 'active')",
    [id, email],
  );
  await db.query("select public.bootstrap_viewer($1, $2, '{}'::jsonb)", [id, email]);
}
