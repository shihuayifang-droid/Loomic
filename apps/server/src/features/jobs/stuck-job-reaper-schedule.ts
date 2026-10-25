/**
 * The timer that drives the stuck-job reaper (workorder 36J, GN-31 step 3).
 *
 * `reapStuckJobs` (36I) is one pass. Something has to run it again and again, in
 * a process whose only other rhythm is the queue poll loop, and that something
 * has three properties worth stating out loud:
 *
 *   1. IT RUNS AT START. A worker that restarts inherits the `running` rows left
 *      behind by its previous life. Waiting one full interval before the first
 *      pass would leave those rows, and their credits, stuck for another five
 *      minutes after every deploy.
 *   2. IT DOES NOT OVERLAP ITSELF. A pass reads rows, writes status and refunds;
 *      two passes over the same population are not faster, they are just two
 *      writers racing for one refund (the guarded write in 36I keeps the money
 *      right, but there is no reason to generate the race). A tick that lands
 *      while the previous pass is still in flight is therefore DROPPED, not
 *      queued: the next tick, five minutes later, takes the work that is left.
 *   3. IT NEVER DIES. One failing pass — a database that timed out, a pool that
 *      was not ready — must not end the schedule, or the worker would silently
 *      stop reclaiming until someone redeploys it. The failure is logged and the
 *      next tick runs as if nothing happened.
 *
 * The scheduling primitives are injected so a test can drive the clock instead
 * of waiting for it; the defaults are the process-wide `setInterval` /
 * `clearInterval`. Nothing here touches the database, the queue or the clock
 * directly — `reap` carries all of that.
 */

import { createAlertSink, type Alert } from "../notifications/alert-sink.js";

/** GN-31: how often the worker reclaims stuck jobs. */
export const STUCK_JOB_REAP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * OP-11 (45CH): hand one alert to the sink and forget it.
 *
 * Built from `process.env` at the moment of failure rather than injected, so
 * the constructor of this schedule keeps the shape it already had. `notify`
 * never rejects (see `alert-sink.ts`), but the guard below is this file's own
 * promise: a broken alert channel must never be the reason a pass dies.
 */
function raiseAlert(alert: Alert): void {
  try {
    void createAlertSink().notify(alert).catch(() => undefined);
  } catch {
    // Reporting is what failed; there is nowhere left to report it to.
  }
}

export type StartStuckJobReaperInput = {
  /** One reaping pass. Rejecting or throwing is handled, not propagated. */
  reap: () => Promise<unknown>;
  /** Overridable period; defaults to `STUCK_JOB_REAP_INTERVAL_MS`. */
  intervalMs?: number;
  /** Where a failed pass is reported. Defaults to silence. */
  log?: (m: string) => void;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

/**
 * Run `reap` now and then every `intervalMs`; overlapping runs are skipped;
 * returns a stop() for shutdown. Never throws.
 */
export function startStuckJobReaper(
  input: StartStuckJobReaperInput,
): { stop: () => void } {
  const intervalMs = input.intervalMs ?? STUCK_JOB_REAP_INTERVAL_MS;
  const log = input.log ?? (() => {});
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  // `inFlight` is the whole overlap guard: set before the pass is awaited, so a
  // tick that arrives in the same microtask window still sees `true`.
  let inFlight = false;
  // `stopped` also covers a `stop()` that lands while the FIRST pass is still
  // awaiting — the pass itself is not cancelled (it may be mid-refund), but no
  // further tick is accepted.
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      await input.reap();
    } catch (error) {
      // A failed pass is reported, never rethrown: the schedule outlives it.
      try {
        log(
          `Stuck job reaper pass failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A throwing logger must not turn "a pass failed" into "the schedule
        // died", which is the one thing this module exists to prevent.
      }

      // OP-11 (45CH): only the failure branch raises an alert — a restart that
      // reclaims nothing is silent, a restart that cannot reclaim is not.
      raiseAlert({
        title: "卡死任务回收失败",
        severity: "error",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      inFlight = false;
    }
  };

  // Property 1: the first pass runs immediately, before the first interval.
  void runOnce();

  const handle = schedule(() => {
    void runOnce();
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      cancel(handle);
    },
  };
}
