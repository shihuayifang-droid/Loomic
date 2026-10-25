/**
 * The timer that drives the job retention sweep (OP-11 / workorder 45CB).
 *
 * It is shaped like `stuck-job-reaper-schedule.ts` (36J) on purpose — same
 * injected clock, same overlap guard, same "a failed pass never kills the
 * schedule" contract — with ONE deliberate difference, stated at the top because
 * it is the whole point of this file:
 *
 *   IT DOES NOT RUN AT START. The reaper runs immediately because a restart
 *   inherits the `running` rows of its previous life and waiting five minutes
 *   keeps their credits stuck. A retention sweep inherits nothing: the rows it
 *   looks at are 180 days old. Running it at deploy time would only put a
 *   `count(*)` (and, with `apply` on, a `delete`) on the database at the exact
 *   moment every worker is starting up, so the first pass waits a full interval.
 *
 * The other two properties are inherited unchanged:
 *
 *   2. IT DOES NOT OVERLAP ITSELF. A tick that lands while the previous pass is
 *      still running is DROPPED, not queued: deleting rows twice over is not
 *      faster, and the next tick a day later takes whatever is left.
 *   3. IT NEVER DIES. A failing pass — a database that timed out, a pool that
 *      was not ready — is logged and the schedule keeps its cadence. A sweep
 *      that silently stopped would be indistinguishable from a clean table.
 *
 * WHETHER IT DELETES IS AN ENVIRONMENT DECISION
 * `jobRetentionApplyEnabled()` is the single place that reads
 * `HAHART_JOB_RETENTION_APPLY`. Only the exact value `"true"` turns the sweep
 * into a real delete; anything else — unset, `"1"`, `"TRUE"`, a typo — leaves it
 * a dry run. That is the approved default (count only) expressed as code that
 * fails safe: a missing variable can never turn a delete on.
 *
 * Nothing here touches the database or the clock directly — `prune` carries all
 * of that, and the scheduling primitives are injected so a test can drive time.
 */

import { createAlertSink, type Alert } from "../notifications/alert-sink.js";

/** 24 hours: the sweep is a housekeeping chore, not an urgent one. */
export const JOB_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The environment variable that turns a counting sweep into a deleting one. */
export const JOB_RETENTION_APPLY_ENV = "HAHART_JOB_RETENTION_APPLY";

/**
 * True only when `HAHART_JOB_RETENTION_APPLY` is exactly `"true"`. Everything
 * else is a dry run, including unset — the approved default.
 */
export function jobRetentionApplyEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[JOB_RETENTION_APPLY_ENV] === "true";
}

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

export type StartJobRetentionScheduleInput = {
  /** One sweep. Rejecting or throwing is handled, not propagated. */
  prune: () => Promise<unknown>;
  /** Overridable period; defaults to `JOB_RETENTION_INTERVAL_MS`. */
  intervalMs?: number;
  /** Where a failed pass is reported. Defaults to silence. */
  log?: (m: string) => void;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

/**
 * Run `prune` every `intervalMs` — the first time only after one full interval —
 * skipping a tick while a pass is in flight; returns a stop() for shutdown.
 * Never throws.
 */
export function startJobRetentionSchedule(
  input: StartJobRetentionScheduleInput,
): { stop: () => void } {
  const intervalMs = input.intervalMs ?? JOB_RETENTION_INTERVAL_MS;
  const log = input.log ?? (() => {});
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  // `inFlight` is the whole overlap guard: set before the pass is awaited, so a
  // tick that arrives in the same microtask window still sees `true`.
  let inFlight = false;
  // `stopped` also covers a `stop()` that lands while a pass is still awaiting:
  // the pass itself is not cancelled (it may be mid-delete), but no further tick
  // is accepted.
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      await input.prune();
    } catch (error) {
      // A failed pass is reported, never rethrown: the schedule outlives it.
      try {
        log(
          `Job retention pass failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A throwing logger must not turn "a pass failed" into "the schedule
        // died", which is the one thing this module exists to prevent.
      }

      // OP-11 (45CH): a failed sweep is exactly the case an operator has to
      // hear about — nobody watches a worker's stdout. The happy path stays
      // silent; only this branch raises an alert.
      raiseAlert({
        title: "任务保留期清理失败",
        severity: "error",
        detail: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
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
  // CLI, a worker that is shutting down) cannot exit. The worker has its own
  // poll loop keeping it alive; this timer only needs to fire while that runs.
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
