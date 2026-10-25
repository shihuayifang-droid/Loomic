/**
 * The timer that drives the daily credits reconciliation (OP-11 / workorder
 * 45CC).
 *
 * Shaped like `features/jobs/job-retention-schedule.ts` (45CB) on purpose — same
 * injected clock, same injected `setInterval` / `clearInterval`, same overlap
 * guard, same "a failed pass never kills the schedule" contract, and the same
 * single deliberate difference from the stuck-job reaper:
 *
 *   IT DOES NOT RUN AT START. A reconciliation inherits nothing: the reaper runs
 *   immediately because a restart adopts its previous life's `running` rows, but
 *   a reconciliation only counts rows that are already at rest. Running it at
 *   deploy would put four `count(*)`s on the database at the exact moment every
 *   worker is starting, and would produce a report generated from data no one
 *   has touched yet. The first pass therefore waits a full interval.
 *
 * This module only schedules; `reconcileCredits` owns the queries and `log` /
 * `warn` / `info` own the reporting.
 *
 * WARN IS FOR ALARMS ONLY (workorder 45CD). `report.ok` is derived from the
 * `"alarm"` findings alone, so only those are listed in the `warn` line;
 * `"info"` findings (C, which compares a runtime counter against a ledger sum —
 * see `daily-reconcile.ts`) get one `info` line instead. Mixing them back
 * together would restore exactly the daily false alarm this ticket removed.
 */

import type { ReconcileReport } from "./daily-reconcile.js";

/** 24 hours: a reconciliation is a daily patrol, not an urgent alarm. */
export const DAILY_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StartDailyReconcileScheduleInput = {
  /** One reconciliation pass. Rejecting or throwing is handled, not propagated. */
  reconcile: () => Promise<ReconcileReport>;
  /** Overridable period; defaults to `DAILY_RECONCILE_INTERVAL_MS`. */
  intervalMs?: number;
  /** Where a clean pass is reported. Defaults to `console.log`. */
  log?: (m: string) => void;
  /** Where a dirty pass is reported. Defaults to `console.warn`. */
  warn?: (m: string) => void;
  /** Where informational findings are reported. Defaults to `console.info`. */
  info?: (m: string) => void;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

/**
 * Run `reconcile` every `intervalMs` — the first time only after one full
 * interval — skipping a tick while a pass is in flight; returns a stop() for
 * shutdown. Never throws.
 */
export function startDailyReconcileSchedule(
  input: StartDailyReconcileScheduleInput,
): { stop: () => void } {
  const intervalMs = input.intervalMs ?? DAILY_RECONCILE_INTERVAL_MS;
  const log = input.log ?? ((m: string) => console.log(m));
  const warn = input.warn ?? ((m: string) => console.warn(m));
  const info = input.info ?? ((m: string) => console.info(m));
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  // `inFlight` is the whole overlap guard: set before the pass is awaited, so a
  // tick that arrives in the same microtask window still sees `true`.
  let inFlight = false;
  // `stopped` also covers a `stop()` that lands while a pass is still awaiting:
  // the pass itself is not cancelled (it is read-only anyway), but no further
  // tick is accepted.
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      const report = await input.reconcile();
      // A drift is a FINDING, not a failure: the schedule stays on its cadence
      // either way, and the difference is only in how loudly it is reported.
      if (report.ok) {
        log(`[credits-reconcile] clean at ${report.ranAt}`);
      } else {
        // Alarms only: `ok` ignores informational findings, so a warn line that
        // included them would contradict the `ok` printed right next to it.
        const counts = report.findings
          .filter((finding) => finding.severity === "alarm")
          .map((finding) => `${finding.check}=${finding.count}`)
          .join(" ");
        warn(`[credits-reconcile] drift at ${report.ranAt}: ${counts}`);
      }

      // Informational findings go out on one line and never touch `ok`. Only the
      // ones that actually saw something are listed, otherwise a healthy day
      // prints the same zeroes forever and the line becomes noise.
      const infos = report.findings
        .filter((finding) => finding.severity === "info" && finding.count > 0)
        .map((finding) => `${finding.check}=${finding.count}`)
        .join(" ");
      if (infos.length > 0) {
        info(`[credits-reconcile] info at ${report.ranAt}: ${infos}`);
      }
    } catch (error) {
      // A failed pass — a database that timed out, a pool that was not ready —
      // is reported, never rethrown: the schedule outlives it.
      try {
        warn(
          `[credits-reconcile] pass failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A throwing reporter must not turn "a pass failed" into "the schedule
        // died", which is the one thing this module exists to prevent.
      }
    } finally {
      inFlight = false;
    }
  };

  // Property 1: NO immediate pass. This is the one intentional difference from
  // the reaper — see the module comment.

  const handle = schedule(() => {
    void runOnce();
  }, intervalMs);

  // A day-long timer must never be the reason a short-lived process (a test, a
  // CLI, a worker that is shutting down) cannot exit.
  if (
    typeof handle === "object" &&
    handle !== null &&
    typeof (handle as { unref?: unknown }).unref === "function"
  ) {
    (handle as { unref: () => void }).unref();
  }

  return {
    stop() {
      stopped = true;
      cancel(handle);
    },
  };
}
