import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37M · BL-44 / BL-02 / BL-45 第 2 步 —— 三池账本表的约束与 RLS。
 *
 * 迁移 `20261021000004_hahart_credit_pools.sql` 只建表与读写约束：
 * 团队周期池（总额与已用分开存）、成员本月团队池用量、个人钱包（每日 / 充值分开存），
 * 以及 credit_transactions 的两个可空池字段。这里用 PGlite 跑真实 SQL。
 */

const USER_OWNER = "00000000-0000-0000-0000-000000037a01";
const USER_MEMBER = "00000000-0000-0000-0000-000000037a02";
const USER_OUTSIDER = "00000000-0000-0000-0000-000000037a03";

let db: PGlite;
let teamId: string;
let outsiderWorkspaceId: string;

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-error";
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  await createUser(db, USER_OWNER, "owner-37m@hahart.test");
  await createUser(db, USER_MEMBER, "member-37m@hahart.test");
  await createUser(db, USER_OUTSIDER, "outsider-37m@hahart.test");

  const team = await db.query<{ id: string }>(
    "select public.ensure_team_workspace($1, $2) as id",
    [USER_OWNER, "HaHart 37M"],
  );
  const teamRow = team.rows[0];
  if (!teamRow) throw new Error("ensure_team_workspace returned no row");
  teamId = teamRow.id;

  await db.query("select public.add_team_member($1, $2)", [USER_MEMBER, "member"]);

  const other = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [USER_OUTSIDER],
  );
  const otherRow = other.rows[0];
  if (!otherRow) throw new Error("signup did not create a personal workspace");
  outsiderWorkspaceId = otherRow.id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("credit pools tables (37M)", () => {
  it("BL-02: the team pool keeps used and limit apart", async () => {
    await db.query(
      "insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used) values ($1, '2026-10-01', 60000, 12345)",
      [teamId],
    );

    const result = await db.query<{ pool_limit: number; pool_used: number; remaining: number }>(
      `select pool_limit, pool_used, pool_limit - pool_used as remaining
       from public.team_credit_pools where workspace_id = $1 and period_month = '2026-10-01'`,
      [teamId],
    );

    expect(result.rows[0]).toEqual({ pool_limit: 60000, pool_used: 12345, remaining: 47655 });
  });

  it("BL-44: a pool row is one calendar month", async () => {
    const code = await sqlState(
      db.query(
        "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2026-10-15', 100)",
        [teamId],
      ),
    );

    expect(code).toBe("23514");
  });

  it("BL-44: one pool per workspace per month", async () => {
    await db.query(
      "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2026-11-01', 100)",
      [teamId],
    );

    const code = await sqlState(
      db.query(
        "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2026-11-01', 200)",
        [teamId],
      ),
    );

    expect(code).toBe("23505");
  });

  it("BL-02: used can never go negative", async () => {
    const poolCode = await sqlState(
      db.query(
        "insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used) values ($1, '2026-12-01', 100, -1)",
        [teamId],
      ),
    );
    const memberCode = await sqlState(
      db.query(
        "insert into public.member_team_usage (workspace_id, user_id, period_month, used) values ($1, $2, '2026-10-01', -1)",
        [teamId, USER_MEMBER],
      ),
    );

    expect(poolCode).toBe("23514");
    expect(memberCode).toBe("23514");
  });

  it("BL-45: a member's personal cap defaults to 20000", async () => {
    await db.query(
      "insert into public.member_team_usage (workspace_id, user_id, period_month) values ($1, $2, '2026-10-01')",
      [teamId, USER_MEMBER],
    );

    const result = await db.query<{ personal_cap: number; used: number }>(
      `select personal_cap, used from public.member_team_usage
       where workspace_id = $1 and user_id = $2 and period_month = '2026-10-01'`,
      [teamId, USER_MEMBER],
    );

    expect(result.rows[0]).toEqual({ personal_cap: 20000, used: 0 });
  });

  it("BL-45: the wallet keeps daily and top-up apart", async () => {
    await db.query(
      "insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance) values ($1, '2026-10-21', 100, 0)",
      [USER_OWNER],
    );

    const result = await db.query<{ daily_balance: number; topup_balance: number; daily_date: string }>(
      `select daily_balance, topup_balance, to_char(daily_date, 'YYYY-MM-DD') as daily_date
       from public.user_credit_wallets where user_id = $1`,
      [USER_OWNER],
    );
    expect(result.rows[0]).toEqual({ daily_balance: 100, topup_balance: 0, daily_date: "2026-10-21" });

    const code = await sqlState(
      db.query("update public.user_credit_wallets set topup_balance = -5 where user_id = $1", [
        USER_OWNER,
      ]),
    );
    expect(code).toBe("23514");
  });

  it("BL-06: a ledger row may name its pool", async () => {
    const balance = await db.query<{ balance: number }>(
      "select balance from public.credit_balances where workspace_id = $1",
      [teamId],
    );
    const balanceAfter = balance.rows[0]?.balance ?? 0;

    const insertRow = (pool: string | null) =>
      db.query(
        `insert into public.credit_transactions (workspace_id, user_id, transaction_type, amount, balance_after, pool)
         values ($1, $2, 'generation_deduct', -5, $3, $4)`,
        [teamId, USER_OWNER, balanceAfter, pool],
      );

    await insertRow("topup");
    const code = await sqlState(insertRow("other"));
    await insertRow(null);

    const stored = await db.query<{ pool: string | null }>(
      "select pool from public.credit_transactions where workspace_id = $1 order by created_at, id",
      [teamId],
    );

    expect(code).toBe("23514");
    expect(stored.rows.map((row) => row.pool)).toEqual(["topup", null]);
  });

  it("RLS: members read their own pool, outsiders read nothing", async () => {
    await db.query(
      "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2027-01-01', 777)",
      [teamId],
    );

    const asMember = await asUser(db, USER_MEMBER, (tx) =>
      tx.query("select pool_limit from public.team_credit_pools where period_month = '2027-01-01'"),
    );
    const asOutsider = await asUser(db, USER_OUTSIDER, (tx) =>
      tx.query("select pool_limit from public.team_credit_pools where period_month = '2027-01-01'"),
    );

    expect(asMember.rows).toEqual([{ pool_limit: 777 }]);
    expect(asOutsider.rows).toEqual([]);

    const insertCode = await sqlState(
      asUser(db, USER_MEMBER, (tx) =>
        tx.query(
          "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2027-02-01', 1)",
          [teamId],
        ),
      ),
    );
    const outsiderInsertCode = await sqlState(
      asUser(db, USER_OUTSIDER, (tx) =>
        tx.query(
          "insert into public.team_credit_pools (workspace_id, period_month, pool_limit) values ($1, '2027-02-01', 1)",
          [outsiderWorkspaceId],
        ),
      ),
    );

    expect(insertCode).toBe("42501");
    expect(outsiderInsertCode).toBe("42501");
  });

  it("RLS: a wallet is private", async () => {
    await db.query(
      "insert into public.user_credit_wallets (user_id, daily_balance) values ($1, 55) on conflict (user_id) do nothing",
      [USER_MEMBER],
    );

    const own = await asUser(db, USER_MEMBER, (tx) =>
      tx.query("select user_id from public.user_credit_wallets"),
    );
    const other = await asUser(db, USER_OUTSIDER, (tx) =>
      tx.query("select user_id from public.user_credit_wallets where user_id = $1", [USER_MEMBER]),
    );

    expect(own.rows).toEqual([{ user_id: USER_MEMBER }]);
    expect(other.rows).toEqual([]);
  });
});
