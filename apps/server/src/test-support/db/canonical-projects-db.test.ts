import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAssetReadRepository } from "../../db/asset-read-repository.js";
import { createCanvasReadRepository } from "../../db/canvas-read-repository.js";
import { createProjectReadRepository } from "../../db/project-read-repository.js";
import { createProjectWriteRepository } from "../../db/project-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43P: canonical migration 0004 (projects, canvases, asset objects) on an
 * empty database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 *
 * The column-set comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0004 is the final form of that chain.
 */

const USER_A = "00000000-0000-0000-0000-0000000000e1";
const USER_B = "00000000-0000-0000-0000-0000000000e2";

const PROJECT_A = "aaaa0000-0000-4000-8000-0000000000e1";
const CANVAS_A = "bbbb0000-0000-4000-8000-0000000000e1";
const CANVAS_CONTENT = { elements: [{ id: "el-1", type: "rectangle" }], appState: {} };

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0004_projects_assets.sql",
);

const TABLES = ["projects", "canvases", "asset_objects"] as const;

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];
let personalWorkspaceA = "";

type ColumnShape = { table_name: string; column_name: string; data_type: string; is_nullable: string };

async function columnShapes(database: PGlite): Promise<ColumnShape[]> {
  const result = await database.query<ColumnShape>(
    `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('projects', 'canvases', 'asset_objects')
      order by table_name, column_name`,
  );
  return result.rows;
}

/** Primary key, unique and check constraints by name and definition. */
async function constraintDefs(database: PGlite): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    `select conrelid::regclass::text || ' ' || conname || ' :: ' || pg_get_constraintdef(oid) as line
       from pg_constraint
      where conrelid in ('public.projects'::regclass, 'public.canvases'::regclass, 'public.asset_objects'::regclass)
        and contype in ('p', 'u', 'c')
      order by 1`,
  );
  return result.rows.map((row) => row.line);
}

async function indexNames(database: PGlite): Promise<string[]> {
  const result = await database.query<{ indexname: string }>(
    `select indexname
       from pg_indexes
      where schemaname = 'public'
        and tablename in ('projects', 'canvases', 'asset_objects')
      order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);

  await createCanonicalUser(db, USER_A, "a@hahart.test");
  await createCanonicalUser(db, USER_B, "b@hahart.test");

  personalWorkspaceA = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_A],
      )
    ).rows,
  ).id;

  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, description, created_by)
     values ($1, $2, 'Canonical Project', 'canonical-project', 'a project', $3)`,
    [PROJECT_A, personalWorkspaceA, USER_A],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content)
     values ($1, $2, 'Main canvas', true, $3, $4::jsonb)`,
    [CANVAS_A, PROJECT_A, USER_A, JSON.stringify(CANVAS_CONTENT)],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0004 projects: schema", () => {
  it("applies 0004_projects_assets.sql", () => {
    expect(applied).toContain("0004_projects_assets.sql");
  });

  it("creates the three tables and both functions", async () => {
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('projects', 'canvases', 'asset_objects')
        order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "asset_objects",
      "canvases",
      "projects",
    ]);

    const functions = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('record_project_asset', 'project_content_target')
        order by 1`,
    );
    expect(functions.rows.map((row) => row.name)).toEqual([
      "private.project_content_target",
      "public.record_project_asset",
    ]);
  });

  it("projects and asset_objects carry the same foreign keys as the old schema", async () => {
    const result = await db.query<{ conname: string }>(
      `select conname from pg_constraint
        where contype = 'f'
          and conrelid in ('public.projects'::regclass, 'public.asset_objects'::regclass)
          and conname in ('asset_objects_source_job_fkey', 'projects_brand_kit_id_fkey')
        order by conname`,
    );
    // Final state once every canonical file ran: the source_job_id FK (0006) and the
    // brand_kit_id FK (0012) are both present.
    expect(result.rows.map((row) => row.conname)).toEqual([
      "asset_objects_source_job_fkey",
      "projects_brand_kit_id_fkey",
    ]);
  });

  it("deleting a hahart_auth user sets created_by to null", async () => {
    await createCanonicalUser(db, "00000000-0000-0000-0000-0000000000e9", "gone@hahart.test");
    await db.query(
      `insert into public.canvases (project_id, name, created_by)
       values ($1, 'Owned by a user that leaves', $2)`,
      [PROJECT_A, "00000000-0000-0000-0000-0000000000e9"],
    );
    await db.query("delete from hahart_auth.users where id = $1", [
      "00000000-0000-0000-0000-0000000000e9",
    ]);
    const rows = await db.query<{ created_by: string | null }>(
      "select created_by from public.canvases where name = 'Owned by a user that leaves'",
    );
    expect(rows.rows).toEqual([{ created_by: null }]);
  });
});

describe("canonical 0004 projects: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  it("has the same columns (name, data type, nullability) on all three tables", async () => {
    const oldShapes = await columnShapes(oldDb);
    const newShapes = await columnShapes(db);

    for (const table of TABLES) {
      const wanted = oldShapes.filter((row) => row.table_name === table);
      expect(wanted.length, `old ${table} has columns`).toBeGreaterThan(0);
      expect(
        newShapes.filter((row) => row.table_name === table),
        `columns of ${table}`,
      ).toEqual(wanted);
    }
  });

  it("has the same primary key, unique and check constraints", async () => {
    expect(await constraintDefs(db)).toEqual(await constraintDefs(oldDb));
  });

  it("has the same indexes as the old schema", async () => {
    expect(await indexNames(db)).toEqual(await indexNames(oldDb));
  });
});

describe("canonical 0004 projects: repositories on the canonical database", () => {
  it("project-write-repository updates the project and project-read-repository reads it back", async () => {
    const writer = createProjectWriteRepository({ getTransactionPool: () => pool });
    const reader = createProjectReadRepository({ getTransactionPool: () => pool });

    const updated = await writer.updateOwnProject({
      actorId: USER_A,
      projectId: PROJECT_A,
      patch: { name: "Renamed Project" },
    });
    expect(updated).toEqual({ updated: 1 });

    const thumb = await writer.setOwnProjectThumbnail({
      actorId: USER_A,
      projectId: PROJECT_A,
      thumbnailPath: "thumbs/a.webp",
    });
    expect(thumb).toEqual({ updated: 1 });

    const found = await reader.findReadableProject({ actorId: USER_A, projectId: PROJECT_A });
    expect(found?.id).toBe(PROJECT_A);
    expect(found?.name).toBe("Renamed Project");
    expect(found?.slug).toBe("canonical-project");
    expect(found?.workspace_id).toBe(personalWorkspaceA);
    expect(found?.brand_kit_id).toBeNull();

    const listed = await reader.listOwnProjects({
      actorId: USER_A,
      workspaceId: personalWorkspaceA,
    });
    expect(listed.map((row) => row.id)).toEqual([PROJECT_A]);
    expect(listed[0]?.thumbnail_path).toBe("thumbs/a.webp");

    const primary = await reader.listReadablePrimaryCanvases({
      actorId: USER_A,
      workspaceId: personalWorkspaceA,
      projectIds: [PROJECT_A],
    });
    expect(primary.map((row) => row.id)).toEqual([CANVAS_A]);
  });

  it("a non-member cannot read the project", async () => {
    const reader = createProjectReadRepository({ getTransactionPool: () => pool });
    expect(await reader.findReadableProject({ actorId: USER_B, projectId: PROJECT_A })).toBeNull();
  });

  it("record_project_asset records an asset that asset-read-repository can read", async () => {
    const recorded = await db.query<{ r: { asset_id: string; workspace_id: string; project_id: string } }>(
      `select public.record_project_asset($1, $2, $3, null, $4, null, 'image/png', 1234) as r`,
      ["project-assets", "ws/canonical/pic.png", USER_A, PROJECT_A],
    );
    const result = firstRow(recorded.rows).r;
    expect(result.workspace_id).toBe(personalWorkspaceA);
    expect(result.project_id).toBe(PROJECT_A);

    // Re-recording the same object is a no-op that returns the same asset.
    const again = await db.query<{ r: { asset_id: string } }>(
      `select public.record_project_asset($1, $2, $3, null, $4, null, null, null) as r`,
      ["project-assets", "ws/canonical/pic.png", USER_A, PROJECT_A],
    );
    expect(firstRow(again.rows).r.asset_id).toBe(result.asset_id);

    const reader = createAssetReadRepository({ getTransactionPool: () => pool });
    const found = await reader.findReadableAsset({ actorId: USER_A, assetId: result.asset_id });
    expect(found).not.toBeNull();
    expect(found?.id).toBe(result.asset_id);
    expect(found?.bucket).toBe("project-assets");
    expect(found?.object_path).toBe("ws/canonical/pic.png");
    expect(found?.mime_type).toBe("image/png");
    expect(found?.project_id).toBe(PROJECT_A);
    expect(found?.workspace_id).toBe(personalWorkspaceA);

    expect(await reader.findReadableAsset({ actorId: USER_B, assetId: result.asset_id })).toBeNull();
  });

  it("record_project_asset records a non-project asset through the fallback workspace", async () => {
    const recorded = await db.query<{ r: { project_id: string | null; workspace_id: string } }>(
      `select public.record_project_asset($1, $2, $3, $4) as r`,
      ["user-avatars", "avatars/a.png", USER_A, personalWorkspaceA],
    );
    const result = firstRow(recorded.rows).r;
    expect(result.project_id).toBeNull();
    expect(result.workspace_id).toBe(personalWorkspaceA);
  });

  it("record_project_asset resolves the project through a canvas id", async () => {
    const recorded = await db.query<{ r: { project_id: string } }>(
      `select public.record_project_asset($1, $2, $3, null, null, $4) as r`,
      ["canvases", "ws/canonical/canvas-file.png", USER_A, CANVAS_A],
    );
    expect(firstRow(recorded.rows).r.project_id).toBe(PROJECT_A);
  });

  it("canvas-read-repository reads the canvas content", async () => {
    const reader = createCanvasReadRepository({ getTransactionPool: () => pool });

    const content = await reader.findReadableCanvasContent({ actorId: USER_A, canvasId: CANVAS_A });
    expect(content).toEqual({ content: CANVAS_CONTENT });

    const link = await reader.findReadableCanvasProjectLink({ actorId: USER_A, canvasId: CANVAS_A });
    expect(link?.project_id).toBe(PROJECT_A);

    expect(
      await reader.findReadableCanvasContent({ actorId: USER_B, canvasId: CANVAS_A }),
    ).toBeNull();
  });
});

describe("canonical 0004 projects: SQL file hygiene", () => {
  it("contains none of the retired Supabase-only constructs", () => {
    const sql = readFileSync(SQL_FILE, "utf8").replaceAll("hahart_auth.", "").toLowerCase();
    const banned = [
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
    ];
    for (const word of banned) {
      expect(sql.includes(word), `0004_projects_assets.sql must not contain "${word}"`).toBe(false);
    }
  });

  it("stays within 400 lines", () => {
    expect(readFileSync(SQL_FILE, "utf8").split("\n").length).toBeLessThanOrEqual(400);
  });
});
