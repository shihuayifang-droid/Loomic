import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createTeamAdminReadRepository,
  type TeamAdminReadRepository,
} from "../../db/team-admin-read-repository.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Ticket 43W: canonical migration 0011 (team member management functions) on an
 * empty database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0011 is the final form of that
 * chain. The only intended difference is the removed object-store ownership
 * statement inside `remove_team_member`. Only the final state is asserted here.
 */

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0011_team_admin.sql",
);

const uid = (suffix: string) => `00000000-0000-0000-0000-00000043e0${suffix}`;

const USER_O = uid("01"); // team owner
const USER_M = uid("02"); // team admin
const USER_A = uid("03"); // team member, owns the project and assets
const USER_B = uid("04"); // added by an admin during the tests
const USER_X = uid("05"); // never in the team

/** Schema-qualified names of the nine functions this ticket creates. */
const FUNCTIONS = [
  "public.add_team_member",
  "public.set_team_member_role",
  "public.remove_team_member",
  "private.assert_team_admin",
  "public.admin_add_team_member",
  "public.admin_set_team_member_role",
  "public.admin_remove_team_member",
  "public.record_foreign_read",
  "public.record_foreign_asset_read",
] as const;

const UNCHANGED_FUNCTIONS = FUNCTIONS.filter(
  (name) => name !== "public.remove_team_member",
);

/** The retired body re-owned object store rows; the new database has none. */
const OLD_STORAGE_SEGMENT = `update storage.objects set owner = p_actor_user_id where bucket_id = 'project-assets' and owner = p_user_id and (storage.foldername(name))[1] = v_id::text; get diagnostics v_o = row_count;`;

let db: PGlite;
let applied: string[] = [];
let repository: TeamAdminReadRepository;
let teamId = "";
let projectId = "";
let canvasId = "";
let sessionId = "";
let projectAssetId = "";
let looseAssetId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function call<T>(sql: string, params: unknown[]): Promise<T> {
  const result = await db.query<{ r: T }>(`select ${sql} as r`, params);
  return firstRow(result.rows).r;
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql, params)).rows).n;
}

async function auditCount(): Promise<number> {
  return count("select count(*)::int as n from public.admin_audit_log");
}

async function roleOf(userId: string): Promise<string | undefined> {
  return (
    await db.query<{ role: string }>(
      "select role::text as role from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid",
      [teamId, userId],
    )
  ).rows[0]?.role;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  repository = createTeamAdminReadRepository({
    getTransactionPool: () => createPGliteTransactionPool(db),
  });

  for (const [id, email] of [
    [USER_O, "o-43w@hahart.test"],
    [USER_M, "m-43w@hahart.test"],
    [USER_A, "a-43w@hahart.test"],
    [USER_B, "b-43w@hahart.test"],
    [USER_X, "x-43w@hahart.test"],
  ] as const) {
    await createCanonicalUser(db, id, email);
  }

  teamId = await call<string>("public.ensure_team_workspace($1::uuid, $2)", [
    USER_O,
    "HaHart Team",
  ]);
  await db.query("select public.add_team_member($1::uuid, 'admin')", [USER_M]);
  await db.query("select public.add_team_member($1::uuid, 'member')", [USER_A]);

  projectId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.projects (workspace_id, name, slug, created_by) values ($1::uuid, 'p', 'p', $2::uuid) returning id",
        [teamId, USER_A],
      )
    ).rows,
  ).id;
  canvasId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.canvases (project_id, name, created_by) values ($1::uuid, 'c', $2::uuid) returning id",
        [projectId, USER_A],
      )
    ).rows,
  ).id;
  sessionId = firstRow(
    (
      await db.query<{ id: string }>(
        "insert into public.chat_sessions (canvas_id, created_by) values ($1::uuid, $2::uuid) returning id",
        [canvasId, USER_A],
      )
    ).rows,
  ).id;
  projectAssetId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
         values ($1::uuid, $2::uuid, 'project-assets', 'w43/in-project.png', $3::uuid) returning id`,
        [teamId, projectId, USER_A],
      )
    ).rows,
  ).id;
  looseAssetId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.asset_objects (workspace_id, bucket, object_path, created_by)
         values ($1::uuid, 'project-assets', 'w43/loose.png', $2::uuid) returning id`,
        [teamId, USER_A],
      )
    ).rows,
  ).id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0011 team admin: schema", () => {
  it("applies 0011_team_admin.sql", () => {
    expect(applied).toContain("0011_team_admin.sql");
  });
});

describe("canonical 0011 team admin: functions on an empty database", () => {
  it("add_team_member refuses owner and does not touch an existing role", async () => {
    expect(
      await failure(() => db.query("select public.add_team_member($1::uuid, 'owner')", [USER_B])),
    ).toContain("role owner is not assignable");
    expect(await call<boolean>("public.add_team_member($1::uuid, 'member')", [USER_M])).toBe(false);
    expect(await roleOf(USER_M)).toBe("admin");
  });

  it("a non-admin calling admin_add_team_member gets the source error and no audit row", async () => {
    const before = await auditCount();
    const message = await failure(() =>
      db.query("select public.admin_add_team_member($1::uuid, $2::uuid, 'member')", [USER_X, USER_B]),
    );
    expect(message).toContain("actor is not a team admin");
    expect(await auditCount()).toBe(before);
    expect(await roleOf(USER_B)).toBeUndefined();
  });

  it("admin_add_team_member adds one member row and one audit row; adding again audits nothing", async () => {
    const before = await auditCount();
    const members = await count(
      "select count(*)::int as n from public.workspace_members where workspace_id = $1::uuid",
      [teamId],
    );

    expect(
      await call<boolean>("public.admin_add_team_member($1::uuid, $2::uuid, 'member')", [USER_M, USER_B]),
    ).toBe(true);
    expect(await roleOf(USER_B)).toBe("member");
    expect(
      await count(
        "select count(*)::int as n from public.workspace_members where workspace_id = $1::uuid",
        [teamId],
      ),
    ).toBe(members + 1);
    expect(await auditCount()).toBe(before + 1);

    const audit = firstRow(
      (
        await db.query<{ action: string; actor_user_id: string; target_user_id: string; detail: unknown }>(
          "select action, actor_user_id, target_user_id, detail from public.admin_audit_log where action = 'team.member.add' order by created_at desc limit 1",
        )
      ).rows,
    );
    expect(audit.actor_user_id).toBe(USER_M);
    expect(audit.target_user_id).toBe(USER_B);
    expect(audit.detail).toEqual({ role: "member" });

    expect(
      await call<boolean>("public.admin_add_team_member($1::uuid, $2::uuid, 'member')", [USER_M, USER_B]),
    ).toBe(false);
    expect(await auditCount()).toBe(before + 1);
  });

  it("admin_set_team_member_role changes the role and records before and after", async () => {
    const before = await auditCount();
    expect(
      await call<boolean>("public.admin_set_team_member_role($1::uuid, $2::uuid, 'admin')", [USER_M, USER_B]),
    ).toBe(true);
    expect(await roleOf(USER_B)).toBe("admin");
    expect(await auditCount()).toBe(before + 1);

    const detail = firstRow(
      (
        await db.query<{ detail: unknown }>(
          "select detail from public.admin_audit_log where action = 'team.member.role' order by created_at desc limit 1",
        )
      ).rows,
    ).detail;
    expect(detail).toEqual({ before: "member", after: "admin" });

    expect(
      await call<boolean>("public.admin_set_team_member_role($1::uuid, $2::uuid, 'admin')", [USER_M, USER_B]),
    ).toBe(false);
    expect(await auditCount()).toBe(before + 1);

    expect(
      await failure(() =>
        db.query("select public.admin_set_team_member_role($1::uuid, $1::uuid, 'member')", [USER_M]),
      ),
    ).toContain("cannot change your own role");
    expect(
      await failure(() =>
        db.query("select public.set_team_member_role($1::uuid, 'member')", [USER_O]),
      ),
    ).toContain("cannot change the team owner");

    // Put B back to a plain member for the later steps.
    await call<boolean>("public.admin_set_team_member_role($1::uuid, $2::uuid, 'member')", [USER_M, USER_B]);
  });

  it("record_foreign_read writes one audit row for a foreign project, canvas and session", async () => {
    const before = await auditCount();
    expect(await call<boolean>("public.record_foreign_read($1::uuid, 'project', $2::uuid)", [USER_M, projectId])).toBe(true);
    expect(
      await call<boolean>("public.record_foreign_read($1::uuid, 'canvas', null, $2::uuid)", [USER_M, canvasId]),
    ).toBe(true);
    expect(
      await call<boolean>("public.record_foreign_read($1::uuid, 'messages', null, null, $2::uuid)", [USER_M, sessionId]),
    ).toBe(true);
    expect(await auditCount()).toBe(before + 3);

    expect(
      await count(
        `select count(*)::int as n from public.admin_audit_log
          where action = 'content.foreign_read' and target_user_id = $1::uuid and target_project_id = $2::uuid`,
        [USER_A, projectId],
      ),
    ).toBe(3);

    // Reading your own project writes nothing.
    expect(await call<boolean>("public.record_foreign_read($1::uuid, 'project', $2::uuid)", [USER_A, projectId])).toBe(false);
    expect(await auditCount()).toBe(before + 3);

    expect(
      await failure(() =>
        db.query("select public.record_foreign_read($1::uuid, 'x', $2::uuid, $3::uuid)", [USER_M, projectId, canvasId]),
      ),
    ).toContain("exactly one of project, canvas, session is required");
  });

  it("record_foreign_asset_read audits a foreign asset, with or without a project", async () => {
    const before = await auditCount();
    expect(await call<boolean>("public.record_foreign_asset_read($1::uuid, $2::uuid)", [USER_M, projectAssetId])).toBe(true);
    expect(await call<boolean>("public.record_foreign_asset_read($1::uuid, $2::uuid)", [USER_M, looseAssetId])).toBe(true);
    expect(await auditCount()).toBe(before + 2);
    expect(await call<boolean>("public.record_foreign_asset_read($1::uuid, $2::uuid)", [USER_A, looseAssetId])).toBe(false);
    expect(await auditCount()).toBe(before + 2);
    expect(
      await failure(() =>
        db.query("select public.record_foreign_asset_read($1::uuid, $2::uuid)", [
          USER_M,
          "00000000-0000-0000-0000-000000000000",
        ]),
      ),
    ).toContain("asset not found");
  });

  it("the team admin read repository lists the members with their roles", async () => {
    const members = await repository.listTeamMembers({ actorId: USER_M });
    const byId = new Map(members.map((member) => [member.userId, member]));

    expect([...byId.keys()].sort()).toEqual([USER_O, USER_M, USER_A, USER_B].sort());
    expect(byId.get(USER_O)?.role).toBe("owner");
    expect(byId.get(USER_M)?.role).toBe("admin");
    expect(byId.get(USER_A)?.role).toBe("member");
    expect(byId.get(USER_B)?.role).toBe("member");
    expect(byId.get(USER_A)?.email).toBe("a-43w@hahart.test");

    await expect(repository.listTeamMembers({ actorId: USER_A })).resolves.toEqual([]);
  });

  it("admin_remove_team_member removes the row and moves projects and all assets to the admin", async () => {
    expect(
      await failure(() => db.query("select public.admin_remove_team_member($1::uuid, $1::uuid)", [USER_M])),
    ).toContain("cannot remove yourself");
    expect(
      await failure(() =>
        db.query("select public.admin_remove_team_member($1::uuid, $2::uuid)", [USER_B, USER_A]),
      ),
    ).toContain("actor is not a team admin");

    const before = await auditCount();
    const result = await call<Record<string, number | null>>(
      "public.admin_remove_team_member($1::uuid, $2::uuid)",
      [USER_M, USER_A],
    );
    expect(result.projects).toBe(1);
    expect(result.assets).toBe(2);
    expect(result.removed).toBe(1);

    expect(await roleOf(USER_A)).toBeUndefined();
    expect(await auditCount()).toBe(before + 1);
    expect(
      firstRow(
        (
          await db.query<{ created_by: string }>("select created_by from public.projects where id = $1::uuid", [
            projectId,
          ])
        ).rows,
      ).created_by,
    ).toBe(USER_M);
    expect(
      await count(
        "select count(*)::int as n from public.asset_objects where workspace_id = $1::uuid and created_by = $2::uuid",
        [teamId, USER_M],
      ),
    ).toBe(2);
    expect(
      await count(
        "select count(*)::int as n from public.asset_objects where workspace_id = $1::uuid and created_by = $2::uuid",
        [teamId, USER_A],
      ),
    ).toBe(0);

    const again = await call<Record<string, number | null>>(
      "public.admin_remove_team_member($1::uuid, $2::uuid)",
      [USER_M, USER_A],
    );
    expect(again.removed).toBe(0);
    expect(await auditCount()).toBe(before + 1);
    expect(
      await failure(() =>
        db.query("select public.remove_team_member($1::uuid, $2::uuid)", [USER_O, USER_M]),
      ),
    ).toContain("cannot remove the team owner");
  });
});

describe("canonical 0011 team admin: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  async function functionShapes(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns '
              || pg_get_function_result(p.oid) || ' lang=' || l.lanname
              || ' volatility=' || p.provolatile::text
              || ' secdef=' || p.prosecdef::text
              || ' config=' || coalesce(p.proconfig::text, '') as line
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname || '.' || p.proname = any($1::text[])
        order by 1`,
      [[...FUNCTIONS]],
    );
    return result.rows.map((row) => row.line);
  }

  /** Function bodies with comment lines dropped and white space collapsed. */
  async function functionBodies(
    database: PGlite,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    const result = await database.query<{ name: string; prosrc: string }>(
      `select n.nspname || '.' || p.proname as name, p.prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname || '.' || p.proname = any($1::text[])
        order by 1`,
      [[...names]],
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.name,
        row.prosrc
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      ]),
    );
  }

  it("has the same function signatures, return types, language, security mode and search path", async () => {
    const oldShapes = await functionShapes(oldDb);
    expect(oldShapes).toHaveLength(FUNCTIONS.length);
    expect(await functionShapes(db)).toEqual(oldShapes);
  });

  it("has the same bodies for the eight unchanged functions, ignoring comments and white space", async () => {
    const oldBodies = await functionBodies(oldDb, UNCHANGED_FUNCTIONS);
    expect(Object.keys(oldBodies)).toHaveLength(UNCHANGED_FUNCTIONS.length);
    expect(await functionBodies(db, UNCHANGED_FUNCTIONS)).toEqual(oldBodies);
  });

  it("remove_team_member differs from the old body only in the removed object store statement", async () => {
    const oldBody = (await functionBodies(oldDb, ["public.remove_team_member"]))["public.remove_team_member"];
    const newBody = (await functionBodies(db, ["public.remove_team_member"]))["public.remove_team_member"];
    if (oldBody === undefined || newBody === undefined) throw new Error("remove_team_member not found");
    expect(oldBody).toContain(OLD_STORAGE_SEGMENT);
    expect(newBody).toBe(oldBody.replace(OLD_STORAGE_SEGMENT + " ", "").replace(OLD_STORAGE_SEGMENT, ""));
  });
});

describe("canonical 0011 team admin: SQL file hygiene", () => {
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
