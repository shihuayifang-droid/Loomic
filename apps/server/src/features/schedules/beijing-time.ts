/**
 * OP-11: the Beijing calendar, read without asking the process what time zone it
 * is in.
 *
 * The acceptance line for this requirement is "with the database set to UTC the
 * tasks still fire on Beijing time". The dangerous way to get that right is to
 * rely on the host: `new Date().getHours()` is whatever `TZ` says, and a
 * container that inherits `TZ=UTC` would silently shift every trigger by eight
 * hours. So the calendar here comes from `Intl` with `timeZone: "Asia/Shanghai"`
 * spelled out — an explicit zone is not affected by `TZ`, by the database, or by
 * anything else the environment happens to be set to.
 *
 * Pure functions only: no clock of its own, no I/O, no database. `now` is always
 * an argument, so a test can drive any instant it likes.
 */

import type { ScheduleEntry } from "./schedule-catalog.js";

/** A Beijing wall-clock instant, minute precision. */
export type BeijingParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/**
 * `hourCycle: "h23"` rather than `hour12: false`: a midnight must read `00`, and
 * "h23" is the option that guarantees it instead of leaving the choice to ICU.
 */
const BEIJING_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const MINUTE_MS = 60_000;

/** The Beijing calendar reading of `at`, independent of the process time zone. */
export function beijingParts(at: Date): BeijingParts {
  const parts = BEIJING_FORMATTER.formatToParts(at);
  const number = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Beijing time is missing the "${type}" part`);
    }
    return Number(part.value);
  };
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
  };
}

/** "HH:mm" → minutes after the Beijing midnight. */
function minutesAfterMidnight(atBeijing: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(atBeijing);
  if (match === null) {
    throw new Error(`Beijing time must look like "HH:mm", got "${atBeijing}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Beijing time is out of range: "${atBeijing}"`);
  }
  return hour * 60 + minute;
}

function minuteOfDay(parts: BeijingParts): number {
  return parts.hour * 60 + parts.minute;
}

/**
 * Is `entry` due at `now`, given it last ran at `lastRunAt`?
 *
 *   - `every n`   — at least `n` minutes since the last run; never before the
 *                   first run.
 *   - `daily HH:mm` — today's Beijing slot has passed, and the last run was not
 *                   at or after it on this same Beijing day.
 *   - `monthly d HH:mm` — the same, one Beijing month up: the slot for the
 *                   current month has passed and this month has not been served
 *                   yet. A month whose slot was missed still counts as unserved,
 *                   so a worker that was down on the 1st catches up on the 2nd
 *                   instead of skipping the month.
 *   - `on_read`   — never; the read path already did the work.
 *
 * A `null` `lastRunAt` means "never ran", which is due whenever the slot has
 * passed.
 */
export function isDue(
  entry: ScheduleEntry,
  lastRunAt: Date | null,
  now: Date,
): boolean {
  const cadence = entry.cadence;

  switch (cadence.kind) {
    case "on_read":
      return false;

    case "every": {
      if (lastRunAt === null) return true;
      return now.getTime() - lastRunAt.getTime() >= cadence.minutes * MINUTE_MS;
    }

    case "daily": {
      const slot = minutesAfterMidnight(cadence.atBeijing);
      const current = beijingParts(now);
      if (minuteOfDay(current) < slot) return false;
      if (lastRunAt === null) return true;

      const previous = beijingParts(lastRunAt);
      const sameDay =
        previous.year === current.year &&
        previous.month === current.month &&
        previous.day === current.day;
      return !(sameDay && minuteOfDay(previous) >= slot);
    }

    case "monthly": {
      const slot = minutesAfterMidnight(cadence.atBeijing);
      const current = beijingParts(now);
      if (current.day < cadence.day) return false;
      if (current.day === cadence.day && minuteOfDay(current) < slot) {
        return false;
      }
      if (lastRunAt === null) return true;

      const previous = beijingParts(lastRunAt);
      const sameMonth =
        previous.year === current.year && previous.month === current.month;
      if (!sameMonth) return true;
      return previous.day < cadence.day;
    }

    default:
      return false;
  }
}
