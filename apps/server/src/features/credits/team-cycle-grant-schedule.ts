/**
 * The timer that drives the monthly team-pool grant (workorder 37R, BL-44).
 *
 * `grant_team_cycle` (37O) is idempotent per month: the first call after
 * 00:00 on the 1st (Beijing) creates the month's row, writes the
 * `cycle_reset` of the previous month's remainder and the `cycle_grant`; every
 * later call in the same month is a no-op that answers the same limit. That is
 * the whole reason this timer does NOT have to fire at exactly midnight: a
 * coarse interval only decides how many minutes after midnight the grant lands,
 * not whether it lands twice.
 *
 * The three properties below are the ones `stuck-job-reaper-schedule.ts` (36J)
 * already argues for, and they matter here for the same reasons:
 *
 *   1. IT RUNS AT START. A worker that restarts on the 1st must not wait a whole
 *      interval before the month's quota exists — until the pool row is there,
 *      every member's team spend is refused.
 *   2. IT DOES NOT OVERLAP ITSELF. Two passes are two transactions racing for
 *      one idempotent insert; the function keeps the money right, but there is
 *      no reason to generate the race. A tick that lands while the previous pass
 *      is still in flight is DROPPED, not queued.
 *   3. IT NEVER DIES. One failing pass — a database that timed out, a pool that
 *      was not ready — must not end the schedule, or the month would start with
 *      no quota until someone redeploys the worker. The failure is logged and
 *      the next tick runs as if nothing happened.
 *
 * The scheduling primitives are injected so a test can drive the clock instead
 * of waiting for it; the defaults are the process-wide `setInterval` /
 * `clearInterval`. Nothing here touches the database or the clock directly —
 * `grant` carries all of that.
 */

import { creditPoolsEnabled } from "./credit-pools-billing.js";

/** BL-44: how often the worker tries to place this month's team pool grant. */
export const TEAM_CYCLE_GRANT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Workorder 38I: whether the worker should run the monthly team-pool grant AT
 * ALL. `grant_team_cycle` writes the pool row and the `cycle_grant` ledger line,
 * which are the three-pool bookkeeping the switch (37T) is supposed to own — so
 * a switched-off deployment must not schedule a single pass.
 *
 * `creditPoolsEnabled` is reused rather than read again here, so the timer and
 * the charge can never disagree about what "on" means. Injected `source` for the
 * tests, exactly like `creditPoolsEnabled`.
 */
export function shouldStartTeamCycleGrant(
  source: Record<string, string | undefined> = process.env,
): boolean {
  return creditPoolsEnabled(source);
}

export type StartTeamCycleGrantInput = {
  /** One granting pass. Rejecting or throwing is handled, not propagated. */
  grant: () => Promise<unknown>;
  /** Overridable period; defaults to `TEAM_CYCLE_GRANT_INTERVAL_MS`. */
  intervalMs?: number;
  /** Where a failed pass is reported. Defaults to silence. */
  log?: (m: string) => void;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

/**
 * Run `grant` now and then every `intervalMs`; overlapping runs are skipped;
 * returns a stop() for shutdown. Never throws.
 */
export function startTeamCycleGrant(
  input: StartTeamCycleGrantInput,
): { stop: () => void } {
  const intervalMs = input.intervalMs ?? TEAM_CYCLE_GRANT_INTERVAL_MS;
  const log = input.log ?? (() => {});
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  // `inFlight` is the whole overlap guard: set before the pass is awaited, so a
  // tick that arrives in the same microtask window still sees `true`.
  let inFlight = false;
  // `stopped` also covers a `stop()` that lands while the FIRST pass is still
  // awaiting — the pass itself is not cancelled (it may be mid-insert), but no
  // further tick is accepted.
  let stopped = false;

  const runOnce = async (): Promise<void> => {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      await input.grant();
    } catch (error) {
      // A failed pass is reported, never rethrown: the schedule outlives it.
      try {
        log(
          `Team cycle grant pass failed: ${
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
