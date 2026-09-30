import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const uid = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

const USER_O = uid("0f"); // team owner
const USER_A = uid("0a"); // team member
const USER_B = uid("0b"); // team member
const USER_X = uid("0c"); // not in the team

let db: PGlite;
let applied: string[] = [];
let teamId = "";
let workspaceA = "";
let workspaceB = "";
let workspaceX = "";
let projectA1 = "";
let projectA2 = "";
let projectB = "";
let projectX = "";
let projectAssetId = "";
let freeAssetId = "";

const counts = { projects: 0, canvases: 0, asset_objects: 0, chat_sessions: 0 };
const ownersBefore = new Map<string, string | null>();

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<Record<string, T>>(sql, params);
  return firstRow(result.rows)[Object.keys(firstRow(result.rows))[0]!] as T;
}

async function migration(): Promise<Record<string, number>> {
  return one<Record<string, number>>(
    "select public.migrate_personal_projects_to_team() as r",
  );
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function rowCount(table: string): Promise<number> {
  return one<number>(`select count(*)::int as n from public.${table}`);
}

async function auditCount(): Promise<number> {
  return one<number>("select count(*)::int as n from public.admin_audit_log");
}

async function projectSlug(projectId: string): Promise<string> {
  return one<string>("select slug from public.projects where id = $1", [projectId]);
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  for (const [id, email] of [
    [USER_O, "o@hahart.test"],
    [USER_A, "a@hahart.test"],
    [USER_B, "b@hahart.test"],
    [USER_X, "x@hahart.test"],
  ] as const) {
    await createUser(db, id, email);
  }

  const personal = async (userId: string) =>
    one<string>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [userId],
    );

  workspaceA = await personal(USER_A);
  workspaceB = await personal(USER_B);
  workspaceX = await personal(USER_X);

  teamId = await one<string>("select public.ensure_team_workspace($1, $2) as id", [
    USER_O,
    "HaHart 团队",
  ]);
  await db.query("select public.add_team_member($1, 'member')", [USER_A]);
  await db.query("select public.add_team_member($1, 'member')", [USER_B]);

  const makeProject = async (
    workspaceId: string,
    slug: string,
    createdBy: string | null,
  ) =>
    one<string>(
      "insert into public.projects (workspace_id, name, slug, created_by) values ($1,$2,$2,$3) returning id",
      [workspaceId, slug, createdBy],
    );

  projectA1 = await makeProject(workspaceA, "a1", USER_A);
  projectA2 = await makeProject(workspaceA, "a2", null);
  projectB = await makeProject(workspaceB, "dup", USER_B);
  projectX = await makeProject(workspaceX, "x1", USER_X);
  await makeProject(teamId, "dup", USER_O);

  const canvasId = await one<string>(
    "insert into public.canvases (project_id, name, created_by) values ($1,'c',$2) returning id",
    [projectA1, USER_A],
  );
  await db.query(
    "insert into public.chat_sessions (canvas_id, created_by) values ($1,$2)",
    [canvasId, USER_A],
  );
  projectAssetId = await one<string>(
    `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
     values ($1,$2,'project-assets',$3,$4) returning id`,
    [workspaceA, projectA1, `${workspaceA}/${projectA1}/a.png`, USER_A],
  );
  freeAssetId = await one<string>(
    `insert into public.asset_objects (workspace_id, bucket, object_path, created_by)
     values ($1,'project-assets',$2,$3) returning id`,
    [workspaceA, `${workspaceA}/free.png`, USER_A],
  );

  counts.projects = await rowCount("projects");
  counts.canvases = await rowCount("canvases");
  counts.asset_objects = await rowCount("asset_objects");
  counts.chat_sessions = await rowCount("chat_sessions");

  const rows = (
    await db.query<{ id: string; created_by: string | null }>(
      "select id, created_by from public.projects",
    )
  ).rows;
  for (const row of rows) ownersBefore.set(row.id, row.created_by);
}, 120_000);

describe("personal to team project migration", () => {
  it("case 1: the asset foreign key now follows updates and deletes", async () => {
    const definition = await one<string>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'asset_objects_project_workspace_fkey'",
    );

    expect(definition).toContain("ON UPDATE CASCADE");
    expect(definition).toContain("ON DELETE CASCADE");
  });

  it("case 2: the first run moves team members' projects and backfills owners", async () => {
    expect(await migration()).toEqual({
      projects_moved: 3,
      assets_moved: 1,
      created_by_backfilled: 1,
      slugs_renamed: 1,
      projects_left_in_personal: 1,
    });
  });

  it("case 3: the second run is a no-op", async () => {
    expect(await migration()).toEqual({
      projects_moved: 0,
      assets_moved: 0,
      created_by_backfilled: 0,
      slugs_renamed: 0,
      projects_left_in_personal: 1,
    });
  });

  it("case 4: row counts are unchanged by the migration", async () => {
    expect({
      projects: await rowCount("projects"),
      canvases: await rowCount("canvases"),
      asset_objects: await rowCount("asset_objects"),
      chat_sessions: await rowCount("chat_sessions"),
    }).toEqual(counts);
    expect(counts).toEqual({
      projects: 5,
      canvases: 1,
      asset_objects: 2,
      chat_sessions: 1,
    });
  });

  it("case 5: every project keeps its owner (except the null one, backfilled to A)", async () => {
    const rows = (
      await db.query<{ id: string; created_by: string | null }>(
        "select id, created_by from public.projects",
      )
    ).rows;

    for (const row of rows) {
      if (row.id === projectA2) {
        expect(row.created_by).toBe(USER_A);
      } else {
        expect(row.created_by, row.id).toBe(ownersBefore.get(row.id));
      }
    }
    expect(await one<string | null>("select created_by from public.projects where id = $1", [projectA2])).toBe(USER_A);
  });

  it("case 6: project assets follow their project; project-less assets stay behind", async () => {
    expect(
      await one<boolean>(
        "select workspace_id = $1 as ok from public.asset_objects where id = $2",
        [teamId, projectAssetId],
      ),
    ).toBe(true);
    expect(
      await one<boolean>(
        "select workspace_id = $1 as ok from public.asset_objects where id = $2",
        [workspaceA, freeAssetId],
      ),
    ).toBe(true);
  });

  it("case 7: a colliding slug is suffixed, the team's own slug is untouched", async () => {
    const slug = await projectSlug(projectB);
    expect(slug.startsWith("dup-")).toBe(true);
    expect(slug.length).toBe("dup-".length + 6);

    expect(
      await one<number>(
        "select count(*)::int as n from public.projects where workspace_id = $1 and slug = 'dup'",
        [teamId],
      ),
    ).toBe(1);
  });

  it("case 8: a non-member's project stays in their personal workspace", async () => {
    expect(
      await one<boolean>(
        "select workspace_id = $1 as ok from public.projects where id = $2",
        [workspaceX, projectX],
      ),
    ).toBe(true);
  });

  it("case 9: moved projects obey the workorder-3 read/write policies", async () => {
    const ownProjects = await asUser(db, USER_A, async (tx) => {
      const result = await tx.query<{ n: number }>(
        "select count(*)::int as n from public.projects where workspace_id = $1 and created_by = $2",
        [teamId, USER_A],
      );
      return firstRow(result.rows).n;
    });
    expect(ownProjects).toBe(2);

    const othersProjects = await asUser(db, USER_B, async (tx) => {
      const result = await tx.query<{ n: number }>(
        "select count(*)::int as n from public.projects where workspace_id = $1 and created_by = $2",
        [teamId, USER_A],
      );
      return firstRow(result.rows).n;
    });
    expect(othersProjects).toBe(0);

    const renamed = await asUser(db, USER_A, (tx) =>
      tx.query("update public.projects set name = 'renamed' where id = $1", [projectA1]),
    );
    expect(renamed.affectedRows ?? 0).toBe(1);
  });

  it("case 10: without a team workspace the migration refuses to run", async () => {
    const fresh = await createMigratedDb();
    await createUser(fresh.db, USER_A, "a@hahart.test");

    const message = await failure(() =>
      fresh.db.query("select public.migrate_personal_projects_to_team()"),
    );
    expect(message).toContain("team workspace does not exist");
  }, 120_000);

  it("case 11: reading an asset records one audit row per foreign read", async () => {
    const before = await auditCount();

    expect(
      await one<boolean>("select public.record_foreign_asset_read($1,$2) as r", [
        USER_A,
        projectAssetId,
      ]),
    ).toBe(false);

    expect(
      await one<boolean>("select public.record_foreign_asset_read($1,$2) as r", [
        USER_O,
        projectAssetId,
      ]),
    ).toBe(true);
    expect(
      await one<boolean>("select public.record_foreign_asset_read($1,$2) as r", [
        USER_O,
        freeAssetId,
      ]),
    ).toBe(true);

    expect(await auditCount()).toBe(before + 2);
    expect(
      await one<number>(
        "select count(*)::int as n from public.admin_audit_log where target_user_id = $1 and detail->>'via' = 'asset'",
        [USER_A],
      ),
    ).toBe(2);

    const missing = await failure(() =>
      db.query("select public.record_foreign_asset_read($1,$2)", [USER_O, projectX]),
    );
    expect(missing).toContain("asset not found");
  });

  it("case 12: both new functions are service_role only", async () => {
    const calls: Array<[string, string, unknown[]]> = [
      [
        "migrate_personal_projects_to_team",
        "select public.migrate_personal_projects_to_team()",
        [],
      ],
      [
        "record_foreign_asset_read",
        "select public.record_foreign_asset_read($1,$2)",
        [USER_O, projectAssetId],
      ],
    ];

    for (const [label, sql, params] of calls) {
      const message = await failure(() =>
        asUser(db, USER_O, (tx) => tx.query(sql, params)),
      );
      expect(message, label).toContain("permission denied for function");
    }
  });
});
