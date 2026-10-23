import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compensateRefunds } from "../../features/credits/compensate-refunds.js";
import { createCreditPoolWriteRepository } from "../../db/credit-pool-write-repository.js";
import {
  createRefundCompensationRepository,
  type RefundCompensationRepository,
} from "../../db/refund-compensation-repository.js";
import { createMigratedDb, createPGliteTransactionPool, createUser } from "./pglite-db.js";

/**
 * BL-41 acceptance (workorder 40K): a refund that failed once and was queued is
 * paid back through the THREE POOLS, exactly once.
 *
 * 39L proved the queue with the old payout (`refund_credits`). This case keeps
 * the same real collaborators — `record_refund_compensation`, the 39J
 * repository's `claimDue` / `finish`, the real `compensateRefunds` — and swaps
 * only the payout for the 37T pool writer, which calls `public.refund_to_pools`
 * (37S). That function reverses the charge from the `pool_breakdown` the
 * `generation_deduct` row recorded, so the assertions are about pools:
 *
 *   daily 5 + team 7 charged -> the compensator pays back daily 5 + team 7,
 *   the wallet is back to 5, the team pool and the member usage are back to 0,
 *   and one `generation_refund` row exists.
 *
 * The second pass rolls the queue row back to due, as a repeated tick would see
 * it. The payout stays idempotent per job (the 37S function returns the same
 * refund row), so nothing pays twice.
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

const OWNER = "00000000-0000-0000-0000-000000040a01";
const AMOUNT = 12;

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let repository: RefundCompensationRepository;
let poolWriter: ReturnType<typeof createCreditPoolWriteRepository>;
let workspaceId: string;

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Sign one user up and hand back the personal workspace the trigger created. */
async function newWorkspace(userId: string, emailSuffix: string): Promise<string> {
  await createUser(db, userId, `${emailSuffix}@hahart.test`);

  return firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

async function setPool(limit: number, used: number): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1::uuid, ${MONTH_SQL}, $2, $3)`,
    [workspaceId, limit, used],
  );
}

async function setWallet(daily: number, topup: number): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1::uuid, ${TODAY_SQL}, $2, $3)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [OWNER, daily, topup],
  );
}

/** A terminally failed image job in the personal workspace. */
async function insertFailedJob(): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs
           (workspace_id, queue_name, job_type, created_by, credits_cost, status)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid, $3::integer, 'failed')
         returning id`,
        [workspaceId, OWNER, AMOUNT],
      )
    ).rows,
  ).id;
}

/** The three-pool charge of the job: daily 5, then team 7. */
async function deduct(amount: number, jobId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string | null }>(
        "select public.deduct_from_pools($1::uuid, $2::uuid, $3, $4::uuid, 'test') as id",
        [workspaceId, OWNER, amount, jobId],
      )
    ).rows,
  ).id as string;
}

async function wallet(): Promise<{ daily_balance: number; topup_balance: number }> {
  return firstRow(
    (
      await db.query<{ daily_balance: number; topup_balance: number }>(
        "select daily_balance, topup_balance from public.user_credit_wallets where user_id = $1::uuid",
        [OWNER],
      )
    ).rows,
  );
}

async function poolUsed(): Promise<number> {
  return firstRow(
    (
      await db.query<{ pool_used: number }>(
        `select pool_used from public.team_credit_pools
         where workspace_id = $1::uuid and period_month = ${MONTH_SQL}`,
        [workspaceId],
      )
    ).rows,
  ).pool_used;
}

async function memberUsed(): Promise<number> {
  return firstRow(
    (
      await db.query<{ used: number }>(
        `select used from public.member_team_usage
         where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
        [workspaceId, OWNER],
      )
    ).rows,
  ).used;
}

async function dueNow(id: string): Promise<void> {
  await db.query(
    `update public.refund_compensations
        set next_attempt_at = now() - interval '1 minute'
      where id = $1::uuid`,
    [id],
  );
}

/** Roll a finished row back to "due", as a repeated tick would see it. */
async function reopen(id: string): Promise<void> {
  await db.query(
    `update public.refund_compensations
        set status = 'pending',
            next_attempt_at = now() - interval '1 minute',
            refund_transaction_id = null
      where id = $1::uuid`,
    [id],
  );
}

type QueueRow = {
  attempts: number;
  status: string;
  refund_transaction_id: string | null;
  last_error: string | null;
};

async function queueRow(id: string): Promise<QueueRow> {
  return firstRow(
    (
      await db.query<QueueRow>(
        `select attempts, status, refund_transaction_id, last_error
           from public.refund_compensations where id = $1::uuid`,
        [id],
      )
    ).rows,
  );
}

type RefundRow = {
  amount: number;
  job_id: string | null;
  pool_breakdown: Record<string, number> | null;
  metadata: Record<string, string> | null;
};

async function refundRows(): Promise<RefundRow[]> {
  return (
    await db.query<RefundRow>(
      `select amount, job_id::text as job_id, pool_breakdown, metadata
         from public.credit_transactions
        where workspace_id = $1::uuid and transaction_type = 'generation_refund'`,
      [workspaceId],
    )
  ).rows;
}

/** One pass of the real compensator, paying back through the pools (37T / 37S). */
async function runPass(log: (m: string) => void = () => {}): ReturnType<typeof compensateRefunds> {
  return compensateRefunds({
    claimDue: (limit) => repository.claimDue(limit),
    refund: async (input) => {
      const refundId = await poolWriter.refundToPools({
        jobId: input.jobId,
        description: input.description,
      });
      if (refundId === null) throw new Error("no pool refund for that job");
      return refundId;
    },
    finish: (input) => repository.finish(input),
    log,
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createRefundCompensationRepository({
    getTransactionPool: () => pool,
  });
  poolWriter = createCreditPoolWriteRepository({
    getTransactionPool: () => pool,
  });

  workspaceId = await newWorkspace(OWNER, "40k-pool-refund");
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("BL-41 (40K): pool refund compensation", () => {
  it("BL-41: a pool refund that failed once is paid back through the pools exactly once", async () => {
    await setPool(60000, 0);
    await setWallet(5, 0);
    const jobId = await insertFailedJob();

    const deductId = await deduct(AMOUNT, jobId);
    expect(await wallet()).toEqual({ daily_balance: 0, topup_balance: 0 });
    expect(await poolUsed()).toBe(7);
    expect(await memberUsed()).toBe(7);

    // The first refund attempt failed, so the job is queued as 39K does it.
    const id = await repository.record({
      jobId,
      workspaceId,
      userId: OWNER,
      amount: AMOUNT,
      description: "refund for job",
      markLinkRefunded: false,
      error: "first refund attempt failed",
    });

    expect(await refundRows()).toEqual([]);
    expect(await queueRow(id)).toMatchObject({ status: "pending", attempts: 0 });

    await dueNow(id);
    const first = await runPass();
    expect(first).toEqual({ done: 1, failed: 0, exhausted: 0 });

    const paid = await refundRows();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.amount).toBe(AMOUNT);
    expect(paid[0]?.job_id).toBe(jobId);
    expect(paid[0]?.pool_breakdown).toEqual({ daily: 5, team: 7, topup: 0 });
    expect(paid[0]?.metadata).toEqual({ original_transaction_id: deductId });

    expect(await wallet()).toEqual({ daily_balance: 5, topup_balance: 0 });
    expect(await poolUsed()).toBe(0);
    expect(await memberUsed()).toBe(0);

    const closed = await queueRow(id);
    expect(closed.status).toBe("done");
    expect(closed.attempts).toBe(1);
    expect(closed.refund_transaction_id).not.toBeNull();
    expect(closed.last_error).toBe("first refund attempt failed");

    // A repeated tick sees the same row due again: still one refund row.
    await reopen(id);
    const second = await runPass();

    expect(second).toEqual({ done: 1, failed: 0, exhausted: 0 });
    expect(await refundRows()).toHaveLength(1);
    expect(await wallet()).toEqual({ daily_balance: 5, topup_balance: 0 });
    expect(await poolUsed()).toBe(0);
    expect((await queueRow(id)).status).toBe("done");
  });
});
