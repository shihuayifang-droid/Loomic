import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createTeamAdminWriteRepository,
  type TeamAdminWriteRepository,
} from "./team-admin-write-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44L: the team administration write repository, run on the same set
 * of cases against the retired supabase migration chain ("legacy") and against
 * the canonical schema ("canonical"). Both must behave the same.
 */

const uid = (suffix: string) => `00000000-0000-0000-0000-00000044c0${suffix}`;

const USER_O = uid("01"); // team owner
const USER_M = uid("02"); // team admin
const USER_A = uid("03"); // team member, owns the project and the asset
const USER_B = uid("04"); // added by the admin during the tests
const USER_X = uid("05"); // never in the team

type Fixture = {
  db: PGlite;
  repository: TeamAdminWriteRepository;
  teamId: string;
  projectId: string;
  canvasId: string;
  sessionId: string;
  assetId: string;
};

type Users = readonly (readonly [string, string])[];

const USERS: Users = [
  [USER_O, "o-44l@hahart.test"],
  [USER_M, "m-44l@hahart.test"],
  [USER_A, "a-44l@hahart.test"],
  [USER_B, "b-44l@hahart.test"],
  [USER_X, "x-44l@hahart.test"],
];

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  for (const [id, email] of USERS) await createUser(db, id, email);
  return finishSetup(db);
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  for (const [id, email] of USERS) await createCanonicalUser(db, id, email);
  return finishSetup(db);
}

async function finishSetup(db: PGlite): Promise<Fixture> {
  const team = await db.query<{ r: string }>(
    "select public.ensure_team_workspace($1::uuid, 'HaHart Team') as r",
    [USER_O],
  );
  const teamId = firstRow(team.rows).r;
  await db.query("select public.add_team_member($1::uuid, 'admin')", [USER_M]);
  await db.query("select public.add_team_member($1::uuid, 'member')", [USER_A]);

  const projectId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.projects (workspace_id, name, slug, created_by) values ($1::uuid, 'p', 'p', $2::uuid) returning id",
        [teamId, USER_A],
      )
    ).rows,
  ).id;
  const canvasId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.canvases (project_id, name, created_by) values ($1::uuid, 'c', $2::uuid) returning id",
        [projectId, USER_A],
      )
    ).rows,
  ).id;
  const sessionId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.chat_sessions (canvas_id, created_by) values ($1::uuid, $2::uuid) returning id",
        [canvasId, USER_A],
      )
    ).rows,
  ).id;
  const assetId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
         values ($1::uuid, $2::uuid, 'project-assets', 'w44l/in-project.png', $3::uuid) returning id`,
        [teamId, projectId, USER_A],
      )
    ).rows,
  ).id;

  const pool = createPGliteTransactionPool(db);
  return {
    db,
    repository: createTeamAdminWriteRepository({ getTransactionPool: () => pool }),
    teamId,
    projectId,
    canvasId,
    sessionId,
    assetId,
  };
}

async function capture(fn: () => Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return { code: e.code, message: String(e.message) };
  }
  throw new Error("expected the call to throw");
}

async function roleOf(fx: Fixture, userId: string): Promise<string | undefined> {
  return (
    await fx.db.query<{ role: string }>(
      "select role::text as role from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid",
      [fx.teamId, userId],
    )
  ).rows[0]?.role;
}

async function auditCount(fx: Fixture, action: string): Promise<number> {
  return firstRow(
    (
      await fx.db.query<{ n: number }>(
        "select count(*)::int as n from public.admin_audit_log where action = $1",
        [action],
      )
    ).rows,
  ).n;
}

type Outcome = {
  addFirst: boolean;
  addMemberRow: boolean;
  addRepeat: boolean;
  nonAdminCode: unknown;
  nonAdminMessage: string;
  setRoleFirst: boolean;
  setRoleAfter: string | undefined;
  removeResult: { removed: number; projects: number; assets: number; objects: number };
  removeMemberRowGone: boolean;
  projectCreatedBy: string;
  removeMissing: { removed: number } | { code: unknown };
  foreignReadFirst: boolean;
  foreignReadAudit: number;
  foreignAssetAudit: number;
  ownReadFalse: boolean;
};

const outcomes = new Map<string, Outcome>();

describe.each([
  ["legacy", setupLegacy],
  ["canonical", setupCanonical],
] as const)("team admin write repository on the %s database", (label, setup) => {
  let fx: Fixture;
  const o: Partial<Outcome> = {};

  beforeAll(async () => {
    fx = await setup();
  }, 120_000);

  afterAll(async () => {
    await fx.db.close();
  });

  it("an admin adds a member once; a repeat returns false", async () => {
    o.addFirst = await fx.repository.addMember({
      actorId: USER_M,
      userId: USER_B,
      role: "member",
    });
    expect(o.addFirst).toBe(true);
    o.addMemberRow = (await roleOf(fx, USER_B)) === "member";
    expect(o.addMemberRow).toBe(true);
    expect(await auditCount(fx, "team.member.add")).toBe(1);

    o.addRepeat = await fx.repository.addMember({
      actorId: USER_M,
      userId: USER_B,
      role: "member",
    });
    expect(o.addRepeat).toBe(false);
    expect(await auditCount(fx, "team.member.add")).toBe(1);
  });

  it("a non-admin cannot add a member and the database error keeps its code", async () => {
    const before = await auditCount(fx, "team.member.add");
    const err = await capture(() =>
      fx.repository.addMember({ actorId: USER_A, userId: USER_X, role: "member" }),
    );
    o.nonAdminCode = err.code;
    o.nonAdminMessage = err.message;
    expect(err.code).toBe("42501");
    expect(err.message).toContain("actor is not a team admin");
    expect(await roleOf(fx, USER_X)).toBeUndefined();
    expect(await auditCount(fx, "team.member.add")).toBe(before);
  });

  it("an admin changes a role", async () => {
    o.setRoleFirst = await fx.repository.setRole({
      actorId: USER_M,
      userId: USER_B,
      role: "admin",
    });
    expect(o.setRoleFirst).toBe(true);
    o.setRoleAfter = await roleOf(fx, USER_B);
    expect(o.setRoleAfter).toBe("admin");
    expect(await auditCount(fx, "team.member.role")).toBe(1);
  });

  it("removing a member moves their projects to the admin and writes one audit row", async () => {
    const result = await fx.repository.removeMember({ actorId: USER_M, userId: USER_A });
    o.removeResult = result;
    expect(result.removed).toBe(1);
    expect(result.projects).toBeGreaterThanOrEqual(1);

    o.removeMemberRowGone = (await roleOf(fx, USER_A)) === undefined;
    expect(o.removeMemberRowGone).toBe(true);

    const project = await fx.db.query<{ created_by: string }>(
      "select created_by from public.projects where id = $1::uuid",
      [fx.projectId],
    );
    o.projectCreatedBy = firstRow(project.rows).created_by;
    expect(o.projectCreatedBy).toBe(USER_M);
    expect(await auditCount(fx, "team.member.remove")).toBe(1);
  });

  it("removing someone who is not a member reports removed 0", async () => {
    const missing = await fx.repository.removeMember({ actorId: USER_M, userId: USER_X });
    o.removeMissing = { removed: missing.removed };
    expect(missing).toEqual({ removed: 0, projects: 0, assets: 0, objects: 0 });
    expect(await auditCount(fx, "team.member.remove")).toBe(1);
  });

  it("foreign reads of a project and of an asset each write one audit row", async () => {
    // USER_A left the team above, but the project is still theirs only in the
    // audit sense: the owner of record is now USER_M, so audit as USER_O.
    const first = await fx.repository.recordForeignRead({
      actorId: USER_O,
      via: "project",
      projectId: fx.projectId,
    });
    o.foreignReadFirst = first;
    expect(first).toBe(true);
    o.foreignReadAudit = await auditCount(fx, "content.foreign_read");
    expect(o.foreignReadAudit).toBe(1);

    const own = await fx.repository.recordForeignRead({
      actorId: USER_M,
      via: "project",
      projectId: fx.projectId,
    });
    o.ownReadFalse = own === false;
    expect(own).toBe(false);
    expect(await auditCount(fx, "content.foreign_read")).toBe(1);

    const asset = await fx.repository.recordForeignAssetRead({
      actorId: USER_O,
      assetId: fx.assetId,
    });
    expect(asset).toBe(true);
    o.foreignAssetAudit = await auditCount(fx, "content.foreign_read");
    expect(o.foreignAssetAudit).toBe(2);

    const viaRows = await fx.db.query<{ via: string }>(
      "select detail->>'via' as via from public.admin_audit_log where action = 'content.foreign_read' order by detail->>'via'",
    );
    expect(viaRows.rows.map((r) => r.via)).toEqual(["asset", "project"]);
  });

  it("records this database's outcome for the comparison", () => {
    outcomes.set(label, o as Outcome);
    expect(Object.keys(o).length).toBeGreaterThan(0);
  });
});

describe("legacy and canonical databases agree", () => {
  it("both produced the same outcome", () => {
    const legacy = outcomes.get("legacy");
    const canonical = outcomes.get("canonical");
    if (legacy === undefined || canonical === undefined) {
      throw new Error("both databases must have run before the comparison");
    }
    expect(canonical).toEqual(legacy);
  });
});
