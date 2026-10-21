import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37O · BL-44 / BL-45 第 4 步 —— 池额度发放函数。
 *
 * 迁移 `20261021000006_hahart_credit_cycle_types.sql` 补三个流水类型，
 * `20261021000007_hahart_credit_cycle_grants.sql` 新增 `public.grant_team_cycle`
 * （月初团队池发放 + 重置）与 `public.grant_daily_credits`（每日赠送入钱包）。
 * 这里用 PGlite 跑真实 SQL。月键 / 日键一律北京时间。
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const PREV_MONTH_SQL = `(${MONTH_SQL} - interval '1 month')::date`;
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let userSeq = 0;

type Actor = { userId: string; workspaceId: string };

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-error";
}

/** 每例一个新用户：signup trigger 建个人工作区，池 / 钱包 / 流水互不干扰。 */
async function newActor(): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000037c${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37o-${userSeq}@hahart.test`);

  const ws = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [userId],
  );
  const row = ws.rows[0];
  if (!row) throw new Error("signup did not create a personal workspace");
  return { userId, workspaceId: row.id };
}

/** 把工作区补成恰好 3 个成员（个人工作区已有 owner 一个）。 */
async function makeThreeMemberTeam(actor: Actor): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    userSeq += 1;
    const memberId = `00000000-0000-0000-0000-000000037d${String(userSeq).padStart(2, "0")}`;
    await createUser(db, memberId, `member-37o-${userSeq}@hahart.test`);
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [actor.workspaceId, memberId],
    );
  }
  const count = await db.query<{ count: number }>(
    "select count(*)::int as count from public.workspace_members where workspace_id = $1",
    [actor.workspaceId],
  );
  expect(count.rows[0]?.count).toBe(3);
}

async function grantCycle(
  actor: Actor,
  month: string | null = null,
  limit: number | null = null,
): Promise<number> {
  const result = await db.query<{ v: number }>(
    "select public.grant_team_cycle($1, $2::date, $3::int) as v",
    [actor.workspaceId, month, limit],
  );
  const row = result.rows[0];
  if (!row) throw new Error("grant_team_cycle returned no row");
  return row.v;
}

async function grantDaily(actor: Actor): Promise<boolean> {
  const result = await db.query<{ v: boolean }>(
    "select public.grant_daily_credits($1, $2) as v",
    [actor.userId, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("grant_daily_credits returned no row");
  return row.v;
}

async function monthPools(
  actor: Actor,
  monthSql: string,
): Promise<Array<{ pool_limit: number; pool_used: number }>> {
  const result = await db.query<{ pool_limit: number; pool_used: number }>(
    `select pool_limit, pool_used from public.team_credit_pools
     where workspace_id = $1 and period_month = ${monthSql}`,
    [actor.workspaceId],
  );
  return result.rows;
}

async function setPoolRow(
  actor: Actor,
  monthSql: string,
  limit: number,
  used: number,
): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1, ${monthSql}, $2, $3)`,
    [actor.workspaceId, limit, used],
  );
}

type TxRow = { amount: number; pool: string | null };

async function txOfType(actor: Actor, type: string): Promise<TxRow[]> {
  const result = await db.query<TxRow>(
    `select amount, pool from public.credit_transactions
     where workspace_id = $1 and transaction_type = $2::public.credit_transaction_type
     order by created_at, id`,
    [actor.workspaceId, type],
  );
  return result.rows;
}

async function setWallet(
  actor: Actor,
  daily: number,
  topup: number,
  dayOffset: number,
): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1, ${TODAY_SQL} - $2::int, $3, $4)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [actor.userId, dayOffset, daily, topup],
  );
}

async function walletRow(actor: Actor): Promise<{
  daily_balance: number;
  topup_balance: number;
  is_today: boolean;
}> {
  const result = await db.query<{
    daily_balance: number;
    topup_balance: number;
    is_today: boolean;
  }>(
    `select daily_balance, topup_balance, (daily_date = ${TODAY_SQL}) as is_today
     from public.user_credit_wallets where user_id = $1`,
    [actor.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("no wallet row");
  return row;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("credit cycle grants (37O)", () => {
  it("BL-44: a three-member team starts the month with 60000", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);

    expect(await grantCycle(actor)).toBe(60000);

    expect(await monthPools(actor, MONTH_SQL)).toEqual([{ pool_limit: 60000, pool_used: 0 }]);
    expect(await txOfType(actor, "cycle_grant")).toEqual([{ amount: 60000, pool: "team" }]);
  });

  it("BL-44: granting twice in a month grants once", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);

    expect(await grantCycle(actor)).toBe(60000);
    expect(await grantCycle(actor)).toBe(60000);

    expect(await monthPools(actor, MONTH_SQL)).toHaveLength(1);
    expect(await txOfType(actor, "cycle_grant")).toHaveLength(1);
  });

  it("BL-44: last month's remainder is reset before the new grant", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    await setPoolRow(actor, PREV_MONTH_SQL, 60000, 47655);

    expect(await grantCycle(actor)).toBe(60000);

    expect(await txOfType(actor, "cycle_reset")).toEqual([{ amount: -12345, pool: "team" }]);
    expect(await txOfType(actor, "cycle_grant")).toEqual([{ amount: 60000, pool: "team" }]);
    expect(await monthPools(actor, PREV_MONTH_SQL)).toEqual([
      { pool_limit: 60000, pool_used: 47655 },
    ]);
  });

  it("BL-44: an exhausted last month writes no reset", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    await setPoolRow(actor, PREV_MONTH_SQL, 60000, 60000);

    expect(await grantCycle(actor)).toBe(60000);

    expect(await txOfType(actor, "cycle_reset")).toHaveLength(0);
    expect(await txOfType(actor, "cycle_grant")).toHaveLength(1);
  });

  it("BL-44: an admin-set limit overrides the default", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);

    expect(await grantCycle(actor, null, 50000)).toBe(50000);

    expect(await monthPools(actor, MONTH_SQL)).toEqual([{ pool_limit: 50000, pool_used: 0 }]);
  });

  it("BL-44: a month key must be a first day", async () => {
    const actor = await newActor();

    const code = await sqlState(grantCycle(actor, "2026-10-15"));

    expect(code).toBe("22023");
  });

  it("BL-45: daily credits are granted once a day", async () => {
    const actor = await newActor();

    expect(await grantDaily(actor)).toBe(true);
    expect(await walletRow(actor)).toEqual({
      daily_balance: 100,
      topup_balance: 0,
      is_today: true,
    });

    expect(await grantDaily(actor)).toBe(false);
    expect(await txOfType(actor, "daily_grant")).toEqual([{ amount: 100, pool: "daily" }]);
  });

  it("BL-45: yesterday's unspent daily credits expire", async () => {
    const actor = await newActor();
    await setWallet(actor, 40, 0, 1);

    expect(await grantDaily(actor)).toBe(true);

    expect(await txOfType(actor, "daily_expire")).toEqual([{ amount: -40, pool: "daily" }]);
    expect(await txOfType(actor, "daily_grant")).toEqual([{ amount: 100, pool: "daily" }]);
    expect((await walletRow(actor)).daily_balance).toBe(100);
  });

  it("BL-45: top-up is untouched by the daily grant", async () => {
    const actor = await newActor();
    await setWallet(actor, 0, 500, 1);

    expect(await grantDaily(actor)).toBe(true);

    expect((await walletRow(actor)).topup_balance).toBe(500);
  });

  it("37N: a freshly granted month can be charged", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    expect(await grantCycle(actor)).toBe(60000);

    const charged = await db.query<{ id: string | null }>(
      "select public.deduct_from_pools($1, $2, $3, null, 'test') as id",
      [actor.workspaceId, actor.userId, 30],
    );
    expect(charged.rows[0]?.id).toBeTruthy();

    expect(await monthPools(actor, MONTH_SQL)).toEqual([{ pool_limit: 60000, pool_used: 30 }]);
  });

  it("security: only the service role may call them", async () => {
    const actor = await newActor();

    const cycleCode = await sqlState(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.grant_team_cycle($1, null, null)", [actor.workspaceId]),
      ),
    );
    const dailyCode = await sqlState(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.grant_daily_credits($1, $2)", [actor.userId, actor.workspaceId]),
      ),
    );

    expect(cycleCode).toBe("42501");
    expect(dailyCode).toBe("42501");
  });
});
