import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AssetReadError,
  FIND_READABLE_ASSET,
  createAssetReadRepository,
  type AssetReadListRepository,
} from "../../db/asset-read-repository.js";
import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the asset read repository (workorder 20E,
 * ADR-0001 migration step 2e).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statement enforces the ACL on a real PostgreSQL parser and planner:
 * the membership join, both ownership branches (`project_id` set and null), the
 * absence of an archive filter, and the rollback path.
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

const PROJECT = "cccc0000-0000-4000-8000-000000000001";
const ARCHIVED_PROJECT = "cccc0000-0000-4000-8000-000000000002";
const MEMBER_PROJECT = "cccc0000-0000-4000-8000-000000000003";

const PROJECT_ASSET = "dddd0000-0000-4000-8000-000000000001";
const ARCHIVED_ASSET = "dddd0000-0000-4000-8000-000000000002";
const MEMBER_PROJECT_ASSET = "dddd0000-0000-4000-8000-000000000003";
const MEMBER_LOOSE_ASSET = "dddd0000-0000-4000-8000-000000000004";
const ADMIN_LOOSE_ASSET = "dddd0000-0000-4000-8000-000000000005";
const OUTSIDER_LOOSE_ASSET = "dddd0000-0000-4000-8000-000000000006";
const NULLABLE_LOOSE_ASSET = "dddd0000-0000-4000-8000-000000000007";
const PERSONAL_LOOSE_ASSET = "dddd0000-0000-4000-8000-000000000008";

// AS-06 (workorder 34N) fixtures: three uploads of PROJECT with created_at one
// minute apart, one generated row that belongs to the generation history, one
// upload in ANOTHER project, and one row per media kind in that other project.
const UPLOAD_OLDEST = "eeee0000-0000-4000-8000-000000000001";
const UPLOAD_MIDDLE = "eeee0000-0000-4000-8000-000000000002";
const UPLOAD_NEWEST = "eeee0000-0000-4000-8000-000000000003";
const GENERATED_IN_PROJECT = "eeee0000-0000-4000-8000-000000000004";
const UPLOAD_OTHER_PROJECT = "eeee0000-0000-4000-8000-000000000005";
const MEDIA_IMAGE = "eeee0000-0000-4000-8000-000000000006";
const MEDIA_VIDEO = "eeee0000-0000-4000-8000-000000000007";
const MEDIA_PDF = "eeee0000-0000-4000-8000-000000000008";

const TEAM_NAME = "HaHart Team";
const BUCKET = "project-assets";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/** A well-formed uuid no row uses: "no such asset" has to be a null, not an error. */
const UNKNOWN_ASSET = "dddd0000-0000-4000-8000-0000000000ff";

type AssetRow = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: number | null;
  workspace_id: string;
  project_id: string | null;
  created_at: Date;
};

let db: PGlite;
let pool: TransactionPool;
let repository: AssetReadListRepository;

/** Counts `connect()` calls, so "one read is one transaction" is observable. */
let connectAttempts = 0;

let teamWorkspaceId = "";
let authorPersonalWorkspaceId = "";

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
  workspaceId: string;
  name: string;
  createdBy: string;
  archivedAt?: string;
}): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      options.id,
      options.workspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      options.archivedAt ?? null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ],
  );
}

async function insertAsset(options: {
  id: string;
  workspaceId: string;
  projectId: string | null;
  createdBy: string;
  objectPath: string;
  mimeType?: string | null;
  byteSize?: number | null;
}): Promise<void> {
  await db.query(
    `insert into public.asset_objects (
       id, workspace_id, project_id, bucket, object_path, mime_type,
       byte_size, created_by, created_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      options.id,
      options.workspaceId,
      options.projectId,
      BUCKET,
      options.objectPath,
      options.mimeType === undefined ? "image/png" : options.mimeType,
      options.byteSize === undefined ? 4096 : options.byteSize,
      options.createdBy,
      "2026-01-05T06:07:08.900Z",
    ],
  );
}

/**
 * An upload row for the AS-06 fixtures (workorder 34N).
 *
 * `insertAsset` predates `source` (33F) and `display_name` (33X) and its eight
 * existing calls are left exactly as they are: this helper writes the columns
 * the upload list filters on, and takes `created_at` so the two orderings can be
 * told apart without relying on insertion order or the clock.
 */
async function insertUpload(options: {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  displayName: string;
  mimeType?: string;
  source?: string;
}): Promise<void> {
  await db.query(
    `insert into public.asset_objects (
       id, workspace_id, project_id, bucket, object_path, mime_type,
       byte_size, created_by, created_at, source, display_name
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      options.id,
      teamWorkspaceId,
      options.projectId,
      BUCKET,
      `${teamWorkspaceId}/${options.projectId}/${options.displayName}`,
      options.mimeType === undefined ? "image/png" : options.mimeType,
      4096,
      options.createdBy,
      options.createdAt,
      options.source === undefined ? "user_upload" : options.source,
      options.displayName,
    ],
  );
}

async function assetRows(ids: readonly string[]): Promise<AssetRow[]> {
  const result = await db.query<AssetRow>(
    `select id, bucket, object_path, mime_type, byte_size, workspace_id,
            project_id, created_at
       from public.asset_objects
      where id = any($1::uuid[])`,
    [[...ids]],
  );

  return [...result.rows].sort((left, right) => left.id.localeCompare(right.id));
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Real signup path for every identity: the auth.users trigger builds profile,
  // personal workspace and the owner membership.
  await createUser(db, AUTHOR_ID, "author@hahart.test");
  await createUser(db, ADMIN_ID, "admin@hahart.test");
  await createUser(db, OWNER_ID, "owner@hahart.test");
  await createUser(db, MEMBER_ID, "member@hahart.test");
  await createUser(db, OUTSIDER_ID, "outsider@hahart.test");

  authorPersonalWorkspaceId = await personalWorkspaceIdOf(AUTHOR_ID);

  teamWorkspaceId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.workspaces (type, name, owner_user_id)
       values ('team', $1, $2)
       returning id`,
      [TEAM_NAME, OWNER_ID],
    )).rows,
  ).id;

  // AUTHOR and MEMBER are ordinary members, ADMIN an admin, OWNER the owner.
  // OUTSIDER is a complete user with no team membership at all — and still owns
  // an asset row in the team workspace below, so "not a member" is proven by the
  // SQL rather than by the absence of data.
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

  await insertProject({
    id: PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Authored",
    createdBy: AUTHOR_ID,
  });
  await insertProject({
    id: ARCHIVED_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Archived",
    createdBy: AUTHOR_ID,
    archivedAt: ARCHIVED_AT,
  });
  await insertProject({
    id: MEMBER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Member authored",
    createdBy: MEMBER_ID,
  });

  await insertAsset({
    id: PROJECT_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: PROJECT,
    createdBy: AUTHOR_ID,
    objectPath: `${teamWorkspaceId}/${PROJECT}/photo.png`,
  });
  await insertAsset({
    id: ARCHIVED_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: ARCHIVED_PROJECT,
    createdBy: AUTHOR_ID,
    objectPath: `${teamWorkspaceId}/${ARCHIVED_PROJECT}/photo.png`,
  });
  await insertAsset({
    id: MEMBER_PROJECT_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: MEMBER_PROJECT,
    createdBy: MEMBER_ID,
    objectPath: `${teamWorkspaceId}/${MEMBER_PROJECT}/photo.png`,
  });
  await insertAsset({
    id: MEMBER_LOOSE_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: MEMBER_ID,
    objectPath: `${teamWorkspaceId}/loose-member.png`,
  });
  await insertAsset({
    id: ADMIN_LOOSE_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: ADMIN_ID,
    objectPath: `${teamWorkspaceId}/loose-admin.png`,
  });
  await insertAsset({
    id: OUTSIDER_LOOSE_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: OUTSIDER_ID,
    objectPath: `${teamWorkspaceId}/loose-outsider.png`,
  });
  await insertAsset({
    id: NULLABLE_LOOSE_ASSET,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: MEMBER_ID,
    objectPath: `${teamWorkspaceId}/loose-nullable.png`,
    mimeType: null,
    byteSize: null,
  });
  await insertAsset({
    id: PERSONAL_LOOSE_ASSET,
    workspaceId: authorPersonalWorkspaceId,
    projectId: null,
    createdBy: AUTHOR_ID,
    objectPath: `${authorPersonalWorkspaceId}/loose-personal.png`,
  });

  // AS-06 fixtures: three real uploads of PROJECT, created one minute apart, so
  // "newest first" and "oldest first" are two different orders of the same rows.
  await insertUpload({
    id: UPLOAD_OLDEST,
    projectId: PROJECT,
    createdBy: AUTHOR_ID,
    createdAt: "2026-02-01T00:00:00.000Z",
    displayName: "first-upload.png",
  });
  await insertUpload({
    id: UPLOAD_MIDDLE,
    projectId: PROJECT,
    createdBy: AUTHOR_ID,
    createdAt: "2026-02-01T00:01:00.000Z",
    displayName: "second-upload.png",
  });
  await insertUpload({
    id: UPLOAD_NEWEST,
    projectId: PROJECT,
    createdBy: AUTHOR_ID,
    createdAt: "2026-02-01T00:02:00.000Z",
    displayName: "third-upload.png",
  });
  // Same project, but not an upload: a generated row must stay out of the list.
  await insertUpload({
    id: GENERATED_IN_PROJECT,
    projectId: PROJECT,
    createdBy: AUTHOR_ID,
    createdAt: "2026-02-01T00:03:00.000Z",
    displayName: "generated.png",
    source: "generator",
  });
  // A real upload of ANOTHER project, and one row per media kind there, so the
  // project filter and the media filter are each proven on rows that exist.
  await insertUpload({
    id: UPLOAD_OTHER_PROJECT,
    projectId: MEMBER_PROJECT,
    createdBy: MEMBER_ID,
    createdAt: "2026-02-03T00:00:00.000Z",
    displayName: "other-project.png",
  });
  await insertUpload({
    id: MEDIA_IMAGE,
    projectId: MEMBER_PROJECT,
    createdBy: MEMBER_ID,
    createdAt: "2026-02-04T00:00:00.000Z",
    displayName: "media-photo.png",
    mimeType: "image/png",
  });
  await insertUpload({
    id: MEDIA_VIDEO,
    projectId: MEMBER_PROJECT,
    createdBy: MEMBER_ID,
    createdAt: "2026-02-04T00:01:00.000Z",
    displayName: "clip.mp4",
    mimeType: "video/mp4",
  });
  await insertUpload({
    id: MEDIA_PDF,
    projectId: MEMBER_PROJECT,
    createdBy: MEMBER_ID,
    createdAt: "2026-02-04T00:02:00.000Z",
    displayName: "brief.pdf",
    mimeType: "application/pdf",
  });

  const pglitePool = createPGliteTransactionPool(db);
  connectAttempts = 0;
  pool = {
    async connect() {
      connectAttempts += 1;
      return pglitePool.connect();
    },
  };
  repository = createAssetReadRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("asset-read-repository: PGlite real SQL ACL", () => {
  it("case 1: the author reads their own project's asset, mapped from real columns", async () => {
    connectAttempts = 0;

    const asset = await repository.findReadableAsset({
      actorId: AUTHOR_ID,
      assetId: PROJECT_ASSET,
    });

    expect(asset).toEqual({
      id: PROJECT_ASSET,
      bucket: BUCKET,
      object_path: `${teamWorkspaceId}/${PROJECT}/photo.png`,
      mime_type: "image/png",
      byte_size: 4096,
      workspace_id: teamWorkspaceId,
      project_id: PROJECT,
      created_at: "2026-01-05T06:07:08.900Z",
    });
    expect(connectAttempts).toBe(1);

    // The uuid and the size really are what PostgreSQL stored, not a formatted
    // copy. PGlite hands `byte_size` (bigint) back as a number; `pg` hands back a
    // decimal string, which is why the repository accepts both (unit case 4).
    const stored = firstRow(await assetRows([PROJECT_ASSET]));
    expect(stored.workspace_id).toBe(asset?.workspace_id);
    expect(stored.project_id).toBe(PROJECT);
    expect(typeof stored.byte_size).toBe("number");
    expect(stored.byte_size).toBe(asset?.byte_size);
  });

  it("case 2: the project branch — author, admin and owner read it, a plain member and a non-member do not", async () => {
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toMatchObject({ id: PROJECT_ASSET });

    // admin/owner read someone else's project asset (PJ-07 read-only widening).
    await expect(
      repository.findReadableAsset({
        actorId: ADMIN_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toMatchObject({ id: PROJECT_ASSET });
    await expect(
      repository.findReadableAsset({
        actorId: OWNER_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toMatchObject({ id: PROJECT_ASSET });

    // A plain member is a member of the workspace and still cannot reach it: the
    // asset inherits the PROJECT's ACL, not the workspace's.
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toBeNull();

    // The non-member owns assets in this very workspace and reaches neither the
    // author's project asset nor their own.
    expect(firstRow(await assetRows([OUTSIDER_LOOSE_ASSET])).id).toBe(
      OUTSIDER_LOOSE_ASSET,
    );
    await expect(
      repository.findReadableAsset({
        actorId: OUTSIDER_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableAsset({
        actorId: OUTSIDER_ID,
        assetId: OUTSIDER_LOOSE_ASSET,
      }),
    ).resolves.toBeNull();

    // The member reading their OWN project's asset is allowed.
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: MEMBER_PROJECT_ASSET,
      }),
    ).resolves.toMatchObject({ id: MEMBER_PROJECT_ASSET });
  });

  it("case 3: the null-project branch — creator, admin and owner read it, another plain member does not", async () => {
    // No project to inherit from: the creator is the owner of the row.
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: MEMBER_LOOSE_ASSET,
      }),
    ).resolves.toMatchObject({ id: MEMBER_LOOSE_ASSET, project_id: null });

    // Another ordinary member of the same workspace is not the creator.
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: MEMBER_LOOSE_ASSET,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.findReadableAsset({
        actorId: ADMIN_ID,
        assetId: MEMBER_LOOSE_ASSET,
      }),
    ).resolves.toMatchObject({ id: MEMBER_LOOSE_ASSET });
    await expect(
      repository.findReadableAsset({
        actorId: OWNER_ID,
        assetId: MEMBER_LOOSE_ASSET,
      }),
    ).resolves.toMatchObject({ id: MEMBER_LOOSE_ASSET });

    // The admin's own loose asset stays readable to the admin, and a plain member
    // cannot reach it.
    await expect(
      repository.findReadableAsset({
        actorId: ADMIN_ID,
        assetId: ADMIN_LOOSE_ASSET,
      }),
    ).resolves.toMatchObject({ id: ADMIN_LOOSE_ASSET });
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: ADMIN_LOOSE_ASSET,
      }),
    ).resolves.toBeNull();
  });

  it("case 4: an archived project does not hide its asset, and does not widen the ACL either", async () => {
    // The project really is archived: the answer comes from the statement, which
    // has no archive clause (the lookup it replaced had none either).
    expect(firstRow(await assetRows([ARCHIVED_ASSET])).project_id).toBe(
      ARCHIVED_PROJECT,
    );
    const archivedProject = firstRow(
      (
        await db.query<{ archived_at: Date | null }>(
          "select archived_at from public.projects where id = $1",
          [ARCHIVED_PROJECT],
        )
      ).rows,
    );
    expect(archivedProject.archived_at).not.toBeNull();

    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: ARCHIVED_ASSET,
      }),
    ).resolves.toMatchObject({ id: ARCHIVED_ASSET });
    await expect(
      repository.findReadableAsset({
        actorId: ADMIN_ID,
        assetId: ARCHIVED_ASSET,
      }),
    ).resolves.toMatchObject({ id: ARCHIVED_ASSET });

    // Dropping the archive clause widened nothing else.
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: ARCHIVED_ASSET,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableAsset({
        actorId: OUTSIDER_ID,
        assetId: ARCHIVED_ASSET,
      }),
    ).resolves.toBeNull();
  });

  it("case 5: a real row with explicit null in every nullable column maps to nulls", async () => {
    const asset = await repository.findReadableAsset({
      actorId: MEMBER_ID,
      assetId: NULLABLE_LOOSE_ASSET,
    });

    expect(asset).toMatchObject({
      id: NULLABLE_LOOSE_ASSET,
      mime_type: null,
      byte_size: null,
      project_id: null,
    });

    // The nulls are the database's, not a mapping artefact.
    const stored = firstRow(await assetRows([NULLABLE_LOOSE_ASSET]));
    expect(stored.mime_type).toBeNull();
    expect(stored.byte_size).toBeNull();
    expect(stored.project_id).toBeNull();
  });

  it("case 6: the read is pinned to the asset's own workspace", async () => {
    // Both rows have no project; one lives in the team workspace, one in the
    // author's personal workspace. Membership decides, and it is checked per row.
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: PERSONAL_LOOSE_ASSET,
      }),
    ).resolves.toMatchObject({
      id: PERSONAL_LOOSE_ASSET,
      workspace_id: authorPersonalWorkspaceId,
    });

    // The team admin is not a member of the author's personal workspace.
    await expect(
      repository.findReadableAsset({
        actorId: ADMIN_ID,
        assetId: PERSONAL_LOOSE_ASSET,
      }),
    ).resolves.toBeNull();
  });

  it("case 7: an unknown id is a null answer, not a failure", async () => {
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: UNKNOWN_ASSET,
      }),
    ).resolves.toBeNull();
  });

  it("case 8: an illegal or empty uuid is a real SQL error, then the same pool still reads", async () => {
    await expect(
      db.query("select id from public.asset_objects where id = $1", [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    for (const badId of [INVALID_ID, ""]) {
      const thrown = await repository
        .findReadableAsset({ actorId: AUTHOR_ID, assetId: badId })
        .catch((reason: unknown) => reason);

      expect(thrown).toBeInstanceOf(AssetReadError);
      const readError = thrown as AssetReadError;
      expect(readError.operation).toBe(FIND_READABLE_ASSET);
      expect(readError.message).toBe(
        `asset read failed (${FIND_READABLE_ASSET})`,
      );
      expect(readError.message).not.toMatch(
        /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
      );
      expect((readError.cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    // ROLLBACK plus release left the connection usable for the next read.
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: PROJECT_ASSET,
      }),
    ).resolves.toMatchObject({ id: PROJECT_ASSET });
  });

  it("case 9: the repository runs its read privileged and still names the actor", async () => {
    const rows = await withPrivilegedTransaction(
      pool,
      { userId: AUTHOR_ID },
      async (client) =>
        (
          await client.query(
            `select
               current_setting('app.user_id', true) as user_id,
               current_setting('app.execution_mode', true) as execution_mode`,
          )
        ).rows,
    );

    expect(rows[0]).toEqual({
      user_id: AUTHOR_ID,
      execution_mode: "privileged",
    });
  });
});

/**
 * AS-06 (workorder 34N): the project upload list on real SQL. Same fixture, same
 * ACL — these five cases prove the list is the project's own UPLOADS (not the
 * project's generated assets, not another project's uploads), in the two orders
 * the drawer offers, filtered by media kind, and readable only by members.
 */
describe("asset-read-repository: PGlite project upload list (AS-06)", () => {
  it("AS-06: uploads of the project come back newest first by default", async () => {
    const rows = await repository.listReadableProjectUploads({
      actorId: AUTHOR_ID,
      projectId: PROJECT,
      order: "newest",
      limit: 50,
    });

    expect(rows.map((row) => row.id)).toEqual([
      UPLOAD_NEWEST,
      UPLOAD_MIDDLE,
      UPLOAD_OLDEST,
    ]);
    // The name is the stored one, not the object key.
    expect(rows.map((row) => row.display_name)).toEqual([
      "third-upload.png",
      "second-upload.png",
      "first-upload.png",
    ]);
    expect(rows[0]?.created_at).toBe("2026-02-01T00:02:00.000Z");
    expect(rows[0]?.project_id).toBe(PROJECT);
    expect(rows[0]?.workspace_id).toBe(teamWorkspaceId);

    // The limit is a bind parameter, and it really limits.
    const two = await repository.listReadableProjectUploads({
      actorId: AUTHOR_ID,
      projectId: PROJECT,
      order: "newest",
      limit: 2,
    });
    expect(two.map((row) => row.id)).toEqual([UPLOAD_NEWEST, UPLOAD_MIDDLE]);
  });

  it("AS-06: oldest first puts the earliest upload on top", async () => {
    const rows = await repository.listReadableProjectUploads({
      actorId: AUTHOR_ID,
      projectId: PROJECT,
      order: "oldest",
      limit: 50,
    });

    expect(rows.map((row) => row.id)).toEqual([
      UPLOAD_OLDEST,
      UPLOAD_MIDDLE,
      UPLOAD_NEWEST,
    ]);
    expect(rows[0]?.display_name).toBe("first-upload.png");
    expect(rows[0]?.created_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("AS-06: generated assets and other projects are not listed", async () => {
    const rows = await repository.listReadableProjectUploads({
      actorId: AUTHOR_ID,
      projectId: PROJECT,
      order: "newest",
      limit: 50,
    });
    const ids = rows.map((row) => row.id);

    expect(ids).not.toContain(GENERATED_IN_PROJECT);
    expect(ids).not.toContain(UPLOAD_OTHER_PROJECT);
    expect(ids).toEqual([UPLOAD_NEWEST, UPLOAD_MIDDLE, UPLOAD_OLDEST]);

    // Both excluded rows exist and are readable one by one: the list is what
    // filters them out, not a missing fixture.
    await expect(
      repository.findReadableAsset({
        actorId: AUTHOR_ID,
        assetId: GENERATED_IN_PROJECT,
      }),
    ).resolves.toMatchObject({ id: GENERATED_IN_PROJECT, project_id: PROJECT });
    await expect(
      repository.findReadableAsset({
        actorId: MEMBER_ID,
        assetId: UPLOAD_OTHER_PROJECT,
      }),
    ).resolves.toMatchObject({
      id: UPLOAD_OTHER_PROJECT,
      project_id: MEMBER_PROJECT,
    });
  });

  it("AS-06: the media filter keeps only that type", async () => {
    const pdf = await repository.listReadableProjectUploads({
      actorId: MEMBER_ID,
      projectId: MEMBER_PROJECT,
      order: "newest",
      mediaType: "pdf",
      limit: 50,
    });
    expect(pdf.map((row) => row.id)).toEqual([MEDIA_PDF]);
    expect(pdf[0]?.display_name).toBe("brief.pdf");
    expect(pdf[0]?.mime_type).toBe("application/pdf");

    const video = await repository.listReadableProjectUploads({
      actorId: MEMBER_ID,
      projectId: MEMBER_PROJECT,
      order: "newest",
      mediaType: "video",
      limit: 50,
    });
    expect(video.map((row) => row.id)).toEqual([MEDIA_VIDEO]);

    const image = await repository.listReadableProjectUploads({
      actorId: MEMBER_ID,
      projectId: MEMBER_PROJECT,
      order: "newest",
      mediaType: "image",
      limit: 50,
    });
    expect(image.map((row) => row.id)).toEqual([
      MEDIA_IMAGE,
      UPLOAD_OTHER_PROJECT,
    ]);
    expect(image.map((row) => row.display_name)).toEqual([
      "media-photo.png",
      "other-project.png",
    ]);

    // Unfiltered, the same project holds all four: the filter narrows, it does
    // not invent or drop rows.
    const all = await repository.listReadableProjectUploads({
      actorId: MEMBER_ID,
      projectId: MEMBER_PROJECT,
      order: "newest",
      limit: 50,
    });
    expect(all.map((row) => row.id)).toEqual([
      MEDIA_PDF,
      MEDIA_VIDEO,
      MEDIA_IMAGE,
      UPLOAD_OTHER_PROJECT,
    ]);
  });

  it("AS-06: a non-member sees nothing", async () => {
    const rows = await repository.listReadableProjectUploads({
      actorId: OUTSIDER_ID,
      projectId: PROJECT,
      order: "newest",
      limit: 50,
    });

    expect(rows).toEqual([]);

    // The same project and the same statement do answer the author: the empty
    // list is the ACL, not an empty table.
    const authored = await repository.listReadableProjectUploads({
      actorId: AUTHOR_ID,
      projectId: PROJECT,
      order: "newest",
      limit: 50,
    });
    expect(authored.length).toBe(3);
  });
});
