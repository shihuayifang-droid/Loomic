import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAdminCreditWriteRepository } from "../../db/admin-credit-write-repository.js";
import { createMemberPauseReadRepository } from "../../db/member-pause-read-repository.js";
import { createPoolGrantWriteRepository } from "../../db/pool-grant-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43U: canonical migration 0009 (credit administration) on an empty
 * database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0009 is the final form of that
 * chain. Nothing here asserts that the objects of 0010 do not exist yet.
 *
 * Pausing is a state plus a lookup: `deduct_from_pools` does not read it, the
 * server does (`member-pause-read-repository`). So the pause cases assert the
 * lookup function and that repository, not a refused deduction.
 */

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0009_credit_admin.sql",
);

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";

const FUNCTIONS = [
  "grant_team_cycle",
  "grant_daily_credits",
  "set_personal_cap",
  "apply_cap_template",
  "set_member_generation_paused",
  "is_member_generation_paused",
  "admin_adjust_topup",
  "set_team_pool_limit",
  "admin_set_personal_cap",
  "admin_apply_cap_template",
] as const;

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];
let seq = 0;
let operatorId = "";
let teamWorkspaceId = "";
let adminCredits: ReturnType<typeof createAdminCreditWriteRepository>;
let poolGrants: ReturnType<typeof createPoolGrantWriteRepository>;
let pauseReads: ReturnType<typeof createMemberPauseReadRepository>;

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

type SqlFailure = { code: string; message: string; detail: string | null };

async function sqlFailure(run: Promise<unknown>): Promise<SqlFailure> {
  try {
    await run;
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown; detail?: unknown };
    return {
      code: String(e.code),
      message: String(e.message),
      detail: typeof e.detail === "string" ? e.detail : null,
    };
  }
  return { code: "no-error", message: "", detail: null };
}

/** One new member of the single team workspace (signup also gives a personal one). */
async function newMember(): Promise<string> {
  seq += 1;
  const userId = `00000000-0000-0000-0000-00000043c0${String(seq).padStart(2, "0")}`;
  await createCanonicalUser(db, userId, `admin-43u-${seq}@hahart.test`);
  await db.query(
    "insert into public.workspace_members (workspace_id, user_id, role) values ($1::uuid, $2::uuid, 'member')",
    [teamWorkspaceId, userId],
  );
  return userId;
}

async function auditCount(action: string, actor: string = operatorId): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.admin_audit_log where action = $1 and actor_user_id = $2::uuid",
        [action, actor],
      )
    ).rows,
  ).n;
}

async function topupOf(userId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ topup_balance: number }>(
        "select topup_balance from public.user_credit_wallets where user_id = $1::uuid",
        [userId],
      )
    ).rows,
  ).topup_balance;
}

async function capSetting(userId: string): Promise<{ cap: number; source: string } | null> {
  const rows = (
    await db.query<{ cap: number; source: string }>(
      "select cap, source from public.member_cap_settings where workspace_id = $1::uuid and user_id = $2::uuid",
      [teamWorkspaceId, userId],
    )
  ).rows;
  return rows[0] ?? null;
}

async function isPausedFn(userId: string): Promise<boolean> {
  return firstRow(
    (
      await db.query<{ v: boolean }>(
        "select public.is_member_generation_paused($1::uuid, $2::uuid) as v",
        [teamWorkspaceId, userId],
      )
    ).rows,
  ).v;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);
  adminCredits = createAdminCreditWriteRepository({ getTransactionPool: () => pool });
  poolGrants = createPoolGrantWriteRepository({ getTransactionPool: () => pool });
  pauseReads = createMemberPauseReadRepository({ getTransactionPool: () => pool });

  operatorId = "00000000-0000-0000-0000-00000043c000";
  await createCanonicalUser(db, operatorId, "admin-43u-operator@hahart.test");
  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', 'team-43u', $1::uuid) returning id`,
        [operatorId],
      )
    ).rows,
  ).id;
  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1::uuid, $2::uuid, 'admin') on conflict do nothing`,
    [teamWorkspaceId, operatorId],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0009 credit admin: schema", () => {
  it("applies 0009_credit_admin.sql", () => {
    expect(applied).toContain("0009_credit_admin.sql");
  });

  it("points member_generation_pauses user columns at hahart_auth.users", async () => {
    const result = await db.query<{ line: string }>(
      `select conrelid::regclass::text || '.' || a.attname || ' -> ' || confrelid::regclass::text as line
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and c.conrelid = 'public.member_generation_pauses'::regclass
          and c.confrelid = 'hahart_auth.users'::regclass
        order by 1`,
    );
    expect(result.rows.map((row) => row.line)).toEqual([
      "member_generation_pauses.paused_by -> hahart_auth.users",
      "member_generation_pauses.user_id -> hahart_auth.users",
    ]);
  });
});

describe("canonical 0009 credit admin: grants", () => {
  it("grant_daily_credits grants once per day and records one daily_grant row", async () => {
    const userId = await newMember();
    expect(await poolGrants.grantDailyCredits({ userId, workspaceId: teamWorkspaceId })).toBe(true);
    expect(await poolGrants.grantDailyCredits({ userId, workspaceId: teamWorkspaceId })).toBe(false);

    const wallet = firstRow(
      (
        await db.query<{ daily_balance: number }>(
          "select daily_balance from public.user_credit_wallets where user_id = $1::uuid",
          [userId],
        )
      ).rows,
    );
    expect(wallet.daily_balance).toBe(100);
    const grants = firstRow(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from public.credit_transactions
            where user_id = $1::uuid and transaction_type = 'daily_grant'`,
          [userId],
        )
      ).rows,
    );
    expect(grants.n).toBe(1);

    const failure = await sqlFailure(
      db.query("select public.grant_daily_credits($1::uuid, $2::uuid, 0)", [userId, teamWorkspaceId]),
    );
    expect(failure.code).toBe("22023");
  });

  it("grant_team_cycle grants the month once and returns the same limit afterwards", async () => {
    await newMember();
    const members = firstRow(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.workspace_members where workspace_id = $1::uuid",
          [teamWorkspaceId],
        )
      ).rows,
    ).n;

    const first = await poolGrants.grantTeamCycle();
    expect(first).toBe(members * 20000);
    await newMember();
    expect(await poolGrants.grantTeamCycle()).toBe(first);

    const rows = await db.query<{ pool_limit: number }>(
      `select pool_limit from public.team_credit_pools
        where workspace_id = $1::uuid and period_month = ${MONTH_SQL}`,
      [teamWorkspaceId],
    );
    expect(rows.rows).toEqual([{ pool_limit: first }]);
    const ledger = firstRow(
      (
        await db.query<{ n: number }>(
          `select count(*)::int as n from public.credit_transactions
            where workspace_id = $1::uuid and transaction_type = 'cycle_grant'`,
          [teamWorkspaceId],
        )
      ).rows,
    );
    expect(ledger.n).toBe(1);

    const bad = await sqlFailure(
      db.query("select public.grant_team_cycle($1::uuid, '2030-01-15')", [teamWorkspaceId]),
    );
    expect(bad.code).toBe("22023");
  });
});

describe("canonical 0009 credit admin: admin adjustments and caps", () => {
  it("admin_adjust_topup moves the top-up balance and writes one audit row", async () => {
    const userId = await newMember();
    const txId = await adminCredits.adjustTopup({
      workspaceId: teamWorkspaceId,
      userId,
      operatorId,
      delta: 500,
      reason: "manual top-up",
    });
    expect(txId).toBeTruthy();
    expect(await topupOf(userId)).toBe(500);

    const tx = firstRow(
      (
        await db.query<{ amount: number; balance_after: number; pool: string }>(
          "select amount, balance_after, pool from public.credit_transactions where id = $1::uuid",
          [txId],
        )
      ).rows,
    );
    expect(tx).toEqual({ amount: 500, balance_after: 500, pool: "topup" });

    const before = await auditCount("credits.adjust_topup");
    await adminCredits.adjustTopup({
      workspaceId: teamWorkspaceId,
      userId,
      operatorId,
      delta: -200,
      reason: "correction",
    });
    expect(await topupOf(userId)).toBe(300);
    expect(await auditCount("credits.adjust_topup")).toBe(before + 1);

    const over = await sqlFailure(
      db.query("select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, -1000, 'x')", [
        teamWorkspaceId,
        userId,
        operatorId,
      ]),
    );
    expect(over).toMatchObject({ code: "P0405", detail: "300" });
    expect(await topupOf(userId)).toBe(300);

    const noReason = await sqlFailure(
      db.query("select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, 5, '  ')", [
        teamWorkspaceId,
        userId,
        operatorId,
      ]),
    );
    expect(noReason.code).toBe("22023");
    expect(noReason.message).toContain("INVALID_ADJUSTMENT");
    expect(await auditCount("credits.adjust_topup")).toBe(before + 1);
  });

  it("admin_set_personal_cap and admin_apply_cap_template take effect and write audit rows", async () => {
    const memberA = await newMember();
    const memberB = await newMember();

    const template = await adminCredits.createCapTemplate({
      workspaceId: teamWorkspaceId,
      name: "intern",
      cap: 10000,
    });

    const applyBefore = await auditCount("credits.apply_template");
    expect(
      await adminCredits.applyCapTemplate({
        workspaceId: teamWorkspaceId,
        templateId: template.id,
        userIds: [memberA, memberB],
        operatorId,
      }),
    ).toBe(2);
    expect(await capSetting(memberA)).toEqual({ cap: 10000, source: "template" });
    expect(await auditCount("credits.apply_template")).toBe(applyBefore + 1);

    const capBefore = await auditCount("credits.set_cap");
    expect(
      await adminCredits.setPersonalCap({
        workspaceId: teamWorkspaceId,
        userId: memberA,
        cap: 15000,
        operatorId,
      }),
    ).toBe(15000);
    expect(await capSetting(memberA)).toEqual({ cap: 15000, source: "manual" });
    expect(await auditCount("credits.set_cap")).toBe(capBefore + 1);

    // A member whose cap was set by hand keeps it when the template is applied again.
    expect(
      await adminCredits.applyCapTemplate({
        workspaceId: teamWorkspaceId,
        templateId: template.id,
        userIds: [memberA, memberB],
        operatorId,
      }),
    ).toBe(1);
    expect(await capSetting(memberA)).toEqual({ cap: 15000, source: "manual" });

    const usage = firstRow(
      (
        await db.query<{ personal_cap: number }>(
          `select personal_cap from public.member_team_usage
            where workspace_id = $1::uuid and user_id = $2::uuid and period_month = ${MONTH_SQL}`,
          [teamWorkspaceId, memberA],
        )
      ).rows,
    );
    expect(usage.personal_cap).toBe(15000);

    const missing = await sqlFailure(
      db.query(
        "select public.apply_cap_template($1::uuid, '00000000-0000-0000-0000-00000043c0ff'::uuid, array[$2::uuid])",
        [teamWorkspaceId, memberA],
      ),
    );
    expect(missing.code).toBe("22023");
    expect(missing.message).toContain("TEMPLATE_NOT_FOUND");
  });

  it("set_team_pool_limit changes this month's limit and audits only real changes", async () => {
    await poolGrants.grantTeamCycle();
    const before = await auditCount("credits.set_pool_limit");

    expect(
      await adminCredits.setTeamPoolLimit({ workspaceId: teamWorkspaceId, limit: 12345, operatorId }),
    ).toBe(12345);
    const row = firstRow(
      (
        await db.query<{ pool_limit: number }>(
          `select pool_limit from public.team_credit_pools
            where workspace_id = $1::uuid and period_month = ${MONTH_SQL}`,
          [teamWorkspaceId],
        )
      ).rows,
    );
    expect(row.pool_limit).toBe(12345);
    expect(await auditCount("credits.set_pool_limit")).toBe(before + 1);

    await adminCredits.setTeamPoolLimit({ workspaceId: teamWorkspaceId, limit: 12345, operatorId });
    expect(await auditCount("credits.set_pool_limit")).toBe(before + 1);

    const negative = await sqlFailure(
      db.query("select public.set_team_pool_limit($1::uuid, -1, $2::uuid)", [
        teamWorkspaceId,
        operatorId,
      ]),
    );
    expect(negative.code).toBe("22023");
  });
});

describe("canonical 0009 credit admin: member generation pause", () => {
  it("is_member_generation_paused and the pause read repository follow set_member_generation_paused", async () => {
    const userId = await newMember();
    expect(await isPausedFn(userId)).toBe(false);
    expect(await pauseReads.isGenerationPaused({ userId })).toBe(false);

    const pauseBefore = await auditCount("member.generation_pause");
    expect(
      await adminCredits.setGenerationPaused({
        workspaceId: teamWorkspaceId,
        userId,
        operatorId,
        paused: true,
        reason: "unusual spend",
      }),
    ).toBe(true);
    expect(await isPausedFn(userId)).toBe(true);
    expect(await pauseReads.isGenerationPaused({ userId })).toBe(true);
    expect(await auditCount("member.generation_pause")).toBe(pauseBefore + 1);

    // Pausing again changes nothing and writes no second audit row.
    expect(
      await adminCredits.setGenerationPaused({
        workspaceId: teamWorkspaceId,
        userId,
        operatorId,
        paused: true,
        reason: "unusual spend",
      }),
    ).toBe(false);
    expect(await auditCount("member.generation_pause")).toBe(pauseBefore + 1);

    const resumeBefore = await auditCount("member.generation_resume");
    expect(
      await adminCredits.setGenerationPaused({
        workspaceId: teamWorkspaceId,
        userId,
        operatorId,
        paused: false,
        reason: "",
      }),
    ).toBe(true);
    expect(await isPausedFn(userId)).toBe(false);
    expect(await pauseReads.isGenerationPaused({ userId })).toBe(false);
    expect(await auditCount("member.generation_resume")).toBe(resumeBefore + 1);

    const noReason = await sqlFailure(
      db.query(
        "select public.set_member_generation_paused($1::uuid, $2::uuid, $3::uuid, true, ' ')",
        [teamWorkspaceId, userId, operatorId],
      ),
    );
    expect(noReason.code).toBe("22023");
    expect(noReason.message).toContain("INVALID_PAUSE");
  });
});

describe("canonical 0009 credit admin: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  const TABLE = "member_generation_pauses";

  async function columnShapes(database: PGlite) {
    const result = await database.query(
      `select ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [TABLE],
    );
    return result.rows;
  }

  async function constraintDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype in ('p', 'u', 'c')
        order by 1`,
      [`public.${TABLE}`],
    );
    return result.rows.map((row) => row.line);
  }

  async function foreignKeyDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || confdeltype::text || ' -> ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype = 'f'
        order by 1`,
      [`public.${TABLE}`],
    );
    // Only the user target differs by design: auth.users -> hahart_auth.users.
    return result.rows.map((row) => row.line.replace("hahart_auth.users", "auth.users"));
  }

  async function indexDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = $1
        order by indexname`,
      [TABLE],
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

  it("has the same member_generation_pauses columns, constraints, foreign keys and indexes", async () => {
    const oldShapes = await columnShapes(oldDb);
    expect(oldShapes.length).toBeGreaterThan(0);
    expect(await columnShapes(db)).toEqual(oldShapes);

    const oldConstraints = await constraintDefs(oldDb);
    expect(oldConstraints.length).toBeGreaterThan(0);
    expect(await constraintDefs(db)).toEqual(oldConstraints);

    expect(await foreignKeyDefs(db)).toEqual(await foreignKeyDefs(oldDb));
    expect(await indexDefs(db)).toEqual(await indexDefs(oldDb));
  });

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
});

describe("canonical 0009 credit admin: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const lower = sql.toLowerCase();

  it("is at most 600 lines", () => {
    expect(sql.split("\n").length).toBeLessThanOrEqual(600);
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
