/**
 * OP-11 / workorder 45CB: the job retention sweep, as a command.
 *
 * Usage (from `apps/server`):
 *   pnpm run jobs:retention             # dry run: counts the candidates, writes nothing
 *   pnpm run jobs:retention -- --apply  # deletes them
 *
 * WHY A CLI AND A TIMER
 * The worker runs the same sweep every 24 hours (`./features/jobs/
 * job-retention-schedule.ts`), but a scheduled deletion is the one kind of write
 * an operator wants to be able to look at before it happens and to repeat by
 * hand afterwards — after a backfill, before a maintenance window, or while
 * deciding whether `HAHART_JOB_RETENTION_APPLY` should be turned on at all. The
 * CLI is that handle, and it goes through exactly the same
 * `pruneFinishedJobs` the worker does, so there is no second implementation of
 * the rule.
 *
 * DRY RUN BY DEFAULT
 * Without `--apply` the run issues a `count(*)` and nothing else. `--apply` is
 * an explicit act, the same way `hahart-project-asset-backfill.ts` and
 * `hahart-video-pointer-backfill.ts` treat theirs.
 *
 * OUTPUT
 * One human-readable summary line and the `JobRetentionResult` as JSON, both on
 * stdout. No connection string, no key, no row content — the result is counts.
 *
 * EXIT CODES
 *   0 — the sweep ran (dry or applied); the numbers are on stdout
 *   2 — the database could not be read or written
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";

import { createDatabasePool, resolveDatabaseUrl } from "../db/pool.js";
import {
  pruneFinishedJobs,
  type JobRetentionResult,
} from "../features/jobs/job-retention.js";

/**
 * The sweep, with its pool created from `DATABASE_URL`. Returns the process exit
 * code instead of calling `process.exit`, so stdout is flushed before the CLI
 * ends. Split out from the entry point so it can be read (and reused) without
 * importing side effects.
 */
export async function runJobRetentionCli(
  argv: readonly string[],
): Promise<number> {
  const apply = argv.includes("--apply");
  let pool: Pool | null = null;

  try {
    pool = createDatabasePool(resolveDatabaseUrl());
    const result: JobRetentionResult = await pruneFinishedJobs(pool, {
      dryRun: !apply,
    });

    process.stdout.write(
      `job retention: dryRun=${result.dryRun} retentionDays=${result.retentionDays} ` +
        `cutoff=${result.cutoff} candidates=${result.candidates} ` +
        `deleted=${result.deleted} batches=${result.batches}\n`,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    // The message is reported, never the connection string: `resolveDatabaseUrl`
    // and `pg` do not put the password in `error.message`.
    process.stderr.write(
      `job retention failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

/** True when this module is the file `node` was pointed at. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  // `process.exitCode` rather than `process.exit()`: the pool is already closed
  // and the writes above must reach the pipe.
  void runJobRetentionCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
