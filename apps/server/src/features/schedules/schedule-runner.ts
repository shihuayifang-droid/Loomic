/**
 * OP-11: the one timer that drives every periodic task (workorder 43A).
 *
 * Before this module the worker had three hand-written timers, one per task,
 * each with its own copy of the same four properties. This keeps the properties
 * and drops the copies:
 *
 *   1. IT RUNS AT START. `every` entries run once before the first interval, so a
 *      worker that restarts reclaims what its previous life left behind instead
 *      of waiting a whole cadence. Daily and monthly entries are not forced at
 *      start: they fire on the first tick whose Beijing slot has passed.
 *   2. IT DOES NOT OVERLAP A TASK WITH ITSELF. A tick that lands while a task is
 *      still in flight is DROPPED, not queued — two passes over one population
 *      are two writers racing for one payout, not twice the throughput.
 *   3. IT NEVER DIES. A failing task is logged as
 *      `ALERT schedule_failed name=<name> error=<msg>` and, when the entry says
 *      `alert: "on_failure"`, handed to `onAlert`; the other entries are
 *      unaffected and the next tick runs as if nothing happened. The alert
 *      channel itself is OP-18 and is not decided yet, so the log line is the
 *      channel today and the callback is its seam.
 *   4. IT ONLY RUNS WHAT EXISTS. An entry that is `not_built` or `on_read`, or
 *      that has no task wired up, is never invoked — the catalog is allowed to
 *      describe work that is not built yet.
 *
 * The clock and the timer primitives are injected, so a test drives minutes in
 * microseconds and "five minutes" is an exact number of milliseconds.
 */

import { isDue } from "./beijing-time.js";
import type { ScheduleEntry } from "./schedule-catalog.js";

/** One minute: the default tick, which is finer than every cadence in the catalog. */
export const DEFAULT_TICK_MS = 60_000;

export type ScheduleAlert = {
  /** The catalog `name` of the task that failed. */
  name: string;
  error: string;
  at: Date;
};

export type StartSchedulesInput = {
  entries: readonly ScheduleEntry[];
  /** One run per catalog name; a missing task means "nothing to run yet". */
  tasks: Partial<Record<string, () => Promise<void>>>;
  /** Where a failure goes; OP-18 replaces this with the real channel. */
  onAlert?: (alert: ScheduleAlert) => void;
  /** Structured log sink, defaults to silence. */
  log?: (message: string) => void;
  /** Overridable tick; defaults to `DEFAULT_TICK_MS`. */
  tickMs?: number;
  /** Injected for the tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Injected for the tests; defaults to the global `setInterval`. */
  setInterval?: typeof setInterval;
  /** Injected for the tests; defaults to the global `clearInterval`. */
  clearInterval?: typeof clearInterval;
};

export type SchedulesHandle = {
  /** Stops the timer; a task already in flight is not cancelled. */
  stop(): void;
  /** Runs one entry now, regardless of its cadence. Unknown names are a no-op. */
  runNow(name: string): Promise<void>;
};

/**
 * Start the schedule. Returns the stop handle and a manual `runNow`.
 */
export function startSchedules(input: StartSchedulesInput): SchedulesHandle {
  const tickMs = input.tickMs ?? DEFAULT_TICK_MS;
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => {});
  const schedule: typeof setInterval = input.setInterval ?? setInterval;
  const cancel: typeof clearInterval = input.clearInterval ?? clearInterval;

  /** Per-entry last started run. Set before the task is awaited, on purpose. */
  const lastRunAt = new Map<string, Date>();
  /** The overlap guard: an entry in here is running and its ticks are dropped. */
  const inFlight = new Set<string>();
  let stopped = false;

  const isRunnable = (entry: ScheduleEntry): boolean =>
    entry.status === "running" && input.tasks[entry.name] !== undefined;

  const runOnce = async (entry: ScheduleEntry): Promise<void> => {
    if (stopped) return;
    if (inFlight.has(entry.name)) return;

    const task = input.tasks[entry.name];
    if (task === undefined) return;

    inFlight.add(entry.name);
    lastRunAt.set(entry.name, now());
    try {
      await task();
    } catch (error) {
      // Reported, never rethrown: the schedule outlives one failing pass.
      const message = error instanceof Error ? error.message : String(error);
      try {
        log(`ALERT schedule_failed name=${entry.name} error=${message}`);
      } catch {
        // A throwing logger must not turn "a task failed" into "the schedule
        // died", which is the one thing this module exists to prevent.
      }
      if (entry.alert === "on_failure") {
        try {
          input.onAlert?.({ name: entry.name, error: message, at: now() });
        } catch {
          // Same reason: the alert channel is not allowed to kill the timer.
        }
      }
    } finally {
      inFlight.delete(entry.name);
    }
  };

  const tick = (): void => {
    if (stopped) return;
    const at = now();
    for (const entry of input.entries) {
      if (!isRunnable(entry)) continue;
      if (inFlight.has(entry.name)) continue;
      if (!isDue(entry, lastRunAt.get(entry.name) ?? null, at)) continue;
      void runOnce(entry);
    }
  };

  // Property 1: `every` entries run immediately, before the first tick.
  for (const entry of input.entries) {
    if (!isRunnable(entry)) continue;
    if (entry.cadence.kind !== "every") continue;
    void runOnce(entry);
  }

  const handle = schedule(tick, tickMs);

  return {
    stop() {
      stopped = true;
      cancel(handle);
    },
    async runNow(name: string): Promise<void> {
      const entry = input.entries.find((candidate) => candidate.name === name);
      if (entry === undefined || !isRunnable(entry)) return;
      await runOnce(entry);
    },
  };
}
