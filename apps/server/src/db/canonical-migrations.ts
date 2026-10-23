/**
 * Canonical migration runner (ADR-0001, migration plan 24 / OP-04).
 *
 * The retired baseline was `supabase/migrations`. A fresh database is built from
 * `apps/server/db/canonical/NNNN_<name>.sql` only, in filename order, with one
 * transaction per file, recorded in `public.schema_migrations`.
 *
 * Contract:
 *
 * - `schema_migrations` keeps `version` (the four leading digits of the file
 *   name), `name`, `checksum` (sha256 hex of the exact file bytes) and
 *   `applied_at`.
 * - A file whose version is already recorded with the same checksum is skipped.
 * - A file whose version is recorded with a *different* checksum is a hard
 *   error: migration files are append-only, so edited history means the database
 *   and the repository have diverged. Nothing after it is executed.
 * - A new file runs inside `begin` ... `commit`; on failure it is rolled back and
 *   the error names the file.
 *
 * The module owns no connection: the caller passes an `exec` adapter, so the same
 * runner serves `pg` in production and PGlite in tests.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `src/db` -> `apps/server/db/canonical`. Derived from this file, no drive letter. */
const HERE = dirname(fileURLToPath(import.meta.url));

export const CANONICAL_DIR = join(HERE, "..", "..", "db", "canonical");

/** `0001_auth.sql` and siblings only; anything else in the directory is ignored. */
const CANONICAL_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export type MigrationFile = {
  /** The four leading digits of the file name, e.g. `0001`. */
  version: string;
  /** The file name, e.g. `0001_auth.sql`. */
  name: string;
  /** The file contents, verbatim. */
  sql: string;
  /** sha256 hex digest of `sql`. */
  checksum: string;
};

export type MigrationRunResult = {
  applied: string[];
  skipped: string[];
};

/**
 * Minimal database handle the runner needs. Both `{ begin, commit, rollback }`
 * and a single statement go through `exec`; parameterised statements use `query`.
 */
export type MigrationExec = {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: any[] }>;
  exec(sql: string): Promise<unknown>;
};

const CREATE_SCHEMA_MIGRATIONS = `
create table if not exists public.schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

/**
 * Read every canonical migration file from `dir` (default `CANONICAL_DIR`),
 * ascending by file name. Non-matching file names are ignored; two files that
 * share a version are an error, because the ledger is keyed by version.
 */
export function listCanonicalMigrations(
  dir: string = CANONICAL_DIR,
): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => CANONICAL_FILE.test(name))
    .sort();

  const byVersion = new Map<string, string>();
  const files: MigrationFile[] = [];

  for (const name of names) {
    const version = name.slice(0, 4);
    const previous = byVersion.get(version);

    if (previous !== undefined) {
      throw new Error(
        `canonical migration version ${version} is claimed by both ${previous} and ${name}`,
      );
    }

    byVersion.set(version, name);

    const sql = readFileSync(join(dir, name), "utf8");
    files.push({
      version,
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return files;
}

/**
 * Apply `files` (default: the canonical directory) to the database behind `exec`
 * and return the names applied now and the names that were already recorded.
 */
export async function runCanonicalMigrations(
  exec: MigrationExec,
  files: MigrationFile[] = listCanonicalMigrations(),
): Promise<MigrationRunResult> {
  await exec.exec(CREATE_SCHEMA_MIGRATIONS);

  const recorded = new Map<string, { name: string; checksum: string }>();
  const existing = await exec.query(
    "select version, name, checksum from public.schema_migrations",
  );

  for (const row of existing.rows) {
    recorded.set(String(row.version), {
      name: String(row.name),
      checksum: String(row.checksum),
    });
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const previous = recorded.get(file.version);

    if (previous !== undefined) {
      if (previous.checksum !== file.checksum) {
        // Append-only: an edited file means the fresh database would diverge.
        // Nothing after this file runs.
        throw new Error(
          `canonical migration ${file.name} was changed after it was applied`,
        );
      }

      skipped.push(file.name);
      continue;
    }

    await exec.exec("begin");

    try {
      await exec.exec(file.sql);
      await exec.query(
        "insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)",
        [file.version, file.name, file.checksum],
      );
      await exec.exec("commit");
    } catch (error) {
      try {
        await exec.exec("rollback");
      } catch {
        // The connection may already be gone; the original error is what matters.
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`canonical migration ${file.name} failed: ${detail}`);
    }

    applied.push(file.name);
  }

  return { applied, skipped };
}
