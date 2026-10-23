import { describe, expect, it, vi } from "vitest";

import type { ScheduleCadence, ScheduleEntry } from "./schedule-catalog.js";
import { DEFAULT_TICK_MS, startSchedules } from "./schedule-runner.js";

/**
 * OP-11: the scheduler around the tasks.
 *
 * The clock is a fake and the timer is a fake, so "a minute later" costs
 * nothing. What the cases pin down is exactly the behaviour that used to be
 * copied into three separate files and would be lost in the move: run at start,
 * run on cadence, never overlap, survive a failure, and stop on shutdown — plus
 * the new promise the sheet makes, that a row which is not built is never run.
 */

function entry(
  name: string,
  cadence: ScheduleCadence,
  status: ScheduleEntry["status"] = "running",
  alert: ScheduleEntry["alert"] = "on_failure",
): ScheduleEntry {
  return {
    name,
    title: "测试条目",
    cadence,
    timeZone: "Asia/Shanghai",
    owns: "GN-31",
    alert,
    status,
    note: "测试用",
  };
}

const EVERY_5: ScheduleCadence = { kind: "every", minutes: 5 };
const DAILY_02_00: ScheduleCadence = { kind: "daily", atBeijing: "02:00" };

type FakeClock = {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  /** The callback the scheduler registered; `null` once cleared. */
  captured: () => (() => void) | null;
  intervalMs: () => number | null;
  clearCount: () => number;
};

function fakeClock(): FakeClock {
  let callback: (() => void) | null = null;
  let intervalMs: number | null = null;
  let cleared = 0;

  const setIntervalStub = ((fn: () => void, ms: number) => {
    callback = fn;
    intervalMs = ms;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  const clearIntervalStub = ((_: unknown) => {
    cleared += 1;
    callback = null;
  }) as unknown as typeof clearInterval;

  return {
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    captured: () => callback,
    intervalMs: () => intervalMs,
    clearCount: () => cleared,
  };
}

/** Let the immediate start-up pass get as far as its `await`. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startSchedules", () => {
  it("OP-11: every entry runs once at start, and the default tick is a minute", async () => {
    const clock = fakeClock();
    const task = vi.fn(async () => undefined);

    const schedules = startSchedules({
      entries: [entry("stuck_job_reaper", EVERY_5)],
      tasks: { stuck_job_reaper: task },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);
    expect(clock.intervalMs()).toBe(DEFAULT_TICK_MS);
    expect(DEFAULT_TICK_MS).toBe(60_000);

    schedules.stop();
  });

  it("OP-11: a daily entry whose Beijing slot has not passed does not run", async () => {
    const clock = fakeClock();
    const task = vi.fn(async () => undefined);
    // Beijing 2026-10-24 00:00 — before the 02:00 slot.
    const now = new Date("2026-10-23T16:00:00Z");

    const schedules = startSchedules({
      entries: [entry("daily_reconciliation", DAILY_02_00)],
      tasks: { daily_reconciliation: task },
      now: () => now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    expect(task).not.toHaveBeenCalled();

    clock.captured()?.();
    await flushMicrotasks();
    expect(task).not.toHaveBeenCalled();

    schedules.stop();
  });

  it("OP-11: a daily entry runs once its Beijing slot has passed", async () => {
    const clock = fakeClock();
    const task = vi.fn(async () => undefined);
    // Beijing 2026-10-24 02:00.
    const now = new Date("2026-10-23T18:00:00Z");

    const schedules = startSchedules({
      entries: [entry("daily_reconciliation", DAILY_02_00)],
      tasks: { daily_reconciliation: task },
      now: () => now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    clock.captured()?.();
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);

    schedules.stop();
  });

  it("OP-11: a failing task alerts once and the other entry still runs", async () => {
    const clock = fakeClock();
    const failing = vi.fn(async () => {
      throw new Error("pass 1 exploded");
    });
    const healthy = vi.fn(async () => undefined);
    const log = vi.fn<(message: string) => void>();
    const alerts: { name: string; error: string; at: Date }[] = [];

    const schedules = startSchedules({
      entries: [
        entry("stuck_job_reaper", EVERY_5),
        entry("refund_compensation", EVERY_5),
      ],
      tasks: { stuck_job_reaper: failing, refund_compensation: healthy },
      onAlert: (alert) => alerts.push(alert),
      log,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.name).toBe("stuck_job_reaper");
    expect(alerts[0]?.error).toBe("pass 1 exploded");
    expect(
      log.mock.calls.some(([message]) =>
        message.includes("ALERT schedule_failed name=stuck_job_reaper"),
      ),
    ).toBe(true);
    expect(healthy).toHaveBeenCalledTimes(1);

    schedules.stop();
  });

  it("OP-11: an entry with alert: none logs but does not call onAlert", async () => {
    const clock = fakeClock();
    const failing = vi.fn(async () => {
      throw new Error("quiet failure");
    });
    const log = vi.fn<(message: string) => void>();
    const onAlert = vi.fn<(alert: unknown) => void>();

    const schedules = startSchedules({
      entries: [entry("probe_quiet", EVERY_5, "running", "none")],
      tasks: { probe_quiet: failing },
      onAlert,
      log,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();

    expect(onAlert).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(
      "ALERT schedule_failed name=probe_quiet error=quiet failure",
    );

    schedules.stop();
  });

  it("OP-11: an overlapping tick is skipped", async () => {
    const clock = fakeClock();
    // This pass never settles, so every tick during it lands "in flight".
    const task = vi.fn(() => new Promise<void>(() => undefined));

    const schedules = startSchedules({
      entries: [entry("stuck_job_reaper", EVERY_5)],
      tasks: { stuck_job_reaper: task },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    const tick = clock.captured();
    tick?.();
    await flushMicrotasks();
    tick?.();
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);

    schedules.stop();
  });

  it("OP-11: stop clears the timer and no later tick runs anything", async () => {
    const clock = fakeClock();
    const task = vi.fn(async () => undefined);

    const schedules = startSchedules({
      entries: [entry("stuck_job_reaper", EVERY_5)],
      tasks: { stuck_job_reaper: task },
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    expect(task).toHaveBeenCalledTimes(1);

    const tick = clock.captured();
    schedules.stop();

    expect(clock.clearCount()).toBe(1);
    // Even a tick that was captured before stop() must not run anything.
    tick?.();
    await flushMicrotasks();

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("OP-11: not_built and on_read entries never run, even when a task is wired", async () => {
    const clock = fakeClock();
    const notBuilt = vi.fn(async () => undefined);
    const onRead = vi.fn(async () => undefined);
    // Beijing 2026-10-24 05:00 — past the 04:00 slot of the not_built entry.
    const now = new Date("2026-10-23T21:00:00Z");

    const schedules = startSchedules({
      entries: [
        entry("job_retention", { kind: "daily", atBeijing: "04:00" }, "not_built", "none"),
        entry("daily_grant_expiry", { kind: "on_read" }, "on_read", "none"),
      ],
      tasks: { job_retention: notBuilt, daily_grant_expiry: onRead },
      now: () => now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    clock.captured()?.();
    await flushMicrotasks();

    expect(notBuilt).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();

    schedules.stop();
  });

  it("OP-11: a running entry with no task wired is skipped", async () => {
    const clock = fakeClock();

    const schedules = startSchedules({
      entries: [entry("orphan_asset_cleanup", EVERY_5)],
      tasks: {},
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    });

    await flushMicrotasks();
    clock.captured()?.();
    await flushMicrotasks();

    // Nothing to assert on but the absence of a crash; the interesting part is
    // that runNow on a name without a task is also a no-op.
    await expect(schedules.runNow("orphan_asset_cleanup")).resolves.toBeUndefined();

    schedules.stop();
  });
});
