import type { PGlite } from "@electric-sql/pglite";
import type { MemberCreditSummary } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LIST_MEMBER_CREDITS,
  MemberCreditReadError,
  createMemberCreditReadRepository,
  type MemberCreditReadRepository,
} from "../../db/member-credit-read-repository.js";
import { createAdminCreditWriteRepository } from "../../db/admin-credit-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * 工单37Z · AD-01 第 1 步 —— 成员额度概览 `listMemberCredits` 的真实 SQL 集成。
 *
 * 仓储自带的一条 `select` 由 PGlite 真正解析执行：月键 / 日键在 SQL 里算（与 37N
 * `deduct_from_pools`、37O `grant_daily_credits` 同写法），用量表与钱包表 LEFT JOIN
 * 到 `workspace_members` 上，所以「没有用量行 / 没有钱包行」是一种**正常答案**而不是
 * 少一行成员。
 *
 * 发放用 37O 的两个函数、扣费用 37N 的函数、上限用 37W 的 `set_personal_cap`、充值
 * 用 37U 的 `admin_adjust_topup`，不由本文件直接写池表：这样读到的数字是「真实发放 +
 * 真实扣费之后」的口径，而不是本文件臆想的行。
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let pool: TransactionPool;
let repository: MemberCreditReadRepository;
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
  const userId = nextUuid("37a");
  await createUser(db, userId, `user-37a-${userId.slice(-3)}@hahart.test`);

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

/** 往工作区再补一个成员（他另有自己的个人工作区，互不干扰）。 */
async function addMember(actor: Actor): Promise<string> {
  const memberId = nextUuid("37b");
  await createUser(db, memberId, `member-37b-${memberId.slice(-3)}@hahart.test`);
  await db.query(
    "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
    [actor.workspaceId, memberId],
  );
  return memberId;
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

/** 37W：本月个人上限（写 member_cap_settings 和本月用量行）。 */
async function setCap(actor: Actor, cap: number): Promise<number> {
  return firstRow(
    (
      await db.query<{ cap: number }>(
        "select public.set_personal_cap($1::uuid, $2::uuid, $3::integer) as cap",
        [actor.workspaceId, actor.userId, cap],
      )
    ).rows,
  ).cap;
}

/** 37U：充值池加值（操作者就是本人，本表不校验角色）。 */
async function adjustTopup(actor: Actor, delta: number): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as id",
        [actor.workspaceId, actor.userId, actor.userId, delta, "test"],
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

function list(workspaceId: string): Promise<MemberCreditSummary[]> {
  return repository.listMemberCredits({ workspaceId });
}

/** 工作区成员数，用来核对「行数 = 成员数」。 */
async function memberCount(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ count: number }>(
        "select count(*)::int as count from public.workspace_members where workspace_id = $1",
        [workspaceId],
      )
    ).rows,
  ).count;
}

function rowFor(
  rows: readonly MemberCreditSummary[],
  userId: string,
): MemberCreditSummary {
  const row = rows.find((candidate) => candidate.userId === userId);
  if (row === undefined) throw new Error(`no summary row for ${userId}`);
  return row;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createMemberCreditReadRepository({
    getTransactionPool: () => pool,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("listMemberCredits (37Z): 成员额度概览", () => {
  it("AD-01: a raised cap shows in the summary", async () => {
    const actor = await newActor();

    // 37W 把本月上限改成 30000：概览必须报这一行，不是 schema 默认的 20000。
    expect(await setCap(actor, 30000)).toBe(30000);

    const rows = await list(actor.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, actor.userId)).toEqual({
      userId: actor.userId,
      personalCap: 30000,
      teamUsed: 0,
      topup: 0,
      dailyRemaining: 0,
    });

    // 本月用量行里确实存着 30000，读到的不是函数兜底值。
    expect(
      firstRow(
        (
          await db.query<{ personal_cap: number }>(
            `select personal_cap from public.member_team_usage
              where workspace_id = $1::uuid and user_id = $2::uuid
                and period_month = ${MONTH_SQL}`,
            [actor.workspaceId, actor.userId],
          )
        ).rows,
      ).personal_cap,
    ).toBe(30000);

    // 改回去：概览跟着走，不是只读一次就定住。
    expect(await setCap(actor, 15000)).toBe(15000);
    expect(rowFor(await list(actor.workspaceId), actor.userId).personalCap).toBe(
      15000,
    );
  });

  it("AD-01: the summary reports team use, top-up and today's daily", async () => {
    const actor = await newActor();
    expect(await grantCycle(actor)).toBe(20000);
    expect(await grantDaily(actor)).toBe(true);
    expect(await adjustTopup(actor, 50)).toEqual(expect.any(String));

    // 130 = 每日 100 全用 + 团队 30（充值池不动）。
    expect(await deduct(actor, 130)).toEqual(expect.any(String));

    const rows = await list(actor.workspaceId);
    expect(rowFor(rows, actor.userId)).toEqual({
      userId: actor.userId,
      personalCap: 20000,
      teamUsed: 30,
      topup: 50,
      dailyRemaining: 0,
    });

    // 与 37N 留下的流水核对：这次扣费确实是 daily 100 + team 30。
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

  it("AD-01: a member who never spent reads defaults", async () => {
    const actor = await newActor();
    const memberB = await addMember(actor);

    // B 没有钱包行、没有用量行、没有上限设定。
    for (const table of ["member_team_usage", "user_credit_wallets"]) {
      expect(
        firstRow(
          (
            await db.query<{ count: number }>(
              `select count(*)::int as count from public.${table} where user_id = $1`,
              [memberB],
            )
          ).rows,
        ).count,
      ).toBe(0);
    }

    expect(rowFor(await list(actor.workspaceId), memberB)).toEqual({
      userId: memberB,
      personalCap: 20000,
      teamUsed: 0,
      topup: 0,
      dailyRemaining: 0,
    });
  });

  it("AD-01: only this workspace's members are listed", async () => {
    const actor = await newActor();
    await addMember(actor);
    await addMember(actor);
    expect(await memberCount(actor.workspaceId)).toBe(3);

    // 另一个工作区（另一个人的个人工作区），谁都不该出现在对方的概览里。
    const other = await newActor();

    const rows = await list(actor.workspaceId);
    expect(rows).toHaveLength(3);
    expect(rows).toHaveLength(await memberCount(actor.workspaceId));
    expect(rows.map((row) => row.userId)).not.toContain(other.userId);

    const otherRows = await list(other.workspaceId);
    expect(otherRows).toHaveLength(1);
    expect(otherRows).toEqual([
      {
        userId: other.userId,
        personalCap: 20000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 0,
      },
    ]);

    // 空工作区是「零行」而不是错误：没有任何成员就什么都不报。
    const empty = nextUuid("37c");
    expect(await list(empty)).toEqual([]);
  });

  it("AD-01: yesterday's daily balance reads as zero", async () => {
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
      firstRow((await db.query<{ d: string }>(`select ${TODAY_SQL}::text as d`)).rows)
        .d,
    );

    expect(rowFor(await list(actor.workspaceId), actor.userId)).toEqual({
      userId: actor.userId,
      personalCap: 20000,
      teamUsed: 0,
      topup: 0,
      dailyRemaining: 0,
    });

    // 同一天则照读：读到的 0 是「过期」，不是「永远读 0」。
    await setWallet(actor, 40, 0, 0);
    expect(
      rowFor(await list(actor.workspaceId), actor.userId).dailyRemaining,
    ).toBe(40);

    // 充值池不受日键影响，换天照读。
    await setWallet(actor, 40, 15, 1);
    expect(rowFor(await list(actor.workspaceId), actor.userId)).toEqual({
      userId: actor.userId,
      personalCap: 20000,
      teamUsed: 0,
      topup: 15,
      dailyRemaining: 0,
    });
  });

  it("error: a failing query is wrapped", async () => {
    const actor = await newActor();

    // 断开的 pool：连接一建起来，任何语句都失败。
    const broken = createMemberCreditReadRepository({
      getTransactionPool: () => ({
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
      }),
    });

    const error = await broken
      .listMemberCredits({ workspaceId: actor.workspaceId })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MemberCreditReadError);
    const readError = error as MemberCreditReadError;
    expect(readError.operation).toBe(LIST_MEMBER_CREDITS);
    expect(readError.operation).toBe("listMemberCredits");
    // 固定文案：不带 SQL、不带 host、不带连接串、不带 id。
    expect(readError.message).toBe(
      `member credit read failed (${LIST_MEMBER_CREDITS})`,
    );
    expect(readError.message).not.toMatch(
      /public\.|workspace_members|postgres:\/\/|connection terminated/i,
    );
    expect((readError.cause as Error).message).toBe(
      "connection terminated unexpectedly",
    );

    // 真实 SQL 失败同样被包起来：非 uuid 的绑定参数由 PostgreSQL 拒绝。
    const sqlError = await repository
      .listMemberCredits({ workspaceId: "not-a-uuid" })
      .catch((reason: unknown) => reason);
    expect(sqlError).toBeInstanceOf(MemberCreditReadError);
    expect((sqlError as MemberCreditReadError).operation).toBe(
      LIST_MEMBER_CREDITS,
    );
    expect(((sqlError as MemberCreditReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // 失败的那次事务没动任何行，同一个 pool 之后照样能读。
    expect(await list(actor.workspaceId)).toEqual([
      {
        userId: actor.userId,
        personalCap: 20000,
        teamUsed: 0,
        topup: 0,
        dailyRemaining: 0,
      },
    ]);
  });

  it("AD-01: a paused member reads as generationPaused: true and others have no such key", async () => {
    const actor = await newActor();
    const memberB = await addMember(actor);

    // 39N 的暂停函数：真行写进 member_generation_pauses，读的是同一张表。
    expect(
      firstRow(
        (
          await db.query<{ v: boolean }>(
            `select public.set_member_generation_paused(
               $1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::text
             ) as v`,
            [actor.workspaceId, memberB, actor.userId, true, "异常消耗"],
          )
        ).rows,
      ).v,
    ).toBe(true);

    const rows = await list(actor.workspaceId);

    // 暂停的成员：键在，值是 true。
    expect(rowFor(rows, memberB)).toEqual({
      userId: memberB,
      personalCap: 20000,
      teamUsed: 0,
      topup: 0,
      dailyRemaining: 0,
      generationPaused: true,
    });

    // 没暂停的成员：整对象里**没有**这个键，不是带一个 false。
    const runningRow = rowFor(rows, actor.userId);
    expect(Object.hasOwn(runningRow, "generationPaused")).toBe(false);
    expect(runningRow).toEqual({
      userId: actor.userId,
      personalCap: 20000,
      teamUsed: 0,
      topup: 0,
      dailyRemaining: 0,
    });

    // 恢复：键跟着消失。
    expect(
      firstRow(
        (
          await db.query<{ v: boolean }>(
            `select public.set_member_generation_paused(
               $1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::text
             ) as v`,
            [actor.workspaceId, memberB, actor.userId, false, null],
          )
        ).rows,
      ).v,
    ).toBe(true);
    expect(
      Object.hasOwn(rowFor(await list(actor.workspaceId), memberB), "generationPaused"),
    ).toBe(false);
  });
});

/**
 * AD-01 / 39O —— 「有操作人才写审计」的那一半：「不传 operatorId 时跑原函数」。
 *
 * `member-pause-and-credit-audit-db.test.ts` 只验数据库函数本身；这一节验的是
 * **仓储**在有 / 无 operatorId 时选了哪条语句：审计包装写一行，原语句一行不写。
 */

/** `credits.set_cap` 审计行数（按被改的那个人数）。 */
async function capAuditCount(targetUserId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ count: number }>(
        `select count(*)::int as count from public.admin_audit_log
          where action = 'credits.set_cap' and target_user_id = $1::uuid`,
        [targetUserId],
      )
    ).rows,
  ).count;
}

describe("admin credit write (39O): the auditing wrapper is opt-in", () => {
  it("AD-01: without an operator the old function runs", async () => {
    const actor = await newActor();
    const writes = createAdminCreditWriteRepository({
      getTransactionPool: () => pool,
    });

    // 不传 operatorId：走 39O 之前那条语句，审计表一行都不多。
    expect(
      await writes.setPersonalCap({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        cap: 21000,
      }),
    ).toBe(21000);
    expect(await capAuditCount(actor.userId)).toBe(0);

    // 传了 operatorId：同一次改动由审计包装完成，恰好一行审计。
    expect(
      await writes.setPersonalCap({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        cap: 22000,
        operatorId: actor.userId,
      }),
    ).toBe(22000);
    expect(await capAuditCount(actor.userId)).toBe(1);

    // 两条路径写的是同一个字段：概览读到的就是最后那次的上限。
    expect(rowFor(await list(actor.workspaceId), actor.userId).personalCap).toBe(
      22000,
    );
  });

  it("AD-01: an empty operator is refused instead of silently unaudited", async () => {
    const actor = await newActor();
    const writes = createAdminCreditWriteRepository({
      getTransactionPool: () => pool,
    });

    const error = await writes
      .setPersonalCap({
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        cap: 21000,
        operatorId: "",
      })
      .catch((reason: unknown) => reason);

    expect((error as Error).message).toBe(
      'admin credit write needs a non-empty "operatorId"',
    );
    // 空操作人不能降级成「不写审计」的那条路：一行都没写。
    expect(await capAuditCount(actor.userId)).toBe(0);
    expect(rowFor(await list(actor.workspaceId), actor.userId).personalCap).toBe(
      20000,
    );
  });
});
