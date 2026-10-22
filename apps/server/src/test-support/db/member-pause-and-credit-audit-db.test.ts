import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * Workorder 39N - AD-01 / BL-21 step 1: member generation pause and credit-operation audit.
 *
 * Migration `20261022000003_hahart_member_pause_and_credit_audit.sql`. Pausing and resuming a
 * member, and every credit write (top-up adjustment, personal cap, cap template, pool limit),
 * leave one `admin_audit_log` row in the same transaction. Real SQL on PGlite.
 */

let db: PGlite;
let seq = 0;

type Team = { workspaceId: string; adminId: string; memberId: string };

type AuditRow = {
  actor_user_id: string;
  action: string;
  target_user_id: string | null;
  detail: Record<string, unknown>;
};

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
  const adminId = nextUuid("39a");
  await createUser(db, adminId, `admin-39n-${adminId.slice(-3)}@hahart.test`);
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
    memberId = nextUuid("39b");
    await createUser(db, memberId, `member-39n-${memberId.slice(-3)}@hahart.test`);
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [workspaceId, memberId],
    );
  }
  return { workspaceId, adminId, memberId };
}

async function setPaused(team: Team, paused: boolean, reason: string | null): Promise<boolean> {
  return firstRow(
    (
      await db.query<{ v: boolean }>(
        `select public.set_member_generation_paused($1::uuid, $2::uuid, $3::uuid, $4::boolean, $5::text) as v`,
        [team.workspaceId, team.memberId, team.adminId, paused, reason],
      )
    ).rows,
  ).v;
}

async function isPaused(team: Team): Promise<boolean> {
  return firstRow(
    (
      await db.query<{ v: boolean }>(
        "select public.is_member_generation_paused($1::uuid, $2::uuid) as v",
        [team.workspaceId, team.memberId],
      )
    ).rows,
  ).v;
}

/** Audit rows written by this team's administrator, optionally one action only. */
async function auditRows(team: Team, action?: string): Promise<AuditRow[]> {
  return (
    await db.query<AuditRow>(
      `select actor_user_id, action, target_user_id, detail from public.admin_audit_log
       where actor_user_id = $1::uuid and ($2::text is null or action = $2::text)
       order by created_at, id`,
      [team.adminId, action ?? null],
    )
  ).rows;
}

async function adjust(team: Team, delta: number, reason: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        "select public.admin_adjust_topup($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text) as id",
        [team.workspaceId, team.memberId, team.adminId, delta, reason],
      )
    ).rows,
  ).id;
}

async function memberCap(team: Team): Promise<number> {
  return firstRow(
    (
      await db.query<{ cap: number }>(
        "select public.member_personal_cap($1::uuid, $2::uuid) as cap",
        [team.workspaceId, team.memberId],
      )
    ).rows,
  ).cap;
}

async function adminSetCap(team: Team, cap: number): Promise<number> {
  return firstRow(
    (
      await db.query<{ v: number }>(
        "select public.admin_set_personal_cap($1::uuid, $2::uuid, $3::uuid, $4::integer) as v",
        [team.workspaceId, team.memberId, team.adminId, cap],
      )
    ).rows,
  ).v;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("member pause and credit audit (39N)", () => {
  it("AD-01: pausing a member is recorded and audited", async () => {
    const team = await newTeam();

    expect(await setPaused(team, true, "  suspicious usage  ")).toBe(true);

    expect(await isPaused(team)).toBe(true);
    const rows = await auditRows(team);
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.action).toBe("member.generation_pause");
    expect(row.actor_user_id).toBe(team.adminId);
    expect(row.target_user_id).toBe(team.memberId);
    expect(row.detail.reason).toBe("suspicious usage");
    expect(row.detail.workspace_id).toBe(team.workspaceId);
    expect(row.detail.before).toBe(false);
    expect(row.detail.after).toBe(true);
  });

  it("AD-01: pausing twice changes nothing the second time", async () => {
    const team = await newTeam();
    expect(await setPaused(team, true, "first")).toBe(true);

    expect(await setPaused(team, true, "second")).toBe(false);

    expect(await isPaused(team)).toBe(true);
    expect((await auditRows(team)).length).toBe(1);
  });

  it("AD-01: resuming removes the pause and is audited", async () => {
    const team = await newTeam();
    await setPaused(team, true, "pause");

    expect(await setPaused(team, false, null)).toBe(true);

    expect(await isPaused(team)).toBe(false);
    const resumes = await auditRows(team, "member.generation_resume");
    expect(resumes.length).toBe(1);
    const row = firstRow(resumes);
    expect(row.target_user_id).toBe(team.memberId);
    expect(row.detail.before).toBe(true);
    expect(row.detail.after).toBe(false);
    expect(await setPaused(team, false, null)).toBe(false);
    expect((await auditRows(team, "member.generation_resume")).length).toBe(1);
  });

  it("AD-01: a pause needs a reason", async () => {
    const team = await newTeam();

    expect(await sqlFailureCode(setPaused(team, true, "   "))).toBe("22023");
    expect(await sqlFailureCode(setPaused(team, true, null))).toBe("22023");

    expect(await isPaused(team)).toBe(false);
    expect((await auditRows(team)).length).toBe(0);
  });

  it("AD-01: a top-up adjustment writes one audit row", async () => {
    const team = await newTeam();

    const txId = await adjust(team, 500, "补发");

    const rows = await auditRows(team, "credits.adjust_topup");
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.target_user_id).toBe(team.memberId);
    expect(row.detail.delta).toBe(500);
    expect(row.detail.reason).toBe("补发");
    expect(row.detail.workspace_id).toBe(team.workspaceId);
    expect(row.detail.transaction_id).toBe(txId);
  });

  it("AD-01: a refused adjustment writes no audit row", async () => {
    const team = await newTeam();
    await adjust(team, 100, "seed");
    const before = (await auditRows(team, "credits.adjust_topup")).length;

    expect(await sqlFailureCode(adjust(team, -101, "too much"))).toBe("P0405");

    expect((await auditRows(team, "credits.adjust_topup")).length).toBe(before);
  });

  it("AD-01: setting a cap through the admin wrapper is audited with before and after", async () => {
    const team = await newTeam();
    await adminSetCap(team, 20000);
    expect(await adminSetCap(team, 30000)).toBe(30000);

    expect(await memberCap(team)).toBe(30000);
    const rows = await auditRows(team, "credits.set_cap");
    expect(rows.length).toBe(2);
    const last = rows[1];
    expect(last?.target_user_id).toBe(team.memberId);
    expect(last?.detail.cap_before).toBe(20000);
    expect(last?.detail.cap_after).toBe(30000);
  });

  it("AD-01: applying a template is audited once", async () => {
    const team = await newTeam();
    const templateId = firstRow(
      (
        await db.query<{ id: string }>(
          `insert into public.credit_cap_templates (workspace_id, name, cap)
           values ($1::uuid, 'tpl-39n', 12000) returning id`,
          [team.workspaceId],
        )
      ).rows,
    ).id;

    const applied = firstRow(
      (
        await db.query<{ n: number }>(
          "select public.admin_apply_cap_template($1::uuid, $2::uuid, $3::uuid[], $4::uuid) as n",
          [team.workspaceId, templateId, [team.memberId, team.adminId], team.adminId],
        )
      ).rows,
    ).n;

    expect(applied).toBe(2);
    const rows = await auditRows(team, "credits.apply_template");
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.detail.template_id).toBe(templateId);
    expect(row.detail.applied).toBe(2);
    expect(row.detail.workspace_id).toBe(team.workspaceId);
    expect(row.detail.user_ids).toEqual([team.memberId, team.adminId]);
    expect(await memberCap(team)).toBe(12000);
  });

  it("AD-01: changing the pool limit is audited", async () => {
    const team = await newTeam();

    await db.query("select public.set_team_pool_limit($1::uuid, 50000, $2::uuid)", [
      team.workspaceId,
      team.adminId,
    ]);

    const rows = await auditRows(team, "credits.set_pool_limit");
    expect(rows.length).toBe(1);
    const row = firstRow(rows);
    expect(row.detail.limit_before).toBe(60000);
    expect(row.detail.limit_after).toBe(50000);
    expect(row.detail.workspace_id).toBe(team.workspaceId);

    await db.query("select public.set_team_pool_limit($1::uuid, 50000, $2::uuid)", [
      team.workspaceId,
      team.adminId,
    ]);
    expect((await auditRows(team, "credits.set_pool_limit")).length).toBe(1);
  });

  it("security: only the service role may call the new functions", async () => {
    const team = await newTeam();

    const calls: Array<[string, unknown[]]> = [
      [
        "select public.set_member_generation_paused($1::uuid, $2::uuid, $3::uuid, true, 'x')",
        [team.workspaceId, team.memberId, team.adminId],
      ],
      [
        "select public.is_member_generation_paused($1::uuid, $2::uuid)",
        [team.workspaceId, team.memberId],
      ],
      [
        "select public.admin_set_personal_cap($1::uuid, $2::uuid, $3::uuid, 100)",
        [team.workspaceId, team.memberId, team.adminId],
      ],
      [
        "select public.admin_apply_cap_template($1::uuid, $2::uuid, $3::uuid[], $4::uuid)",
        [team.workspaceId, team.workspaceId, [team.memberId], team.adminId],
      ],
    ];
    for (const [sql, params] of calls) {
      const code = await sqlFailureCode(asUser(db, team.adminId, (tx) => tx.query(sql, params)));
      expect(code).toBe("42501");
    }
  });

  it("security: the original audit actions can still be written", async () => {
    const team = await newTeam();

    await db.query(
      `insert into public.admin_audit_log (actor_user_id, action, target_user_id)
       values ($1::uuid, 'team.member.add', $2::uuid)`,
      [team.adminId, team.memberId],
    );

    expect((await auditRows(team, "team.member.add")).length).toBe(1);
    expect(
      await sqlFailureCode(
        db.query(
          `insert into public.admin_audit_log (actor_user_id, action) values ($1::uuid, 'no.such.action')`,
          [team.adminId],
        ),
      ),
    ).toBe("23514");
  });
});
