/**
 * Canonical migration CLI (ADR-0001, OP-04): initialise a fresh database.
 *
 * Usage:
 *   node --env-file-if-exists=../../.env.local --import tsx \
 *     src/cli/hahart-db-migrate.ts
 *
 * Reads `DATABASE_URL`, applies `apps/server/db/canonical/*.sql` in filename
 * order, prints `applied=<n> skipped=<m>` plus the file names, and exits 0.
 * A missing `DATABASE_URL` or any migration failure exits 1. Environment values
 * are never printed.
 */
import { pathToFileURL } from "node:url";

import { runCanonicalMigrations } from "../db/canonical-migrations.js";
import { createDatabasePool } from "../db/pool.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const databaseUrl = env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL is required\n");
    return 1;
  }

  const pool = createDatabasePool(databaseUrl);

  try {
    const client = await pool.connect();

    try {
      const result = await runCanonicalMigrations({
        async query(
          sql: string,
          params?: readonly unknown[],
        ): Promise<{ rows: any[] }> {
          const queryResult = await client.query(
            sql,
            params ? [...params] : undefined,
          );
          return { rows: queryResult.rows as any[] };
        },
        async exec(sql: string): Promise<unknown> {
          return client.query(sql);
        },
      });

      process.stdout.write(
        `applied=${result.applied.length} skipped=${result.skipped.length}\n`,
      );

      for (const name of result.applied) {
        process.stdout.write(`applied ${name}\n`);
      }

      for (const name of result.skipped) {
        process.stdout.write(`skipped ${name}\n`);
      }

      return 0;
    } finally {
      client.release();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`db migrate failed: ${detail}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
