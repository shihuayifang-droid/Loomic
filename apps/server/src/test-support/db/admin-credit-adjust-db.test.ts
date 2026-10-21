import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37U - BL-12 / BL-01 / AD-01 step 1: `public.admin_adjust_topup` and `public.set_personal_cap`.
 *
 * Migration `20261021000009_hahart_admin_credit_adjust.sql`. Adjustments land in the top-up pool,
 * never count against the personal cap, and a deduction larger than the pool is refused with
 * P0405 whose `detail` carries the maximum. Real SQL on PGlite.
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let userSeq = 0;

type Actor = { userId: string; workspaceId: string };

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

type SqlFailure = { code: string; detail: string | null };

async function sqlFailure(run: Promise<unknown>): Promise<SqlFailure> {
  try {
    await run;
  } catch (error) {
    const e = error as { code?: unknown; detail?: unknown };
    return {
      code: String(e.code),
      detail: typeof e.detail === "string" ? e.detail : null,
    };
  }
  return { code: "no-error", detail: null };
}

/** One new user per case: signup creates the personal workspace, so nothing is shared. */
async function newActor(): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000037d${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37u-${userSeq}@hahart.test`);

  const row = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  );
  return { userId, workspaceId: row.id };
}

async function adjust(
  actor: Actor,
  operatorId: string | null,
  delta: number | null,
  reason: string | null,
): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as id",
        [actor.workspaceId, actor.userId, operatorId, delta, reason],
      )
    ).rows,
  ).id;
}

async function topup(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ topup_balance: number }>(
        "select topup_balance from public.user_credit_wallets where user_id = $1::uuid",
        [actor.userId],
      )
    ).rows,
  ).topup_balance;
}

async function countAdjustments(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n from public.credit_transactions
         where workspace_id = $1::uuid and transaction_type = 'admin_adjustment'`,
        [actor.workspaceId],
      )
    ).rows,
  ).n;
}

type TxRow = {
  amount: number;
  balance_after: number;
  transaction_type: string;
  pool: string | null;
  metadata: Record<string, unknown> | null;
};

async function txById(id: string): Promise<TxRow> {
  return firstRow(
    (
      await db.query<TxRow>(
        `select amount, balance_after, transaction_type::text as transaction_type, pool, metadata
         from public.credit_transactions where id = $1::uuid`,
        [id],
      )
    ).rows,
  );
}

type UsageRow = { used: number; personal_cap: number };

async function usageRows(actor: Actor): Promise<UsageRow[]> {
  return (
    await db.query<UsageRow>(
      `select used, personal_cap from public.member_team_usage
       where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
      [actor.workspaceId, actor.userId],
    )
  ).rows;
}

async function setCap(actor: Actor, cap: number | null, month: string | null = null): Promise<number> {
  return firstRow(
    (
      await db.query<{ cap: number }>(
        "select public.set_personal_cap($1::uuid, $2::uuid, $3::integer, $4::date) as cap",
        [actor.workspaceId, actor.userId, cap, month],
      )
    ).rows,
  ).cap;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("admin_adjust_topup / set_personal_cap (37U)", () => {
  it("BL-12: +500 lands in the top-up pool", async () => {
    const actor = await newActor();
    const operator = await newActor();

    const id = await adjust(actor, operator.userId, 500, "补发");

    expect(await topup(actor)).toBe(500);
    const tx = await txById(id);
    expect(tx.amount).toBe(500);
    expect(tx.balance_after).toBe(500);
    expect(tx.transaction_type).toBe("admin_adjustment");
    expect(tx.pool).toBe("topup");
    expect(tx.metadata).toEqual({
      operator_id: operator.userId,
      reason: "补发",
      balance_before: 0,
      balance_after: 500,
    });
  });

  it("BL-12: an adjustment does not count against the personal cap", async () => {
    const actor = await newActor();
    const operator = await newActor();

    await adjust(actor, operator.userId, 500, "补发");

    const rows = await usageRows(actor);
    expect(rows.length === 0 || rows.every((row) => row.used === 0)).toBe(true);
  });

  it("BL-12: taking more than the top-up holds is refused with the maximum", async () => {
    const actor = await newActor();
    const operator = await newActor();
    await adjust(actor, operator.userId, 500, "补发");

    const failure = await sqlFailure(adjust(actor, operator.userId, -800, "扣回"));

    expect(failure.code).toBe("P0405");
    expect(failure.detail).toBe("500");
    expect(await topup(actor)).toBe(500);
    expect(await countAdjustments(actor)).toBe(1);
  });

  it("BL-12: taking exactly what is there is allowed", async () => {
    const actor = await newActor();
    const operator = await newActor();
    await adjust(actor, operator.userId, 500, "补发");

    await adjust(actor, operator.userId, -500, "扣回");

    expect(await topup(actor)).toBe(0);
    expect(await countAdjustments(actor)).toBe(2);
  });

  it("BL-12: a reason is required", async () => {
    const actor = await newActor();
    const operator = await newActor();

    const blank = await sqlFailure(adjust(actor, operator.userId, 500, "   "));
    const missing = await sqlFailure(adjust(actor, operator.userId, 500, null));

    expect(blank.code).toBe("22023");
    expect(missing.code).toBe("22023");
    expect(await countAdjustments(actor)).toBe(0);
  });

  it("BL-12: a zero adjustment is refused", async () => {
    const actor = await newActor();
    const operator = await newActor();

    const failure = await sqlFailure(adjust(actor, operator.userId, 0, "无"));

    expect(failure.code).toBe("22023");
    expect(await countAdjustments(actor)).toBe(0);
  });

  it("BL-01: the personal cap can be raised", async () => {
    const actor = await newActor();
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, used)
       values ($1::uuid, $2::uuid, ${MONTH_SQL}, 123)`,
      [actor.workspaceId, actor.userId],
    );

    const cap = await setCap(actor, 30000);

    expect(cap).toBe(30000);
    expect(await usageRows(actor)).toEqual([{ used: 123, personal_cap: 30000 }]);
  });

  it("BL-01: the new cap is what the charge function enforces", async () => {
    const actor = await newActor();
    await db.query(
      `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
       values ($1::uuid, ${MONTH_SQL}, 60000, 0)`,
      [actor.workspaceId],
    );
    await setCap(actor, 100);

    const over = await sqlFailure(
      db.query("select public.deduct_from_pools($1::uuid, $2::uuid, 101, null, 'test')", [
        actor.workspaceId,
        actor.userId,
      ]),
    );
    expect(over.code).toBe("P0403");

    await db.query("select public.deduct_from_pools($1::uuid, $2::uuid, 100, null, 'test')", [
      actor.workspaceId,
      actor.userId,
    ]);
    expect(await usageRows(actor)).toEqual([{ used: 100, personal_cap: 100 }]);
  });

  it("BL-01: a cap month must be a first day; a cap must not be negative", async () => {
    const actor = await newActor();

    const badMonth = await sqlFailure(setCap(actor, 30000, "2026-10-15"));
    const badCap = await sqlFailure(setCap(actor, -1));

    expect(badMonth.code).toBe("22023");
    expect(badCap.code).toBe("22023");
  });

  it("security: only the service role may call them", async () => {
    const actor = await newActor();
    const operator = await newActor();

    const adjustCall = await sqlFailure(
      asUser(db, actor.userId, (tx) =>
        tx.query(
          "select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, 500, 'x')",
          [actor.workspaceId, actor.userId, operator.userId],
        ),
      ),
    );
    const capCall = await sqlFailure(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.set_personal_cap($1::uuid, $2::uuid, 30000)", [
          actor.workspaceId,
          actor.userId,
        ]),
      ),
    );

    expect(adjustCall.code).toBe("42501");
    expect(capCall.code).toBe("42501");
  });
});
