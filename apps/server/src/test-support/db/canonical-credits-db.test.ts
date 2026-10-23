import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import type { PriceDetail } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCreditLedgerWriteRepository } from "../../db/credit-ledger-write-repository.js";
import { createCreditReadRepository } from "../../db/credit-read-repository.js";
import { createPricingRuleRepository } from "../../db/pricing-rule-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43S: canonical migration 0007 (credits core and pricing) on an empty
 * database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0007 is the final form of that chain.
 * Nothing here asserts that the pool tables of 0008 do not exist yet.
 */

const USER_FLOW = "00000000-0000-0000-0000-0000000043a1";
const USER_REFUND = "00000000-0000-0000-0000-0000000043a2";
const USER_DAILY = "00000000-0000-0000-0000-0000000043a3";
const USER_READ = "00000000-0000-0000-0000-0000000043a4";

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0007_credits_core.sql",
);

const TABLES = [
  "subscriptions",
  "credit_balances",
  "credit_transactions",
  "daily_credit_claims",
  "pricing_rules",
  "price_change_log",
] as const;

const FUNCTIONS = [
  "deduct_credits",
  "refund_credits",
  "claim_daily_credits",
  "grant_plan_credits",
  "init_workspace_credits",
] as const;

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function workspaceOf(userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
}

async function balanceOf(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ balance: number }>(
        "select balance from public.credit_balances where workspace_id = $1",
        [workspaceId],
      )
    ).rows,
  ).balance;
}

async function insertJob(workspaceId: string, userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [workspaceId, userId],
      )
    ).rows,
  ).id;
}

async function countLedger(workspaceId: string, type: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        `select count(*)::int as n from public.credit_transactions
          where workspace_id = $1 and transaction_type = $2::public.credit_transaction_type`,
        [workspaceId, type],
      )
    ).rows,
  ).n;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);

  for (const [index, userId] of [USER_FLOW, USER_REFUND, USER_DAILY, USER_READ].entries()) {
    await createCanonicalUser(db, userId, `credits-${index}@hahart.test`);
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0007 credits core: schema", () => {
  it("applies 0007_credits_core.sql", () => {
    expect(applied).toContain("0007_credits_core.sql");
  });

  it("points credit_transactions.user_id at hahart_auth.users and not at auth.users", async () => {
    const result = await db.query<{ target: string }>(
      `select confrelid::regclass::text as target
         from pg_constraint
        where conrelid = 'public.credit_transactions'::regclass
          and conname = 'credit_transactions_user_id_fkey'`,
    );
    expect(result.rows).toEqual([{ target: "hahart_auth.users" }]);
  });

  it("does not create payment_events", async () => {
    const result = await db.query<{ found: string | null }>(
      "select to_regclass('public.payment_events')::text as found",
    );
    expect(result.rows).toEqual([{ found: null }]);
  });

  it("creates the personal workspace's subscription and balance rows through the init trigger", async () => {
    const workspaceId = await workspaceOf(USER_FLOW);
    const subscription = await db.query<{ plan: string }>(
      "select plan::text as plan from public.subscriptions where workspace_id = $1",
      [workspaceId],
    );
    expect(subscription.rows).toEqual([{ plan: "free" }]);
    expect(await balanceOf(workspaceId)).toBe(0);
  });
});

describe("canonical 0007 credits core: functions and repositories", () => {
  it("deduct_credits writes a ledger row and raises SQLSTATE P0402 when the balance is short", async () => {
    const workspaceId = await workspaceOf(USER_FLOW);
    const granted = await db.query<{ v: number }>(
      "select public.grant_plan_credits($1::uuid, 'pro'::public.subscription_plan, 50) as v",
      [workspaceId],
    );
    expect(firstRow(granted.rows).v).toBe(50);
    expect(
      firstRow(
        (
          await db.query<{ plan: string }>(
            "select plan::text as plan from public.subscriptions where workspace_id = $1",
            [workspaceId],
          )
        ).rows,
      ).plan,
    ).toBe("pro");

    const deducted = await db.query<{ id: string }>(
      "select public.deduct_credits($1::uuid, $2::uuid, 20, null, 'flow') as id",
      [workspaceId, USER_FLOW],
    );
    expect(firstRow(deducted.rows).id).toBeTruthy();
    expect(await balanceOf(workspaceId)).toBe(30);

    const ledger = await db.query<{ amount: number; balance_after: number }>(
      `select amount, balance_after from public.credit_transactions
        where workspace_id = $1 and transaction_type = 'generation_deduct'`,
      [workspaceId],
    );
    expect(ledger.rows).toEqual([{ amount: -20, balance_after: 30 }]);

    await expect(
      db.query("select public.deduct_credits($1::uuid, $2::uuid, 1000, null, 'too much')", [
        workspaceId,
        USER_FLOW,
      ]),
    ).rejects.toMatchObject({ code: "P0402" });
    expect(await balanceOf(workspaceId)).toBe(30);
  });

  it("ledger repository records a pending consume row that does not move the balance", async () => {
    const workspaceId = await workspaceOf(USER_FLOW);
    const detail: PriceDetail = {
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
    const ruleId = firstRow(
      (await db.query<{ id: string }>("select id from public.pricing_rules limit 1")).rows,
    ).id;
    const before = await balanceOf(workspaceId);

    const ledger = createCreditLedgerWriteRepository({ getTransactionPool: () => pool });
    const { transactionId } = await ledger.recordPendingConsume({
      workspaceId,
      userId: USER_FLOW,
      jobId: null,
      description: "43S pending",
      ruleId,
      priceDetail: detail,
    });
    expect(transactionId).toBeTruthy();
    expect(await balanceOf(workspaceId)).toBe(before);
  });

  it("refund_credits pays out once per job and returns the same ledger id on a repeat", async () => {
    const workspaceId = await workspaceOf(USER_REFUND);
    const jobId = await insertJob(workspaceId, USER_REFUND);

    const first = await db.query<{ id: string }>(
      "select public.refund_credits($1::uuid, $2::uuid, 7, $3::uuid, 'refund') as id",
      [workspaceId, USER_REFUND, jobId],
    );
    const second = await db.query<{ id: string }>(
      "select public.refund_credits($1::uuid, $2::uuid, 7, $3::uuid, 'refund again') as id",
      [workspaceId, USER_REFUND, jobId],
    );
    expect(firstRow(second.rows).id).toBe(firstRow(first.rows).id);
    expect(await balanceOf(workspaceId)).toBe(7);
    expect(await countLedger(workspaceId, "generation_refund")).toBe(1);

    // The partial unique index is the backstop for a writer that skips the function.
    await expect(
      db.query(
        `insert into public.credit_transactions
           (workspace_id, user_id, transaction_type, amount, balance_after, job_id)
         values ($1, $2, 'generation_refund', 7, 14, $3)`,
        [workspaceId, USER_REFUND, jobId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("claim_daily_credits grants once per day", async () => {
    const workspaceId = await workspaceOf(USER_DAILY);
    const first = await db.query<{ ok: boolean }>(
      "select public.claim_daily_credits($1::uuid, 5) as ok",
      [workspaceId],
    );
    const second = await db.query<{ ok: boolean }>(
      "select public.claim_daily_credits($1::uuid, 5) as ok",
      [workspaceId],
    );
    expect(firstRow(first.rows).ok).toBe(true);
    expect(firstRow(second.rows).ok).toBe(false);
    expect(await balanceOf(workspaceId)).toBe(5);
    expect(await countLedger(workspaceId, "daily_grant")).toBe(1);
  });

  it("credit read repository reads the balance, the plan and the ledger", async () => {
    const workspaceId = await workspaceOf(USER_READ);
    await db.query("select public.grant_plan_credits($1::uuid, 'starter'::public.subscription_plan, 12)", [
      workspaceId,
    ]);

    const reads = createCreditReadRepository({ getTransactionPool: () => pool });
    const snapshot = await reads.readBalanceSnapshot({ workspaceId, claimDate: "2030-01-01" });
    expect(snapshot).toMatchObject({ balance: 12, plan: "starter" });

    const subscription = await reads.readSubscription({ workspaceId });
    expect(subscription).toMatchObject({ plan: "starter" });

    const rows = await reads.listTransactions({ workspaceId, limit: 10 });
    expect(rows.map((row) => row.transaction_type)).toEqual(["subscription_grant"]);
    expect(rows.map((row) => row.amount)).toEqual([12]);
  });

  it("pricing rule repository reads an inserted price row and the seed rows", async () => {
    await db.query(
      `insert into public.pricing_rules
         (model_id, entry_point, search_key, price, price_status, effective_at)
       values ('test/43s-model', '*', '*', 9, 'active', '2020-01-01T00:00:00Z')`,
    );

    const rules = createPricingRuleRepository({ getTransactionPool: () => pool });
    const candidates = await rules.listCandidateRules({
      modelId: "test/43s-model",
      at: new Date("2030-01-01T00:00:00Z"),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ price: 9, priceStatus: "active" });

    expect(await rules.hasModel({ modelId: "test/43s-model" })).toBe(true);
    expect(await rules.hasModel({ modelId: "test/not-registered" })).toBe(false);
    expect(await rules.hasModel({ modelId: "tool:upscale" })).toBe(true);
  });
});

describe("canonical 0007 credits core: final form equals the retired migration chain", () => {
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

  async function enumValues(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select t.typname || ' ' || (row_number() over (partition by t.typname order by e.enumsortorder))::text || ' ' || e.enumlabel as line
         from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname in ('credit_transaction_type', 'subscription_plan', 'billing_period')
        order by t.typname, e.enumsortorder`,
    );
    return result.rows.map((row) => row.line);
  }

  async function functionShapes(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns '
              || pg_get_function_result(p.oid) || ' secdef=' || p.prosecdef::text
              || ' config=' || coalesce(p.proconfig::text, '') as line
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by 1`,
      [[...FUNCTIONS]],
    );
    return result.rows.map((row) => row.line);
  }

  async function triggerDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.workspaces'::regclass and not tgisinternal
          and tgname = 'trg_init_workspace_credits'`,
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

      expect(await foreignKeyDefs(db, table)).toEqual(await foreignKeyDefs(oldDb, table));
      expect(await indexDefs(db, table)).toEqual(await indexDefs(oldDb, table));
    });
  }

  it("has the same enum values in the same order", async () => {
    const oldValues = await enumValues(oldDb);
    expect(oldValues.length).toBeGreaterThan(0);
    expect(await enumValues(db)).toEqual(oldValues);
  });

  it("has the same function signatures, return types, security mode and search path", async () => {
    const oldShapes = await functionShapes(oldDb);
    expect(oldShapes).toHaveLength(FUNCTIONS.length);
    expect(await functionShapes(db)).toEqual(oldShapes);
  });

  it("has the same init trigger on workspaces", async () => {
    const oldTriggers = await triggerDefs(oldDb);
    expect(oldTriggers).toHaveLength(1);
    expect(await triggerDefs(db)).toEqual(oldTriggers);
  });

  it("seeds the same pricing rows as the source", async () => {
    const seedSql = `select model_id, entry_point, search_key, time_period, unit_name, unit_size,
                            price, price_status, extras::text as extras
                       from public.pricing_rules
                      where model_id not like 'test/%'
                      order by model_id, entry_point, search_key, time_period`;
    const oldRows = (await oldDb.query(seedSql)).rows;
    expect(oldRows).toHaveLength(123);
    expect((await db.query(seedSql)).rows).toEqual(oldRows);
  });
});

describe("canonical 0007 credits core: SQL file hygiene", () => {
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
