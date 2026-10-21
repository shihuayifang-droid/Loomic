import type { PGlite } from "@electric-sql/pglite";
import { creditTransactionSchema } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LIST_MEMBER_POOL_TRANSACTIONS,
  MEMBER_POOL_TRANSACTION_COLUMNS,
  PoolTransactionReadError,
  createPoolTransactionReadRepository,
  type PoolTransactionReadRepository,
} from "../../db/pool-transaction-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * 工单38U · BL-06 / T-111 —— 成员三池流水读取仓储 `listMemberPoolTransactions`
 * 的真实 SQL 集成。
 *
 * 背景：37N / 37S 的三池扣费与退款流水写在**团队工作区**下，而
 * `GET /api/credits/transactions` 按个人工作区列，开关打开后成员看不到自己的三池
 * 扣费 / 退款。仓储自带的那一条 `select` 由 PGlite 真正解析执行，本文件证明的是：
 *
 *   - 一条流水按 (workspace_id, user_id) 两个绑定参数过滤，所以一个成员只能读到自己的
 *     行，团队级流水（`user_id` 为 null 的 `cycle_grant` / `cycle_reset`）不出现在任何人
 *     的列表里；
 *   - `pool` 与 `pool_breakdown` 两列按列名读回，拆分明细逐池是整数；
 *   - `created_at` 规范成 ISO 字符串（`creditTransactionSchema` 声明的是
 *     `z.string()`，而驱动给的是 `Date`），整行能被共享 schema 解析；
 *   - `limit` 生效，且只限制本人的行；
 *   - 失败被包成固定文案的 `PoolTransactionReadError`，不带 SQL / host / id。
 *
 * 发放 / 充值 / 扣费用的是 37O 的 `grant_team_cycle`、37U 的 `admin_adjust_topup`、
 * 37N 的 `deduct_from_pools` 三个函数，不由本文件直接写流水：这样读到的 `pool` /
 * `pool_breakdown` 是**真实写入方**留下的口径，而不是本文件臆想的行。
 *
 * 数据库是 PGlite：进程内、随仓库、无服务、无 socket、无 `DATABASE_URL`。
 */

const USER_A = "00000000-0000-0000-0000-0000000038a0";
const USER_B = "00000000-0000-0000-0000-0000000038a1";
const USER_C = "00000000-0000-0000-0000-0000000038a2";

/** A member of no team workspace: no pool line at all, which is a legal answer. */
const USER_D = "00000000-0000-0000-0000-0000000038a3";

/** The two rows this file writes by hand, with timestamps it controls. */
const EXPLICIT_ROWS = [
  {
    id: "00000000-0000-0000-0000-0000000038b1",
    createdAt: "2026-04-01T00:00:01.001Z",
  },
  {
    id: "00000000-0000-0000-0000-0000000038b2",
    createdAt: "2026-04-01T00:00:09.009Z",
  },
] as const;

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

let db: PGlite;
let pool: TransactionPool;
let repository: PoolTransactionReadRepository;
let workspaceId = "";
let memberBWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** 37O：本月团队池发放（默认 = 成员数 x 20000）。 */
async function grantCycle(workspace: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ v: number }>(
        "select public.grant_team_cycle($1, null, null) as v",
        [workspace],
      )
    ).rows,
  ).v;
}

/** 37U：管理员给成员充值池加减（充值 50 -> `admin_adjustment`、`pool = topup`）。 */
async function adjustTopup(
  userId: string,
  operatorId: string,
  delta: number,
): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as id",
        [workspaceId, userId, operatorId, delta, "seed"],
      )
    ).rows,
  ).id;
}

/** 37N：按池扣费（写 `generation_deduct`，带 `pool` / `pool_breakdown`）。 */
async function deduct(
  userId: string,
  amount: number,
  jobId: string | null = null,
): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.deduct_from_pools($1, $2, $3, $4, 'test') as id",
        [workspaceId, userId, amount, jobId],
      )
    ).rows,
  ).id;
}

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

function list(userId: string, limit = 20) {
  return repository.listMemberPoolTransactions({
    workspaceId,
    userId,
    limit,
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createPoolTransactionReadRepository({ pool });

  // 真实注册路径：signup trigger 建 profile 与个人工作区。
  await createUser(db, USER_A, "pool-tx-a@hahart.test");
  await createUser(db, USER_B, "pool-tx-b@hahart.test");
  await createUser(db, USER_C, "pool-tx-c@hahart.test");
  await createUser(db, USER_D, "pool-tx-d@hahart.test");
  workspaceId = await personalWorkspaceId(USER_A);
  memberBWorkspaceId = await personalWorkspaceId(USER_B);

  // A 的团队工作区恰好 3 人：自己（owner）+ B + C。团队池默认 3 x 20000。
  for (const member of [USER_B, USER_C]) {
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [workspaceId, member],
    );
  }
  expect(
    firstRow(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_members where workspace_id = $1::uuid",
          [workspaceId],
        )
      ).rows,
    ).count,
  ).toBe(3);

  // 37O：本月团队池发放。它同时写一条 user_id 为 null 的团队级 `cycle_grant`。
  expect(await grantCycle(workspaceId)).toBe(60000);
  const teamLine = firstRow(
    (
      await db.query<{
        id: string;
        user_id: string | null;
        transaction_type: string;
        pool: string | null;
      }>(
        `select id::text as id, user_id::text as user_id,
                transaction_type::text as transaction_type, pool
           from public.credit_transactions
          where workspace_id = $1::uuid and transaction_type = 'cycle_grant'`,
        [workspaceId],
      )
    ).rows,
  );
  expect(teamLine.user_id).toBeNull();
  expect(teamLine.pool).toBe("team");

  // 37U：A 充值 50（`admin_adjustment`、`pool = topup`，无拆分）。
  await adjustTopup(USER_A, USER_A, 50);
  // 37N：A 扣 20（daily 0 -> team 20），B 扣 5。
  await deduct(USER_A, 20);
  await deduct(USER_B, 5);

  // 两行手写流水，时间戳由本文件控制：用来证明「新到旧」这一条是 SQL 的顺序，
  // 不是插入顺序，也不是 id 的顺序。团队作业下函数写出的两行可能同毫秒。
  for (const [index, row] of EXPLICIT_ROWS.entries()) {
    await db.query(
      `insert into public.credit_transactions (
         id, workspace_id, user_id, transaction_type, amount, balance_after,
         job_id, description, created_at, pool, pool_breakdown
       ) values (
         $1, $2::uuid, $3::uuid, 'generation_deduct'::public.credit_transaction_type,
         $4::integer, $5::integer, null, $6, $7, null,
         jsonb_build_object('daily', 0, 'team', $4::integer, 'topup', 0)
       )`,
      [
        row.id,
        workspaceId,
        USER_C,
        -(index + 1),
        100 - index,
        `explicit ${index}`,
        row.createdAt,
      ],
    );
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("listMemberPoolTransactions (38U): 成员自己的三池流水", () => {
  it("BL-06: A's list is A's two pool lines, newest first, with the split", async () => {
    const rows = await list(USER_A, 20);

    // 充值 50 + 扣 20 两行，B 的扣 5 不在里面，团队级 cycle_grant 也不在。
    expect(rows).toHaveLength(2);

    const charge = firstRow(
      rows.filter((row) => row.transaction_type === "generation_deduct"),
    );
    const topup = firstRow(
      rows.filter((row) => row.transaction_type === "admin_adjustment"),
    );

    // 37N 的扣费行：金额为负，拆分是 daily 0 / team 20 / topup 0（A 没有每日余额）。
    expect(charge.amount).toBe(-20);
    expect(charge.pool_breakdown).toEqual({ daily: 0, team: 20, topup: 0 });
    // 一池扣完时 `pool` 才有名字；这里整笔都来自团队池。
    expect(charge.pool).toBe("team");

    // 37U 的充值行：充的是充值池，没有拆分。
    expect(topup.amount).toBe(50);
    expect(topup.balance_after).toBe(50);
    expect(topup.pool).toBe("topup");
    expect(topup.pool_breakdown).toBeNull();

    // 新到旧：A 的两行按 created_at 降序（同毫秒时用 id 兜底）。
    const times = rows.map((row) => new Date(row.created_at).getTime());
    const newest = firstRow(times);
    const oldest = firstRow(times.slice(1));
    expect(newest).toBeGreaterThanOrEqual(oldest);
    // 每一行都是完整的一行、列齐、且能被共享 schema 解析（pool 两列是可选字段）。
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...MEMBER_POOL_TRANSACTION_COLUMNS]);
      expect(typeof row.created_at).toBe("string");
      expect(row.created_at).not.toBeInstanceOf(Date);
      expect(new Date(row.created_at).toISOString()).toBe(row.created_at);
      expect(creditTransactionSchema.safeParse(row).success).toBe(true);
    }
  });

  it("BL-06: a team-level cycle_grant line belongs to no member's list", async () => {
    // 团队级那一行是真的写在库里，只是 user_id 为 null。
    const teamLines = (
      await db.query<{ n: number }>(
        `select count(*)::int as n
           from public.credit_transactions
          where workspace_id = $1::uuid and user_id is null`,
        [workspaceId],
      )
    ).rows;
    expect(firstRow(teamLines).n).toBeGreaterThanOrEqual(1);

    // 三个成员各自读到的都不含它。
    for (const userId of [USER_A, USER_B, USER_C]) {
      const rows = await list(userId, 100);
      expect(
        rows.filter((row) => row.transaction_type === "cycle_grant"),
      ).toEqual([]);
      expect(rows.every((row) => row.transaction_type !== "cycle_reset")).toBe(
        true,
      );
    }
  });

  it("BL-06: another member's lines are not mine", async () => {
    const mine = await list(USER_A, 100);
    const theirs = await list(USER_B, 100);

    // B 只在团队工作区里扣过 5：他自己的列表只有这一行。
    expect(theirs).toHaveLength(1);
    expect(firstRow(theirs).transaction_type).toBe("generation_deduct");
    expect(firstRow(theirs).amount).toBe(-5);
    expect(firstRow(theirs).pool_breakdown).toEqual({
      daily: 0,
      team: 5,
      topup: 0,
    });

    // 两个列表没有共同的 id：谁的流水就只在谁的列表里。
    const mineIds = new Set(mine.map((row) => row.id));
    for (const row of theirs) {
      expect(mineIds.has(row.id)).toBe(false);
    }

    // 不在这个团队里的成员（D 有他自己的个人工作区）读到的是空列表：
    // 工作区参数是谓词，不是「某个团队」的默认值。
    await expect(
      repository.listMemberPoolTransactions({
        workspaceId,
        userId: USER_D,
        limit: 20,
      }),
    ).resolves.toEqual([]);
    // B 的个人工作区里也没有这些行。
    await expect(
      repository.listMemberPoolTransactions({
        workspaceId: memberBWorkspaceId,
        userId: USER_B,
        limit: 20,
      }),
    ).resolves.toEqual([]);
  });

  it("BL-06: the limit limits THIS member's rows, and newest first", async () => {
    const all = await list(USER_C, 20);
    // C 有本文件手写的两行，时间戳 01.001 与 09.009。
    expect(all.map((row) => row.id)).toEqual([
      EXPLICIT_ROWS[1].id,
      EXPLICIT_ROWS[0].id,
    ]);
    expect(all.map((row) => row.created_at)).toEqual([
      EXPLICIT_ROWS[1].createdAt,
      EXPLICIT_ROWS[0].createdAt,
    ]);

    const newestOne = await list(USER_C, 1);
    expect(newestOne).toHaveLength(1);
    expect(firstRow(newestOne).id).toBe(EXPLICIT_ROWS[1].id);

    // A 的两行在 limit 1 下只剩较新的那一行，且与全量列表的第一行一致。
    const aAll = await list(USER_A, 20);
    const aOne = await list(USER_A, 1);
    expect(aOne).toHaveLength(1);
    expect(firstRow(aOne).id).toBe(firstRow(aAll).id);
  });

  it("error: a failing read is wrapped, and the pool stays usable", async () => {
    const brokenPool: TransactionPool = {
      async connect() {
        return {
          async query(): Promise<{ rows: unknown[] }> {
            throw new Error("connection terminated unexpectedly");
          },
          release() {
            // 断开之后无可释放。
          },
        };
      },
    };

    const broken = createPoolTransactionReadRepository({ pool: brokenPool });
    const error = await broken
      .listMemberPoolTransactions({
        workspaceId,
        userId: USER_A,
        limit: 20,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PoolTransactionReadError);
    const readError = error as PoolTransactionReadError;
    expect(readError.operation).toBe(LIST_MEMBER_POOL_TRANSACTIONS);
    expect(readError.operation).toBe("listMemberPoolTransactions");
    // 固定文案：不带 SQL、不带 host、不带连接串、不带 id。
    expect(readError.message).toBe(
      `pool transaction read failed (${LIST_MEMBER_POOL_TRANSACTIONS})`,
    );
    expect(readError.message).not.toMatch(
      /public\.|credit_transactions|postgres:\/\/|connection terminated/i,
    );
    expect((readError.cause as Error).message).toBe(
      "connection terminated unexpectedly",
    );

    // 真实 SQL 失败同样被包起来：非 uuid 的绑定参数由 PostgreSQL 拒绝。
    const sqlError = await repository
      .listMemberPoolTransactions({
        workspaceId: "not-a-uuid",
        userId: USER_A,
        limit: 20,
      })
      .catch((reason: unknown) => reason);
    expect(sqlError).toBeInstanceOf(PoolTransactionReadError);
    expect(((sqlError as PoolTransactionReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // 失败的那次事务没动任何行，同一个 pool 之后照样能读。
    await expect(list(USER_A, 20)).resolves.toHaveLength(2);
  });
});
