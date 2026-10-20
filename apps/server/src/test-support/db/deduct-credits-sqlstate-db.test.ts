import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单33D · X-40 §4 —— 余额不足的 SQLSTATE 是 `P0402`，由迁移
 * `20261020000001_hahart_deduct_credits_sqlstate.sql` 声明。
 *
 * 这一文件钉住的是数据库那一侧的契约（服务端的「认码不认文案」在
 * `features/credits/credit-service.test.ts` 里钉住）：
 *
 * - 扣超过余额时抛出的是真的 `P0402`，不是默认的 `P0001` —— 所以它和别的
 *   RAISE 能区分开；
 * - 失败的那一次一分钱不动、一行流水不留；
 * - 余额之内的扣款照旧成功并返回流水 id；
 * - 函数体里 `ERRCODE = 'P0402'` 恰好出现一次，只属于余额那一个分支。
 *
 * PGlite：进程内、无 socket、无 `DATABASE_URL`。`beforeAll` 把全部迁移跑一遍
 * 并真 signup 一个用户（trigger 建个人工作区与余额行），`afterAll` 关掉。
 */

const USER_ID = "00000000-0000-0000-0000-0000000033d0";

/** 起始余额：第一例扣 5 一定不够，第二例扣 2 一定够。 */
const STARTING_BALANCE = 3;

let db: PGlite;
let workspaceId: string;

async function currentBalance(workspace: string): Promise<number> {
  const result = await db.query<{ balance: number }>(
    "select balance from public.credit_balances where workspace_id = $1::uuid",
    [workspace],
  );

  const row = result.rows[0];
  if (!row) throw new Error("no credit balance row for the workspace");

  return row.balance;
}

async function deductRows(workspace: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from public.credit_transactions
     where workspace_id = $1::uuid and transaction_type = 'generation_deduct'`,
    [workspace],
  );

  const row = result.rows[0];
  if (!row) throw new Error("the count query returned no row");

  return row.count;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // 真 signup：trigger 建 profile + 个人工作区 + 余额行（0）+ 订阅行（free）。
  await createUser(db, USER_ID, "deduct-sqlstate@hahart.test");

  const workspace = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [USER_ID],
  );

  const row = workspace.rows[0];
  if (!row) throw new Error("signup did not create a personal workspace");

  workspaceId = row.id;

  await db.query("update public.credit_balances set balance = $2 where workspace_id = $1::uuid", [
    workspaceId,
    STARTING_BALANCE,
  ]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("deduct_credits: insufficient balance is a SQLSTATE, not a message (X-40 §4)", () => {
  it("X-40: deducting more than the balance raises SQLSTATE P0402", async () => {
    const balanceBefore = await currentBalance(workspaceId);
    const rowsBefore = await deductRows(workspaceId);

    expect(balanceBefore).toBe(STARTING_BALANCE);
    expect(rowsBefore).toBe(0);

    await expect(
      db.query("select public.deduct_credits($1::uuid, $2::uuid, 5)", [
        workspaceId,
        USER_ID,
      ]),
    ).rejects.toMatchObject({ code: "P0402" });

    // 失败的那一次什么都没动：余额原样，流水一行没多。
    await expect(currentBalance(workspaceId)).resolves.toBe(STARTING_BALANCE);
    await expect(deductRows(workspaceId)).resolves.toBe(rowsBefore);
  });

  it("X-40: a deduction within the balance still succeeds", async () => {
    const result = await db.query<{ deduct_credits: string }>(
      "select public.deduct_credits($1::uuid, $2::uuid, 2)",
      [workspaceId, USER_ID],
    );

    const transactionId = result.rows[0]?.deduct_credits;

    expect(typeof transactionId).toBe("string");
    expect(transactionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await expect(currentBalance(workspaceId)).resolves.toBe(STARTING_BALANCE - 2);
    await expect(deductRows(workspaceId)).resolves.toBe(1);
  });

  it("X-40: the function body raises P0402 only for the balance branch", async () => {
    const result = await db.query<{ prosrc: string }>(
      "select prosrc from pg_proc where proname = 'deduct_credits'",
    );

    const body = result.rows[0]?.prosrc;
    if (typeof body !== "string") throw new Error("deduct_credits is not in pg_proc");

    const hits = body.split("ERRCODE = 'P0402'").length - 1;

    expect(hits).toBe(1);
    // 其余两个 RAISE 仍然是默认 SQLSTATE（没有自己的 ERRCODE）。
    expect(body.split("RAISE EXCEPTION").length - 1).toBe(3);
  });
});
