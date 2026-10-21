import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPoolBalanceReadRepository,
  type PoolBalanceReadRepository,
} from "../../db/pool-balance-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Workorder 38N - BL-44: `public.set_team_pool_limit`.
 *
 * Migration `20261021000011_hahart_set_team_pool_limit.sql`. The administrator changes this
 * month's team pool limit; `pool_used` is left alone, so what a member can still use follows at
 * once. Real SQL on PGlite, with the grant (37O), the charge (37N) and the balance read (37P)
 * all real.
 */

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let pool: TransactionPool;
let repository: PoolBalanceReadRepository;
let seq = 0;

type Team = { workspaceId: string; adminId: string; memberId: string };

function nextUuid(prefix: string): string {
  seq += 1;
  return `00000000-0000-0000-0000-000000${prefix}${String(seq).padStart(3, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function sqlFailureCode(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return "no-error";
}

/** A fresh 3-person team: the personal workspace owner plus two more members. */
async function newTeam(): Promise<Team> {
  const adminId = nextUuid("38a");
  await createUser(db, adminId, `admin-38n-${adminId.slice(-3)}@hahart.test`);
  const workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [adminId],
      )
    ).rows,
  ).id;

  let memberId = "";
  for (let i = 0; i < 2; i += 1) {
    memberId = nextUuid("38b");
    await createUser(db, memberId, `member-38n-${memberId.slice(-3)}@hahart.test`);
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [workspaceId, memberId],
    );
  }
  return { workspaceId, adminId, memberId };
}

async function grantCycle(team: Team): Promise<number> {
  return firstRow(
    (
      await db.query<{ v: number }>("select public.grant_team_cycle($1, null, null) as v", [
        team.workspaceId,
      ])
    ).rows,
  ).v;
}

async function deduct(team: Team, amount: number): Promise<void> {
  await db.query("select public.deduct_from_pools($1, $2, $3, null, 'test')", [
    team.workspaceId,
    team.memberId,
    amount,
  ]);
}

async function setLimit(team: Team, limit: number | null): Promise<number> {
  return firstRow(
    (
      await db.query<{ v: number }>(
        "select public.set_team_pool_limit($1::uuid, $2::integer, $3::uuid) as v",
        [team.workspaceId, limit, team.adminId],
      )
    ).rows,
  ).v;
}

async function poolRow(team: Team): Promise<{ pool_limit: number; pool_used: number }> {
  return firstRow(
    (
      await db.query<{ pool_limit: number; pool_used: number }>(
        `select pool_limit, pool_used from public.team_credit_pools
         where workspace_id = $1 and period_month = ${MONTH_SQL}`,
        [team.workspaceId],
      )
    ).rows,
  );
}

type TxRow = {
  amount: number;
  balance_after: number;
  pool: string | null;
  user_id: string | null;
  metadata: Record<string, unknown> | null;
};

async function ledger(team: Team, type: string): Promise<TxRow[]> {
  return (
    await db.query<TxRow>(
      `select amount, balance_after, pool, user_id, metadata from public.credit_transactions
       where workspace_id = $1 and transaction_type::text = $2
       order by created_at, id`,
      [team.workspaceId, type],
    )
  ).rows;
}

async function ledgerCount(team: Team): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.credit_transactions where workspace_id = $1",
        [team.workspaceId],
      )
    ).rows,
  ).n;
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

describe("set_team_pool_limit (38N)", () => {
  it("BL-44: changing the pool to 50000 takes effect this month", async () => {
    const team = await newTeam();
    expect(await grantCycle(team)).toBe(60000);
    await deduct(team, 30);

    expect(await setLimit(team, 50000)).toBe(50000);

    expect(await poolRow(team)).toEqual({ pool_limit: 50000, pool_used: 30 });
    const balances = await repository.readPoolBalances({
      workspaceId: team.workspaceId,
      userId: team.memberId,
    });
    expect(balances.teamRemaining).toBe(49970);
  });

  it("BL-44: the change is on the ledger with who and what", async () => {
    const team = await newTeam();
    await grantCycle(team);

    await setLimit(team, 50000);

    const rows = await ledger(team, "admin_adjustment");
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.amount).toBe(-10000);
    expect(row.pool).toBe("team");
    expect(row.user_id).toBeNull();
    expect(row.balance_after).toBe(50000);
    expect(row.metadata?.limit_before).toBe(60000);
    expect(row.metadata?.limit_after).toBe(50000);
    expect(row.metadata?.operator_id).toBe(team.adminId);
  });

  it("BL-44: a pool row is created first when the month has none", async () => {
    const team = await newTeam();
    expect((await ledger(team, "cycle_grant")).length).toBe(0);

    expect(await setLimit(team, 50000)).toBe(50000);

    const grants = await ledger(team, "cycle_grant");
    expect(grants.length).toBe(1);
    expect(firstRow(grants).amount).toBe(60000);
    const adjustments = await ledger(team, "admin_adjustment");
    expect(adjustments.length).toBe(1);
    expect(firstRow(adjustments).amount).toBe(-10000);
    expect((await poolRow(team)).pool_limit).toBe(50000);
  });

  it("BL-44: setting the same limit writes nothing", async () => {
    const team = await newTeam();
    await grantCycle(team);
    await setLimit(team, 50000);
    const before = await ledgerCount(team);

    expect(await setLimit(team, 50000)).toBe(50000);

    expect(await ledgerCount(team)).toBe(before);
    expect((await poolRow(team)).pool_limit).toBe(50000);
  });

  it("BL-44: a negative limit is refused", async () => {
    const team = await newTeam();
    await grantCycle(team);

    expect(await sqlFailureCode(setLimit(team, -1))).toBe("22023");
    expect(await sqlFailureCode(setLimit(team, null))).toBe("22023");
    expect((await poolRow(team)).pool_limit).toBe(60000);
  });

  it("security: only the service role may call it", async () => {
    const team = await newTeam();

    const code = await sqlFailureCode(
      asUser(db, team.adminId, (tx) =>
        tx.query("select public.set_team_pool_limit($1::uuid, 50000, $2::uuid)", [
          team.workspaceId,
          team.adminId,
        ]),
      ),
    );

    expect(code).toBe("42501");
  });
});
