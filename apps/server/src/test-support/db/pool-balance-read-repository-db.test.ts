import type { PGlite } from "@electric-sql/pglite";
import { availableCredits } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PoolBalanceReadError,
  READ_POOL_BALANCES,
  createPoolBalanceReadRepository,
  type PoolBalanceReadRepository,
} from "../../db/pool-balance-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * 工单37P · BL-45 第 5 步 —— 三池余额读取仓储 `readPoolBalances` 的真实 SQL 集成。
 *
 * 仓储自带的一条 `select` 由 PGlite 真正解析执行：月键 / 日键在 SQL 里算（与 37N
 * `deduct_from_pools`、37O `grant_daily_credits` 同写法），三张表 LEFT JOIN 到一行，
 * 所以「没有池行 / 没有用量行 / 没有钱包行」都是一种**正常答案**而不是错误。
 *
 * 发放用 37O 的两个函数、扣费用 37N 的函数，不由本文件直接写池表：这样读到的数字
 * 是「真实发放 + 真实扣费之后」的口径，而不是本文件臆想的行。
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let pool: TransactionPool;
let repository: PoolBalanceReadRepository;
let seq = 0;

type Actor = { userId: string; workspaceId: string };

function nextUuid(prefix: string): string {
  seq += 1;
  return `00000000-0000-0000-0000-000000${prefix}${String(seq).padStart(3, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** 每例一个新用户：signup trigger 建个人工作区，池 / 钱包 / 用量互不干扰。 */
async function newActor(): Promise<Actor> {
  const userId = nextUuid("37e");
  await createUser(db, userId, `user-37p-${userId.slice(-3)}@hahart.test`);

  const row = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      )
    ).rows,
  );
  return { userId, workspaceId: row.id };
}

/** 往工作区再补两个成员：个人工作区本身已有 owner，补完恰好 3 人。 */
async function makeThreeMemberTeam(actor: Actor): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    const memberId = nextUuid("37f");
    await createUser(db, memberId, `member-37p-${memberId.slice(-3)}@hahart.test`);
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [actor.workspaceId, memberId],
    );
  }
  expect(
    firstRow(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_members where workspace_id = $1",
          [actor.workspaceId],
        )
      ).rows,
    ).count,
  ).toBe(3);
}

/** 37O：本月团队池发放（默认 = 成员数 x 20000）。 */
async function grantCycle(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ v: number }>(
        "select public.grant_team_cycle($1, null, null) as v",
        [actor.workspaceId],
      )
    ).rows,
  ).v;
}

/** 37O：每日赠送入钱包（默认 100）。 */
async function grantDaily(actor: Actor): Promise<boolean> {
  return firstRow(
    (
      await db.query<{ v: boolean }>(
        "select public.grant_daily_credits($1, $2) as v",
        [actor.userId, actor.workspaceId],
      )
    ).rows,
  ).v;
}

/** 37N：按池扣费。 */
async function deduct(actor: Actor, amount: number): Promise<string | null> {
  return firstRow(
    (
      await db.query<{ id: string | null }>(
        "select public.deduct_from_pools($1, $2, $3, null, 'test') as id",
        [actor.workspaceId, actor.userId, amount],
      )
    ).rows,
  ).id;
}

/** 钱包直接置行：日键相对北京时间今天偏移 `dayOffset` 天。 */
async function setWallet(
  actor: Actor,
  daily: number,
  topup: number,
  dayOffset = 0,
): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1, ${TODAY_SQL} - $2::int, $3, $4)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [actor.userId, dayOffset, daily, topup],
  );
}

function read(actor: Actor) {
  return repository.readPoolBalances({
    workspaceId: actor.workspaceId,
    userId: actor.userId,
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createPoolBalanceReadRepository({ pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("readPoolBalances (37P): 三池读取", () => {
  it("BL-45: a member with nothing set up reads all zero with the default cap", async () => {
    const actor = await newActor();

    await expect(read(actor)).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });

    // 一例都不写行：三张表对这个成员都是空的，而答案仍是一行数字，不是错误。
    for (const table of [
      "team_credit_pools",
      "member_team_usage",
      "user_credit_wallets",
    ]) {
      const count = firstRow(
        (
          await db.query<{ count: number }>(
            table === "user_credit_wallets"
              ? `select count(*)::int as count from public.${table} where user_id = $1`
              : table === "member_team_usage"
                ? `select count(*)::int as count from public.${table} where user_id = $1`
                : `select count(*)::int as count from public.${table} where workspace_id = $1`,
            [table === "team_credit_pools" ? actor.workspaceId : actor.userId],
          )
        ).rows,
      ).count;
      expect([table, count]).toEqual([table, 0]);
    }

    // 同一工作区里不存在的用户 id 也是这个答案，而不是 0 行。
    const unknown = nextUuid("380");
    await expect(
      repository.readPoolBalances({
        workspaceId: actor.workspaceId,
        userId: unknown,
      }),
    ).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });
  });

  it("BL-45: granted pools read back", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);

    // 3 人 -> 默认团队池 3 x 20000 = 60000；每日赠送 100。
    expect(await grantCycle(actor)).toBe(60000);
    expect(await grantDaily(actor)).toBe(true);

    await expect(read(actor)).resolves.toEqual({
      daily: 100,
      teamRemaining: 60000,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });
  });

  it("BL-45: a charge shows up in the read", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    await grantCycle(actor);
    await grantDaily(actor);

    // 130 = 每日 100 全用 + 团队 30（个人上限 20000 远未到）。
    await expect(deduct(actor, 130)).resolves.toEqual(expect.any(String));

    await expect(read(actor)).resolves.toEqual({
      daily: 0,
      teamRemaining: 59970,
      personalTeamUsed: 30,
      personalCap: 20000,
      topup: 0,
    });

    // 并用 37N 留下的流水核对：这次扣费确实是 daily 100 + team 30。
    const tx = firstRow(
      (
        await db.query<{ pool_breakdown: Record<string, number> }>(
          `select pool_breakdown from public.credit_transactions
            where workspace_id = $1 and transaction_type = 'generation_deduct'`,
          [actor.workspaceId],
        )
      ).rows,
    );
    expect(tx.pool_breakdown).toEqual({ daily: 100, team: 30, topup: 0 });
  });

  it("BL-45: yesterday's daily balance reads as zero", async () => {
    const actor = await newActor();
    await setWallet(actor, 40, 0, 1);

    // 行真的在，且 daily_date 是北京时间昨天 40：过期即 0。
    const wallet = firstRow(
      (
        await db.query<{ daily_balance: number; daily_date: string }>(
          "select daily_balance, daily_date::text as daily_date from public.user_credit_wallets where user_id = $1",
          [actor.userId],
        )
      ).rows,
    );
    expect(wallet.daily_balance).toBe(40);
    expect(wallet.daily_date).not.toBe(
      firstRow((await db.query<{ d: string }>(`select ${TODAY_SQL}::text as d`)).rows).d,
    );

    await expect(read(actor)).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });

    // 同一天则照读：读到的 0 是「过期」，不是「永远读 0」。
    await setWallet(actor, 40, 0, 0);
    await expect(read(actor)).resolves.toEqual({
      daily: 40,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });

    // 充值池不受日键影响，换天照读。
    await setWallet(actor, 40, 15, 1);
    await expect(read(actor)).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 15,
    });
  });

  it("BL-45: the read agrees with availableCredits", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    await grantCycle(actor);
    await grantDaily(actor);
    await deduct(actor, 130);

    const balances = await read(actor);

    // 0 + min(59970, 20000 - 30) + 0。
    expect(availableCredits(balances)).toBe(19970);
    expect(balances).toEqual({
      daily: 0,
      teamRemaining: 59970,
      personalTeamUsed: 30,
      personalCap: 20000,
      topup: 0,
    });

    // 再加充值池：可用额度 = 每日 + 团队可再取 + 充值。
    await setWallet(actor, 0, 7, 0);
    expect(availableCredits(await read(actor))).toBe(19977);
  });

  it("BL-45: another member's usage is not mine", async () => {
    const actor = await newActor();
    await makeThreeMemberTeam(actor);
    await grantCycle(actor);

    // 同工作区的成员 B：没有钱包行，50 整笔走团队池。
    const memberB = nextUuid("381");
    await createUser(db, memberB, `member-b-37p@hahart.test`);
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [actor.workspaceId, memberB],
    );
    expect(
      await deduct(
        { userId: memberB, workspaceId: actor.workspaceId },
        50,
      ),
    ).toEqual(expect.any(String));

    const mine = await read(actor);
    expect(mine.personalTeamUsed).toBe(0);
    expect(mine.teamRemaining).toBe(59950);

    // B 自己读到的是自己的用量，看到的是同一个已扣减的团队池。
    await expect(
      repository.readPoolBalances({
        workspaceId: actor.workspaceId,
        userId: memberB,
      }),
    ).resolves.toEqual({
      daily: 0,
      teamRemaining: 59950,
      personalTeamUsed: 50,
      personalCap: 20000,
      topup: 0,
    });
  });

  it("error: a failing query is wrapped", async () => {
    const actor = await newActor();

    // 断开的 pool：连接一建起来，任何语句都失败。
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

    const broken = createPoolBalanceReadRepository({ pool: brokenPool });
    const error = await broken
      .readPoolBalances({ workspaceId: actor.workspaceId, userId: actor.userId })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(PoolBalanceReadError);
    const readError = error as PoolBalanceReadError;
    expect(readError.operation).toBe(READ_POOL_BALANCES);
    expect(readError.operation).toBe("readPoolBalances");
    // 固定文案：不带 SQL、不带 host、不带连接串、不带 id。
    expect(readError.message).toBe(
      `pool balance read failed (${READ_POOL_BALANCES})`,
    );
    expect(readError.message).not.toMatch(
      /public\.|team_credit_pools|postgres:\/\/|connection terminated/i,
    );
    expect((readError.cause as Error).message).toBe(
      "connection terminated unexpectedly",
    );

    // 真实 SQL 失败同样被包起来：非 uuid 的绑定参数由 PostgreSQL 拒绝。
    const sqlError = await repository
      .readPoolBalances({
        workspaceId: "not-a-uuid",
        userId: actor.userId,
      })
      .catch((reason: unknown) => reason);
    expect(sqlError).toBeInstanceOf(PoolBalanceReadError);
    expect((sqlError as PoolBalanceReadError).operation).toBe(
      READ_POOL_BALANCES,
    );
    expect(((sqlError as PoolBalanceReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // 失败的那次事务没动任何行，同一个 pool 之后照样能读。
    await expect(read(actor)).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });
  });
});
