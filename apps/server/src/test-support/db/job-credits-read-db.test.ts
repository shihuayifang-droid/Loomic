import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createJobCreditsReadRepository,
  type JobCreditsReadRepository,
} from "../../db/job-credits-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the job credits read repository (workorder 36K,
 * GN-35 / CV-02).
 *
 * Three properties, each one a different way the route's answer could lie:
 *   1. a refunded job reports BOTH numbers — what it cost (`credits_cost`) and
 *      what came back (the `generation_refund` ledger sum, 12 of 12);
 *   2. a job that was never refunded reports 0 back, not an absence and not a
 *      null;
 *   3. somebody else's job reads as NOTHING (`null`) — the ownership predicate
 *      is the statement's, so the repository cannot be talked into reading a row
 *      that is not the actor's.
 *
 * Every case owns its own user (signup creates the credit balance row) so the
 * ledger starts empty per case and the cases cannot mask each other.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host.
 */

const USER_1 = "00000000-0000-0000-0000-000000036b01";
const USER_2 = "00000000-0000-0000-0000-000000036b02";
const USER_3 = "00000000-0000-0000-0000-000000036b03";
/** Never inserted: it is only ever passed as the ACTOR of case 3. */
const STRANGER = "00000000-0000-0000-0000-000000036b09";

/** The ledger row the charged job was paid with; no FK, so any uuid will do. */
const CHARGE_TRANSACTION_ID = "00000000-0000-0000-0000-000000036b10";

let db: PGlite;
let pool: TransactionPool;
let repository: JobCreditsReadRepository;

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
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

/**
 * A queued job owned by `userId`, with the two billing columns the read projects.
 * `credits_cost` is nullable in the schema, so NULL is a legal value here.
 */
async function insertJob(options: {
  workspaceId: string;
  userId: string;
  creditsCost: number | null;
  creditsTransactionId: string | null;
}): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs
           (workspace_id, queue_name, job_type, created_by,
            credits_cost, credits_transaction_id)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid,
                 $3, $4::uuid)
         returning id`,
        [
          options.workspaceId,
          options.userId,
          options.creditsCost,
          options.creditsTransactionId,
        ],
      )
    ).rows,
  ).id;
}

/** Insert one `generation_refund` ledger row for the job. */
async function insertRefundRow(options: {
  workspaceId: string;
  userId: string;
  jobId: string;
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
  pool = createPGliteTransactionPool(db);
  repository = createJobCreditsReadRepository({
    getTransactionPool: () => pool,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("GN-35: the credits of one job, read by its owner", () => {
  it("GN-35: a refunded job reports what it cost and what came back", async () => {
    const workspaceId = await newWorkspace(USER_1);
    const jobId = await insertJob({
      workspaceId,
      userId: USER_1,
      creditsCost: 12,
      creditsTransactionId: CHARGE_TRANSACTION_ID,
    });
    await insertRefundRow({
      workspaceId,
      userId: USER_1,
      jobId,
      amount: 12,
    });

    const row = await repository.readOwnJobCredits({
      actorId: USER_1,
      jobId,
    });

    expect(row).not.toBeNull();
    expect(row).toEqual({
      jobId,
      creditsCost: 12,
      creditsRefunded: 12,
      creditsTransactionId: CHARGE_TRANSACTION_ID,
    });
  });

  it("GN-35: a job never refunded reports 0 back", async () => {
    const workspaceId = await newWorkspace(USER_2);
    const jobId = await insertJob({
      workspaceId,
      userId: USER_2,
      creditsCost: 5,
      creditsTransactionId: null,
    });

    const row = await repository.readOwnJobCredits({
      actorId: USER_2,
      jobId,
    });

    expect(row).not.toBeNull();
    expect(row).toEqual({
      jobId,
      creditsCost: 5,
      creditsRefunded: 0,
      creditsTransactionId: null,
    });
  });

  it("GN-35: somebody else's job reads as nothing", async () => {
    const workspaceId = await newWorkspace(USER_3);
    const jobId = await insertJob({
      workspaceId,
      userId: USER_3,
      creditsCost: 7,
      creditsTransactionId: null,
    });
    await insertRefundRow({
      workspaceId,
      userId: USER_3,
      jobId,
      amount: 7,
    });

    // A real user who simply does not own the job: the statement's `created_by`
    // predicate answers null, and the route projects that onto its one 404.
    await expect(
      repository.readOwnJobCredits({ actorId: STRANGER, jobId }),
    ).resolves.toBeNull();

    // The row is really there and really the owner's — the null above is the
    // predicate's answer, not a missing row.
    const ownersView = await repository.readOwnJobCredits({
      actorId: USER_3,
      jobId,
    });
    expect(ownersView).not.toBeNull();
    expect(ownersView?.creditsCost).toBe(7);
    expect(ownersView?.creditsRefunded).toBe(7);
  });
});
