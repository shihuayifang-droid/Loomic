import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37N · BL-04 / BL-45 第 3 步 —— 按池扣费函数 `public.deduct_from_pools`。
 *
 * 迁移 `20261021000005_hahart_deduct_from_pools.sql` 新增函数，算法与 37L 的
 * `planDeduction` 一致：先每日 -> 再团队（受个人月上限）-> 再充值；凑不够整笔拒绝，
 * 用 P0402 / P0403 / P0404 三个 SQLSTATE 区分。这里用 PGlite 跑真实 SQL。
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
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
  const userId = `00000000-0000-0000-0000-000000037b${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37n-${userSeq}@hahart.test`);

  const ws = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [userId],
  );
  const row = ws.rows[0];
  if (!row) throw new Error("signup did not create a personal workspace");
  return { userId, workspaceId: row.id };
}

async function setPool(actor: Actor, limit: number, used: number): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1, ${MONTH_SQL}, $2, $3)`,
    [actor.workspaceId, limit, used],
  );
}

async function setMemberUsage(actor: Actor, used: number): Promise<void> {
  await db.query(
    `insert into public.member_team_usage (workspace_id, user_id, period_month, used)
     values ($1, $2, ${MONTH_SQL}, $3)`,
    [actor.workspaceId, actor.userId, used],
  );
}

async function setWallet(actor: Actor, daily: number, topup: number, dayOffset = 0): Promise<void> {
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

async function deduct(actor: Actor, amount: number): Promise<string | null> {
  const result = await db.query<{ id: string | null }>(
    "select public.deduct_from_pools($1, $2, $3, null, 'test') as id",
    [actor.workspaceId, actor.userId, amount],
  );
  const row = result.rows[0];
  if (!row) throw new Error("deduct_from_pools returned no row");
  return row.id;
}

async function wallet(actor: Actor): Promise<{ daily_balance: number; topup_balance: number }> {
  const result = await db.query<{ daily_balance: number; topup_balance: number }>(
    "select daily_balance, topup_balance from public.user_credit_wallets where user_id = $1",
    [actor.userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("no wallet row");
  return row;
}

async function poolUsed(actor: Actor): Promise<number> {
  const result = await db.query<{ pool_used: number }>(
    `select pool_used from public.team_credit_pools
     where workspace_id = $1 and period_month = ${MONTH_SQL}`,
    [actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("no pool row");
  return row.pool_used;
}

async function memberUsage(
  actor: Actor,
): Promise<{ used: number; personal_cap: number } | undefined> {
  const result = await db.query<{ used: number; personal_cap: number }>(
    `select used, personal_cap from public.member_team_usage
     where workspace_id = $1 and user_id = $2 and period_month = ${MONTH_SQL}`,
    [actor.workspaceId, actor.userId],
  );
  return result.rows[0];
}

async function txRows(actor: Actor): Promise<number> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from public.credit_transactions
     where workspace_id = $1 and transaction_type = 'generation_deduct'`,
    [actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("count returned no row");
  return row.count;
}

async function txById(id: string): Promise<{
  pool: string | null;
  pool_breakdown: Record<string, number>;
  amount: number;
}> {
  const result = await db.query<{
    pool: string | null;
    pool_breakdown: Record<string, number>;
    amount: number;
  }>("select pool, pool_breakdown, amount from public.credit_transactions where id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("no transaction row");
  return row;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("deduct_from_pools (37N)", () => {
  it("BL-04: daily is spent first", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 0);
    await setWallet(actor, 100, 0);

    const id = await deduct(actor, 30);
    if (!id) throw new Error("expected a transaction id");

    expect(await wallet(actor)).toEqual({ daily_balance: 70, topup_balance: 0 });
    expect(await poolUsed(actor)).toBe(0);

    const tx = await txById(id);
    expect(tx.pool).toBe("daily");
    expect(tx.pool_breakdown).toEqual({ daily: 30, team: 0, topup: 0 });
    expect(tx.amount).toBe(-30);
  });

  it("BL-04: then the team pool, then top-up", async () => {
    const actor = await newActor();
    await setPool(actor, 100, 0);
    await setWallet(actor, 10, 50);

    const id = await deduct(actor, 130);
    if (!id) throw new Error("expected a transaction id");

    expect(await wallet(actor)).toEqual({ daily_balance: 0, topup_balance: 30 });
    expect(await poolUsed(actor)).toBe(100);
    expect((await memberUsage(actor))?.used).toBe(100);

    const tx = await txById(id);
    expect(tx.pool).toBeNull();
    expect(tx.pool_breakdown).toEqual({ daily: 10, team: 100, topup: 20 });
  });

  it("BL-45: a member at 19990 of the cap cannot take a 12-credit job", async () => {
    const actor = await newActor();
    await setPool(actor, 50000, 19990);
    await setMemberUsage(actor, 19990);
    await setWallet(actor, 0, 0);

    expect(await sqlState(deduct(actor, 12))).toBe("P0403");

    await db.query("update public.user_credit_wallets set topup_balance = 100 where user_id = $1", [
      actor.userId,
    ]);

    const id = await deduct(actor, 12);
    if (!id) throw new Error("expected a transaction id");
    const tx = await txById(id);
    expect(tx.pool_breakdown).toEqual({ daily: 0, team: 10, topup: 2 });
  });

  it("BL-45: an empty team pool says so", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 60000);
    await setMemberUsage(actor, 0);
    await setWallet(actor, 0, 0);

    expect(await sqlState(deduct(actor, 1))).toBe("P0404");
  });

  it("BL-45: a member with no pool this month is told the team pool is empty", async () => {
    const actor = await newActor();

    expect(await sqlState(deduct(actor, 1))).toBe("P0404");
  });

  it("BL-45: a member with no team allowance at all is just out of credits", async () => {
    const actor = await newActor();
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap, used)
       values ($1, $2, ${MONTH_SQL}, 0, 0)`,
      [actor.workspaceId, actor.userId],
    );

    expect(await sqlState(deduct(actor, 1))).toBe("P0402");
  });

  it("BL-45: a refused charge changes nothing", async () => {
    const actor = await newActor();
    await setPool(actor, 50000, 19990);
    await setMemberUsage(actor, 19990);
    await setWallet(actor, 0, 0);

    const before = {
      pool: await poolUsed(actor),
      member: await memberUsage(actor),
      wallet: await wallet(actor),
      rows: await txRows(actor),
    };

    expect(await sqlState(deduct(actor, 12))).toBe("P0403");

    expect(await poolUsed(actor)).toBe(before.pool);
    expect(await memberUsage(actor)).toEqual(before.member);
    expect(await wallet(actor)).toEqual(before.wallet);
    expect(await txRows(actor)).toBe(before.rows);
  });

  it("BL-45: yesterday's daily credits are not spent", async () => {
    const actor = await newActor();
    await setWallet(actor, 100, 0, 1);

    expect(await sqlState(deduct(actor, 1))).toBe("P0404");
    expect((await wallet(actor)).daily_balance).toBe(100);
  });

  it("BL-04: a missing usage row is created at the default cap", async () => {
    const actor = await newActor();
    await setPool(actor, 1000, 0);
    await setWallet(actor, 0, 0);

    expect(await memberUsage(actor)).toBeUndefined();

    await deduct(actor, 5);

    expect(await memberUsage(actor)).toEqual({ used: 5, personal_cap: 20000 });
    expect(await poolUsed(actor)).toBe(5);
  });

  it("BL-45: zero or negative amounts write nothing", async () => {
    const actor = await newActor();
    await setPool(actor, 1000, 0);
    await setWallet(actor, 10, 10);

    expect(await deduct(actor, 0)).toBeNull();
    expect(await deduct(actor, -3)).toBeNull();

    expect(await txRows(actor)).toBe(0);
    expect(await wallet(actor)).toEqual({ daily_balance: 10, topup_balance: 10 });
  });

  it("security: only the service role may call it", async () => {
    const actor = await newActor();
    await setWallet(actor, 10, 0);

    const code = await sqlState(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.deduct_from_pools($1, $2, $3, null, null)", [
          actor.workspaceId,
          actor.userId,
          1,
        ]),
      ),
    );

    expect(code).toBe("42501");
  });
});

/**
 * 工单40K · 《三池计费测试环境验收清单》3.1 / 3.2 —— 37N 已有用例没覆盖的两条。
 *
 * 个人月上限默认 20000（见上一条「a missing usage row is created at the default
 * cap」），所以 `setMemberUsage(actor, 19997)` 之后只剩 3 点团队额度。PGlite 是单
 * 连接，真行锁并发测不出来：3.2 这里只能验证连续两次扣费各池不为负、两条
 * breakdown 之和等于实扣总额。
 */
describe("deduct_from_pools: three-pool acceptance gaps (40K)", () => {
  it("BL-04: a cap of 3 left splits 12 as daily 5, team 3, top-up 4", async () => {
    const actor = await newActor();
    await setPool(actor, 20000, 0);
    await setMemberUsage(actor, 19997);
    await setWallet(actor, 5, 100);

    const id = await deduct(actor, 12);
    if (!id) throw new Error("expected a transaction id");

    expect(await txRows(actor)).toBe(1);
    const tx = await txById(id);
    expect(tx.pool_breakdown).toEqual({ daily: 5, team: 3, topup: 4 });
    expect(tx.amount).toBe(-12);
    expect(await wallet(actor)).toEqual({ daily_balance: 0, topup_balance: 96 });
    expect(await poolUsed(actor)).toBe(3);
    expect((await memberUsage(actor))?.used).toBe(20000);
  });

  it("BL-04: two charges in a row never drive a pool negative and add up", async () => {
    const actor = await newActor();
    await setPool(actor, 20000, 0);
    await setWallet(actor, 5, 10);

    const ids = await Promise.all([deduct(actor, 8), deduct(actor, 8)]);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();

    const remaining = await wallet(actor);
    expect(remaining.daily_balance).toBeGreaterThanOrEqual(0);
    expect(remaining.topup_balance).toBeGreaterThanOrEqual(0);

    let summed = 0;
    for (const id of ids) {
      if (!id) throw new Error("expected two transaction ids");
      const tx = await txById(id);
      expect(Object.keys(tx.pool_breakdown).sort()).toEqual(["daily", "team", "topup"]);
      summed += Object.values(tx.pool_breakdown).reduce((a, b) => a + b, 0);
    }
    expect(summed).toBe(16);

    expect(await txRows(actor)).toBe(2);
  });
});
