import { describe, expect, it } from "vitest";

import { beijingParts, isDue } from "./beijing-time.js";
import type { ScheduleCadence, ScheduleEntry } from "./schedule-catalog.js";

/**
 * OP-11: the Beijing calendar and the due-time rules.
 *
 * Every instant below is written in UTC and every expectation is Beijing time,
 * which is the whole point: the test never asks the process what time zone it
 * is in. The last case drives that home by re-running the same assertions under
 * `TZ=UTC` and `TZ=America/New_York`, the acceptance line "with the database set
 * to UTC the tasks still fire on Beijing time" reduced to code.
 */

function entry(
  name: string,
  cadence: ScheduleCadence,
  status: ScheduleEntry["status"] = "running",
): ScheduleEntry {
  return {
    name,
    title: "测试条目",
    cadence,
    timeZone: "Asia/Shanghai",
    owns: "GN-31",
    alert: "on_failure",
    status,
    note: "测试用",
  };
}

// Beijing is UTC+8 with no daylight saving, so the offsets below are exact.
const DAILY_02_00 = entry("probe_daily", { kind: "daily", atBeijing: "02:00" });
const MONTHLY_DAY1_00_00 = entry("probe_monthly", {
  kind: "monthly",
  day: 1,
  atBeijing: "00:00",
});
const EVERY_5 = entry("probe_every", { kind: "every", minutes: 5 });

describe("beijingParts", () => {
  it("OP-11: reads the Beijing calendar out of a UTC instant", () => {
    expect(beijingParts(new Date("2026-10-23T16:30:00Z"))).toEqual({
      year: 2026,
      month: 10,
      day: 24,
      hour: 0,
      minute: 30,
    });
  });

  it("OP-11: a UTC evening is the next Beijing day", () => {
    expect(beijingParts(new Date("2026-12-31T16:00:00Z"))).toEqual({
      year: 2027,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
  });
});

describe("isDue — every", () => {
  it("OP-11: never run is due", () => {
    expect(isDue(EVERY_5, null, new Date("2026-10-23T00:00:00Z"))).toBe(true);
  });

  it("OP-11: 4m59s after the last run is not due, 5m is", () => {
    const lastRunAt = new Date("2026-10-23T00:00:00Z");

    expect(isDue(EVERY_5, lastRunAt, new Date("2026-10-23T00:04:59Z"))).toBe(
      false,
    );
    expect(isDue(EVERY_5, lastRunAt, new Date("2026-10-23T00:05:00Z"))).toBe(true);
  });
});

describe("isDue — daily", () => {
  it("OP-11: Beijing 01:59 is not due, 02:00 is", () => {
    expect(isDue(DAILY_02_00, null, new Date("2026-10-23T17:59:00Z"))).toBe(false);
    expect(isDue(DAILY_02_00, null, new Date("2026-10-23T18:00:00Z"))).toBe(true);
  });

  it("OP-11: after running in today's slot, today does not come round again", () => {
    const ranAt = new Date("2026-10-23T18:00:00Z"); // Beijing 2026-10-24 02:00
    const laterSameDay = new Date("2026-10-23T20:00:00Z"); // Beijing 2026-10-24 04:00

    expect(isDue(DAILY_02_00, ranAt, laterSameDay)).toBe(false);
  });

  it("OP-11: the next Beijing 02:00 is due again", () => {
    const ranAt = new Date("2026-10-23T18:00:00Z"); // Beijing 2026-10-24 02:00
    const nextDay = new Date("2026-10-24T18:00:00Z"); // Beijing 2026-10-25 02:00

    expect(isDue(DAILY_02_00, ranAt, nextDay)).toBe(true);
  });

  it("OP-11: a run before today's slot does not consume today's slot", () => {
    const ranAt = new Date("2026-10-23T17:00:00Z"); // Beijing 2026-10-24 01:00
    const slot = new Date("2026-10-23T18:00:00Z"); // Beijing 2026-10-24 02:00

    expect(isDue(DAILY_02_00, ranAt, slot)).toBe(true);
  });
});

describe("isDue — monthly", () => {
  it("OP-11: UTC 10-31T16:00 is Beijing 11-01 00:00 and is due", () => {
    expect(
      isDue(MONTHLY_DAY1_00_00, null, new Date("2026-10-31T16:00:00Z")),
    ).toBe(true);
  });

  it("OP-11: a slot missed earlier in the month still counts as unserved (catch-up)", () => {
    expect(
      isDue(MONTHLY_DAY1_00_00, null, new Date("2026-10-31T15:59:00Z")),
    ).toBe(true); // catch-up: November's slot has not started, October's has
  });

  it("OP-11: after this month's slot ran, the month does not come round again", () => {
    const ranAt = new Date("2026-10-31T16:00:00Z"); // Beijing 2026-11-01 00:00
    const fiveMinutesLater = new Date("2026-10-31T16:05:00Z"); // Beijing 2026-11-01 00:05

    expect(isDue(MONTHLY_DAY1_00_00, ranAt, fiveMinutesLater)).toBe(false);
  });

  it("OP-11: the next Beijing month is due again", () => {
    const ranAt = new Date("2026-10-31T16:00:00Z"); // Beijing 2026-11-01 00:00
    const nextMonth = new Date("2026-11-30T16:00:00Z"); // Beijing 2026-12-01 00:00

    expect(isDue(MONTHLY_DAY1_00_00, ranAt, nextMonth)).toBe(true);
  });
});

describe("isDue — on_read", () => {
  it("OP-11: a read-time entry is never due", () => {
    const onRead = entry("probe_on_read", { kind: "on_read" }, "on_read");
    expect(isDue(onRead, null, new Date("2026-10-23T18:00:00Z"))).toBe(false);
    expect(isDue(onRead, null, new Date("2026-10-23T18:00:00Z"))).toBe(false);
  });
});

describe("isDue — independence from the process time zone", () => {
  /** Re-run the same instants with `TZ` set to `timeZone`. */
  function underTimeZone(timeZone: string): unknown {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      return {
        parts: beijingParts(new Date("2026-10-23T16:30:00Z")),
        dailyBefore: isDue(DAILY_02_00, null, new Date("2026-10-23T17:59:00Z")),
        dailyAt: isDue(DAILY_02_00, null, new Date("2026-10-23T18:00:00Z")),
        dailyRepeat: isDue(
          DAILY_02_00,
          new Date("2026-10-23T18:00:00Z"),
          new Date("2026-10-23T20:00:00Z"),
        ),
        monthly: isDue(
          MONTHLY_DAY1_00_00,
          null,
          new Date("2026-10-31T16:00:00Z"),
        ),
        every: isDue(
          EVERY_5,
          new Date("2026-10-23T00:00:00Z"),
          new Date("2026-10-23T00:05:00Z"),
        ),
      };
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  }

  it("OP-11: UTC, New York and the host default all agree", () => {
    const utc = underTimeZone("UTC");
    const newYork = underTimeZone("America/New_York");
    const hostDefault = underTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);

    expect(newYork).toEqual(utc);
    expect(hostDefault).toEqual(utc);
    expect(utc).toEqual({
      parts: { year: 2026, month: 10, day: 24, hour: 0, minute: 30 },
      dailyBefore: false,
      dailyAt: true,
      dailyRepeat: false,
      monthly: true,
      every: true,
    });
  });
});
