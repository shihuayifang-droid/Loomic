/**
 * OP-11: one list of every periodic task the platform owns.
 *
 * The requirement asks for a single sheet — name, cron, time zone, which
 * requirement it serves, whether a failure raises an alert — and for the sheet
 * to stay honest: an entry whose task is not built says so (`not_built`) instead
 * of pretending, and an entry that is really a read-time decision says `on_read`
 * instead of getting a timer it does not need.
 *
 * Three entries are `running` today. Every one of them is driven by
 * `startSchedules` (`./schedule-runner.ts`) from the worker process; nothing in
 * this file runs anything by itself.
 *
 * Every cadence is expressed in Beijing time, and the time zone is part of the
 * entry rather than of the process: `./beijing-time.ts` reads the calendar out of
 * `Asia/Shanghai` explicitly, so a database or a host set to UTC (or to anything
 * else) cannot move a trigger.
 */

export type ScheduleCadence =
  | { kind: "every"; minutes: number }
  /** `atBeijing` is "HH:mm" on the Beijing wall clock. */
  | { kind: "daily"; atBeijing: string }
  /** `day` is the day of the Beijing month; `atBeijing` is "HH:mm". */
  | { kind: "monthly"; day: number; atBeijing: string }
  /** No timer: the work happens inside a read path, idempotently per Beijing day. */
  | { kind: "on_read" };

export type ScheduleEntry = {
  /** Stable English id; the runner looks its task up by this name. */
  name: string;
  /** Chinese name, for the sheet a human reads. */
  title: string;
  cadence: ScheduleCadence;
  timeZone: "Asia/Shanghai";
  /** The requirement item this schedule serves. */
  owns: string;
  alert: "on_failure" | "none";
  status: "running" | "on_read" | "not_built";
  /** What is true today, in Chinese. */
  note: string;
};

/**
 * The sheet. Order follows the requirement text, so a reader comparing the two
 * walks them side by side.
 */
export const SCHEDULE_CATALOG: readonly ScheduleEntry[] = [
  {
    name: "daily_grant_expiry",
    title: "每日赠送过期",
    cadence: { kind: "on_read" },
    timeZone: "Asia/Shanghai",
    owns: "BL-44",
    alert: "none",
    status: "on_read",
    note: "读余额时按北京日期幂等发放 / 过期（grant_daily_credits），无需定时",
  },
  {
    name: "team_cycle_grant",
    title: "团队池月度重置",
    cadence: { kind: "every", minutes: 10 },
    timeZone: "Asia/Shanghai",
    owns: "BL-44",
    alert: "on_failure",
    status: "running",
    note: "每月 1 日北京 00:00 后首个 10 分钟内发放，按月幂等；三池开关开启时运行",
  },
  {
    name: "orphan_asset_cleanup",
    title: "孤儿产物清理",
    cadence: { kind: "daily", atBeijing: "03:30" },
    timeZone: "Asia/Shanghai",
    owns: "GN-24",
    alert: "none",
    status: "not_built",
    note: "随自主存储（OP-05）实现",
  },
  {
    name: "job_retention",
    title: "任务表保留期",
    cadence: { kind: "daily", atBeijing: "04:00" },
    timeZone: "Asia/Shanghai",
    owns: "GN-31",
    alert: "none",
    status: "not_built",
    note: "保留期未定，随 OP-05 / 全新库实现",
  },
  {
    name: "stuck_job_reaper",
    title: "卡死任务清理",
    cadence: { kind: "every", minutes: 5 },
    timeZone: "Asia/Shanghai",
    owns: "GN-31",
    alert: "on_failure",
    status: "running",
    note: "超时 running 任务标失败并退款",
  },
  {
    name: "refund_compensation",
    title: "退款补偿重试",
    cadence: { kind: "every", minutes: 5 },
    timeZone: "Asia/Shanghai",
    owns: "BL-41",
    alert: "on_failure",
    status: "running",
    note: "退款失败入队后重试 12 次，放弃时告警",
  },
  {
    name: "daily_reconciliation",
    title: "每日对账",
    cadence: { kind: "daily", atBeijing: "02:00" },
    timeZone: "Asia/Shanghai",
    owns: "BL-41",
    alert: "none",
    status: "not_built",
    note: "对账口径未定",
  },
  {
    name: "slow_queue_window",
    title: "低速队列时段",
    cadence: { kind: "daily", atBeijing: "00:00" },
    timeZone: "Asia/Shanghai",
    owns: "GN-31",
    alert: "none",
    status: "not_built",
    note: "一期无低速队列",
  },
];
