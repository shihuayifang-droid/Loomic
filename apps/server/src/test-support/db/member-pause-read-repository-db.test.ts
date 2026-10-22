import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MemberPauseReadError,
  createMemberPauseReadRepository,
  type MemberPauseReadRepository,
} from "../../db/member-pause-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * 工单39P · AD-01 / BL-21 第 3 步 —— 服务端闸门读的那一条 `exists`。
 *
 * 39N 的 `member_generation_pauses` 只给 service role，写入只有
 * `set_member_generation_paused` 一条路；这里不直接写表，而是用那个函数把真行写进去，
 * 再由仓储的**真 SQL**（PGlite 真正解析执行，join `workspaces` 限定 `type = 'team'`）
 * 读回来。这样测到的就是「管理员点了暂停之后，扣费前的闸门会不会拦」这个口径，而不是
 * 本文件臆想的一行。
 *
 * `isGenerationPaused` 只按 `user_id` 问，没有 workspace 参数：暂停是**成员**的属性，
 * 不是某一次请求的属性，所以换一个工作区提交也不能绕过。下面第 3 例把这句钉住。
 *
 * 只有一个团队工作区：数据库有 `workspaces_single_team_key`（全库单团队），所以团队建
 * 一次，每例只新造成员并挂进这个团队。
 */

let db: PGlite;
let pool: TransactionPool;
let repository: MemberPauseReadRepository;
let teamWorkspaceId = "";
let adminId = "";
let seq = 0;

function nextUuid(prefix: string): string {
  seq += 1;
  return `00000000-0000-0000-0000-000000${prefix}${String(seq).padStart(3, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** 一个全新成员：signup trigger 建个人工作区，这里再把他挂进唯一那个团队。 */
async function newMember(): Promise<string> {
  const userId = nextUuid("39b");
  await createUser(db, userId, `member-39p-${userId.slice(-3)}@hahart.test`);
  await db.query(
    "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
    [teamWorkspaceId, userId],
  );
  return userId;
}

/** 39N：管理员暂停 / 恢复一个成员（真的写 `member_generation_pauses`）。 */
async function setPaused(
  workspaceId: string,
  userId: string,
  adminUserId: string,
  paused: boolean,
  reason: string | null,
): Promise<boolean> {
  return firstRow(
    (
      await db.query<{ v: boolean }>(
        `select public.set_member_generation_paused(
           $1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::text
         ) as v`,
        [workspaceId, userId, adminUserId, paused, reason],
      )
    ).rows,
  ).v;
}

/** 闸门读的那一次调用：只有 userId，没有 workspace。 */
function isPaused(userId: string): Promise<boolean> {
  return repository.isGenerationPaused({ userId });
}

/** 某人的个人工作区 id（signup trigger 建的），用于「非团队工作区的暂停行」。 */
async function personalWorkspaceOf(userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createMemberPauseReadRepository({
    getTransactionPool: () => pool,
  });

  adminId = nextUuid("39a");
  await createUser(db, adminId, `admin-39p-${adminId.slice(-3)}@hahart.test`);
  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2)
         returning id`,
        ["team-39p", adminId],
      )
    ).rows,
  ).id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("isGenerationPaused (39P): 暂停后提交一律被拒的那一次读", () => {
  it("AD-01: a paused member is paused, and a resume clears it", async () => {
    const memberId = await newMember();

    // 暂停之前：没人被暂停，闸门必须读 false（否则每一次生成都会被拒）。
    expect(await isPaused(memberId)).toBe(false);
    expect(await isPaused(adminId)).toBe(false);

    // 管理员暂停这个成员：真行进了 member_generation_pauses。
    expect(
      await setPaused(teamWorkspaceId, memberId, adminId, true, "异常消耗"),
    ).toBe(true);

    expect(await isPaused(memberId)).toBe(true);

    // 恢复：读回来必须是 false，不是「暂停过就永远是暂停」。
    expect(
      await setPaused(teamWorkspaceId, memberId, adminId, false, null),
    ).toBe(true);

    expect(await isPaused(memberId)).toBe(false);
  });

  it("AD-01: another member of the same team is not paused", async () => {
    const memberId = await newMember();
    const otherMemberId = await newMember();

    expect(
      await setPaused(teamWorkspaceId, memberId, adminId, true, "异常消耗"),
    ).toBe(true);

    // 只暂停了一个人：另外两个成员仍然是 false。
    expect(await isPaused(memberId)).toBe(true);
    expect(await isPaused(otherMemberId)).toBe(false);
    expect(await isPaused(adminId)).toBe(false);
  });

  it("BL-21: a pause row written against a personal workspace is not a team pause", async () => {
    const memberId = await newMember();
    const personalWorkspaceId = await personalWorkspaceOf(memberId);

    // 39N 的函数不校验工作区类型，所以这条行写得进去；闸门的 join 只认 type = 'team'，
    // 因此它**不**该让这个成员变成「已暂停」。
    expect(
      await setPaused(
        personalWorkspaceId,
        memberId,
        adminId,
        true,
        "个人工作区的暂停行",
      ),
    ).toBe(true);

    expect(
      firstRow(
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from public.member_generation_pauses where user_id = $1::uuid",
            [memberId],
          )
        ).rows,
      ).n,
    ).toBe(1);

    expect(await isPaused(memberId)).toBe(false);
  });

  it("BL-21: a failed read throws instead of answering not-paused", async () => {
    const broken = createMemberPauseReadRepository({
      getTransactionPool: () => {
        throw new Error("no pool");
      },
    });

    const error = await broken
      .isGenerationPaused({ userId: nextUuid("39d") })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MemberPauseReadError);
    // 固定文本：不带 SQL、不带主机、不带 id。
    expect((error as MemberPauseReadError).message).toBe(
      "member pause read failed (isGenerationPaused)",
    );
    expect((error as MemberPauseReadError).operation).toBe("isGenerationPaused");
  });
});
