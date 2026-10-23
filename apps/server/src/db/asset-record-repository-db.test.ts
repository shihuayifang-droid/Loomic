import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createAssetRecordRepository,
  type AssetRecordRepository,
} from "./asset-record-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44B: the record_project_asset repository, run on the same set of
 * cases against the retired supabase migration chain ("legacy") and against the
 * canonical schema ("canonical"). Both must behave the same.
 */

const USER_ID = "00000000-0000-0000-0000-0000000044b1";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000044b2";

const PROJECT_ID = "aaaa0000-0000-4000-8000-0000000044b1";
const OTHER_PROJECT_ID = "aaaa0000-0000-4000-8000-0000000044b2";
const CANVAS_ID = "bbbb0000-0000-4000-8000-0000000044b1";
const UNKNOWN_PROJECT_ID = "aaaa0000-0000-4000-8000-0000000044ff";

const BUCKET = "project-assets";

type Fixture = {
  db: PGlite;
  repository: AssetRecordRepository;
  personalWorkspaceId: string;
  projectWorkspaceId: string;
};

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  await createUser(db, USER_ID, "u-44b@hahart.test");
  await createUser(db, OTHER_USER_ID, "o-44b@hahart.test");
  return finishSetup(db);
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  await createCanonicalUser(db, USER_ID, "u-44b@hahart.test");
  await createCanonicalUser(db, OTHER_USER_ID, "o-44b@hahart.test");
  return finishSetup(db);
}

async function personalWorkspaceOf(db: PGlite, userId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("no personal workspace");
  return row.id;
}

async function finishSetup(db: PGlite): Promise<Fixture> {
  const personalWorkspaceId = await personalWorkspaceOf(db, USER_ID);
  const projectWorkspaceId = await personalWorkspaceOf(db, OTHER_USER_ID);

  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, description, created_by)
     values ($1, $2, 'Project 44B', 'project-44b', 'a project', $3)`,
    [PROJECT_ID, projectWorkspaceId, OTHER_USER_ID],
  );
  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, description, created_by)
     values ($1, $2, 'Project 44B other', 'project-44b-other', 'another project', $3)`,
    [OTHER_PROJECT_ID, projectWorkspaceId, OTHER_USER_ID],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content)
     values ($1, $2, 'Main canvas', true, $3, '{"elements":[],"appState":{}}'::jsonb)`,
    [CANVAS_ID, PROJECT_ID, OTHER_USER_ID],
  );

  const pool = createPGliteTransactionPool(db);
  return {
    db,
    repository: createAssetRecordRepository({ getTransactionPool: () => pool }),
    personalWorkspaceId,
    projectWorkspaceId,
  };
}

type AssetRow = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: string | number | null;
  created_by: string | null;
  workspace_id: string;
  project_id: string | null;
};

async function assetRows(db: PGlite, objectPath: string): Promise<AssetRow[]> {
  const result = await db.query<AssetRow>(
    `select id, bucket, object_path, mime_type, byte_size, created_by, workspace_id, project_id
       from public.asset_objects
      where bucket = $1 and object_path = $2`,
    [BUCKET, objectPath],
  );
  return result.rows;
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

describe.each([
  ["legacy", setupLegacy],
  ["canonical", setupCanonical],
] as const)("asset record repository on the %s schema", (_name, setup) => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setup();
  }, 120_000);

  afterAll(async () => {
    await fx.db.close();
  });

  it("records a project asset under the project's workspace", async () => {
    const recorded = await fx.repository.recordProjectAsset({
      bucket: BUCKET,
      objectPath: "44b/project-asset.png",
      createdBy: USER_ID,
      fallbackWorkspaceId: fx.personalWorkspaceId,
      projectId: PROJECT_ID,
      mimeType: "image/png",
      byteSize: 1234,
    });

    expect(recorded.projectId).toBe(PROJECT_ID);
    expect(recorded.workspaceId).toBe(fx.projectWorkspaceId);

    const rows = await assetRows(fx.db, "44b/project-asset.png");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(recorded.assetId);
    expect(row.bucket).toBe(BUCKET);
    expect(row.object_path).toBe("44b/project-asset.png");
    expect(row.mime_type).toBe("image/png");
    expect(Number(row.byte_size)).toBe(1234);
    expect(row.created_by).toBe(USER_ID);
    expect(row.workspace_id).toBe(fx.projectWorkspaceId);
    expect(row.project_id).toBe(PROJECT_ID);
  });

  it("records a non-project asset under the fallback workspace", async () => {
    const recorded = await fx.repository.recordProjectAsset({
      bucket: BUCKET,
      objectPath: "44b/loose-asset.png",
      createdBy: USER_ID,
      fallbackWorkspaceId: fx.personalWorkspaceId,
    });

    expect(recorded.projectId).toBeNull();
    expect(recorded.workspaceId).toBe(fx.personalWorkspaceId);

    const rows = await assetRows(fx.db, "44b/loose-asset.png");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_id).toBeNull();
    expect(rows[0]!.mime_type).toBeNull();
    expect(rows[0]!.byte_size).toBeNull();
  });

  it("resolves the project from a canvas id", async () => {
    const recorded = await fx.repository.recordProjectAsset({
      bucket: BUCKET,
      objectPath: "44b/canvas-asset.png",
      createdBy: USER_ID,
      fallbackWorkspaceId: fx.personalWorkspaceId,
      canvasId: CANVAS_ID,
    });

    expect(recorded.projectId).toBe(PROJECT_ID);
    expect(recorded.workspaceId).toBe(fx.projectWorkspaceId);
  });

  it("records the same bucket and path twice as one row with the same id", async () => {
    const input = {
      bucket: BUCKET,
      objectPath: "44b/repeat-asset.png",
      createdBy: USER_ID,
      fallbackWorkspaceId: fx.personalWorkspaceId,
      projectId: PROJECT_ID,
    };
    const first = await fx.repository.recordProjectAsset(input);
    const second = await fx.repository.recordProjectAsset({
      ...input,
      mimeType: "image/png",
      byteSize: 99,
    });

    expect(second.assetId).toBe(first.assetId);
    expect(second).toEqual(first);

    const rows = await assetRows(fx.db, "44b/repeat-asset.png");
    expect(rows).toHaveLength(1);
    // The second call fills the metadata the first one left empty.
    expect(rows[0]!.mime_type).toBe("image/png");
    expect(Number(rows[0]!.byte_size)).toBe(99);
  });

  it("refuses to move an existing object to another project (SQLSTATE 23505)", async () => {
    await fx.repository.recordProjectAsset({
      bucket: BUCKET,
      objectPath: "44b/owned-asset.png",
      createdBy: USER_ID,
      fallbackWorkspaceId: fx.personalWorkspaceId,
      projectId: PROJECT_ID,
    });

    const failure = await capture(() =>
      fx.repository.recordProjectAsset({
        bucket: BUCKET,
        objectPath: "44b/owned-asset.png",
        createdBy: USER_ID,
        fallbackWorkspaceId: fx.personalWorkspaceId,
        projectId: OTHER_PROJECT_ID,
      }),
    );
    expect(failure.code).toBe("23505");

    const rows = await assetRows(fx.db, "44b/owned-asset.png");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_id).toBe(PROJECT_ID);
  });

  it("throws the database error with its SQLSTATE for an unknown project (P0002)", async () => {
    const failure = await capture(() =>
      fx.repository.recordProjectAsset({
        bucket: BUCKET,
        objectPath: "44b/unknown-project.png",
        createdBy: USER_ID,
        fallbackWorkspaceId: fx.personalWorkspaceId,
        projectId: UNKNOWN_PROJECT_ID,
      }),
    );
    expect(failure.code).toBe("P0002");
    expect(await assetRows(fx.db, "44b/unknown-project.png")).toHaveLength(0);
  });

  it("throws SQLSTATE 22023 for a blank bucket", async () => {
    const failure = await capture(() =>
      fx.repository.recordProjectAsset({
        bucket: "  ",
        objectPath: "44b/blank-bucket.png",
        createdBy: USER_ID,
        fallbackWorkspaceId: fx.personalWorkspaceId,
      }),
    );
    expect(failure.code).toBe("22023");
  });
});
