import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPoolGrantWriteRepository } from "../../db/pool-grant-write-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../../test-support/db/pglite-db.js";
import {
  TEAM_CYCLE_GRANT_INTERVAL_MS,
  shouldStartTeamCycleGrant,
  startTeamCycleGrant,
} from "./team-cycle-grant-schedule.js";

/**
 * 工单37R · BL-44 / BL-45 —— 池额度的自动发放。
 *
 * 两半，两个问题：
 *
 *   A. 定时器（`startTeamCycleGrant`，照 36J 的 reaper 写法）—— 启动就跑、
 *      不重叠、失败只记日志、`stop()` 之后不再跑。这一半没有数据库也没有真实
 *      时钟，`setInterval` 是注入的假定时器，所以「十分钟」在这里是精确的
 *      600000 毫秒。
 *   B. 仓储（`createPoolGrantWriteRepository`）—— 用 PGlite 跑真实 SQL：
 *      `public.grant_team_cycle` 找那唯一的团队工作区并发放本月额度，同日 / 同月
 *      再调是空操作；没有团队工作区就什么都不发，返回 `null`。
 *
 * 第 6 例（没有团队工作区）必须排在建团队工作区之前 —— 整个库最多一个
 * `type = 'team'` 行（`workspaces_single_team_key`），所以它是本文件的第一个
 * 数据库用例，后面的用例才建那个团队。
 */

type Grant = () => Promise<unknown>;

/** Let the immediate first pass get as far as its first `await`. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type TimerCall = { callback: () => void; intervalMs: number | undefined };

/**
 * A `setInterval` double that records the callback and the period instead of
 * waiting for them, so "the next tick" is a function call and not ten minutes.
 */
function captureSchedule() {
  const calls: TimerCall[] = [];
  const handles: Array<ReturnType<typeof setInterval>> = [];
  let cleared: Array<ReturnType<typeof setInterval>> = [];

  const schedule = ((callback: () => void, intervalMs?: number) => {
    calls.push({ callback, intervalMs });
    // A plain number is a usable handle for the fake cancel below; the cast is
    // only so the injected signature stays `typeof setInterval`.
    const handle = (calls.length as unknown) as ReturnType<typeof setInterval>;
    handles.push(handle);
    return handle;
  }) as unknown as typeof setInterval;

  const cancel = ((handle?: ReturnType<typeof setInterval>) => {
    cleared = [...cleared, handle as ReturnType<typeof setInterval>];
  }) as unknown as typeof clearInterval;

  return {
    calls,
    handles,
    cleared: () => cleared,
    schedule,
    cancel,
  };
}

describe("startTeamCycleGrant", () => {
  it("BL-44: the grant runs at once and then on the interval", async () => {
    // The period is a literal, not a "roughly ten minutes" a reader guesses at.
    expect(TEAM_CYCLE_GRANT_INTERVAL_MS).toBe(600000);

    const timers = captureSchedule();
    const grant = vi.fn<Grant>(async () => undefined);

    const { stop } = startTeamCycleGrant({
      grant,
      setInterval: timers.schedule,
      clearInterval: timers.cancel,
    });

    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(1);
    // One timer, armed with the default period.
    expect(timers.calls).toHaveLength(1);
    expect(timers.calls[0]?.intervalMs).toBe(600000);

    timers.calls[0]?.callback();
    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(2);

    stop();
  });

  it("BL-44: a slow pass is not run twice at the same time", async () => {
    const timers = captureSchedule();
    // This pass never settles, so every tick during it lands "in flight".
    const grant = vi.fn<Grant>(() => new Promise(() => undefined));

    const { stop } = startTeamCycleGrant({
      grant,
      setInterval: timers.schedule,
      clearInterval: timers.cancel,
    });

    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(1);

    timers.calls[0]?.callback();
    timers.calls[0]?.callback();
    await flushMicrotasks();

    // Two ticks during one in-flight pass are dropped, not queued.
    expect(grant).toHaveBeenCalledTimes(1);

    stop();
  });

  it("BL-44: a failing pass is logged, not thrown", async () => {
    const timers = captureSchedule();
    const grant = vi.fn<Grant>(async () => {
      throw new Error("x");
    });
    const log = vi.fn<(m: string) => void>();

    const { stop } = startTeamCycleGrant({
      grant,
      log,
      setInterval: timers.schedule,
      clearInterval: timers.cancel,
    });

    await flushMicrotasks();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Team cycle grant pass failed: x");

    // The failure did not end the schedule: the next tick still runs.
    timers.calls[0]?.callback();
    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(2);

    stop();
  });

  it("BL-44: stop ends the schedule", async () => {
    const timers = captureSchedule();
    const grant = vi.fn<Grant>(async () => undefined);

    const { stop } = startTeamCycleGrant({
      grant,
      setInterval: timers.schedule,
      clearInterval: timers.cancel,
    });

    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(1);

    stop();

    // The timer that was armed is the one that was cancelled.
    expect(timers.cleared()).toEqual([timers.handles[0]]);

    timers.calls[0]?.callback();
    await flushMicrotasks();
    expect(grant).toHaveBeenCalledTimes(1);
  });
});

// ── Real SQL, through PGlite ─────────────────────────────────

const OWNER_ID = "00000000-0000-0000-0000-00000000e001";
const MEMBER_A_ID = "00000000-0000-0000-0000-00000000e002";
const MEMBER_B_ID = "00000000-0000-0000-0000-00000000e003";

let db: PGlite;
let teamWorkspaceId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function cycleGrantRows(): Promise<number> {
  const result = await db.query<{ n: number }>(
    "select count(*)::int as n from public.credit_transactions " +
      "where workspace_id = $1 and transaction_type = 'cycle_grant'",
    [teamWorkspaceId],
  );
  return firstRow(result.rows).n;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Only personal workspaces exist at this point (the signup trigger makes
  // them), which is exactly the state the "no team workspace" case needs.
  for (const [id, email] of [
    [OWNER_ID, "owner-37r@hahart.test"],
    [MEMBER_A_ID, "member-a-37r@hahart.test"],
    [MEMBER_B_ID, "member-b-37r@hahart.test"],
  ] as const) {
    await createUser(db, id, email);
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("pool grant write repository: no team workspace", () => {
  it("BL-44: no team workspace grants nothing", async () => {
    const repository = createPoolGrantWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    const none = await db.query<{ n: number }>(
      "select count(*)::int as n from public.workspaces where type = 'team'",
    );
    expect(firstRow(none.rows).n).toBe(0);

    await expect(repository.grantTeamCycle()).resolves.toBeNull();

    const grants = await db.query<{ n: number }>(
      "select count(*)::int as n from public.credit_transactions " +
        "where transaction_type = 'cycle_grant'",
    );
    expect(firstRow(grants.rows).n).toBe(0);
  });
});

describe("pool grant write repository: a team workspace", () => {
  beforeAll(async () => {
    teamWorkspaceId = firstRow(
      (
        await db.query<{ id: string }>(
          "insert into public.workspaces (type, name, owner_user_id) " +
            "values ('team', $1, $2) returning id",
          ["HaHart Team", OWNER_ID],
        )
      ).rows,
    ).id;

    // grant_team_cycle's default limit is members * 20000, so exactly three
    // members make "60000" a number this file can predict.
    for (const [userId, role] of [
      [OWNER_ID, "owner"],
      [MEMBER_A_ID, "member"],
      [MEMBER_B_ID, "member"],
    ] as const) {
      await db.query(
        "insert into public.workspace_members (workspace_id, user_id, role) " +
          "values ($1, $2, $3::public.workspace_member_role)",
        [teamWorkspaceId, userId, role],
      );
    }

    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from public.workspace_members where workspace_id = $1",
      [teamWorkspaceId],
    );
    expect(firstRow(count.rows).n).toBe(3);
  });

  it("BL-44: the repository grants the team workspace once per month", async () => {
    const repository = createPoolGrantWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    await expect(repository.grantTeamCycle()).resolves.toBe(60000);
    // Same month, second call: the function answers the same limit and writes
    // nothing — this is the property the ten-minute timer relies on.
    await expect(repository.grantTeamCycle()).resolves.toBe(60000);

    expect(await cycleGrantRows()).toBe(1);

    const pools = await db.query<{ pool_limit: number; pool_used: number }>(
      "select pool_limit, pool_used from public.team_credit_pools " +
        "where workspace_id = $1 " +
        "and period_month = date_trunc('month', now() at time zone 'Asia/Shanghai')::date",
      [teamWorkspaceId],
    );
    expect(pools.rows).toEqual([{ pool_limit: 60000, pool_used: 0 }]);
  });

  it("BL-45: daily credits through the repository are granted once", async () => {
    const repository = createPoolGrantWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    const input = { userId: MEMBER_A_ID, workspaceId: teamWorkspaceId };

    await expect(repository.grantDailyCredits(input)).resolves.toBe(true);
    // Same day, second call: nothing more is granted.
    await expect(repository.grantDailyCredits(input)).resolves.toBe(false);

    const wallet = await db.query<{ daily_balance: number; is_today: boolean }>(
      "select daily_balance, " +
        "(daily_date = (now() at time zone 'Asia/Shanghai')::date) as is_today " +
        "from public.user_credit_wallets where user_id = $1",
      [MEMBER_A_ID],
    );
    expect(wallet.rows).toEqual([{ daily_balance: 100, is_today: true }]);

    const grants = await db.query<{ n: number }>(
      "select count(*)::int as n from public.credit_transactions " +
        "where user_id = $1 and transaction_type = 'daily_grant'",
      [MEMBER_A_ID],
    );
    expect(firstRow(grants.rows).n).toBe(1);
  });
});

describe("shouldStartTeamCycleGrant (workorder 38I)", () => {
  it("T-108: the worker does not start the team cycle grant with the switch off", () => {
    expect(shouldStartTeamCycleGrant({})).toBe(false);
    expect(shouldStartTeamCycleGrant({ LOOMIC_CREDIT_POOLS: "off" })).toBe(
      false,
    );
    expect(shouldStartTeamCycleGrant({ LOOMIC_CREDIT_POOLS: "true" })).toBe(
      false,
    );
    // Only the bare lowercase `on` opens the switch, exactly as 37T ruled.
    expect(shouldStartTeamCycleGrant({ LOOMIC_CREDIT_POOLS: "ON" })).toBe(false);
  });

  it("T-108: the worker starts the team cycle grant with the switch on", () => {
    expect(shouldStartTeamCycleGrant({ LOOMIC_CREDIT_POOLS: "on" })).toBe(true);
  });
});
