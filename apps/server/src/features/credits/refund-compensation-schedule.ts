/**
 * The timer that drives the refund compensator (workorder 39L, BL-41 step 4).
 *
 * `compensateRefunds` (39L) is one pass over the queue. Something has to run it
 * again and again, in the worker process, and — exactly like the stuck-job
 * reaper it sits beside (`features/jobs/stuck-job-reaper-schedule.ts`) — that
 * something has three properties worth stating out loud:
 *
 *   1. IT RUNS AT START. A worker that restarts inherits the `pending` rows its
 *      previous life claimed; waiting one full interval would leave those rows,
 *      and the credits behind them, unpaid for another five minutes after every
 *      deploy. The claim is date-driven, so a pass at start can only pick up
 *      rows that are genuinely due.
 *   2. IT DOES NOT OVERLAP ITSELF. A pass claims rows, pays and closes them; two
 *      passes over the same population are not faster, they are two writers
 *      racing for one payout. A tick that lands while the previous pass is still
 *      in flight is therefore DROPPED, not queued: the next tick, five minutes
 *      later, takes the work that is left.
 *   3. IT NEVER DIES. One failing pass — a database that timed out, a pool that
 *      was not ready — must not end the schedule, or the worker would silently
 *      stop compensating and every failed refund would wait forever. The failure
 *      is logged and the next tick runs as if nothing happened.
 *
 * The scheduling primitives are injected so a test can drive the clock instead
 * of waiting for it; the defaults are the process-wide `setInterval` /
 * `clearInterval`. Nothing here touches the database or the clock directly —
 * `compensate` carries all of that.
 */

/** BL-41: how often the worker retries a failed refund. */
export const REFUND_COMPENSATION_INTERVAL_MS = 5 * 60 * 1000;

export type StartRefundCompensatorInput = {
  /** One compensation pass. Rejecting or throwing is handled, not propagated. */
  compensate: () => Promise<unknown>;
  /** Overridable period; defaults to `REFUND_COMPENSATION_INTERVAL_MS`. */
  intervalMs?: number;
  /** Where a failed pass is reported. Defaults to silence. */
  log?: (m: string) => void;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

/**
 * Run `compensate` now and then every `intervalMs`; overlapping runs are
 * skipped; returns a stop() for shutdown. Never throws.
 */
export function startRefundCompensator(
  input: StartRefundCompensatorInput,
): { stop: () => void } {
  const intervalMs = input.intervalMs ?? REFUND_COMPENSATION_INTERVAL_MS;
  const log = input.log ?? (() => {});
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  // `inFlight` is the whole overlap guard: set before the pass is awaited, so a
  // tick that arrives in the same microtask window still sees `true`.
  let inFlight = false;
  // `stopped` also covers a `stop()` that lands while the FIRST pass is still
  // awaiting — the pass itself is not cancelled (it may be mid-payout), but no
  // further tick is accepted.
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      await input.compensate();
    } catch (error) {
      // A failed pass is reported, never rethrown: the schedule outlives it.
      try {
        log(
          `Refund compensator pass failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A throwing logger must not turn "a pass failed" into "the schedule
        // died", which is the one thing this module exists to prevent.
      }
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
