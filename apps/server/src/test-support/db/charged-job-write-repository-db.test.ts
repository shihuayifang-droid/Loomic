import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createChargedJobWriteRepository,
  type ChargedJobInput,
  type ChargedJobWriteRepository,
} from "../../db/charged-job-write-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Workorder 39F (GN-33 step 2): the pg repository over `create_charged_job`.
 * PGlite only; the queue is the test stub `pgmq.send`, which throws for the
 * queue name `fail_queue`.
 */

let db: PGlite;
let repository: ChargedJobWriteRepository;
let userSeq = 0;

type Actor = { userId: string; workspaceId: string };

async function newActor(balance: number): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000039f${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-39f-${userSeq}@hahart.test`);

  const ws = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [userId],
  );
  const row = ws.rows[0];
  if (!row) throw new Error("signup did not create a personal workspace");

  await db.query("update public.credit_balances set balance = $2 where workspace_id = $1", [
    row.id,
    balance,
  ]);
  return { userId, workspaceId: row.id };
}

function inputFor(actor: Actor, queueName = "image_generation_jobs"): ChargedJobInput {
  return {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    projectId: null,
    canvasId: null,
    sessionId: null,
    threadId: null,
    queueName,
    jobType: "image_generation",
    payload: { prompt: "a red fox" },
    clientRequestId: null,
    amount: 12,
    description: "test charge",
    usePools: false,
    chargeWorkspaceId: actor.workspaceId,
    message: { job_type: "image_generation", workspace_id: actor.workspaceId },
  };
}

async function errorOf(run: Promise<unknown>): Promise<{ code?: unknown } | null> {
  try {
    await run;
  } catch (error) {
    return error as { code?: unknown };
  }
  return null;
}

async function jobRows(actor: Actor): Promise<number> {
  const result = await db.query<{ count: number }>(
    "select count(*)::int as count from public.background_jobs where created_by = $1",
    [actor.userId],
  );
  return result.rows[0]?.count ?? -1;
}

async function balanceOf(actor: Actor): Promise<number> {
  const result = await db.query<{ balance: number }>(
    "select balance from public.credit_balances where workspace_id = $1",
    [actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("no balance row");
  return row.balance;
}

async function sentRows(): Promise<number> {
  const result = await db.query<{ count: number }>(
    "select count(*)::int as count from pgmq.test_sent",
  );
  return result.rows[0]?.count ?? -1;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  const pool = createPGliteTransactionPool(db);
  repository = createChargedJobWriteRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("charged job write repository (39F)", () => {
  it("returns the whole queued row and the transaction id, and enqueues once", async () => {
    const actor = await newActor(100);
    const sentBefore = await sentRows();

    const result = await repository.createChargedJob(inputFor(actor));

    expect(result.transactionId).toBeTruthy();
    expect(result.row.status).toBe("queued");
    expect(result.row.created_by).toBe(actor.userId);
    expect(result.row.workspace_id).toBe(actor.workspaceId);
    expect(result.row.queue_name).toBe("image_generation_jobs");
    expect(await sentRows()).toBe(sentBefore + 1);
    expect(await balanceOf(actor)).toBe(88);
  });

  it("an insufficient balance throws P0402 and leaves no job", async () => {
    const actor = await newActor(5);
    const sentBefore = await sentRows();

    const error = await errorOf(repository.createChargedJob(inputFor(actor)));

    expect(error).not.toBeNull();
    expect(error?.code).toBe("P0402");
    expect(await jobRows(actor)).toBe(0);
    expect(await balanceOf(actor)).toBe(5);
    expect(await sentRows()).toBe(sentBefore);
  });

  it("a failed enqueue throws and leaves balance and jobs unchanged", async () => {
    const actor = await newActor(100);

    const error = await errorOf(
      repository.createChargedJob(inputFor(actor, "fail_queue")),
    );

    expect(error).not.toBeNull();
    expect(await jobRows(actor)).toBe(0);
    expect(await balanceOf(actor)).toBe(100);
  });
});
