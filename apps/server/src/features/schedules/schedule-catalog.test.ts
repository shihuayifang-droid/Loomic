import { describe, expect, it } from "vitest";

import { SCHEDULE_CATALOG } from "./schedule-catalog.js";

/**
 * OP-11: the sheet itself.
 *
 * These cases do not exercise behaviour — the sheet has none. They lock the two
 * things a reader of the requirement compares against the code: the eight rows
 * and their order, and the promise that every row tells the truth about itself
 * (a `running` row has an owner, a Beijing time zone and a non-empty note, and
 * exactly the three tasks that are wired up in the worker say `running`).
 */

describe("SCHEDULE_CATALOG", () => {
  it("OP-11: has exactly the eight requirement entries, in requirement order", () => {
    expect(SCHEDULE_CATALOG.map((entry) => entry.name)).toEqual([
      "daily_grant_expiry",
      "team_cycle_grant",
      "orphan_asset_cleanup",
      "job_retention",
      "stuck_job_reaper",
      "refund_compensation",
      "daily_reconciliation",
      "slow_queue_window",
    ]);
  });

  it("OP-11: every name is unique", () => {
    const names = SCHEDULE_CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("OP-11: every entry is in Beijing time and owns a requirement item", () => {
    for (const entry of SCHEDULE_CATALOG) {
      expect(entry.timeZone).toBe("Asia/Shanghai");
      expect(entry.owns).not.toBe("");
    }
  });

  it("OP-11: exactly the three wired-up tasks are running, and they alert", () => {
    const running = SCHEDULE_CATALOG.filter((entry) => entry.status === "running");
    expect(running.map((entry) => entry.name).sort()).toEqual([
      "refund_compensation",
      "stuck_job_reaper",
      "team_cycle_grant",
    ]);
    for (const entry of running) {
      expect(entry.alert).toBe("on_failure");
    }
  });

  it("OP-11: the read-time entry has no timer and nothing pretends to run", () => {
    const onRead = SCHEDULE_CATALOG.filter((entry) => entry.status === "on_read");
    expect(onRead.map((entry) => entry.name)).toEqual(["daily_grant_expiry"]);
    for (const entry of onRead) {
      expect(entry.cadence.kind).toBe("on_read");
    }
    for (const entry of SCHEDULE_CATALOG) {
      if (entry.status === "not_built") {
        expect(entry.cadence.kind).not.toBe("on_read");
        expect(entry.alert).toBe("none");
      }
    }
  });

  it("OP-11: every entry says what is true today", () => {
    for (const entry of SCHEDULE_CATALOG) {
      expect(entry.title).not.toBe("");
      expect(entry.note.trim()).not.toBe("");
    }
  });
});
