import type { PGlite } from "@electric-sql/pglite";
import type { PriceDetail } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CreditLedgerWriteRepositoryError,
  createCreditLedgerWriteRepository,
  type CreditLedgerWriteRepository,
} from "../../db/credit-ledger-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * 工单31B · T2 / T7 —— 待定价消费流水的真 SQL 用例。
 *
 * 这一文件钉住的是**账本本身**（工单 31B 裁决 1、2 的运行时证据）：
 *
 * - 金额 0、类型 `generation_deduct`（不新增 enum 值）、`metadata.price_pending`
 *   为 true、`metadata.price_detail.price_status` 为 `pending`；
 * - `balance_after` 取同一事务里读到的余额，且**余额不变**（这一行不动钱）；
 * - 没有余额行时 `balance_after` 记 0；
 * - 带 job 与不带 job（同步出图路由）两种情况都能落库；
 * - 坏 uuid 是真实 SQL 错误，回滚后一行都不留，且被包成仓储自己的错误类型。
 *
 * PGlite：进程内、无 socket、无 `DATABASE_URL`。`beforeAll` 迁移一次并给两个用户
 * 建好工作区（真 signup trigger），`afterAll` 关掉。
 */

const USER_ID = "00000000-0000-0000-0000-0000000031b0";
const NO_BALANCE_USER_ID = "00000000-0000-0000-0000-0000000031b1";
const JOB_ID = "00000000-0000-0000-0000-0000000031b2";
const RULE_ID = "00000000-0000-0000-0000-0000000031b3";

/** 起始余额：读回来的 `balance_after` 必须正好是它，且事后仍是它。 */
const STARTING_BALANCE = 37;

/** 一条待定价的报价明细（GN-01 结构，价格三字段都是 0）。 */
const PENDING_DETAIL: PriceDetail = {
  base_price: 0,
  unit_name: "次",
  unit_count: 1,
  unit_price: 0,
  total_price: 0,
  search_key: "hd",
  search_key_matched: "hd",
  time_variant_period: "normal",
  disable_unlimited: false,
  entry_point: "canvas_generator",
  extras: [],
  price_status: "pending",
};

/** 一行流水的完整形状，供断言与回传引用。 */
type LedgerRow = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  transaction_type: string;
  amount: number;
  balance_after: number;
  job_id: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
};

const SELECT_LEDGER_ROW_SQL = `
select id::text as id,
       workspace_id::text as workspace_id,
       user_id::text as user_id,
       transaction_type::text as transaction_type,
       amount,
       balance_after,
       job_id::text as job_id,
       description,
       metadata
  from public.credit_transactions
 where id = $1::uuid
`;

let db: PGlite;
let pool: TransactionPool;
let ledger: CreditLedgerWriteRepository;
let workspaceId = "";
let noBalanceWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** 该工作区的个人工作区（signup trigger 建的那一个）。 */
async function personalWorkspaceId(userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

async function readLedgerRow(transactionId: string): Promise<LedgerRow> {
  return firstRow(
    (await db.query<LedgerRow>(SELECT_LEDGER_ROW_SQL, [transactionId])).rows,
  );
}

async function currentBalance(workspace: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ balance: number }>(
        "select balance from public.credit_balances where workspace_id = $1::uuid",
        [workspace],
      )
    ).rows,
  ).balance;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  ledger = createCreditLedgerWriteRepository({ getTransactionPool: () => pool });

  // 真 signup：trigger 建 profile + 个人工作区 + 余额行（0）+ 订阅行（free）。
  await createUser(db, USER_ID, "credit-ledger@hahart.test");
  await createUser(db, NO_BALANCE_USER_ID, "credit-ledger-nobalance@hahart.test");
  workspaceId = await personalWorkspaceId(USER_ID);
  noBalanceWorkspaceId = await personalWorkspaceId(NO_BALANCE_USER_ID);

  await db.query("update public.credit_balances set balance = $2 where workspace_id = $1::uuid", [
    workspaceId,
    STARTING_BALANCE,
  ]);

  // `job_id` 要指一条真任务（外键），同步路由那种 null 情况另有用例。
  await db.query(
    `insert into public.background_jobs (id, workspace_id, queue_name, job_type, status, created_by)
     values ($1, $2, 'image_generation_jobs', 'image_generation', 'queued', $3)`,
    [JOB_ID, workspaceId, USER_ID],
  );

  // 「没有余额行」只在行被删掉之后才可达：trigger 会给每个工作区建一行。
  await db.query("delete from public.credit_balances where workspace_id = $1::uuid", [
    noBalanceWorkspaceId,
  ]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("credit ledger write repository: 待定价消费流水（裁决 1、2）", () => {
  it("case 1: 写入后读回的行是金额 0、类型 generation_deduct、balance_after=37、带 price_pending", async () => {
    const { transactionId } = await ledger.recordPendingConsume({
      workspaceId,
      userId: USER_ID,
      jobId: JOB_ID,
      description: "Image generation: kwjm/gpt-image-2",
      ruleId: RULE_ID,
      priceDetail: PENDING_DETAIL,
    });

    const row = await readLedgerRow(transactionId);
    // 回传要引用的「那一行」—— 原样打出来，避免誊写出错。
    console.log("[31B-ledger-row]", JSON.stringify(row));

    expect(row.workspace_id).toBe(workspaceId);
    expect(row.user_id).toBe(USER_ID);
    // 裁决 1：不新增 enum 值，「consume 流水」就是 generation_deduct。
    expect(row.transaction_type).toBe("generation_deduct");
    expect(row.amount).toBe(0);
    expect(row.balance_after).toBe(STARTING_BALANCE);
    expect(row.job_id).toBe(JOB_ID);
    expect(row.description).toBe("Image generation: kwjm/gpt-image-2");
    // 裁决 1：待定价的标记在 metadata 里。
    expect(row.metadata["price_pending"]).toBe(true);
    expect(row.metadata["rule_id"]).toBe(RULE_ID);
    expect((row.metadata["price_detail"] as Record<string, unknown>)["price_status"]).toBe(
      "pending",
    );

    // 再单独按 JSON 路径读一次，证明这是数据库里的值，不是本进程的转述。
    const fromJson = firstRow(
      (
        await db.query<{ price_pending: string; status: string; job: string | null }>(
          `select metadata->>'price_pending' as price_pending,
                  metadata->'price_detail'->>'price_status' as status,
                  metadata->>'rule_id' as job
             from public.credit_transactions
            where id = $1::uuid`,
          [transactionId],
        )
      ).rows,
    );
    expect(fromJson).toEqual({ price_pending: "true", status: "pending", job: RULE_ID });

    // 这一行不动钱：余额仍是 37。
    expect(await currentBalance(workspaceId)).toBe(STARTING_BALANCE);
  });

  it("case 2: 同步路由（没有 job）写出来的行 job_id 是 null", async () => {
    const { transactionId } = await ledger.recordPendingConsume({
      workspaceId,
      userId: USER_ID,
      jobId: null,
      description: "Direct image generation: kwjm/gpt-image-2",
      ruleId: RULE_ID,
      priceDetail: PENDING_DETAIL,
    });

    const row = await readLedgerRow(transactionId);
    expect(row.job_id).toBeNull();
    expect(row.amount).toBe(0);
    expect(row.balance_after).toBe(STARTING_BALANCE);
  });

  it("case 3: 没有余额行的工作区，balance_after 记 0（裁决 2，不是「读失败」）", async () => {
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.credit_balances where workspace_id = $1::uuid",
          [noBalanceWorkspaceId],
        )
      ).rows[0]?.n,
    ).toBe(0);

    const { transactionId } = await ledger.recordPendingConsume({
      workspaceId: noBalanceWorkspaceId,
      userId: NO_BALANCE_USER_ID,
      jobId: null,
      description: "Image generation: kwjm/gpt-image-2",
      ruleId: RULE_ID,
      priceDetail: PENDING_DETAIL,
    });

    const row = await readLedgerRow(transactionId);
    expect(row.balance_after).toBe(0);
    expect(row.amount).toBe(0);
    // 余额行仍然不存在：这一行不写余额。
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.credit_balances where workspace_id = $1::uuid",
          [noBalanceWorkspaceId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("case 4: 坏 uuid 是真实 SQL 错误，被包成仓储错误类型且一行都不留", async () => {
    const before = firstRow(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.credit_transactions",
        )
      ).rows,
    ).n;

    const error = await ledger
      .recordPendingConsume({
        workspaceId: "not-a-uuid",
        userId: USER_ID,
        jobId: null,
        description: "broken",
        ruleId: RULE_ID,
        priceDetail: PENDING_DETAIL,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CreditLedgerWriteRepositoryError);
    expect((error as CreditLedgerWriteRepositoryError).operation).toBe(
      "recordPendingConsume",
    );
    // 驱动原文留在 cause 上，但不进 message。
    expect((error as CreditLedgerWriteRepositoryError).message).not.toContain("not-a-uuid");

    const after = firstRow(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.credit_transactions",
        )
      ).rows,
    ).n;
    expect(after).toBe(before);
  });

  it("case 5: 同一个工作区连写两条是两个不同的事务 id（append-only，不合并）", async () => {
    const first = await ledger.recordPendingConsume({
      workspaceId,
      userId: USER_ID,
      jobId: null,
      description: "Image generation: kwjm/gpt-image-2",
      ruleId: RULE_ID,
      priceDetail: PENDING_DETAIL,
    });
    const second = await ledger.recordPendingConsume({
      workspaceId,
      userId: USER_ID,
      jobId: null,
      description: "Image generation: kwjm/gpt-image-2",
      ruleId: RULE_ID,
      priceDetail: PENDING_DETAIL,
    });

    expect(first.transactionId).not.toBe(second.transactionId);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.credit_transactions where workspace_id = $1::uuid",
          [workspaceId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThanOrEqual(4);
  });
});
