import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDb, createUser } from "./pglite-db.js";

/**
 * BL-41 (5) / T-40: one refund per job, enforced by migration
 * `20261021000003_hahart_refund_once_per_job.sql` (partial unique index +
 * idempotent `refund_credits`).
 *
 * Four properties, each one a different way a second refund could get through:
 *   1. calling `refund_credits` twice for one job pays out once and returns the
 *      same ledger id both times - a retry is not a second refund;
 *   2. two different jobs still refund independently - the guard is per job, not
 *      per workspace;
 *   3. writing the ledger row directly (bypassing the function) is refused for a
 *      second `generation_refund` row for the same job, SQLSTATE 23505 - the
 *      index is the backstop when two callers race;
 *   4. a refund without a job is not de-duplicated - the index is partial on
 *      `job_id is not null`.
 *
 * Every case owns its own workspace (signup creates the credit balance row) so
 * the balance and ledger counts start at zero and the cases cannot mask each
 * other. The migration is applied by `createMigratedDb`, so a broken index or
 * function definition fails in `beforeAll` naming the file.
 */

const USER_1 = "00000000-0000-0000-0000-000000036d01";
const USER_2 = "00000000-0000-0000-0000-000000036d02";
const USER_3 = "00000000-0000-0000-0000-000000036d03";
const USER_4 = "00000000-0000-0000-0000-000000036d04";

let db: PGlite;

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Sign one user up and hand back the personal workspace the trigger created. */
async function newWorkspace(userId: string): Promise<string> {
  await createUser(db, userId, `${userId}@hahart.test`);

  return firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

/** A queued image job owned by `userId`; `background_jobs.created_by` is the owner. */
async function insertJob(workspaceId: string, userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [workspaceId, userId],
      )
    ).rows,
  ).id;
}

async function currentBalance(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ balance: number }>(
        "select balance from public.credit_balances where workspace_id = $1::uuid",
        [workspaceId],
      )
    ).rows,
  ).balance;
}

/** How many refund ledger rows the workspace carries. */
async function refundRows(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n from public.credit_transactions
          where workspace_id = $1::uuid and transaction_type = 'generation_refund'`,
        [workspaceId],
      )
    ).rows,
  ).n;
}

/** Insert one ledger row directly, so the unique index is what has to refuse it. */
async function insertRefundRow(options: {
  workspaceId: string;
  userId: string;
  jobId: string | null;
  amount: number;
}): Promise<void> {
  await db.query(
    `insert into public.credit_transactions
       (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
     values ($1::uuid, $2::uuid, 'generation_refund', $3, 0, $4::uuid, 'x')`,
    [options.workspaceId, options.userId, options.amount, options.jobId],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("BL-41: a job is refunded at most once", () => {
  it("BL-41: a job is refunded only once", async () => {
    const workspaceId = await newWorkspace(USER_1);
    const jobId = await insertJob(workspaceId, USER_1);

    const balanceBefore = await currentBalance(workspaceId);
    expect(balanceBefore).toBe(0);

    const first = firstRow(
      (
        await db.query<{ refund_credits: string }>(
          "select public.refund_credits($1::uuid, $2::uuid, 7, $3::uuid, 'x')",
          [workspaceId, USER_1, jobId],
        )
      ).rows,
    ).refund_credits;

    const second = firstRow(
      (
        await db.query<{ refund_credits: string }>(
          "select public.refund_credits($1::uuid, $2::uuid, 7, $3::uuid, 'x')",
          [workspaceId, USER_1, jobId],
        )
      ).rows,
    ).refund_credits;

    expect(second).toBe(first);
    await expect(currentBalance(workspaceId)).resolves.toBe(balanceBefore + 7);
    await expect(refundRows(workspaceId)).resolves.toBe(1);
  });

  it("BL-41: different jobs are refunded independently", async () => {
    const workspaceId = await newWorkspace(USER_2);
    const jobA = await insertJob(workspaceId, USER_2);
    const jobB = await insertJob(workspaceId, USER_2);

    await db.query("select public.refund_credits($1::uuid, $2::uuid, 5, $3::uuid, 'x')", [
      workspaceId,
      USER_2,
      jobA,
    ]);
    await db.query("select public.refund_credits($1::uuid, $2::uuid, 4, $3::uuid, 'x')", [
      workspaceId,
      USER_2,
      jobB,
    ]);

    await expect(refundRows(workspaceId)).resolves.toBe(2);

    const perJob = await db.query<{ job_id: string; n: number }>(
      `select job_id::text as job_id, count(*)::int as n
         from public.credit_transactions
        where workspace_id = $1::uuid and transaction_type = 'generation_refund'
        group by job_id
        order by job_id::text`,
      [workspaceId],
    );

    expect(perJob.rows.map((row) => row.n)).toEqual([1, 1]);
    await expect(currentBalance(workspaceId)).resolves.toBe(9);
  });

  it("BL-41: the database refuses a second refund row for the same job", async () => {
    const workspaceId = await newWorkspace(USER_3);
    const jobId = await insertJob(workspaceId, USER_3);

    await insertRefundRow({ workspaceId, userId: USER_3, jobId, amount: 3 });

    let refused = { code: "", message: "" };
    try {
      await insertRefundRow({ workspaceId, userId: USER_3, jobId, amount: 3 });
    } catch (error) {
      const cause = error as { code?: unknown; message?: unknown };
      refused = { code: String(cause.code), message: String(cause.message) };
    }

    expect(refused.code).toBe("23505");
    expect(refused.message).toMatch(/credit_transactions_one_refund_per_job/);

    // The refused row is not there either: the whole statement rolled back.
    await expect(refundRows(workspaceId)).resolves.toBe(1);
  });

  it("BL-41: refunds without a job are not de-duplicated", async () => {
    const workspaceId = await newWorkspace(USER_4);

    await db.query("select public.refund_credits($1::uuid, $2::uuid, 4, null, 'x')", [
      workspaceId,
      USER_4,
    ]);
    await db.query("select public.refund_credits($1::uuid, $2::uuid, 4, null, 'x')", [
      workspaceId,
      USER_4,
    ]);

    await expect(refundRows(workspaceId)).resolves.toBe(2);
    await expect(currentBalance(workspaceId)).resolves.toBe(8);

    // Both rows are job-less: the index is partial on `job_id is not null`, so it
    // never sees them.
    const jobless = firstRow(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from public.credit_transactions
            where workspace_id = $1::uuid
              and transaction_type = 'generation_refund'
              and job_id is null`,
          [workspaceId],
        )
      ).rows,
    ).n;

    expect(jobless).toBe(2);
  });
});
