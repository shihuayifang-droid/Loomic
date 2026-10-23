import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMemberCreditReadRepository } from "../../db/member-credit-read-repository.js";
import { createPoolBalanceReadRepository } from "../../db/pool-balance-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43T: canonical migration 0008 (team credit pools and member quotas) on
 * an empty database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0008 is the final form of that
 * chain. Nothing here asserts that the objects of 0009 do not exist yet.
 */

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0008_credit_pools.sql",
);

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";
const TODAY_SQL = "(now() at time zone 'Asia/Shanghai')::date";

const TABLES = [
  "team_credit_pools",
  "member_team_usage",
  "user_credit_wallets",
  "credit_cap_templates",
  "member_cap_settings",
  "credit_transactions",
] as const;

const FUNCTIONS = [
  "deduct_from_pools",
  "refund_to_pools",
  "member_personal_cap",
  "member_team_usage_inherit_cap",
] as const;

type Actor = { userId: string; workspaceId: string };

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];
let seq = 0;

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** One fresh user (and personal workspace) per case, so pools never interfere. */
async function newActor(): Promise<Actor> {
  seq += 1;
  const userId = `00000000-0000-0000-0000-00000043b0${String(seq).padStart(2, "0")}`;
  await createCanonicalUser(db, userId, `pools-${seq}@hahart.test`);
  const row = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  );
  return { userId, workspaceId: row.id };
}

async function insertJob(actor: Actor): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [actor.workspaceId, actor.userId],
      )
    ).rows,
  ).id;
}

async function setPool(actor: Actor, limit: number, used = 0): Promise<void> {
  await db.query(
    `insert into public.team_credit_pools (workspace_id, period_month, pool_limit, pool_used)
     values ($1::uuid, ${MONTH_SQL}, $2, $3)`,
    [actor.workspaceId, limit, used],
  );
}

/** Wallet row; `dayOffset` days before Beijing-time today. */
async function setWallet(
  actor: Actor,
  daily: number,
  topup: number,
  dayOffset = 0,
): Promise<void> {
  await db.query(
    `insert into public.user_credit_wallets (user_id, daily_date, daily_balance, topup_balance)
     values ($1::uuid, ${TODAY_SQL} - $2::int, $3, $4)
     on conflict (user_id) do update
       set daily_date = excluded.daily_date,
           daily_balance = excluded.daily_balance,
           topup_balance = excluded.topup_balance`,
    [actor.userId, dayOffset, daily, topup],
  );
}

async function deduct(actor: Actor, amount: number, jobId: string | null = null): Promise<string> {
  const row = firstRow(
    (
      await db.query<{ id: string | null }>(
        "select public.deduct_from_pools($1::uuid, $2::uuid, $3, $4::uuid, 'test') as id",
        [actor.workspaceId, actor.userId, amount, jobId],
      )
    ).rows,
  );
  if (!row.id) throw new Error("expected a deduction id");
  return row.id;
}

async function refund(jobId: string): Promise<string | null> {
  return firstRow(
    (
      await db.query<{ id: string | null }>(
        "select public.refund_to_pools($1::uuid, 'test') as id",
        [jobId],
      )
    ).rows,
  ).id;
}

async function walletOf(actor: Actor): Promise<{ daily_balance: number; topup_balance: number }> {
  return firstRow(
    (
      await db.query<{ daily_balance: number; topup_balance: number }>(
        "select daily_balance, topup_balance from public.user_credit_wallets where user_id = $1::uuid",
        [actor.userId],
      )
    ).rows,
  );
}

async function poolUsed(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ pool_used: number }>(
        `select pool_used from public.team_credit_pools
          where workspace_id = $1::uuid and period_month = ${MONTH_SQL}`,
        [actor.workspaceId],
      )
    ).rows,
  ).pool_used;
}

async function memberUsed(actor: Actor): Promise<number | null> {
  const rows = (
    await db.query<{ used: number }>(
      `select used from public.member_team_usage
        where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
      [actor.workspaceId, actor.userId],
    )
  ).rows;
  return rows[0]?.used ?? null;
}

type TxRow = {
  transaction_type: string;
  amount: number;
  balance_after: number;
  pool: string | null;
  pool_breakdown: Record<string, number> | null;
  metadata: Record<string, string> | null;
};

async function txById(id: string): Promise<TxRow> {
  return firstRow(
    (
      await db.query<TxRow>(
        `select transaction_type::text as transaction_type, amount, balance_after, pool,
                pool_breakdown, metadata
           from public.credit_transactions where id = $1::uuid`,
        [id],
      )
    ).rows,
  );
}

async function countLedger(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.credit_transactions where workspace_id = $1::uuid",
        [actor.workspaceId],
      )
    ).rows,
  ).n;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0008 credit pools: schema", () => {
  it("applies 0008_credit_pools.sql", () => {
    expect(applied).toContain("0008_credit_pools.sql");
  });

  it("points every user_id foreign key at hahart_auth.users and not at auth.users", async () => {
    const result = await db.query<{ line: string }>(
      `select conrelid::regclass::text || ' -> ' || confrelid::regclass::text as line
         from pg_constraint
        where contype = 'f'
          and conrelid in ('public.member_team_usage'::regclass,
                           'public.user_credit_wallets'::regclass,
                           'public.member_cap_settings'::regclass)
          and conkey @> array[(select attnum from pg_attribute
                                where attrelid = conrelid and attname = 'user_id')]
        order by 1`,
    );
    expect(result.rows.map((row) => row.line)).toEqual([
      "member_cap_settings -> hahart_auth.users",
      "member_team_usage -> hahart_auth.users",
      "user_credit_wallets -> hahart_auth.users",
    ]);
  });

  it("member_team_usage_inherit_cap copies a stored setting into a new default-cap month row only", async () => {
    const actor = await newActor();
    await db.query(
      `insert into public.member_cap_settings (workspace_id, user_id, cap, source)
       values ($1::uuid, $2::uuid, 777, 'manual')`,
      [actor.workspaceId, actor.userId],
    );

    // Default cap on insert: replaced by the stored setting.
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month)
       values ($1::uuid, $2::uuid, '2020-01-01')`,
      [actor.workspaceId, actor.userId],
    );
    // Explicit cap on insert: kept as given.
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap)
       values ($1::uuid, $2::uuid, '2020-02-01', 5)`,
      [actor.workspaceId, actor.userId],
    );

    const rows = await db.query<{ period_month: string; personal_cap: number }>(
      `select period_month::text as period_month, personal_cap
         from public.member_team_usage
        where workspace_id = $1::uuid and user_id = $2::uuid
        order by period_month`,
      [actor.workspaceId, actor.userId],
    );
    expect(rows.rows).toEqual([
      { period_month: "2020-01-01", personal_cap: 777 },
      { period_month: "2020-02-01", personal_cap: 5 },
    ]);

    expect(
      firstRow(
        (
          await db.query<{ cap: number }>(
            "select public.member_personal_cap($1::uuid, $2::uuid) as cap",
            [actor.workspaceId, actor.userId],
          )
        ).rows,
      ).cap,
    ).toBe(777);

    const other = await newActor();
    expect(
      firstRow(
        (
          await db.query<{ cap: number }>(
            "select public.member_personal_cap($1::uuid, $2::uuid) as cap",
            [other.workspaceId, other.userId],
          )
        ).rows,
      ).cap,
    ).toBe(20000);
  });
});

describe("canonical 0008 credit pools: deduct_from_pools and refund_to_pools", () => {
  it("deducts daily pool first, then the team pool, and writes pool_breakdown", async () => {
    const actor = await newActor();
    await setPool(actor, 1000);
    await setWallet(actor, 100, 50);

    // 130 = daily 100 + team 30; the top-up pool is untouched.
    const txId = await deduct(actor, 130);
    expect(await txById(txId)).toEqual({
      transaction_type: "generation_deduct",
      amount: -130,
      // (100 - 100) daily + min(970, 20000 - 30) team + (50 - 0) top-up.
      balance_after: 1020,
      pool: null,
      pool_breakdown: { daily: 100, team: 30, topup: 0 },
      metadata: {},
    });
    expect(await walletOf(actor)).toEqual({ daily_balance: 0, topup_balance: 50 });
    expect(await poolUsed(actor)).toBe(30);
    expect(await memberUsed(actor)).toBe(30);

    // A single-pool charge names its pool: 970 team (the pool's rest) + 20 top-up.
    const second = await deduct(actor, 990);
    expect(await txById(second)).toMatchObject({
      pool: null,
      pool_breakdown: { daily: 0, team: 970, topup: 20 },
    });
    const third = await deduct(actor, 10);
    expect(await txById(third)).toMatchObject({
      pool: "topup",
      pool_breakdown: { daily: 0, team: 0, topup: 10 },
    });
    expect(await walletOf(actor)).toEqual({ daily_balance: 0, topup_balance: 20 });
  });

  it("refuses a charge that exceeds the personal cap with SQLSTATE P0403 and changes nothing", async () => {
    const actor = await newActor();
    await setPool(actor, 1000);
    await db.query(
      `insert into public.member_cap_settings (workspace_id, user_id, cap, source)
       values ($1::uuid, $2::uuid, 10, 'manual')`,
      [actor.workspaceId, actor.userId],
    );

    await expect(deduct(actor, 50)).rejects.toMatchObject({
      code: "P0403",
      message: expect.stringContaining("PERSONAL_CAP_REACHED"),
    });
    expect(await poolUsed(actor)).toBe(0);
    expect(await memberUsed(actor)).toBeNull();
    expect(await countLedger(actor)).toBe(0);
  });

  it("refuses with P0404 when the team pool runs out first, and P0402 when nothing is left", async () => {
    const actor = await newActor();
    await setPool(actor, 5);
    await expect(deduct(actor, 10)).rejects.toMatchObject({
      code: "P0404",
      message: expect.stringContaining("TEAM_POOL_EXHAUSTED"),
    });
    expect(await poolUsed(actor)).toBe(0);

    // No pool row and a cap of 0: both the pool and the cap are exhausted.
    const empty = await newActor();
    await db.query(
      `insert into public.member_cap_settings (workspace_id, user_id, cap, source)
       values ($1::uuid, $2::uuid, 0, 'manual')`,
      [empty.workspaceId, empty.userId],
    );
    await expect(deduct(empty, 10)).rejects.toMatchObject({
      code: "P0402",
      message: expect.stringContaining("INSUFFICIENT_CREDITS"),
    });
    expect(await countLedger(empty)).toBe(0);
  });

  it("refunds along the original path, once per job", async () => {
    const actor = await newActor();
    await setPool(actor, 1000);
    await setWallet(actor, 100, 50);
    const jobId = await insertJob(actor);

    // 120 = daily 100 + team 20.
    const deductId = await deduct(actor, 120, jobId);
    expect(await poolUsed(actor)).toBe(20);
    expect(await memberUsed(actor)).toBe(20);

    const refundId = await refund(jobId);
    expect(refundId).toBeTruthy();
    const refunded = await txById(refundId as string);
    expect(refunded).toEqual({
      transaction_type: "generation_refund",
      amount: 120,
      balance_after: 0,
      pool: null,
      pool_breakdown: { daily: 100, team: 20, topup: 0 },
      metadata: { original_transaction_id: deductId },
    });
    expect(await poolUsed(actor)).toBe(0);
    expect(await memberUsed(actor)).toBe(0);
    expect(await walletOf(actor)).toEqual({ daily_balance: 100, topup_balance: 50 });

    // A repeat returns the first refund row and writes nothing more.
    const ledgerBefore = await countLedger(actor);
    expect(await refund(jobId)).toBe(refundId);
    expect(await countLedger(actor)).toBe(ledgerBefore);
    expect(await poolUsed(actor)).toBe(0);

    // A missing job id raises 22023; an unknown job refunds nothing.
    await expect(
      db.query("select public.refund_to_pools(null, 'x')"),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await refund("00000000-0000-0000-0000-0000000043ff")).toBeNull();
  });

  it("writes a daily_expire row when the refunded daily pool is already from an earlier day", async () => {
    const actor = await newActor();
    const jobId = await insertJob(actor);
    await setWallet(actor, 60, 0);
    await deduct(actor, 40, jobId);
    expect(await walletOf(actor)).toEqual({ daily_balance: 20, topup_balance: 0 });

    // The day rolls over before the refund: the wallet's daily date is now yesterday.
    await db.query(
      `update public.user_credit_wallets set daily_date = ${TODAY_SQL} - 1 where user_id = $1::uuid`,
      [actor.userId],
    );
    const refundId = await refund(jobId);
    expect(await txById(refundId as string)).toMatchObject({
      transaction_type: "generation_refund",
      amount: 40,
      pool: "daily",
    });
    // Wallet is not given the expired daily credits back.
    expect(await walletOf(actor)).toEqual({ daily_balance: 20, topup_balance: 0 });

    const expired = await db.query<{ amount: number; pool: string }>(
      `select amount, pool from public.credit_transactions
        where workspace_id = $1::uuid and transaction_type = 'daily_expire'`,
      [actor.workspaceId],
    );
    expect(expired.rows).toEqual([{ amount: -40, pool: "daily" }]);
  });
});

describe("canonical 0008 credit pools: read repositories", () => {
  it("pool balance repository reads the numbers deduct_from_pools leaves behind", async () => {
    const reads = createPoolBalanceReadRepository({ pool });

    const idle = await newActor();
    await expect(
      reads.readPoolBalances({ workspaceId: idle.workspaceId, userId: idle.userId }),
    ).resolves.toEqual({
      daily: 0,
      teamRemaining: 0,
      personalTeamUsed: 0,
      personalCap: 20000,
      topup: 0,
    });

    const actor = await newActor();
    await setPool(actor, 1000);
    await setWallet(actor, 100, 50);
    await deduct(actor, 130);
    await expect(
      reads.readPoolBalances({ workspaceId: actor.workspaceId, userId: actor.userId }),
    ).resolves.toEqual({
      daily: 0,
      teamRemaining: 970,
      personalTeamUsed: 30,
      personalCap: 20000,
      topup: 50,
    });
  });

  it("member credit repository lists a member's cap, team use, top-up and daily balance", async () => {
    // listMemberCredits also reads member_generation_pauses, a table that belongs
    // to 0009. This stand-in only supplies the two columns the statement reads and
    // is a no-op once 0009 has created the real table.
    await db.query(
      `create table if not exists public.member_generation_pauses (
         workspace_id uuid not null,
         user_id uuid not null
       )`,
    );

    const reads = createMemberCreditReadRepository({ getTransactionPool: () => pool });
    const actor = await newActor();
    await setPool(actor, 1000);
    await setWallet(actor, 100, 50);
    await deduct(actor, 130);

    const rows = await reads.listMemberCredits({ workspaceId: actor.workspaceId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: actor.userId,
      personalCap: 20000,
      teamUsed: 30,
      topup: 50,
      dailyRemaining: 0,
    });
  });
});

describe("canonical 0008 credit pools: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  async function columnShapes(database: PGlite, table: string) {
    const result = await database.query(
      `select ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [table],
    );
    return result.rows;
  }

  async function constraintDefs(database: PGlite, table: string): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype in ('p', 'u', 'c')
        order by 1`,
      [`public.${table}`],
    );
    return result.rows.map((row) => row.line);
  }

  async function foreignKeyDefs(database: PGlite, table: string): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || confdeltype::text || ' -> ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype = 'f'
        order by 1`,
      [`public.${table}`],
    );
    // Only the user target differs by design: auth.users -> hahart_auth.users.
    return result.rows.map((row) => row.line.replace("hahart_auth.users", "auth.users"));
  }

  async function indexDefs(database: PGlite, table: string): Promise<string[]> {
    const result = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = $1
        order by indexname`,
      [table],
    );
    return result.rows.map((row) => row.indexdef);
  }

  async function functionShapes(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns '
              || pg_get_function_result(p.oid) || ' lang=' || l.lanname
              || ' volatility=' || p.provolatile::text
              || ' secdef=' || p.prosecdef::text
              || ' config=' || coalesce(p.proconfig::text, '') as line
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by 1`,
      [[...FUNCTIONS]],
    );
    return result.rows.map((row) => row.line);
  }

  /** Function bodies with comment lines dropped and white space collapsed. */
  async function functionBodies(database: PGlite): Promise<string[]> {
    const result = await database.query<{ name: string; prosrc: string }>(
      `select p.proname as name, p.prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by 1`,
      [[...FUNCTIONS]],
    );
    return result.rows.map(
      (row) =>
        `${row.name}: ${row.prosrc
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()}`,
    );
  }

  async function triggerDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.member_team_usage'::regclass and not tgisinternal
        order by tgname`,
    );
    return result.rows.map((row) => row.def);
  }

  for (const table of TABLES) {
    it(`has the same ${table} columns, constraints, foreign keys and indexes`, async () => {
      const oldShapes = await columnShapes(oldDb, table);
      expect(oldShapes.length).toBeGreaterThan(0);
      expect(await columnShapes(db, table)).toEqual(oldShapes);

      const oldConstraints = await constraintDefs(oldDb, table);
      expect(oldConstraints.length).toBeGreaterThan(0);
      expect(await constraintDefs(db, table)).toEqual(oldConstraints);

      const oldForeignKeys = await foreignKeyDefs(oldDb, table);
      expect(await foreignKeyDefs(db, table)).toEqual(oldForeignKeys);
      expect(await indexDefs(db, table)).toEqual(await indexDefs(oldDb, table));
    });
  }

  it("has the same function signatures, return types, language, security mode and search path", async () => {
    const oldShapes = await functionShapes(oldDb);
    expect(oldShapes).toHaveLength(FUNCTIONS.length);
    expect(await functionShapes(db)).toEqual(oldShapes);
  });

  it("has the same function bodies, ignoring comments and white space", async () => {
    const oldBodies = await functionBodies(oldDb);
    expect(oldBodies).toHaveLength(FUNCTIONS.length);
    expect(await functionBodies(db)).toEqual(oldBodies);
  });

  it("has the same inherit-cap trigger on member_team_usage", async () => {
    const oldTriggers = await triggerDefs(oldDb);
    expect(oldTriggers).toHaveLength(1);
    expect(await triggerDefs(db)).toEqual(oldTriggers);
  });
});

describe("canonical 0008 credit pools: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const lower = sql.toLowerCase();

  it("is at most 500 lines", () => {
    expect(sql.split("\n").length).toBeLessThanOrEqual(500);
  });

  it("carries no Supabase-only constructs", () => {
    const withoutOwnSchema = lower.replaceAll("hahart_auth.", "");
    for (const banned of [
      "auth.",
      "storage.",
      "pgmq",
      "auth.uid",
      "row level security",
      "create policy",
      "grant ",
      "anon",
      "authenticated",
      "service_role",
    ]) {
      expect(withoutOwnSchema.includes(banned), banned).toBe(false);
    }
  });
});
