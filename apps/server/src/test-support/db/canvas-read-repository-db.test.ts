import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIND_READABLE_CANVAS_CONTENT,
  FIND_READABLE_CANVAS_PROJECT_LINK,
  LIST_READABLE_CANVAS_ASSETS,
  LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
  CanvasReadError,
  createCanvasReadRepository,
  type CanvasReadRepository,
  type CanvasProjectLinkRow,
} from "../../db/canvas-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the canvas read repository (workorder 20C,
 * ADR-0001 migration step 2c).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statement enforces the ACL on a real PostgreSQL parser and planner:
 * the canvas → project → workspace_members walk, the author/admin/owner clause,
 * the archived filter, the job canvas/status/type filter and its ordering, the
 * `unnest` pair match with `asset_objects.project_id = <canvas project>`, and
 * the rollback path after an illegal uuid.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database owner, which BYPASSES RLS
 * — that is exactly why every judge below reads through the repository and never
 * through `asUser`: the old policies are not the evidence, the SQL is.
 *
 * One instance is migrated in `beforeAll`, the fixture is built on real tables,
 * and `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000d1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000d2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000d3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000d4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000d5";

const ACTIVE_PROJECT = "cccc0000-0000-4000-8000-000000000001";
const ADMIN_PROJECT = "cccc0000-0000-4000-8000-000000000002";
const MEMBER_PROJECT = "cccc0000-0000-4000-8000-000000000003";
const ARCHIVED_PROJECT = "cccc0000-0000-4000-8000-000000000004";
const OUTSIDER_PROJECT = "cccc0000-0000-4000-8000-000000000005";
const BRANDED_PROJECT = "cccc0000-0000-4000-8000-000000000006";

const ACTIVE_CANVAS = "dddd0000-0000-4000-8000-000000000001";
const ADMIN_CANVAS = "dddd0000-0000-4000-8000-000000000002";
const MEMBER_CANVAS = "dddd0000-0000-4000-8000-000000000003";
const ARCHIVED_CANVAS = "dddd0000-0000-4000-8000-000000000004";
const OUTSIDER_CANVAS = "dddd0000-0000-4000-8000-000000000005";
const BRANDED_CANVAS = "dddd0000-0000-4000-8000-000000000006";
const MISSING_CANVAS = "dddd0000-0000-4000-8000-00000000000f";

/** The one brand kit in the fixture (workorder 21R). */
const BRAND_KIT_ID = "bbbb0000-0000-4000-8000-000000000001";

const JOB_OLD = "eeee0000-0000-4000-8000-000000000001";
const JOB_MID = "eeee0000-0000-4000-8000-000000000002";
const JOB_NEW = "eeee0000-0000-4000-8000-000000000003";
const JOB_FAILED = "eeee0000-0000-4000-8000-000000000004";
const JOB_VIDEO = "eeee0000-0000-4000-8000-000000000005";
const JOB_OTHER_CANVAS = "eeee0000-0000-4000-8000-000000000006";

const ASSET_MATCH = "ffff0000-0000-4000-8000-000000000001";
const ASSET_FOREIGN = "ffff0000-0000-4000-8000-000000000002";
const ASSET_LEGACY = "ffff0000-0000-4000-8000-000000000003";
const ASSET_ARCHIVED = "ffff0000-0000-4000-8000-000000000004";
const ASSET_OTHER_BUCKET = "ffff0000-0000-4000-8000-000000000005";

const BUCKET = "project-assets";
const OTHER_BUCKET = "user-avatars";
const MATCH_PATH = "ws-team/canvas-files/active/pic.png";
const FOREIGN_PATH = "ws-team/canvas-files/active/foreign.png";
const LEGACY_PATH = "ws-team/canvas-files/active/legacy.png";
const ARCHIVED_PATH = "ws-team/canvas-files/archived/old.png";
const TEAM_NAME = "HaHart Canvas Team";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

const ACTIVE_CONTENT = {
  elements: [
    { id: "el-1", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: { "file-1": { id: "file-1", dataURL: "oss://project-assets/x.png" } },
};

type JobRow = {
  id: string;
  created_at: Date;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
};

let db: PGlite;
let pool: TransactionPool;
let repository: CanvasReadRepository;

/** Counts `connect()` calls, so "no SQL for an empty ref list" is observable. */
let connectAttempts = 0;

let teamWorkspaceId = "";
let outsiderPersonalWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function personalWorkspaceIdOf(userId: string): Promise<string> {
  return firstRow(
    (await db.query<{ id: string }>(
      `select id
         from public.workspaces
        where owner_user_id = $1
          and type = 'personal'`,
      [userId],
    )).rows,
  ).id;
}

async function insertProject(options: {
  id: string;
  name: string;
  createdBy: string;
  archivedAt?: string;
  brandKitId?: string;
}): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, brand_kit_id, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [
      options.id,
      teamWorkspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      options.archivedAt ?? null,
      options.brandKitId ?? null,
      "2026-01-01T00:00:00.000Z",
    ],
  );
}

async function insertCanvas(options: {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  content: unknown;
}): Promise<void> {
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      options.id,
      options.projectId,
      options.name,
      true,
      options.createdBy,
      JSON.stringify(options.content),
      4,
    ],
  );
}

/**
 * Jobs carry the OUTSIDER's personal workspace on purpose. A statement that
 * authorised through `background_jobs.workspace_id` would then deny the canvas's
 * own author and every case below would fail — which is what makes the canvas →
 * project path the proven authorization source. `project_id` is left null for the
 * same reason.
 */
async function insertJob(options: {
  id: string;
  canvasId: string;
  status: "succeeded" | "failed";
  jobType: "image_generation" | "video_generation";
  createdAt: string;
  result?: Record<string, unknown> | null;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs (
       id, workspace_id, project_id, canvas_id, queue_name, job_type, status,
       payload, result, created_by, created_at
     )
     values ($1, $2, null, $3, 'ha_hart_jobs', $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      options.id,
      outsiderPersonalWorkspaceId,
      options.canvasId,
      options.jobType,
      options.status,
      JSON.stringify({ prompt: `prompt ${options.id}` }),
      options.result ? JSON.stringify(options.result) : null,
      AUTHOR_ID,
      options.createdAt,
    ],
  );
}

async function insertAsset(options: {
  id: string;
  projectId: string | null;
  bucket: string;
  objectPath: string;
}): Promise<void> {
  await db.query(
    `insert into public.asset_objects (
       id, workspace_id, project_id, bucket, object_path, mime_type, byte_size, created_by
     )
     values ($1, $2, $3, $4, $5, 'image/png', 1234, $6)`,
    [
      options.id,
      teamWorkspaceId,
      options.projectId,
      options.bucket,
      options.objectPath,
      AUTHOR_ID,
    ],
  );
}

const RESULT_OLD = {
  object_path: "ws-team/generated/old.png",
  width: 512,
  height: 512,
  mime_type: "image/png",
};

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Real signup path for every identity: the auth.users trigger builds profile,
  // personal workspace and the owner membership.
  await createUser(db, AUTHOR_ID, "canvas-author@hahart.test");
  await createUser(db, ADMIN_ID, "canvas-admin@hahart.test");
  await createUser(db, OWNER_ID, "canvas-owner@hahart.test");
  await createUser(db, MEMBER_ID, "canvas-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "canvas-outsider@hahart.test");

  outsiderPersonalWorkspaceId = await personalWorkspaceIdOf(OUTSIDER_ID);

  teamWorkspaceId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.workspaces (type, name, owner_user_id)
       values ('team', $1, $2)
       returning id`,
      [TEAM_NAME, OWNER_ID],
    )).rows,
  ).id;

  // AUTHOR is an ordinary member, ADMIN an admin, OWNER the owner. OUTSIDER is a
  // complete user with no team membership at all — and still owns a project and a
  // canvas inside this workspace below, so "not a member" is proven by the SQL
  // rather than by the absence of data.
  for (const [userId, role] of [
    [AUTHOR_ID, "member"],
    [ADMIN_ID, "admin"],
    [OWNER_ID, "owner"],
    [MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  await insertProject({ id: ACTIVE_PROJECT, name: "Active", createdBy: AUTHOR_ID });
  await insertProject({ id: ADMIN_PROJECT, name: "Admin own", createdBy: ADMIN_ID });
  await insertProject({ id: MEMBER_PROJECT, name: "Member own", createdBy: MEMBER_ID });
  await insertProject({
    id: ARCHIVED_PROJECT,
    name: "Archived",
    createdBy: AUTHOR_ID,
    archivedAt: ARCHIVED_AT,
  });
  await insertProject({
    id: OUTSIDER_PROJECT,
    name: "Outsider own",
    createdBy: OUTSIDER_ID,
  });

  // One project carries a brand kit, so "the project HAS a kit" is a case of its
  // own rather than a shape the fixture can never produce.
  await db.query(
    `insert into public.brand_kits (id, user_id, name, is_default)
     values ($1, $2, 'Canvas Team Kit', true)`,
    [BRAND_KIT_ID, AUTHOR_ID],
  );
  await insertProject({
    id: BRANDED_PROJECT,
    name: "Branded",
    createdBy: AUTHOR_ID,
    brandKitId: BRAND_KIT_ID,
  });

  await insertCanvas({
    id: ACTIVE_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Active canvas",
    createdBy: AUTHOR_ID,
    content: ACTIVE_CONTENT,
  });
  await insertCanvas({
    id: ADMIN_CANVAS,
    projectId: ADMIN_PROJECT,
    name: "Admin canvas",
    createdBy: ADMIN_ID,
    content: { elements: [], appState: {} },
  });
  await insertCanvas({
    id: MEMBER_CANVAS,
    projectId: MEMBER_PROJECT,
    name: "Member canvas",
    createdBy: MEMBER_ID,
    content: { elements: [{ id: "el-member" }], appState: {} },
  });
  await insertCanvas({
    id: ARCHIVED_CANVAS,
    projectId: ARCHIVED_PROJECT,
    name: "Archived canvas",
    createdBy: AUTHOR_ID,
    content: { elements: [{ id: "el-archived" }], appState: {} },
  });
  await insertCanvas({
    id: OUTSIDER_CANVAS,
    projectId: OUTSIDER_PROJECT,
    name: "Outsider canvas",
    createdBy: OUTSIDER_ID,
    content: { elements: [{ id: "el-outsider" }], appState: {} },
  });
  await insertCanvas({
    id: BRANDED_CANVAS,
    projectId: BRANDED_PROJECT,
    name: "Branded canvas",
    createdBy: AUTHOR_ID,
    content: { elements: [{ id: "el-branded" }], appState: {} },
  });

  await insertJob({
    id: JOB_NEW,
    canvasId: ACTIVE_CANVAS,
    status: "succeeded",
    jobType: "image_generation",
    createdAt: "2026-01-03T00:00:00.000Z",
    result: { ...RESULT_OLD, object_path: "ws-team/generated/new.png" },
  });
  await insertJob({
    id: JOB_OLD,
    canvasId: ACTIVE_CANVAS,
    status: "succeeded",
    jobType: "image_generation",
    createdAt: "2026-01-01T00:00:00.000Z",
    result: RESULT_OLD,
  });
  await insertJob({
    id: JOB_MID,
    canvasId: ACTIVE_CANVAS,
    status: "succeeded",
    jobType: "image_generation",
    createdAt: "2026-01-02T00:00:00.000Z",
    result: { ...RESULT_OLD, object_path: "ws-team/generated/mid.png" },
  });
  await insertJob({
    id: JOB_FAILED,
    canvasId: ACTIVE_CANVAS,
    status: "failed",
    jobType: "image_generation",
    createdAt: "2026-01-04T00:00:00.000Z",
    result: null,
  });
  await insertJob({
    id: JOB_VIDEO,
    canvasId: ACTIVE_CANVAS,
    status: "succeeded",
    jobType: "video_generation",
    createdAt: "2026-01-05T00:00:00.000Z",
    result: { object_path: "ws-team/generated/clip.mp4" },
  });
  await insertJob({
    id: JOB_OTHER_CANVAS,
    canvasId: MEMBER_CANVAS,
    status: "succeeded",
    jobType: "image_generation",
    createdAt: "2026-01-06T00:00:00.000Z",
    result: { ...RESULT_OLD, object_path: "ws-team/generated/other.png" },
  });

  await insertAsset({
    id: ASSET_MATCH,
    projectId: ACTIVE_PROJECT,
    bucket: BUCKET,
    objectPath: MATCH_PATH,
  });
  await insertAsset({
    id: ASSET_FOREIGN,
    projectId: ADMIN_PROJECT,
    bucket: BUCKET,
    objectPath: FOREIGN_PATH,
  });
  await insertAsset({
    id: ASSET_LEGACY,
    projectId: null,
    bucket: BUCKET,
    objectPath: LEGACY_PATH,
  });
  await insertAsset({
    id: ASSET_ARCHIVED,
    projectId: ARCHIVED_PROJECT,
    bucket: BUCKET,
    objectPath: ARCHIVED_PATH,
  });
  // Same path as ASSET_MATCH in another bucket: the pair, not the path, is the
  // identity.
  await insertAsset({
    id: ASSET_OTHER_BUCKET,
    projectId: ACTIVE_PROJECT,
    bucket: OTHER_BUCKET,
    objectPath: MATCH_PATH,
  });

  const pglitePool = createPGliteTransactionPool(db);
  connectAttempts = 0;
  pool = {
    async connect() {
      connectAttempts += 1;
      return pglitePool.connect();
    },
  };
  repository = createCanvasReadRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canvas-read-repository: PGlite real SQL ACL", () => {
  it("case 1: the author reads their own active canvas content, mapped from the real jsonb column", async () => {
    const found = await repository.findReadableCanvasContent({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });

    expect(found).toEqual({ content: ACTIVE_CONTENT });

    // The bytes really are in the table, not reconstructed by the mapper.
    const stored = firstRow(
      (await db.query<{ content: unknown }>(
        `select content from public.canvases where id = $1`,
        [ACTIVE_CANVAS],
      )).rows,
    );
    expect(stored.content).toEqual(ACTIVE_CONTENT);
  });

  it("case 2: admin and owner read a canvas of someone else's project, an ordinary member and a non-member do not", async () => {
    const asAdmin = await repository.findReadableCanvasContent({
      actorId: ADMIN_ID,
      canvasId: ACTIVE_CANVAS,
    });
    const asOwner = await repository.findReadableCanvasContent({
      actorId: OWNER_ID,
      canvasId: ACTIVE_CANVAS,
    });
    expect(asAdmin).toEqual({ content: ACTIVE_CONTENT });
    expect(asOwner).toEqual({ content: ACTIVE_CONTENT });

    // A plain member is not the author: nothing, not even a redacted row.
    await expect(
      repository.findReadableCanvasContent({
        actorId: MEMBER_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.toBeNull();

    // The outsider owns a canvas in this very workspace and is still refused.
    expect(
      firstRow(
        (await db.query<{ id: string }>(
          `select id from public.canvases where id = $1`,
          [OUTSIDER_CANVAS],
        )).rows,
      ).id,
    ).toBe(OUTSIDER_CANVAS);
    await expect(
      repository.findReadableCanvasContent({
        actorId: OUTSIDER_ID,
        canvasId: OUTSIDER_CANVAS,
      }),
    ).resolves.toBeNull();

    // The same member reading their own canvas is allowed.
    expect(
      (
        await repository.findReadableCanvasContent({
          actorId: MEMBER_ID,
          canvasId: MEMBER_CANVAS,
        })
      )?.content,
    ).toEqual({ elements: [{ id: "el-member" }], appState: {} });
  });

  it("case 3: an archived project's canvas and a missing canvas are both null", async () => {
    const stored = firstRow(
      (await db.query<{ archived_at: Date | null }>(
        `select archived_at from public.projects where id = $1`,
        [ARCHIVED_PROJECT],
      )).rows,
    );
    expect(stored.archived_at).not.toBeNull();

    await expect(
      repository.findReadableCanvasContent({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableCanvasContent({
        actorId: ADMIN_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.findReadableCanvasContent({
        actorId: AUTHOR_ID,
        canvasId: MISSING_CANVAS,
      }),
    ).resolves.toBeNull();
  });

  it("case 4: the job list is this canvas's succeeded image jobs, oldest first, and nothing else", async () => {
    const jobs = await repository.listReadableSucceededImageJobs({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });

    expect(jobs.map((job) => job.id)).toEqual([JOB_OLD, JOB_MID, JOB_NEW]);
    expect(jobs.map((job) => job.created_at)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
    expect(jobs[0]?.payload).toEqual({ prompt: `prompt ${JOB_OLD}` });
    expect(jobs[0]?.result).toMatchObject({ object_path: RESULT_OLD.object_path });

    // The rows that must be filtered out really exist.
    const all = await db.query<JobRow>(
      `select id from public.background_jobs where canvas_id = $1 order by created_at asc`,
      [ACTIVE_CANVAS],
    );
    expect(all.rows.map((row) => row.id)).toEqual([
      JOB_OLD,
      JOB_MID,
      JOB_NEW,
      JOB_FAILED,
      JOB_VIDEO,
    ]);
  });

  it("case 5: the job list inherits the canvas's project ACL, not the job's own workspace", async () => {
    const asAdmin = await repository.listReadableSucceededImageJobs({
      actorId: ADMIN_ID,
      canvasId: ACTIVE_CANVAS,
    });
    expect(asAdmin.map((job) => job.id)).toEqual([JOB_OLD, JOB_MID, JOB_NEW]);

    await expect(
      repository.listReadableSucceededImageJobs({
        actorId: MEMBER_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listReadableSucceededImageJobs({
        actorId: OUTSIDER_ID,
        canvasId: ACTIVE_CANVAS,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listReadableSucceededImageJobs({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toEqual([]);

    // The member's own canvas still answers for the member.
    expect(
      (
        await repository.listReadableSucceededImageJobs({
          actorId: MEMBER_ID,
          canvasId: MEMBER_CANVAS,
        })
      ).map((job) => job.id),
    ).toEqual([JOB_OTHER_CANVAS]);
  });

  it("case 6: assets come back for the exact pair of the canvas's own project, and never by path alone", async () => {
    const refs = [
      { bucket: BUCKET, objectPath: MATCH_PATH },
      { bucket: BUCKET, objectPath: FOREIGN_PATH },
      { bucket: BUCKET, objectPath: LEGACY_PATH },
      { bucket: OTHER_BUCKET, objectPath: MATCH_PATH },
    ];

    const rows = await repository.listReadableCanvasAssets({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
      refs,
    });

    // Only objects that belong to THIS canvas's project answer: the
    // foreign-project row and the legacy null-project row are real rows that
    // must stay out. The same PATH in another bucket is a different object, so
    // the two rows below answer their own pairs and never each other's.
    expect(rows.map((row) => row.id).sort()).toEqual(
      [ASSET_MATCH, ASSET_OTHER_BUCKET].sort(),
    );

    // With only the project-assets pair requested, the user-avatars row of the
    // same path must not come back — the pair, not the path, is the identity.
    expect(
      await repository.listReadableCanvasAssets({
        actorId: AUTHOR_ID,
        canvasId: ACTIVE_CANVAS,
        refs: [{ bucket: BUCKET, objectPath: MATCH_PATH }],
      }),
    ).toEqual([{ id: ASSET_MATCH, bucket: BUCKET, object_path: MATCH_PATH }]);

    const asAdmin = await repository.listReadableCanvasAssets({
      actorId: ADMIN_ID,
      canvasId: ACTIVE_CANVAS,
      refs,
    });
    expect(asAdmin.map((row) => row.id).sort()).toEqual(
      [ASSET_MATCH, ASSET_OTHER_BUCKET].sort(),
    );

    // The foreign asset is readable where it actually belongs.
    expect(
      (
        await repository.listReadableCanvasAssets({
          actorId: ADMIN_ID,
          canvasId: ADMIN_CANVAS,
          refs: [{ bucket: BUCKET, objectPath: FOREIGN_PATH }],
        })
      ).map((row) => row.id),
    ).toEqual([ASSET_FOREIGN]);

    // An archived project's asset is not returned through its own canvas either.
    await expect(
      repository.listReadableCanvasAssets({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
        refs: [{ bucket: BUCKET, objectPath: ARCHIVED_PATH }],
      }),
    ).resolves.toEqual([]);
  });

  it("case 7: a plain member and a non-member get no asset identities, although the rows exist", async () => {
    const refs = [
      { bucket: BUCKET, objectPath: MATCH_PATH },
      { bucket: OTHER_BUCKET, objectPath: MATCH_PATH },
    ];

    await expect(
      repository.listReadableCanvasAssets({
        actorId: MEMBER_ID,
        canvasId: ACTIVE_CANVAS,
        refs,
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listReadableCanvasAssets({
        actorId: OUTSIDER_ID,
        canvasId: ACTIVE_CANVAS,
        refs,
      }),
    ).resolves.toEqual([]);

    const owners = await repository.listReadableCanvasAssets({
      actorId: OWNER_ID,
      canvasId: ACTIVE_CANVAS,
      refs,
    });
    expect(owners.map((row) => row.id).sort()).toEqual(
      [ASSET_MATCH, ASSET_OTHER_BUCKET].sort(),
    );
  });

  it("case 8: an empty ref list answers [] without opening a connection", async () => {
    connectAttempts = 0;

    const rows = await repository.listReadableCanvasAssets({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
      refs: [],
    });

    expect(rows).toEqual([]);
    expect(connectAttempts).toBe(0);

    // The counter really does observe a read: this one has to open one.
    await repository.findReadableCanvasContent({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });
    expect(connectAttempts).toBe(1);
  });

  it("case 9: an illegal uuid is a real SQL error, wrapped, and the same pool still reads", async () => {
    await expect(
      db.query("select id from public.canvases where id = $1", [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const detail = await repository
      .findReadableCanvasContent({ actorId: AUTHOR_ID, canvasId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(detail).toBeInstanceOf(CanvasReadError);
    expect((detail as CanvasReadError).operation).toBe(
      FIND_READABLE_CANVAS_CONTENT,
    );
    expect((detail as CanvasReadError).message).toBe(
      `canvas read failed (${FIND_READABLE_CANVAS_CONTENT})`,
    );
    expect((detail as CanvasReadError).message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(((detail as CanvasReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // Each of the other two reads reports its own operation for the same class
    // of failure.
    const jobsError = await repository
      .listReadableSucceededImageJobs({
        actorId: AUTHOR_ID,
        canvasId: INVALID_ID,
      })
      .catch((reason: unknown) => reason);
    expect((jobsError as CanvasReadError).operation).toBe(
      LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
    );

    const assetsError = await repository
      .listReadableCanvasAssets({
        actorId: AUTHOR_ID,
        canvasId: INVALID_ID,
        refs: [{ bucket: BUCKET, objectPath: MATCH_PATH }],
      })
      .catch((reason: unknown) => reason);
    expect(assetsError).toBeInstanceOf(CanvasReadError);
    expect((assetsError as CanvasReadError).operation).toBe(
      LIST_READABLE_CANVAS_ASSETS,
    );

    // ROLLBACK plus release left the connection usable for the next read.
    const after = await repository.findReadableCanvasContent({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });
    expect(after).toEqual({ content: ACTIVE_CONTENT });
  });
});

// ---------------------------------------------------------------------------
// Workorder 21R: the canvas → project link.
//
// This is the read the Agent runtime used for the brand kit, for the workspace
// whose skills it loads, and for the project a generation job is authorised
// against. It replaces a read the caller's PostgREST client performed under
// `canvases_select_project_reader` / `private.can_read_project`, so the only
// acceptable answer is the one that policy would have given — including for an
// ARCHIVED project, which is why this read has no archived filter at all.
//
// Every case below reads the same question TWICE for the same identity:
//
//   (1) through the repository, which is privileged (the database owner bypasses
//       RLS), so the statement's own predicate is the only gate;
//   (2) through `asUser()`, i.e. `set local role authenticated` plus a
//       transaction-local `request.jwt.claim.sub`, running the exact SELECT the
//       removed PostgREST read performed.
//
// The two must be EQUAL for every identity, and equal to the project the canvas
// belongs to or to `null`.
// ---------------------------------------------------------------------------

/**
 * The removed PostgREST read, verbatim as SQL: one column, one key. Under
 * `asUser()` the `canvases_select_project_reader` policy decides which row
 * exists, exactly as PostgREST's own client did; `maybeSingle()` is the
 * `rows[0] ?? null` below.
 */
const SELECT_CANVAS_PROJECT = `select project_id
  from public.canvases
 where id = $1`;

async function viaRepository(
  actorId: string,
  canvasId: string,
): Promise<CanvasProjectLinkRow | null> {
  return repository.findReadableCanvasProjectLink({ actorId, canvasId });
}

async function viaRls(
  actorId: string,
  canvasId: string,
): Promise<string | null> {
  const result = await asUser(db, actorId, (tx) =>
    tx.query<{ project_id: string }>(SELECT_CANVAS_PROJECT, [canvasId]),
  );

  return result.rows[0]?.project_id ?? null;
}

/**
 * The comparison this file exists for. Both reads are performed for ONE identity
 * on ONE canvas and each is asserted against the expected answer AND against the
 * other, so a disagreement is reported as a disagreement rather than as two
 * independent mismatches.
 */
async function expectBothReads(
  actorId: string,
  canvasId: string,
  expectedProjectId: string | null,
): Promise<void> {
  const byRepository = await viaRepository(actorId, canvasId);
  const byRls = await viaRls(actorId, canvasId);

  expect(byRls).toBe(expectedProjectId);
  expect(byRepository?.project_id ?? null).toBe(expectedProjectId);
  expect(byRepository?.project_id ?? null).toBe(byRls);

  if (byRepository) {
    // The link carries the workspace the skill read is keyed by, and it is the
    // project's own workspace — never the caller's personal one (Q1).
    expect(byRepository.workspace_id).toBe(teamWorkspaceId);
  }
}

/** A canvas and the project it belongs to, as the fixture really holds them. */
async function storedProjectOf(canvasId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ project_id: string }>(
        "select project_id from public.canvases where id = $1",
        [canvasId],
      )
    ).rows,
  ).project_id;
}

describe("canvas-read-repository: canvas → project link (workorder 21R)", () => {
  it("case 10: the author reads their own project's link, with a null brand kit", async () => {
    const link = await viaRepository(AUTHOR_ID, ACTIVE_CANVAS);

    expect(link).toEqual({
      project_id: ACTIVE_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
    // The row really is in the table under that project.
    expect(await storedProjectOf(ACTIVE_CANVAS)).toBe(ACTIVE_PROJECT);
  });

  it("case 11: a project that HAS a brand kit answers with that kit id", async () => {
    const link = await viaRepository(AUTHOR_ID, BRANDED_CANVAS);

    expect(link).toEqual({
      project_id: BRANDED_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: BRAND_KIT_ID,
    });

    // The kit id is the PROJECT's column, not reconstructed by the mapper.
    const stored = firstRow(
      (
        await db.query<{ brand_kit_id: string | null }>(
          "select brand_kit_id from public.projects where id = $1",
          [BRANDED_PROJECT],
        )
      ).rows,
    );
    expect(stored.brand_kit_id).toBe(BRAND_KIT_ID);
  });

  it("case 12: a same-workspace admin reads the link of another author's canvas", async () => {
    expect(await viaRepository(ADMIN_ID, ACTIVE_CANVAS)).toEqual({
      project_id: ACTIVE_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
    // And the admin reads the branded one with its kit, so the widening carries
    // the whole row rather than a redacted project id.
    expect((await viaRepository(ADMIN_ID, BRANDED_CANVAS))?.brand_kit_id).toBe(
      BRAND_KIT_ID,
    );
  });

  it("case 13: the workspace owner reads the link of another author's canvas", async () => {
    expect(await viaRepository(OWNER_ID, ACTIVE_CANVAS)).toEqual({
      project_id: ACTIVE_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
  });

  it("case 14: an ordinary member is refused another author's canvas and allowed their own", async () => {
    // Not the author, role `member`: the admin/owner branch does not apply.
    await expect(viaRepository(MEMBER_ID, ACTIVE_CANVAS)).resolves.toBeNull();

    // Their own canvas still answers — the refusal above is the author clause,
    // not a blanket denial of ordinary members.
    expect(await viaRepository(MEMBER_ID, MEMBER_CANVAS)).toEqual({
      project_id: MEMBER_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
  });

  it("case 15: an author who is NOT a workspace member is refused their own project", async () => {
    // The fixture's sharpest boundary: OUTSIDER_ID owns OUTSIDER_PROJECT and its
    // canvas inside this very workspace, but has no `workspace_members` row. The
    // read ACL is `created_by = me AND I am a member`, so authorship alone is not
    // enough — reading it as "author OR admin" would leak here.
    expect(await storedProjectOf(OUTSIDER_CANVAS)).toBe(OUTSIDER_PROJECT);
    expect(
      firstRow(
        (
          await db.query<{ n: number }>(
            `select count(*)::int as n from public.workspace_members
              where workspace_id = $1 and user_id = $2`,
            [teamWorkspaceId, OUTSIDER_ID],
          )
        ).rows,
      ).n,
    ).toBe(0);

    await expect(viaRepository(OUTSIDER_ID, OUTSIDER_CANVAS)).resolves.toBeNull();
    await expect(viaRls(OUTSIDER_ID, OUTSIDER_CANVAS)).resolves.toBeNull();
  });

  it("case 16: ★ an ARCHIVED project's canvas still resolves — the point of this read", async () => {
    // The project really is archived, and the CONTENT read really does refuse it
    // (that filter is deliberate too, and belongs to that read alone).
    const archived = firstRow(
      (
        await db.query<{ archived_at: Date | null }>(
          "select archived_at from public.projects where id = $1",
          [ARCHIVED_PROJECT],
        )
      ).rows,
    );
    expect(archived.archived_at).not.toBeNull();
    await expect(
      repository.findReadableCanvasContent({
        actorId: AUTHOR_ID,
        canvasId: ARCHIVED_CANVAS,
      }),
    ).resolves.toBeNull();

    // The link read must NOT follow it: the brand kit and the workspace skills
    // of an archived project's canvas have to keep resolving, and a generation
    // submitted from it must not be refused before credits are charged.
    expect(await viaRepository(AUTHOR_ID, ARCHIVED_CANVAS)).toEqual({
      project_id: ARCHIVED_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
    // An admin reads it too, and the policy agrees with both.
    expect((await viaRepository(ADMIN_ID, ARCHIVED_CANVAS))?.project_id).toBe(
      ARCHIVED_PROJECT,
    );
    await expectBothReads(AUTHOR_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    await expectBothReads(ADMIN_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    await expectBothReads(OWNER_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    await expectBothReads(MEMBER_ID, ARCHIVED_CANVAS, null);
    await expectBothReads(OUTSIDER_ID, ARCHIVED_CANVAS, null);
  });

  it("case 17: a well-formed uuid with no canvas is null, not an error", async () => {
    for (const actorId of [AUTHOR_ID, ADMIN_ID, OWNER_ID, MEMBER_ID, OUTSIDER_ID]) {
      await expect(viaRepository(actorId, MISSING_CANVAS)).resolves.toBeNull();
    }
    await expect(viaRls(AUTHOR_ID, MISSING_CANVAS)).resolves.toBeNull();
  });

  it("case 18: an illegal uuid is a real SQL error, wrapped, and the same pool reads on", async () => {
    await expect(
      db.query("select project_id from public.canvases where id = $1", [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const detail = await viaRepository(AUTHOR_ID, INVALID_ID).catch(
      (reason: unknown) => reason,
    );

    expect(detail).toBeInstanceOf(CanvasReadError);
    expect((detail as CanvasReadError).operation).toBe(
      FIND_READABLE_CANVAS_PROJECT_LINK,
    );
    expect((detail as CanvasReadError).message).toBe(
      `canvas read failed (${FIND_READABLE_CANVAS_PROJECT_LINK})`,
    );
    expect((detail as CanvasReadError).message).not.toMatch(
      /select|public\.|join|archived|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(((detail as CanvasReadError).cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // ROLLBACK plus release left the connection usable for the next read, and
    // the fixture was not modified by the failed one.
    await expect(viaRepository(AUTHOR_ID, ACTIVE_CANVAS)).resolves.toEqual({
      project_id: ACTIVE_PROJECT,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
  });

  it("case 19: one call issues exactly one domain statement, privileged for the actor, and leaves no context behind", async () => {
    const seen: string[] = [];
    let connects = 0;
    const observingPool: TransactionPool = {
      async connect() {
        connects += 1;
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            if (sql.includes("public.canvases")) seen.push(sql);
            return inner.query(sql, params);
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createCanvasReadRepository({
      getTransactionPool: () => observingPool,
    });

    const link = await observing.findReadableCanvasProjectLink({
      actorId: AUTHOR_ID,
      canvasId: ACTIVE_CANVAS,
    });

    expect(link?.project_id).toBe(ACTIVE_PROJECT);
    expect(connects).toBe(1);
    // One statement, and it is the link read — not a membership probe followed
    // by a second statement.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("public.workspace_members");

    // The transaction-local actor does not survive the call.
    const gone = firstRow(
      (
        await db.query<{ user_id: boolean }>(
          `select nullif(current_setting('app.user_id', true), '') is null as user_id`,
        )
      ).rows,
    );
    expect(gone.user_id).toBe(true);

    // And the next read is still its own caller's.
    await expect(viaRepository(OUTSIDER_ID, ACTIVE_CANVAS)).resolves.toBeNull();
  });

  // ── the identity matrix: repository vs `can_read_project` ──
  //
  // Five identities x five canvases, each cell read twice. The expectations are
  // stated here once and then walked, so a cell cannot be quietly dropped.

  it("case 20: the author agrees with the policy on all five canvases", async () => {
    await expectBothReads(AUTHOR_ID, ACTIVE_CANVAS, ACTIVE_PROJECT);
    await expectBothReads(AUTHOR_ID, ADMIN_CANVAS, null);
    await expectBothReads(AUTHOR_ID, MEMBER_CANVAS, null);
    await expectBothReads(AUTHOR_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    await expectBothReads(AUTHOR_ID, OUTSIDER_CANVAS, null);
    await expectBothReads(AUTHOR_ID, BRANDED_CANVAS, BRANDED_PROJECT);
  });

  it("case 21: the admin agrees with the policy on all five canvases — every project of the workspace", async () => {
    await expectBothReads(ADMIN_ID, ACTIVE_CANVAS, ACTIVE_PROJECT);
    await expectBothReads(ADMIN_ID, ADMIN_CANVAS, ADMIN_PROJECT);
    await expectBothReads(ADMIN_ID, MEMBER_CANVAS, MEMBER_PROJECT);
    await expectBothReads(ADMIN_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    // Including a project whose author is not a member at all: the admin/owner
    // branch does not consult the author.
    await expectBothReads(ADMIN_ID, OUTSIDER_CANVAS, OUTSIDER_PROJECT);
    await expectBothReads(ADMIN_ID, BRANDED_CANVAS, BRANDED_PROJECT);
  });

  it("case 22: the owner agrees with the policy on all five canvases", async () => {
    await expectBothReads(OWNER_ID, ACTIVE_CANVAS, ACTIVE_PROJECT);
    await expectBothReads(OWNER_ID, ADMIN_CANVAS, ADMIN_PROJECT);
    await expectBothReads(OWNER_ID, MEMBER_CANVAS, MEMBER_PROJECT);
    await expectBothReads(OWNER_ID, ARCHIVED_CANVAS, ARCHIVED_PROJECT);
    await expectBothReads(OWNER_ID, OUTSIDER_CANVAS, OUTSIDER_PROJECT);
    await expectBothReads(OWNER_ID, BRANDED_CANVAS, BRANDED_PROJECT);
  });

  it("case 23: the ordinary member agrees with the policy — only their own project", async () => {
    await expectBothReads(MEMBER_ID, ACTIVE_CANVAS, null);
    await expectBothReads(MEMBER_ID, ADMIN_CANVAS, null);
    await expectBothReads(MEMBER_ID, MEMBER_CANVAS, MEMBER_PROJECT);
    await expectBothReads(MEMBER_ID, ARCHIVED_CANVAS, null);
    await expectBothReads(MEMBER_ID, OUTSIDER_CANVAS, null);
    // An archived project is equally invisible to a plain member who is not its
    // author — dropping the archived filter must not become a widening.
    await expectBothReads(MEMBER_ID, BRANDED_CANVAS, null);
  });

  it("case 24: the non-member agrees with the policy — nothing, not even their own project", async () => {
    await expectBothReads(OUTSIDER_ID, ACTIVE_CANVAS, null);
    await expectBothReads(OUTSIDER_ID, ADMIN_CANVAS, null);
    await expectBothReads(OUTSIDER_ID, MEMBER_CANVAS, null);
    await expectBothReads(OUTSIDER_ID, ARCHIVED_CANVAS, null);
    // The sharpest cell of the matrix: the project IS theirs and is still
    // refused, because the membership join is not optional.
    expect(await storedProjectOf(OUTSIDER_CANVAS)).toBe(OUTSIDER_PROJECT);
    await expectBothReads(OUTSIDER_ID, OUTSIDER_CANVAS, null);
    await expectBothReads(OUTSIDER_ID, BRANDED_CANVAS, null);
  });
});
