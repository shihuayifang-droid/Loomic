import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单37S - BL-41 (1) (5) step 1: `public.refund_to_pools`.
 *
 * Migration `20261021000008_hahart_refund_to_pools.sql` refunds a job back to the pools its
 * charge came from (read from `pool_breakdown` on the `generation_deduct` row that
 * `deduct_from_pools` wrote). Credits whose daily pool already expired come back and are
 * expired again with a matching `daily_expire` row. Real SQL on PGlite.
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let userSeq = 0;

type Actor = { userId: string; workspaceId: string };

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-error";
}

/** One new user per case: signup creates the personal workspace, so nothing is shared. */
async function newActor(): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000037c${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-37s-${userSeq}@hahart.test`);

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

async function insertJob(actor: Actor): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [actor.workspaceId, actor.userId],
      )
    ).rows,
  ).id;
}

async function setPool(actor: Actor, limit: number, used: number): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1::uuid, ${MONTH_SQL}, $2, $3)`,
    [actor.workspaceId, limit, used],
  );
}

async function setWallet(actor: Actor, daily: number, topup: number): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1::uuid, ${TODAY_SQL}, $2, $3)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [actor.userId, daily, topup],
  );
}

async function deduct(actor: Actor, amount: number, jobId: string): Promise<string> {
  const row = firstRow(
    (
      await db.query<{ id: string | null }>(
        "select public.deduct_from_pools($1::uuid, $2::uuid, $3, $4::uuid, 'test') as id",
        [actor.workspaceId, actor.userId, amount, jobId],
      )
    ).rows,
  );
  if (!row.id) throw new Error("expected a deduction id");
  return row.id;
}

async function refund(jobId: string): Promise<string | null> {
  return firstRow(
    (
      await db.query<{ id: string | null }>("select public.refund_to_pools($1::uuid, 'test') as id", [
        jobId,
      ])
    ).rows,
  ).id;
}

async function wallet(actor: Actor): Promise<{ daily_balance: number; topup_balance: number }> {
  return firstRow(
    (
      await db.query<{ daily_balance: number; topup_balance: number }>(
        "select daily_balance, topup_balance from public.user_credit_wallets where user_id = $1::uuid",
        [actor.userId],
      )
    ).rows,
  );
}

async function poolUsed(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ pool_used: number }>(
        `select pool_used from public.team_credit_pools
         where workspace_id = $1::uuid and period_month = ${MONTH_SQL}`,
        [actor.workspaceId],
      )
    ).rows,
  ).pool_used;
}

async function memberUsed(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ used: number }>(
        `select used from public.member_team_usage
         where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
        [actor.workspaceId, actor.userId],
      )
    ).rows,
  ).used;
}

async function countType(actor: Actor, type: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n from public.credit_transactions
         where workspace_id = $1::uuid and transaction_type = $2::credit_transaction_type`,
        [actor.workspaceId, type],
      )
    ).rows,
  ).n;
}

type TxRow = {
  amount: number;
  pool: string | null;
  pool_breakdown: Record<string, number> | null;
  metadata: Record<string, string> | null;
  job_id: string | null;
};

async function txById(id: string): Promise<TxRow> {
  return firstRow(
    (
      await db.query<TxRow>(
        `select amount, pool, pool_breakdown, metadata, job_id::text as job_id
         from public.credit_transactions where id = $1::uuid`,
        [id],
      )
    ).rows,
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("refund_to_pools (37S)", () => {
  it("BL-41: a refund goes back to the pools it came from", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 0);
    await setWallet(actor, 5, 0);
    const jobId = await insertJob(actor);

    const deductId = await deduct(actor, 12, jobId);
    expect(await wallet(actor)).toEqual({ daily_balance: 0, topup_balance: 0 });
    expect(await poolUsed(actor)).toBe(7);
    expect(await memberUsed(actor)).toBe(7);

    const refundId = await refund(jobId);
    if (!refundId) throw new Error("expected a refund id");

    expect(await wallet(actor)).toEqual({ daily_balance: 5, topup_balance: 0 });
    expect(await poolUsed(actor)).toBe(0);
    expect(await memberUsed(actor)).toBe(0);

    const tx = await txById(refundId);
    expect(tx.amount).toBe(12);
    expect(tx.pool).toBeNull();
    expect(tx.pool_breakdown).toEqual({ daily: 5, team: 7, topup: 0 });
    expect(tx.metadata).toEqual({ original_transaction_id: deductId });
    expect(tx.job_id).toBe(jobId);
  });

  it("BL-41: refunding twice writes one refund", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 0);
    await setWallet(actor, 5, 0);
    const jobId = await insertJob(actor);
    await deduct(actor, 12, jobId);

    const first = await refund(jobId);
    const walletAfterFirst = await wallet(actor);
    const poolAfterFirst = await poolUsed(actor);
    const second = await refund(jobId);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await countType(actor, "generation_refund")).toBe(1);
    expect(await wallet(actor)).toEqual(walletAfterFirst);
    expect(await poolUsed(actor)).toBe(poolAfterFirst);
  });

  it("BL-41: top-up comes back to top-up", async () => {
    const actor = await newActor();
    await setWallet(actor, 0, 50);
    const jobId = await insertJob(actor);

    const deductId = await deduct(actor, 20, jobId);
    expect((await wallet(actor)).topup_balance).toBe(30);

    const refundId = await refund(jobId);
    if (!refundId) throw new Error("expected a refund id");

    expect(await wallet(actor)).toEqual({ daily_balance: 0, topup_balance: 50 });

    const tx = await txById(refundId);
    expect(tx.amount).toBe(20);
    expect(tx.pool).toBe("topup");
    expect(tx.pool_breakdown).toEqual({ daily: 0, team: 0, topup: 20 });
    expect(tx.metadata).toEqual({ original_transaction_id: deductId });
  });

  it("BL-41: daily credits refunded after midnight expire again", async () => {
    const actor = await newActor();
    await setWallet(actor, 5, 0);
    const jobId = await insertJob(actor);
    await deduct(actor, 5, jobId);

    // Simulate the job crossing midnight: the charge happened yesterday (Beijing time) and
    // today's own daily grant of 100 has already been issued.
    await db.query(
      `update public.credit_transactions
       set created_at = now() - interval '1 day'
       where job_id = $1::uuid and transaction_type = 'generation_deduct'`,
      [jobId],
    );
    await db.query(
      `update public.user_credit_wallets
       set daily_date = ${TODAY_SQL}, daily_balance = 100
       where user_id = $1::uuid`,
      [actor.userId],
    );

    const refundId = await refund(jobId);
    if (!refundId) throw new Error("expected a refund id");

    expect((await wallet(actor)).daily_balance).toBe(100);
    expect((await txById(refundId)).amount).toBe(5);

    const expired = await db.query<{ amount: number; pool: string | null }>(
      `select amount, pool from public.credit_transactions
       where workspace_id = $1::uuid and transaction_type = 'daily_expire'`,
      [actor.workspaceId],
    );
    expect(expired.rows).toEqual([{ amount: -5, pool: "daily" }]);
  });

  it("BL-41: a job never charged through the pools refunds nothing", async () => {
    const actor = await newActor();
    const jobId = await insertJob(actor);
    await db.query(
      `insert into public.credit_transactions
         (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
       values ($1::uuid, $2::uuid, 'generation_deduct', -5, 0, $3::uuid, 'old path')`,
      [actor.workspaceId, actor.userId, jobId],
    );

    expect(await refund(jobId)).toBeNull();
    expect(await countType(actor, "generation_refund")).toBe(0);
  });

  it("BL-41: a refund must name its job", async () => {
    const code = await sqlState(db.query("select public.refund_to_pools(null)"));

    expect(code).toBe("22023");
  });

  it("BL-41: the old and new refund paths cannot both pay", async () => {
    const actor = await newActor();
    await setPool(actor, 60000, 0);
    await setWallet(actor, 5, 0);
    const jobId = await insertJob(actor);
    await deduct(actor, 12, jobId);

    const refundId = await refund(jobId);
    const oldPath = firstRow(
      (
        await db.query<{ id: string }>(
          "select public.refund_credits($1::uuid, $2::uuid, 12, $3::uuid, 'x') as id",
          [actor.workspaceId, actor.userId, jobId],
        )
      ).rows,
    ).id;

    expect(oldPath).toBe(refundId);
    expect(await countType(actor, "generation_refund")).toBe(1);
  });

  it("security: only the service role may call it", async () => {
    const actor = await newActor();
    const jobId = await insertJob(actor);

    const code = await sqlState(
      asUser(db, actor.userId, (tx) =>
        tx.query("select public.refund_to_pools($1::uuid, null)", [jobId]),
      ),
    );

    expect(code).toBe("42501");
  });
});
