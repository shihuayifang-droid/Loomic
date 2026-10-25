/**
 * The job retention sweep (OP-11 / workorder 45CB).
 *
 * The rule under test is the approved one: keep 180 days, delete terminal rows
 * only, and count instead of deleting unless asked otherwise. The tests below
 * therefore drive a RECORDING pool and assert on the statements it received —
 * which statements were issued, in which order, with which parameters, and how
 * many times — because that is what "dry run writes nothing", "only terminal
 * rows", "batched until a short batch" and "the legacy `dead_letter` ages out"
 * mean in terms this module actually controls.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOB_RETENTION_BATCH_SIZE,
  JOB_RETENTION_DAYS,
  pruneFinishedJobs,
  TERMINAL_JOB_STATUSES,
  type JobRetentionPool,
} from "./job-retention.js";
import {
  JOB_RETENTION_APPLY_ENV,
  JOB_RETENTION_INTERVAL_MS,
  jobRetentionApplyEnabled,
  startJobRetentionSchedule,
} from "./job-retention-schedule.js";

type Call = { sql: string; params: readonly unknown[] };

/**
 * A pool that answers `count(*)` with `candidates` and each `delete` with the
 * next entry of `deletedPerBatch` (the last entry repeats). Every statement is
 * recorded, so a test can prove what was NOT issued.
 */
function recordingPool(input: {
  candidates?: number;
  deletedPerBatch?: number[];
  failAtCall?: number;
}): { pool: JobRetentionPool; calls: Call[] } {
  const calls: Call[] = [];
  let deletes = 0;

  const pool: JobRetentionPool = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (input.failAtCall !== undefined && calls.length === input.failAtCall) {
        throw new Error("pool is not ready");
      }
      if (sql.includes("count(*)")) {
        return { rows: [{ candidates: String(input.candidates ?? 0) }] };
      }
      const plan = input.deletedPerBatch ?? [];
      const rowCount =
        plan[Math.min(deletes, plan.length - 1)] ?? 0;
      deletes += 1;
      return { rows: [], rowCount };
    },
  };

  return { pool, calls };
}

const NOW = new Date("2026-03-01T00:00:00.000Z");

describe("pruneFinishedJobs", () => {
  it("OP-11: is a dry run by default — one count(*), no delete at all", async () => {
    const { pool, calls } = recordingPool({ candidates: 42 });

    const result = await pruneFinishedJobs(pool, { now: NOW });

    expect(result).toEqual({
      dryRun: true,
      retentionDays: JOB_RETENTION_DAYS,
      cutoff: "2025-09-02T00:00:00.000Z",
      candidates: 42,
      deleted: 0,
      batches: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("count(*)");
    expect(calls.some((call) => call.sql.includes("delete"))).toBe(false);
  });

  it("OP-11: a dry run with dryRun:true spelled out writes nothing either", async () => {
    const { pool, calls } = recordingPool({ candidates: 7 });

    const result = await pruneFinishedJobs(pool, { now: NOW, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.candidates).toBe(7);
    expect(calls).toHaveLength(1);
  });

  it("OP-11: 180 days is the window even when nothing is passed", () => {
    expect(JOB_RETENTION_DAYS).toBe(180);
    expect(JOB_RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_JOB_RETENTION_BATCH_SIZE).toBe(5000);
  });

  it("OP-11: the cutoff is now minus the window, and it is the parameter of every statement", async () => {
    const { pool, calls } = recordingPool({ candidates: 0, deletedPerBatch: [0] });

    await pruneFinishedJobs(pool, { now: NOW, dryRun: false });

    // 2026-03-01 minus 180 days = 2025-09-02.
    expect(calls[0]?.params).toEqual(["2025-09-02T00:00:00.000Z"]);
    expect(calls[1]?.params).toEqual([
      "2025-09-02T00:00:00.000Z",
      DEFAULT_JOB_RETENTION_BATCH_SIZE,
    ]);
  });

  it("OP-11: retentionDays and batchSize are honoured", async () => {
    const { pool, calls } = recordingPool({ candidates: 1, deletedPerBatch: [1] });

    const result = await pruneFinishedJobs(pool, {
      now: NOW,
      dryRun: false,
      retentionDays: 30,
      batchSize: 10,
    });

    expect(result.retentionDays).toBe(30);
    expect(result.cutoff).toBe("2026-01-30T00:00:00.000Z");
    expect(calls[1]?.params).toEqual(["2026-01-30T00:00:00.000Z", 10]);
    expect(result.batches).toBe(1);
  });

  /**
   * The one rule that must never bend: a job that still has an owner is not
   * history. The sweep names the four terminal statuses and nothing else.
   */
  it("OP-11: never deletes a non-terminal row — queued/running/retrying are not in the statement", async () => {
    const { pool, calls } = recordingPool({ candidates: 3, deletedPerBatch: [3] });

    await pruneFinishedJobs(pool, { now: NOW, dryRun: false });

    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual([
      "canceled",
      "dead_letter",
      "failed",
      "succeeded",
    ]);

    const statements = calls.map((call) => call.sql).join("\n");
    expect(statements).toContain(
      "status in ('succeeded', 'failed', 'canceled', 'dead_letter')",
    );
    expect(statements).not.toContain("'queued'");
    expect(statements).not.toContain("'running'");
    expect(statements).not.toContain("'retrying'");
    // And no statement deletes by anything but the shared candidate `where`.
    for (const call of calls.filter((c) => c.sql.includes("delete"))) {
      expect(call.sql).toContain(
        "where status in ('succeeded', 'failed', 'canceled', 'dead_letter')",
      );
      expect(call.sql).toContain(
        "coalesce(completed_at, failed_at, canceled_at, created_at)",
      );
    }
  });

  it("OP-11: reads and deletes by id only — no select of payload / result", async () => {
    const { pool, calls } = recordingPool({ candidates: 2, deletedPerBatch: [2] });

    await pruneFinishedJobs(pool, { now: NOW, dryRun: false });

    const statements = calls.map((call) => call.sql.toLowerCase()).join("\n");
    expect(statements).not.toContain("select *");
    expect(statements).not.toContain("payload");
    expect(statements).not.toContain("result ");
    // The sub-select carries `id` alone.
    expect(statements).toContain("select id");
  });

  it("OP-11: deletes in batches until one comes back short, and sums the real numbers", async () => {
    const { pool, calls } = recordingPool({
      candidates: 12,
      deletedPerBatch: [5, 5, 2],
    });

    const result = await pruneFinishedJobs(pool, {
      now: NOW,
      dryRun: false,
      batchSize: 5,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deleted).toBe(12);
    expect(result.batches).toBe(3);
    expect(result.candidates).toBe(12);
    // 1 count + 3 deletes.
    expect(calls).toHaveLength(4);
  });

  it("OP-11: stops when a full-sized batch is followed by nothing left", async () => {
    const { pool } = recordingPool({ candidates: 5, deletedPerBatch: [5, 0] });

    const result = await pruneFinishedJobs(pool, {
      now: NOW,
      dryRun: false,
      batchSize: 5,
    });

    expect(result.deleted).toBe(5);
    expect(result.batches).toBe(2);
  });

  it("OP-11: rejects a batchSize that would never shrink the table", async () => {
    const { pool, calls } = recordingPool({ candidates: 1 });

    await expect(
      pruneFinishedJobs(pool, { now: NOW, dryRun: false, batchSize: 0 }),
    ).rejects.toThrow(/batchSize/);
    expect(calls).toHaveLength(0);
  });
});

describe("startJobRetentionSchedule", () => {
  /** The smallest fake timer: nothing runs until the test says so. */
  function fakeTimers() {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const setIntervalImpl = ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    }) as unknown as typeof setInterval;
    const clearIntervalImpl = ((handle: unknown) => {
      cleared.push(handle);
    }) as unknown as typeof clearInterval;
    return { timers, cleared, setIntervalImpl, clearIntervalImpl };
  }

  it("OP-11: does NOT run at start — a deploy must not sweep the table", async () => {
    const clock = fakeTimers();
    let runs = 0;

    const { stop } = startJobRetentionSchedule({
      prune: async () => {
        runs += 1;
      },
      setInterval: clock.setIntervalImpl,
      clearInterval: clock.clearIntervalImpl,
    });

    expect(runs).toBe(0);
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]?.ms).toBe(24 * 60 * 60 * 1000);
    stop();
  });

  it("OP-11: runs on every tick", async () => {
    const clock = fakeTimers();
    let runs = 0;

    const { stop } = startJobRetentionSchedule({
      prune: async () => {
        runs += 1;
      },
      setInterval: clock.setIntervalImpl,
      clearInterval: clock.clearIntervalImpl,
    });

    clock.timers[0]?.fn();
    await Promise.resolve();
    clock.timers[0]?.fn();
    await Promise.resolve();

    expect(runs).toBe(2);
    stop();
  });

  it("OP-11: a tick during a pass is dropped, not queued", async () => {
    const clock = fakeTimers();
    let runs = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { stop } = startJobRetentionSchedule({
      prune: async () => {
        runs += 1;
        await blocked;
      },
      setInterval: clock.setIntervalImpl,
      clearInterval: clock.clearIntervalImpl,
    });

    clock.timers[0]?.fn();
    clock.timers[0]?.fn();
    clock.timers[0]?.fn();
    await Promise.resolve();

    expect(runs).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();

    clock.timers[0]?.fn();
    await Promise.resolve();
    expect(runs).toBe(2);
    stop();
  });

  it("OP-11: a failing pass is logged and the schedule survives it", async () => {
    const clock = fakeTimers();
    const logs: string[] = [];
    let runs = 0;

    const { stop } = startJobRetentionSchedule({
      prune: async () => {
        runs += 1;
        throw new Error("database timed out");
      },
      log: (m) => logs.push(m),
      setInterval: clock.setIntervalImpl,
      clearInterval: clock.clearIntervalImpl,
    });

    clock.timers[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    clock.timers[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(runs).toBe(2);
    expect(logs.join("\n")).toContain("Job retention pass failed: database timed out");
    stop();
  });

  it("OP-11: stop() clears the timer and swallows later ticks", async () => {
    const clock = fakeTimers();
    let runs = 0;

    const { stop } = startJobRetentionSchedule({
      prune: async () => {
        runs += 1;
      },
      setInterval: clock.setIntervalImpl,
      clearInterval: clock.clearIntervalImpl,
    });

    stop();
    expect(clock.cleared).toHaveLength(1);
    clock.timers[0]?.fn();
    await Promise.resolve();
    expect(runs).toBe(0);
  });

  it("OP-11: only the exact value true in HAHART_JOB_RETENTION_APPLY enables a real delete", () => {
    expect(JOB_RETENTION_APPLY_ENV).toBe("HAHART_JOB_RETENTION_APPLY");
    expect(jobRetentionApplyEnabled({})).toBe(false);
    expect(jobRetentionApplyEnabled({ HAHART_JOB_RETENTION_APPLY: "" })).toBe(false);
    expect(jobRetentionApplyEnabled({ HAHART_JOB_RETENTION_APPLY: "1" })).toBe(false);
    expect(jobRetentionApplyEnabled({ HAHART_JOB_RETENTION_APPLY: "TRUE" })).toBe(false);
    expect(jobRetentionApplyEnabled({ HAHART_JOB_RETENTION_APPLY: "yes" })).toBe(false);
    expect(jobRetentionApplyEnabled({ HAHART_JOB_RETENTION_APPLY: "true" })).toBe(true);
  });
});
