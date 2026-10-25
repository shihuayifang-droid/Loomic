/**
 * OP-11 / workorder 45CC: the daily credits reconciliation, as a command.
 *
 * Usage (from `apps/server`):
 *   pnpm run credits:reconcile      # prints the ReconcileReport as JSON
 *
 * WHY A CLI AS WELL AS THE TIMER
 * The worker runs the same `reconcileCredits` every 24 hours
 * (`./features/credits/daily-reconcile-schedule.ts`). The CLI exists so an
 * operator can ask the question on demand — after a backfill, before a
 * maintenance window, or while a `console.warn` from the worker is being
 * investigated — and it goes through exactly the same function, so there is no
 * second implementation of the four checks.
 *
 * NOTHING IS REPAIRED
 * There is no `--apply` and no flag that would take one. The approved behaviour
 * (U-26) is warn-only, and a command that could silently rewrite `pool_used`
 * would be the one way to break that. The output is counts and sample ids.
 *
 * EXIT CODES
 *   0 — the reconciliation ran. `ok` may be false: finding drift is the point of
 *       a patrol, not a failure of it, and a non-zero exit here would turn a
 *       monitoring cron into a "failed" job every time it did its job.
 *   2 — the database could not be read
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";

import { createDatabasePool, resolveDatabaseUrl } from "../db/pool.js";
import {
  reconcileCredits,
  type ReconcileReport,
} from "../features/credits/daily-reconcile.js";

/**
 * The reconciliation, with its pool created from `DATABASE_URL`. Returns the
 * process exit code instead of calling `process.exit`, so stdout is flushed
 * before the CLI ends. Split out from the entry point so it can be read (and
 * reused) without importing side effects.
 */
export async function runCreditsReconcileCli(): Promise<number> {
  let pool: Pool | null = null;

  try {
    pool = createDatabasePool(resolveDatabaseUrl());
    const report: ReconcileReport = await reconcileCredits(pool);

    // The report IS the output: `ranAt`, `ok` and one row per check, with the
    // exact counts and the sample ids. No connection string, no key.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    // The message is reported, never the connection string: `resolveDatabaseUrl`
    // and `pg` do not put the password in `error.message`.
    process.stderr.write(
      `credits reconcile failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
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
  // and the write above must reach the pipe.
  void runCreditsReconcileCli().then((code) => {
    process.exitCode = code;
  });
}
