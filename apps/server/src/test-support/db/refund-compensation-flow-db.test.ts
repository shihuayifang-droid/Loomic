import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compensateRefunds } from "../../features/credits/compensate-refunds.js";
import {
  createRefundCompensationRepository,
  type RefundCompensationRepository,
} from "../../db/refund-compensation-repository.js";
import { createJobCreditsLinkRepository } from "../../db/job-credits-link-repository.js";
import { createMigratedDb, createPGliteTransactionPool, createUser } from "./pglite-db.js";

/**
 * BL-41 acceptance 2 (workorder 39L): a refund that failed once is paid back by
 * the compensator, and the workspace ends up with exactly ONE refund row.
 *
 * This is the whole loop, with the REAL collaborators — no doubles anywhere in
 * the money path:
 *
 *   `record_refund_compensation` (what 39K does when the first refund fails)
 *     -> the row is due
 *     -> `compensateRefunds` with the 39J repository's `claimDue` / `finish`
 *        and `refund_credits` for the payout
 *     -> one `generation_refund` row, queue row `done`.
 *
 * The second case rolls the row back to pending and runs the pass again: the
 * payout is idempotent per job (the partial unique index of
 * `20261021000003_hahart_refund_once_per_job.sql` plus `refund_credits`), so a
 * retry after a successful payout does not pay twice.
 *
 * The third case is the other half of the same contract: a FIRST-attempt failure
 * that is still retryable closes the row `pending`, never `exhausted`, and no
 * money moves.
 *
 * Time is simulated by rewriting `next_attempt_at`; nothing here sleeps.
 */

const OWNER = "00000000-0000-0000-0000-000000039b01";
const AMOUNT = 12;

let db: PGlite;
let pool: ReturnType<typeof createPGliteTransactionPool>;
let repository: RefundCompensationRepository;
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

async function setBalance(target: string, balance: number): Promise<void> {
  await db.query(
    "update public.credit_balances set balance = $2::integer where workspace_id = $1::uuid",
    [target, balance],
  );
}

async function currentBalance(target: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ balance: number }>(
        "select balance from public.credit_balances where workspace_id = $1::uuid",
        [target],
      )
    ).rows,
  ).balance;
}

/** A terminally failed image job whose credits were already taken. */
async function insertFailedJob(target: string, userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs
           (workspace_id, queue_name, job_type, created_by, credits_cost, status)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid, $3::integer, 'failed')
         returning id`,
        [target, userId, AMOUNT],
      )
    ).rows,
  ).id;
}

/** The charge row that has to be there before a refund means anything. */
async function insertCharge(
  target: string,
  userId: string,
  jobId: string,
): Promise<void> {
  await db.query(
    `insert into public.credit_transactions
       (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
     values ($1::uuid, $2::uuid, 'generation_deduct', $3::integer, 0, $4::uuid, 'charge')`,
    [target, userId, -AMOUNT, jobId],
  );
}

/** `refund_credits`: the old, idempotent-per-job payout the compensator calls. */
async function refundCredits(input: {
  workspaceId: string;
  userId: string;
  amount: number;
  jobId: string;
  description: string;
}): Promise<string> {
  return firstRow(
    (
      await db.query<{ refund_credits: string }>(
        `select public.refund_credits(
           $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::text
         ) as refund_credits`,
        [
          input.workspaceId,
          input.userId,
          input.amount,
          input.jobId,
          input.description,
        ],
      )
    ).rows,
  ).refund_credits;
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

type RefundRow = { amount: number; job_id: string | null };

async function refundRows(target: string): Promise<RefundRow[]> {
  return (
    await db.query<RefundRow>(
      `select amount, job_id
         from public.credit_transactions
        where workspace_id = $1::uuid and transaction_type = 'generation_refund'`,
      [target],
    )
  ).rows;
}

/** One pass of the real compensator, wired exactly as the worker wires it. */
async function runPass(log: (m: string) => void = () => {}): ReturnType<typeof compensateRefunds> {
  const creditsLink = createJobCreditsLinkRepository({
    getTransactionPool: () => pool,
  });

  return compensateRefunds({
    claimDue: (limit) => repository.claimDue(limit),
    refund: (input) => refundCredits(input),
    markLinkRefunded: (input) => creditsLink.markChargeRefunded(input),
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

  workspaceId = await newWorkspace(OWNER, "39l-flow");
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("BL-41 (2): a failed refund is compensated once", () => {
  it("BL-41 (2): loses the refund once, pays it back once, and never twice", async () => {
    await setBalance(workspaceId, 100);
    const jobId = await insertFailedJob(workspaceId, OWNER);
    await insertCharge(workspaceId, OWNER, jobId);

    // 39K: the first refund attempt failed, so the job is queued.
    const id = await repository.record({
      jobId,
      workspaceId,
      userId: OWNER,
      amount: AMOUNT,
      description: "refund for job",
      markLinkRefunded: false,
      error: "first refund attempt failed",
    });

    const beforeFirstPass = await refundRows(workspaceId);
    expect(beforeFirstPass).toEqual([]);
    expect(await queueRow(id)).toMatchObject({ status: "pending", attempts: 0 });

    // Five minutes later.
    await dueNow(id);

    const first = await runPass();

    expect(first).toEqual({ done: 1, failed: 0, exhausted: 0 });
    expect(await currentBalance(workspaceId)).toBe(100 + AMOUNT);

    const afterFirstPass = await refundRows(workspaceId);
    expect(afterFirstPass).toHaveLength(1);
    expect(afterFirstPass[0]?.amount).toBe(AMOUNT);
    expect(afterFirstPass[0]?.job_id).toBe(jobId);

    const closed = await queueRow(id);
    expect(closed.status).toBe("done");
    expect(closed.attempts).toBe(1);
    expect(closed.refund_transaction_id).not.toBeNull();
    expect(closed.last_error).toBe("first refund attempt failed");

    // A repeated tick sees the same row due again: still one refund row and the
    // balance does not move a second time.
    await reopen(id);

    const second = await runPass();

    expect(second).toEqual({ done: 1, failed: 0, exhausted: 0 });
    expect(await refundRows(workspaceId)).toHaveLength(1);
    expect(await currentBalance(workspaceId)).toBe(100 + AMOUNT);
    expect((await queueRow(id)).status).toBe("done");
  });

  it("BL-41 (2): a still failing payout pays nothing and leaves the row pending", async () => {
    const user = "00000000-0000-0000-0000-000000039b02";
    const target = await newWorkspace(user, "39l-flow-fail");
    await setBalance(target, 50);
    const jobId = await insertFailedJob(target, user);
    await insertCharge(target, user, jobId);

    const id = await repository.record({
      jobId,
      workspaceId: target,
      userId: user,
      amount: AMOUNT,
      description: "refund for job",
      markLinkRefunded: false,
      error: "first refund attempt failed",
    });
    await dueNow(id);

    const creditsLink = createJobCreditsLinkRepository({
      getTransactionPool: () => pool,
    });
    const alerts: string[] = [];

    const result = await compensateRefunds({
      claimDue: (limit) => repository.claimDue(limit),
      refund: async () => {
        throw new Error("payout still failing");
      },
      markLinkRefunded: (input) => creditsLink.markChargeRefunded(input),
      finish: (input) => repository.finish(input),
      log: (m) => alerts.push(m),
    });

    expect(result).toEqual({ done: 0, failed: 1, exhausted: 0 });
    expect(alerts).toEqual([]);
    expect(await refundRows(target)).toEqual([]);
    expect(await currentBalance(target)).toBe(50);

    const row = await queueRow(id);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("payout still failing");
  });
});
