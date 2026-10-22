import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单39E · GN-33 第 1 步 —— 建任务 + 扣费 + 入队同一事务的 DB 函数
 * `public.create_charged_job`（迁移 `20261022000001_hahart_create_charged_job.sql`）。
 *
 * 验收：扣费失败 -> 库中没有残留 queued 任务；入队失败 -> 余额与任务表均不变。
 * 入队用测试桩 `pgmq.send`（supabase-stubs.sql），队列名 `fail_queue` 时抛错。
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

/** 每例一个新用户：signup trigger 建个人工作区与余额行。 */
async function newActor(balance: number): Promise<Actor> {
  userSeq += 1;
  const userId = `00000000-0000-0000-0000-000000039e${String(userSeq).padStart(2, "0")}`;
  await createUser(db, userId, `user-39e-${userSeq}@hahart.test`);

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

type Charged = { job_id: string; transaction_id: string };

function createChargedJob(
  actor: Actor,
  amount: number,
  usePools: boolean,
  queue = "image_generation_jobs",
): Promise<{ rows: Charged[] }> {
  const message = JSON.stringify({ job_type: "image_generation", workspace_id: actor.workspaceId });
  return db.query<Charged>(
    `select * from public.create_charged_job(
       $1::uuid, $2::uuid, null, null, null, null,
       $3, 'image_generation'::public.background_job_type, '{}'::jsonb, null,
       $4::int, 'test charge', $5::boolean, $1::uuid, $6::jsonb)`,
    [actor.workspaceId, actor.userId, queue, amount, usePools, message],
  );
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

async function jobRows(actor: Actor): Promise<number> {
  const result = await db.query<{ count: number }>(
    "select count(*)::int as count from public.background_jobs where created_by = $1",
    [actor.userId],
  );
  return result.rows[0]?.count ?? -1;
}

async function txRows(actor: Actor): Promise<number> {
  const result = await db.query<{ count: number }>(
    "select count(*)::int as count from public.credit_transactions where user_id = $1",
    [actor.userId],
  );
  return result.rows[0]?.count ?? -1;
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
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("create_charged_job (39E)", () => {
  it("creates the job, charges the balance and enqueues in one go", async () => {
    const actor = await newActor(100);
    const sentBefore = await sentRows();

    const result = await createChargedJob(actor, 12, false);
    const charged = result.rows[0];
    if (!charged) throw new Error("expected a row");

    expect(charged.job_id).toBeTruthy();
    expect(charged.transaction_id).toBeTruthy();

    const job = await db.query<{
      status: string;
      credits_cost: number;
      credits_transaction_id: string;
    }>(
      "select status, credits_cost, credits_transaction_id from public.background_jobs where id = $1",
      [charged.job_id],
    );
    expect(job.rows[0]).toEqual({
      status: "queued",
      credits_cost: 12,
      credits_transaction_id: charged.transaction_id,
    });

    expect(await balanceOf(actor)).toBe(88);

    expect(await sentRows()).toBe(sentBefore + 1);
    const sent = await db.query<{ job_id: string; job_type: string }>(
      `select message->>'job_id' as job_id, message->>'job_type' as job_type
       from pgmq.test_sent where message->>'job_id' = $1`,
      [charged.job_id],
    );
    expect(sent.rows).toEqual([{ job_id: charged.job_id, job_type: "image_generation" }]);
  });

  it("GN-33: a failed charge leaves no queued job", async () => {
    const actor = await newActor(5);
    const sentBefore = await sentRows();

    expect(await sqlState(createChargedJob(actor, 12, false))).toBe("P0402");

    expect(await jobRows(actor)).toBe(0);
    expect(await balanceOf(actor)).toBe(5);
    expect(await sentRows()).toBe(sentBefore);
  });

  it("GN-33: a failed enqueue leaves balance and jobs unchanged", async () => {
    const actor = await newActor(100);
    const txBefore = await txRows(actor);

    const code = await sqlState(createChargedJob(actor, 12, false, "fail_queue"));
    expect(code).toBe("XX000");

    expect(await jobRows(actor)).toBe(0);
    expect(await balanceOf(actor)).toBe(100);
    expect(await txRows(actor)).toBe(txBefore);
  });

  it("charges the pools when asked to", async () => {
    const actor = await newActor(0);
    await db.query(
      `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
       values ($1, ${MONTH_SQL}, 1000, 0)`,
      [actor.workspaceId],
    );
    await db.query(
      `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
       values ($1, ${TODAY_SQL}, 5, 50)
       on conflict (user_id) do update
         set daily_date = excluded.daily_date,
             daily_balance = excluded.daily_balance,
             topup_balance = excluded.topup_balance`,
      [actor.userId],
    );

    const result = await createChargedJob(actor, 20, true);
    const charged = result.rows[0];
    if (!charged) throw new Error("expected a row");

    const tx = await db.query<{
      pool_breakdown: Record<string, number>;
      job_id: string;
    }>("select pool_breakdown, job_id from public.credit_transactions where id = $1", [
      charged.transaction_id,
    ]);
    expect(tx.rows[0]).toEqual({
      pool_breakdown: { daily: 5, team: 15, topup: 0 },
      job_id: charged.job_id,
    });
    expect(await jobRows(actor)).toBe(1);
  });

  it("a refused pool charge leaves no job", async () => {
    const actor = await newActor(0);
    await db.query(
      `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
       values ($1, ${MONTH_SQL}, 50000, 19990)`,
      [actor.workspaceId],
    );
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, used)
       values ($1, $2, ${MONTH_SQL}, 19990)`,
      [actor.workspaceId, actor.userId],
    );
    await db.query(
      `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
       values ($1, ${TODAY_SQL}, 0, 0)
       on conflict (user_id) do update
         set daily_date = excluded.daily_date,
             daily_balance = excluded.daily_balance,
             topup_balance = excluded.topup_balance`,
      [actor.userId],
    );

    expect(await sqlState(createChargedJob(actor, 12, true))).toBe("P0403");
    expect(await jobRows(actor)).toBe(0);
  });

  it("a zero amount is rejected and writes nothing", async () => {
    const actor = await newActor(100);

    expect(await sqlState(createChargedJob(actor, 0, false))).toBe("22023");
    expect(await jobRows(actor)).toBe(0);
    expect(await balanceOf(actor)).toBe(100);
  });

  it("security: only the service role may call it", async () => {
    const actor = await newActor(100);

    const code = await sqlState(
      asUser(db, actor.userId, (tx) =>
        tx.query(
          `select * from public.create_charged_job(
             $1::uuid, $2::uuid, null, null, null, null,
             'image_generation_jobs', 'image_generation'::public.background_job_type,
             '{}'::jsonb, null, 12, 'test', false, $1::uuid, '{}'::jsonb)`,
          [actor.workspaceId, actor.userId],
        ),
      ),
    );

    expect(code).toBe("42501");
    expect(await jobRows(actor)).toBe(0);
  });
});
