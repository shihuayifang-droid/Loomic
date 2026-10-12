// X-52 prep (T1): asset metadata must follow the canvas/project source of truth.
//
// WHAT THIS FILE PROTECTS
// `background_jobs.workspace_id` is the PERSONAL billing workspace (Q1), while
// canvases and projects live in the team workspace. If asset metadata inherited
// the job's workspace, every generated image would be attached to a workspace
// that does not own its project — and once the bucket is private (X-52) the
// project that generated it could no longer read it.
//
// So the interesting cases are the ones where a caller tries to decide ownership
// itself: a project that does not match its canvas, an id that does not exist, a
// missing fallback for a non-project asset, a second caller trying to take over
// an existing row. Each must fail loudly rather than write something plausible.
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const uid = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

const USER_O = uid("0f"); // team owner
const USER_A = uid("0a"); // team member, owns project A
const USER_B = uid("0b"); // team member, owns project B

let db: PGlite;
let applied: string[] = [];

let teamId = "";
let personalA = "";
let projectA = "";
let projectB = "";
let canvasA = "";
let canvasB = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Run `fn` as service_role — the only identity allowed to call the RPC. */
async function asServiceRole<T>(
  database: PGlite,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx);
  });
}

type RecordResult = { asset_id: string; workspace_id: string; project_id: string | null };

/**
 * Call the RPC as service_role. Defaults model a canvas-generated asset; pass
 * `null` explicitly where a case is about the absence of an id.
 */
async function record(
  options: {
    bucket?: string;
    path: string;
    createdBy?: string;
    fallback?: string | null;
    projectId?: string | null;
    canvasId?: string | null;
    mimeType?: string | null;
    byteSize?: number | null;
  },
): Promise<RecordResult> {
  const result = await asServiceRole(db, async (tx) =>
    tx.query<{ r: RecordResult }>(
      `select public.record_project_asset($1, $2, $3, $4, $5, $6, $7, $8) as r`,
      [
        options.bucket ?? "project-assets",
        options.path,
        options.createdBy ?? USER_A,
        options.fallback ?? null,
        options.projectId ?? null,
        options.canvasId ?? null,
        options.mimeType ?? null,
        options.byteSize ?? null,
      ],
    ),
  );

  return firstRow(result.rows).r;
}

/** The asset row as the superuser sees it, or null when it was never written. */
async function assetRow(
  path: string,
): Promise<{ workspace_id: string; project_id: string | null; created_by: string | null } | null> {
  const rows = (
    await db.query<{ workspace_id: string; project_id: string | null; created_by: string | null }>(
      "select workspace_id, project_id, created_by from public.asset_objects where object_path = $1",
      [path],
    )
  ).rows;
  return rows[0] ?? null;
}

/** The rejection message; fails the test if the statement is allowed. */
async function denial(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be denied, but it succeeded");
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  await createUser(db, USER_O, "o@hahart.test");
  await createUser(db, USER_A, "a@hahart.test");
  await createUser(db, USER_B, "b@hahart.test");

  teamId = firstRow(
    (await db.query<{ id: string }>("select public.ensure_team_workspace($1, $2) as id", [
      USER_O,
      "HaHart 团队",
    ])).rows,
  ).id;

  for (const [userId, role] of [
    [USER_A, "member"],
    [USER_B, "member"],
  ] as const) {
    await db.query("select public.add_team_member($1, $2)", [userId, role]);
  }

  personalA = firstRow(
    (await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [USER_A],
    )).rows,
  ).id;

  const createProject = async (name: string, slug: string, owner: string) =>
    firstRow(
      (await db.query<{ id: string }>(
        `insert into public.projects (workspace_id, name, slug, created_by)
         values ($1, $2, $3, $4) returning id`,
        [teamId, name, slug, owner],
      )).rows,
    ).id;

  projectA = await createProject("Project A", "project-a", USER_A);
  projectB = await createProject("Project B", "project-b", USER_B);

  const createCanvas = async (projectId: string, name: string, owner: string) =>
    firstRow(
      (await db.query<{ id: string }>(
        `insert into public.canvases (project_id, name, created_by)
         values ($1, $2, $3) returning id`,
        [projectId, name, owner],
      )).rows,
    ).id;

  canvasA = await createCanvas(projectA, "Canvas A", USER_A);
  canvasB = await createCanvas(projectB, "Canvas B", USER_B);
}, 120_000);

describe("record_project_asset (X-52 prep)", () => {
  it("case 1: a canvas-derived asset lands in the project's team workspace", async () => {
    const result = await record({ path: "team/from-canvas.png", canvasId: canvasA });

    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);

    const row = await assetRow("team/from-canvas.png");
    expect(row).toEqual({
      workspace_id: teamId,
      project_id: projectA,
      created_by: USER_A,
    });
  });

  it("case 2: project + canvas that agree are accepted", async () => {
    const result = await record({
      path: "team/matching.png",
      projectId: projectA,
      canvasId: canvasA,
    });

    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);
  });

  it("case 3: a project that contradicts its canvas is refused", async () => {
    const message = await denial(() =>
      record({ path: "team/mismatch.png", projectId: projectB, canvasId: canvasA }),
    );

    expect(message).toContain("canvas and project do not match");
    expect(await assetRow("team/mismatch.png")).toBeNull();
  });

  it("case 4: unknown canvas / unknown project are refused, not invented", async () => {
    const unknown = "00000000-0000-0000-0000-0000000000ff";

    expect(await denial(() => record({ path: "team/no-canvas.png", canvasId: unknown }))).toContain(
      "content target not found",
    );
    expect(await denial(() => record({ path: "team/no-project.png", projectId: unknown }))).toContain(
      "content target not found",
    );
    expect(await assetRow("team/no-canvas.png")).toBeNull();
    expect(await assetRow("team/no-project.png")).toBeNull();
  });

  it("case 5: a project-only asset takes the project's workspace", async () => {
    const result = await record({ path: "team/project-only.png", projectId: projectA });

    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);
  });

  it("case 6: a non-project asset needs an explicit fallback workspace", async () => {
    // Without one there is nothing to attach the object to — and guessing from
    // the object path would attach it to whichever workspace the path names,
    // which is exactly the bug this migration exists to prevent.
    expect(await denial(() => record({ path: "personal/no-fallback.png" }))).toContain(
      "fallback workspace is required",
    );

    const result = await record({
      path: "personal/with-fallback.png",
      fallback: personalA,
      createdBy: USER_A,
    });

    expect(result.project_id).toBeNull();
    expect(result.workspace_id).toBe(personalA);
  });

  it("case 7: recording the same key twice is idempotent", async () => {
    const first = await record({ path: "team/repeat.png", canvasId: canvasA });
    const second = await record({ path: "team/repeat.png", canvasId: canvasA });

    expect(second.asset_id).toBe(first.asset_id);
    expect(second.project_id).toBe(projectA);
    expect(second.workspace_id).toBe(teamId);

    const count = firstRow(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.asset_objects where object_path = $1",
        ["team/repeat.png"],
      )).rows,
    ).n;
    expect(count).toBe(1);
  });

  it("case 8: a second caller cannot take over created_by", async () => {
    await record({ path: "team/ownership.png", canvasId: canvasA, createdBy: USER_A });
    await record({ path: "team/ownership.png", canvasId: canvasA, createdBy: USER_B });

    const row = await assetRow("team/ownership.png");
    expect(row?.created_by).toBe(USER_A);
  });

  it("case 9: an existing row cannot be moved to another project", async () => {
    await record({ path: "team/locked.png", canvasId: canvasA });

    const message = await denial(() => record({ path: "team/locked.png", canvasId: canvasB }));

    expect(message).toContain("already belongs to another project");
    expect((await assetRow("team/locked.png"))?.project_id).toBe(projectA);
  });

  it("case 10: an unrecorded project asset can still be adopted once", async () => {
    // The backfill path: a row written before project_id existed is completed,
    // not overwritten.
    await db.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, null, 'project-assets', 'team/adopt-me.png', $2)`,
      [personalA, USER_A],
    );

    const result = await record({ path: "team/adopt-me.png", canvasId: canvasA });

    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);
  });

  it("case 11: authenticated cannot call the RPC at all", async () => {
    const message = await denial(() =>
      asUser(db, USER_A, async (tx) =>
        tx.query("select public.record_project_asset($1, $2, $3, $4)", [
          "project-assets",
          "team/forbidden.png",
          USER_A,
          personalA,
        ]),
      ),
    );

    expect(message.toLowerCase()).toContain("permission denied");
    expect(await assetRow("team/forbidden.png")).toBeNull();
  });

  it("case 12: a member cannot read another member's project asset", async () => {
    await record({ path: "team/private-to-a.png", canvasId: canvasA, createdBy: USER_A });

    const visibleToB = await asUser(db, USER_B, async (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from public.asset_objects where object_path = $1",
        ["team/private-to-a.png"],
      ),
    );
    expect(firstRow(visibleToB.rows).n).toBe(0);

    const visibleToA = await asUser(db, USER_A, async (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from public.asset_objects where object_path = $1",
        ["team/private-to-a.png"],
      ),
    );
    expect(firstRow(visibleToA.rows).n).toBe(1);
  });

  it("case 13: the migration is part of the applied set", () => {
    expect(applied).toContain("20261002000002_hahart_project_asset_metadata.sql");
  });
});
