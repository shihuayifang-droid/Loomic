import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import {
  DEFAULT_SAMPLE_LIMIT,
  RECONCILE_CHECKS,
  reconcileCredits,
  type ReconcileFinding,
  type ReconcileReport,
} from "./daily-reconcile.js";
import {
  DAILY_RECONCILE_INTERVAL_MS,
  startDailyReconcileSchedule,
} from "./daily-reconcile-schedule.js";

/**
 * The daily credits reconciliation (OP-11 / workorder 45CC).
 *
 * Two groups of cases. The first is about the REPORT: four checks, exact counts,
 * capped samples, `ok` derived only from the counts of `"alarm"` findings
 * (45CD: C is informational and never fails the run), and — the property the
 * whole ticket rests on — not one write statement ever reaching the driver. The
 * second is the timer around it, borrowed from 45CB: no immediate pass, dropped
 * overlaps, a failing pass logged instead of fatal.
 */

type QueryCall = { sql: string; params: readonly unknown[] | undefined };

type FakeResult = { count: number | string; samples?: unknown };

/**
 * A pool-shaped recorder: hands back the queued results in call order and keeps
 * every statement, so a test can assert on what was sent without a database.
 */
function fakePool(results: readonly FakeResult[]): {
  pool: Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let index = 0;

  const pool = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      const result = results[index] ?? { count: 0, samples: [] };
      index += 1;
      return { rows: [result] };
    },
  } as unknown as Pool;

  return { pool, calls };
}

function cleanReport(): ReconcileReport {
  return {
    ranAt: "2026-10-22T00:00:00.000Z",
    ok: true,
    findings: [],
  };
}

function findingsReport(findings: ReconcileFinding[]): ReconcileReport {
  return {
    ranAt: "2026-10-22T00:00:00.000Z",
    // Same rule as the implementation: informational findings never fail a run.
    ok: findings
      .filter((finding) => finding.severity === "alarm")
      .every((finding) => finding.count === 0),
    findings,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileCredits", () => {
  it("runs the four checks in order and is clean when every count is zero", async () => {
    const { pool, calls } = fakePool([]);

    const report = await reconcileCredits(pool, {
      now: new Date("2026-10-22T03:04:05.000Z"),
    });

    expect(report.ranAt).toBe("2026-10-22T03:04:05.000Z");
    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.check)).toEqual([
      "A_job_without_transaction",
      "B_missing_deduction_transaction",
      "C_team_pool_drift",
      "D_negative_balance",
    ]);
    expect(report.findings.map((finding) => finding.count)).toEqual([0, 0, 0, 0]);
    // 45CD: A and B are alarms, C is informational, D is an alarm.
    expect(report.findings.map((finding) => finding.severity)).toEqual([
      "alarm",
      "alarm",
      "info",
      "alarm",
    ]);
    expect(calls).toHaveLength(4);
  });

  it("carries count and samples through for a drift", async () => {
    const { pool } = fakePool([
      { count: 2, samples: [{ job_id: "job-a" }, { job_id: "job-b" }] },
      { count: "1", samples: [{ job_id: "job-c", credits_transaction_id: "tx-c" }] },
      { count: 1, samples: [{ workspace_id: "ws-1", period_month: "2026-10-01" }] },
      { count: 0, samples: [] },
    ]);

    const report = await reconcileCredits(pool);

    expect(report.ok).toBe(false);
    expect(report.findings[0]).toEqual({
      check: "A_job_without_transaction",
      severity: "alarm",
      count: 2,
      samples: [{ job_id: "job-a" }, { job_id: "job-b" }],
    });
    // A string count out of `count(*)` is still a number in the report.
    expect(report.findings[1]?.count).toBe(1);
    expect(report.findings[2]?.severity).toBe("info");
    expect(report.findings[2]?.samples).toEqual([
      { workspace_id: "ws-1", period_month: "2026-10-01" },
    ]);
    expect(report.findings[3]?.count).toBe(0);
  });

  it("does not fail the run when only the informational check has counts", async () => {
    // A/B/D clean, C (info) drifted: this is the shape the ticket exists for.
    const { pool } = fakePool([
      { count: 0, samples: [] },
      { count: 0, samples: [] },
      { count: 2, samples: [{ workspace_id: "ws-1", period_month: "2026-10-01" }] },
      { count: 0, samples: [] },
    ]);

    const report = await reconcileCredits(pool);

    expect(report.ok).toBe(true);
    expect(report.findings[2]).toEqual({
      check: "C_team_pool_drift",
      severity: "info",
      count: 2,
      samples: [{ workspace_id: "ws-1", period_month: "2026-10-01" }],
    });
  });

  it("fails the run as soon as an alarm check has a count", async () => {
    for (const alarmIndex of [0, 1, 3]) {
      const results = [0, 0, 2, 0].map((count, index) => ({
        count: index === alarmIndex ? 1 : count,
        samples: [],
      }));
      const { pool } = fakePool(results);

      const report = await reconcileCredits(pool);

      expect(report.ok).toBe(false);
      expect(report.findings[alarmIndex]?.severity).toBe("alarm");
      expect(report.findings[alarmIndex]?.count).toBe(1);
    }
  });

  it("asks the database for exactly `sampleLimit` samples and defaults to five", async () => {
    const defaulted = fakePool([]);
    await reconcileCredits(defaulted.pool);
    expect(defaulted.calls.map((call) => call.params)).toEqual([
      [DEFAULT_SAMPLE_LIMIT],
      [DEFAULT_SAMPLE_LIMIT],
      [DEFAULT_SAMPLE_LIMIT],
      [DEFAULT_SAMPLE_LIMIT],
    ]);
    expect(DEFAULT_SAMPLE_LIMIT).toBe(5);

    const capped = fakePool([]);
    await reconcileCredits(capped.pool, { sampleLimit: 2 });
    expect(capped.calls.map((call) => call.params)).toEqual([[2], [2], [2], [2]]);
  });

  it("clamps a negative sampleLimit to zero instead of sending it to the driver", async () => {
    const { pool, calls } = fakePool([]);
    await reconcileCredits(pool, { sampleLimit: -3 });
    expect(calls.map((call) => call.params)).toEqual([[0], [0], [0], [0]]);
  });

  it("never sends a write statement: every check is a read", async () => {
    const { pool, calls } = fakePool([]);
    await reconcileCredits(pool);

    expect(calls).toHaveLength(RECONCILE_CHECKS.length);
    for (const call of calls) {
      // A read is a `with`/`select` and contains no write verb anywhere.
      expect(call.sql).toMatch(/^\s*(with|select)\b/i);
      expect(call.sql).not.toMatch(
        /\b(insert|update|delete|upsert|merge|truncate|create|alter|drop|grant)\b/i,
      );
    }
    // The exported definitions are the same text that was sent.
    expect(RECONCILE_CHECKS.map((check) => check.sql)).toEqual(
      calls.map((call) => call.sql),
    );
  });

  it("does not read `metadata`: samples name ids, never whole rows", async () => {
    for (const check of RECONCILE_CHECKS) {
      expect(check.sql).not.toMatch(/select\s+\*/i);
      // `metadata` may only be consulted as a JSON key (`metadata ->> '...'`),
      // never selected as a column: it can hold a whole request payload.
      expect(check.sql).not.toMatch(/\bmetadata\b(?!\s*->>)/i);
    }
  });
});

describe("startDailyReconcileSchedule", () => {
  it("does NOT run at start; the first pass waits a full 24 hours", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => cleanReport());

    startDailyReconcileSchedule({
      reconcile,
      log: () => {},
      warn: () => {},
    });

    expect(DAILY_RECONCILE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    expect(reconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS - 1000);
    expect(reconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("skips a tick that lands while the previous pass is still in flight", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(async () => {
      await gate;
      return cleanReport();
    });

    startDailyReconcileSchedule({
      reconcile,
      log: () => {},
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("reports a clean pass through log", async () => {
    vi.useFakeTimers();
    const log = vi.fn();

    startDailyReconcileSchedule({
      reconcile: async () => cleanReport(),
      log,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("clean");
  });

  it("warns with the alarm counts only, and reports info findings on their own line", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const info = vi.fn();

    startDailyReconcileSchedule({
      reconcile: async () =>
        findingsReport([
          { check: "A_job_without_transaction", severity: "alarm", count: 3, samples: [] },
          { check: "B_missing_deduction_transaction", severity: "alarm", count: 1, samples: [] },
          { check: "C_team_pool_drift", severity: "info", count: 2, samples: [] },
          { check: "D_negative_balance", severity: "alarm", count: 2, samples: [] },
        ]),
      log: () => {},
      warn,
      info,
    });

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("A_job_without_transaction=3");
    expect(message).toContain("B_missing_deduction_transaction=1");
    expect(message).toContain("D_negative_balance=2");
    // An informational finding is not an alarm and must not be in the warn line.
    expect(message).not.toContain("C_team_pool_drift");

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("C_team_pool_drift=2");
  });

  it("logs a pass whose only finding is informational as clean", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const warn = vi.fn();
    const info = vi.fn();

    startDailyReconcileSchedule({
      reconcile: async () =>
        findingsReport([
          { check: "A_job_without_transaction", severity: "alarm", count: 0, samples: [] },
          { check: "B_missing_deduction_transaction", severity: "alarm", count: 0, samples: [] },
          { check: "C_team_pool_drift", severity: "info", count: 2, samples: [] },
          { check: "D_negative_balance", severity: "alarm", count: 0, samples: [] },
        ]),
      log,
      warn,
      info,
    });

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);

    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("clean");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("C_team_pool_drift=2");
  });

  it("a failing pass is reported and the schedule keeps its cadence", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const reconcile = vi.fn(async () => {
      throw new Error("database went away");
    });

    startDailyReconcileSchedule({
      reconcile,
      log: () => {},
      warn,
    });

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("database went away");

    // The next tick still runs, so a bad day never ends the patrol.
    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("stop ends the schedule", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => cleanReport());

    const schedule = startDailyReconcileSchedule({
      reconcile,
      log: () => {},
      warn: () => {},
    });
    schedule.stop();

    await vi.advanceTimersByTimeAsync(DAILY_RECONCILE_INTERVAL_MS * 2);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
