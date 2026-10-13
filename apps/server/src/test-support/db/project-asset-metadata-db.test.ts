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

/**
 * The row as the RPC compares it. `byte_size` is bigint, so the driver may hand
 * it back as a number or a string; both are passed straight back in below, which
 * is exactly what the CLI does with the snapshot it planned from.
 */
type Snapshot = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  created_by: string | null;
  mime_type: string | null;
  byte_size: number | string | null;
};

type CompareResult = {
  status?: string;
  reason?: string;
  asset_id?: string;
  workspace_id?: string;
  project_id?: string | null;
};

async function assetSnapshot(path: string): Promise<Snapshot | null> {
  const rows = (
    await db.query<Snapshot>(
      `select id, workspace_id, project_id, created_by, mime_type, byte_size
         from public.asset_objects where object_path = $1`,
      [path],
    )
  ).rows;
  return rows[0] ?? null;
}

/**
 * Call the compare-and-write RPC as service_role. `expected` is the plan-time
 * snapshot; `null` means "the plan was made when no row existed", which is
 * expressed to the RPC as a null expected asset id.
 */
async function compareAndWrite(options: {
  path: string;
  bucket?: string;
  createdBy?: string | null;
  fallback?: string | null;
  projectId?: string | null;
  canvasId?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
  expected: Snapshot | null;
}): Promise<CompareResult> {
  const expected = options.expected;

  const result = await asServiceRole(db, async (tx) =>
    tx.query<{ r: CompareResult }>(
      `select public.record_project_asset_if_matches(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
       ) as r`,
      [
        options.bucket ?? "project-assets",
        options.path,
        options.createdBy === undefined ? USER_A : options.createdBy,
        options.fallback ?? null,
        options.projectId ?? null,
        options.canvasId ?? null,
        options.mimeType ?? null,
        options.byteSize ?? null,
        expected?.id ?? null,
        expected?.workspace_id ?? null,
        expected?.project_id ?? null,
        expected?.created_by ?? null,
        expected?.mime_type ?? null,
        expected?.byte_size ?? null,
      ],
    ),
  );

  return firstRow(result.rows).r;
}

/** Insert an asset row directly (as superuser) and return its snapshot. */
async function seedAsset(
  path: string,
  overrides: {
    workspaceId?: string;
    projectId?: string | null;
    createdBy?: string | null;
    mimeType?: string | null;
    byteSize?: number | null;
  } = {},
): Promise<Snapshot> {
  await db.query(
    `insert into public.asset_objects
       (workspace_id, project_id, bucket, object_path, created_by, mime_type, byte_size)
     values ($1, $2, 'project-assets', $3, $4, $5, $6)`,
    [
      overrides.workspaceId ?? teamId,
      overrides.projectId ?? null,
      path,
      overrides.createdBy === undefined ? USER_A : overrides.createdBy,
      overrides.mimeType ?? null,
      overrides.byteSize ?? null,
    ],
  );

  const snapshot = await assetSnapshot(path);
  if (snapshot === null) throw new Error(`seedAsset did not write ${path}`);
  return snapshot;
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

// T-20: the backfill's compare-and-write has to happen under a row lock.
//
// WHY THIS FILE PROTECTS IT: the CLI used to read the row, decide, and write in a
// separate round trip. Every case here is a way that window loses data — a row that
// appeared, a row that vanished, a row rebuilt under the same key, one field moved
// while the plan was in flight. The database has to be the one that says no, and it
// has to say it without writing anything.
describe("record_project_asset_if_matches (T-20 compare-and-write)", () => {
  const STALE_FIELDS = [
    "project_id",
    "workspace_id",
    "created_by",
    "mime_type",
    "byte_size",
  ] as const;

  /** Move one compared field away from the plan-time snapshot. */
  async function mutate(path: string, field: (typeof STALE_FIELDS)[number]): Promise<void> {
    switch (field) {
      case "project_id":
        await db.query(
          "update public.asset_objects set project_id = $2 where object_path = $1",
          [path, projectA],
        );
        return;
      case "workspace_id":
        await db.query(
          "update public.asset_objects set workspace_id = $2 where object_path = $1",
          [path, personalA],
        );
        return;
      case "created_by":
        await db.query(
          "update public.asset_objects set created_by = $2 where object_path = $1",
          [path, USER_B],
        );
        return;
      case "mime_type":
        await db.query(
          "update public.asset_objects set mime_type = 'image/jpeg' where object_path = $1",
          [path],
        );
        return;
      case "byte_size":
        await db.query(
          "update public.asset_objects set byte_size = 4096 where object_path = $1",
          [path],
        );
        return;
    }
  }

  it("case 14: a plan made against no row inserts it once and reports applied", async () => {
    const result = await compareAndWrite({
      path: "team/cmp-new.png",
      canvasId: canvasA,
      mimeType: "image/png",
      expected: null,
    });

    expect(result.status).toBe("applied");
    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);

    const row = await assetSnapshot("team/cmp-new.png");
    expect(row?.project_id).toBe(projectA);
    expect(row?.workspace_id).toBe(teamId);
    expect(row?.mime_type).toBe("image/png");
  });

  it("case 15: a row that appeared since planning is a conflict and is not adopted", async () => {
    const path = "team/cmp-appeared.png";
    const appeared = await seedAsset(path, {
      workspaceId: personalA,
      projectId: null,
      createdBy: USER_B,
    });

    const result = await compareAndWrite({ path, canvasId: canvasA, expected: null });

    expect(result).toEqual({ status: "conflict", reason: "row_appeared" });
    // Not one field of the row that appeared may change.
    expect(await assetSnapshot(path)).toEqual(appeared);
  });

  it("case 15b: the planned row disappearing is a conflict, not a resurrection", async () => {
    const path = "team/cmp-deleted.png";
    const snapshot = await seedAsset(path, { mimeType: "image/png", byteSize: 2048 });

    await db.query("delete from public.asset_objects where object_path = $1", [path]);

    const result = await compareAndWrite({
      path,
      canvasId: canvasA,
      mimeType: "image/png",
      byteSize: 2048,
      expected: snapshot,
    });

    expect(result).toEqual({ status: "conflict", reason: "row_missing" });
    expect(await assetSnapshot(path)).toBeNull();
  });

  it("case 15c: a delete plus an identical rebuild is caught by the asset id (ABA)", async () => {
    const path = "team/cmp-aba.png";
    const snapshot = await seedAsset(path, {
      createdBy: USER_A,
      mimeType: "image/png",
      byteSize: 2048,
    });

    await db.query("delete from public.asset_objects where object_path = $1", [path]);
    await db.query(
      `insert into public.asset_objects
         (workspace_id, project_id, bucket, object_path, created_by, mime_type, byte_size)
       values ($1, null, 'project-assets', $2, $3, 'image/png', 2048)`,
      [teamId, path, USER_A],
    );

    const rebuilt = await assetSnapshot(path);
    // Same key, same fields — only the id gives it away, which is why the
    // snapshot carries the id at all.
    expect(rebuilt?.id).not.toBe(snapshot.id);

    const result = await compareAndWrite({
      path,
      canvasId: canvasA,
      mimeType: "image/png",
      byteSize: 2048,
      expected: snapshot,
    });

    expect(result).toEqual({ status: "conflict", reason: "state_changed" });
    expect(await assetSnapshot(path)).toEqual(rebuilt);
  });

  it("case 16: a null-project row whose snapshot still matches is adopted", async () => {
    const path = "team/cmp-adopt.png";
    const snapshot = await seedAsset(path, {
      workspaceId: personalA,
      projectId: null,
      createdBy: USER_A,
      mimeType: "image/png",
      byteSize: 2048,
    });

    const result = await compareAndWrite({
      path,
      canvasId: canvasA,
      mimeType: "image/png",
      byteSize: 2048,
      expected: snapshot,
    });

    expect(result.status).toBe("applied");
    expect(result.project_id).toBe(projectA);
    expect(result.workspace_id).toBe(teamId);

    const row = await assetSnapshot(path);
    expect(row?.project_id).toBe(projectA);
    expect(row?.workspace_id).toBe(teamId);
    // Completion semantics are unchanged: the author is not taken over.
    expect(row?.created_by).toBe(USER_A);
    expect(row?.mime_type).toBe("image/png");
    expect(row?.byte_size).toBe(snapshot.byte_size);
  });

  for (const field of STALE_FIELDS) {
    it(`case 17 (${field}): a snapshot that changed is a conflict with zero writes`, async () => {
      const path = `team/cmp-stale-${field.replace(/_/g, "-")}.png`;
      const snapshot = await seedAsset(path, { mimeType: "image/png", byteSize: 2048 });

      await mutate(path, field);
      const mutated = await assetSnapshot(path);

      const result = await compareAndWrite({
        path,
        canvasId: canvasA,
        mimeType: "image/png",
        byteSize: 2048,
        expected: snapshot,
      });

      expect(result).toEqual({ status: "conflict", reason: "state_changed" });
      expect(await assetSnapshot(path)).toEqual(mutated);
    });
  }

  it("case 18: a contradiction, an unknown target and illegal arguments still raise", async () => {
    const unknown = "00000000-0000-0000-0000-0000000000fe";

    expect(
      await denial(() =>
        compareAndWrite({
          path: "team/cmp-mismatch.png",
          projectId: projectB,
          canvasId: canvasA,
          expected: null,
        }),
      ),
    ).toContain("canvas and project do not match");

    expect(
      await denial(() =>
        compareAndWrite({ path: "team/cmp-no-canvas.png", canvasId: unknown, expected: null }),
      ),
    ).toContain("content target not found");

    expect(
      await denial(() =>
        compareAndWrite({ path: "team/cmp-no-project.png", projectId: unknown, expected: null }),
      ),
    ).toContain("content target not found");

    expect(
      await denial(() =>
        compareAndWrite({ path: "personal/cmp-no-fallback.png", expected: null }),
      ),
    ).toContain("fallback workspace is required");

    expect(
      await denial(() =>
        compareAndWrite({
          path: "team/cmp-no-author.png",
          canvasId: canvasA,
          createdBy: null,
          expected: null,
        }),
      ),
    ).toContain("created_by is required");

    expect(
      await denial(() =>
        compareAndWrite({
          path: "team/cmp-no-bucket.png",
          bucket: "   ",
          canvasId: canvasA,
          expected: null,
        }),
      ),
    ).toContain("bucket is required");

    expect(await assetSnapshot("team/cmp-mismatch.png")).toBeNull();
    expect(await assetSnapshot("team/cmp-no-canvas.png")).toBeNull();
    expect(await assetSnapshot("team/cmp-no-project.png")).toBeNull();
    expect(await assetSnapshot("team/cmp-no-author.png")).toBeNull();
  });

  it("case 19: the migration is applied and only service_role may execute it", async () => {
    expect(applied).toContain(
      "20261013000001_hahart_project_asset_backfill_compare_write.sql",
    );

    const signature =
      "public.record_project_asset_if_matches(text,text,uuid,uuid,uuid,uuid,text,bigint,uuid,uuid,uuid,uuid,text,bigint)";

    const privileges = firstRow(
      (await db.query<{ service: boolean; authenticated: boolean; anon: boolean }>(
        `select has_function_privilege('service_role', $1, 'EXECUTE') as service,
                has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
                has_function_privilege('anon', $1, 'EXECUTE') as anon`,
        [signature],
      )).rows,
    );

    expect(privileges).toEqual({ service: true, authenticated: false, anon: false });
  });

  it("case 20: authenticated and anon cannot call it end to end", async () => {
    const attempt = (userId: string | null) =>
      denial(() =>
        asUser(db, userId, async (tx) =>
          tx.query("select public.record_project_asset_if_matches($1, $2, $3, $4)", [
            "project-assets",
            "team/cmp-forbidden.png",
            USER_A,
            personalA,
          ]),
        ),
      );

    expect((await attempt(USER_A)).toLowerCase()).toContain("permission denied");
    expect((await attempt(null)).toLowerCase()).toContain("permission denied");
    expect(await assetSnapshot("team/cmp-forbidden.png")).toBeNull();
  });

  it("case 21: the live writer now takes the same row lock before it decides", async () => {
    const definition = firstRow(
      (await db.query<{ def: string }>(
        `select pg_get_functiondef(
           'public.record_project_asset(text,text,uuid,uuid,uuid,uuid,text,bigint)'::regprocedure
         ) as def`,
      )).rows,
    ).def.toLowerCase();

    expect(definition).toContain("public.asset_objects");
    // Without this clause the backfill's lock and a normal writer's read are not
    // the same lock, and a worker can still update from a stale snapshot.
    expect(definition).toMatch(/object_path = btrim\(p_object_path\)\s+for update/);
  });

  it("case 22: a second writer still cannot move an owned row to another project", async () => {
    const path = "team/cmp-owned.png";
    await record({ path, canvasId: canvasA });
    const owned = await assetSnapshot(path);

    expect(await denial(() => record({ path, canvasId: canvasB }))).toContain(
      "already belongs to another project",
    );
    expect(await assetSnapshot(path)).toEqual(owned);

    // Same defence inside the compare-and-write path: a matching snapshot does
    // not authorise a different project.
    expect(
      await denial(() => compareAndWrite({ path, canvasId: canvasB, expected: owned })),
    ).toContain("already belongs to another project");
    expect(await assetSnapshot(path)).toEqual(owned);
  });
});
