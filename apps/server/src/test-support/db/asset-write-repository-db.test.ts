import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DELETE_OWN_ASSET,
  AssetWriteError,
  createAssetWriteRepository,
  type AssetWriteRepository,
} from "../../db/asset-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the asset WRITE repository (workorder 21AA),
 * measured against `asset_objects_delete_self`.
 *
 * A privileged connection bypasses row level security, so the statement's own
 * predicate is the whole authorisation rule. Every identity is therefore measured
 * three ways, exactly as the project write matrix does:
 *
 *   1. through the repository (privileged, the ACL is the statement);
 *   2. through `asUser()` — the pre-migration PostgREST delete replayed as
 *      `delete from public.asset_objects where id = $1`, so the POLICY decides;
 *   3. against the stored rows, which is what both answers must describe.
 *
 * The interesting rows are the ones the policy treats differently:
 *
 *   - no `project_id`: author + membership is the whole rule;
 *   - a `project_id` the author does NOT own: the extra `can_write_project` branch
 *     is what refuses it, even though `created_by` is the caller.
 *
 * PGlite runs in-process: no server, no socket, no `DATABASE_URL`, no host.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000b2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000b3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000b4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000b5";
/** The asset's creator, but no membership row in the asset's workspace. */
const FORMER_MEMBER_ID = "00000000-0000-0000-0000-0000000000b6";

const AUTHOR_PROJECT = "aaaa0000-0000-4000-8000-000000000011";
const MEMBER_PROJECT = "aaaa0000-0000-4000-8000-000000000012";

const ASSET_OWN_NO_PROJECT = "dddd0000-0000-4000-8000-000000000001";
const ASSET_OWN_IN_OWN_PROJECT = "dddd0000-0000-4000-8000-000000000002";
const ASSET_OWN_IN_MEMBER_PROJECT = "dddd0000-0000-4000-8000-000000000003";
const ASSET_MEMBER_NO_PROJECT = "dddd0000-0000-4000-8000-000000000004";
const ASSET_ADMIN_TARGET = "dddd0000-0000-4000-8000-000000000005";
const ASSET_OUTSIDER_NO_PROJECT = "dddd0000-0000-4000-8000-000000000006";
const ASSET_FORMER_NO_PROJECT = "dddd0000-0000-4000-8000-000000000007";
const ASSET_PERSONAL = "dddd0000-0000-4000-8000-000000000008";
const ASSET_POLICY_AGREEMENT = "dddd0000-0000-4000-8000-000000000009";

const BUCKET = "project-assets";
const CREATED_AT = "2026-01-12T10:11:12.500Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";
/** A well-formed uuid no row uses: "no such asset" has to be a zero count. */
const UNKNOWN_ASSET = "dddd0000-0000-4000-8000-0000000000ff";
/** A bind that would be injection if it were ever concatenated into the statement. */
const INJECTION_ID = "' or '1'='1";

type AssetRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: number | null;
  created_by: string | null;
  created_at: Date;
};

type AssetSnapshot = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: number | null;
  created_by: string | null;
  created_at: string;
};

let db: PGlite;
let pool: TransactionPool;
let repository: AssetWriteRepository;

let teamWorkspaceId = "";
let authorPersonalWorkspaceId = "";

function snapshotOf(row: AssetRow): AssetSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    bucket: row.bucket,
    object_path: row.object_path,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    created_by: row.created_by,
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(String(row.created_at)).toISOString(),
  };
}

async function allAssets(): Promise<AssetSnapshot[]> {
  const rows = (
    await db.query<AssetRow>(
      `select id, workspace_id, project_id, bucket, object_path, mime_type,
              byte_size, created_by, created_at
         from public.asset_objects order by id`,
    )
  ).rows;

  return rows.map(snapshotOf);
}

async function assetIds(): Promise<string[]> {
  return (
    await db.query<{ id: string }>(
      "select id from public.asset_objects order by id",
    )
  ).rows.map((row) => row.id);
}

/**
 * Replay the pre-migration PostgREST delete under `asUser()`: the statement carries
 * ONLY the id, so the policy is the entire authorisation.
 */
async function asUserDelete(userId: string, assetId: string): Promise<number> {
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ id: string }>(
      "delete from public.asset_objects where id = $1 returning id",
      [assetId],
    );
    return result.rows.length;
  });
}

async function firstRow<T>(rows: readonly T[]): Promise<T> {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function personalWorkspaceIdOf(userId: string): Promise<string> {
  return (
    await firstRow(
      (
        await db.query<{ id: string }>(
          `select id from public.workspaces
            where owner_user_id = $1 and type = 'personal'`,
          [userId],
        )
      ).rows,
    )
  ).id;
}

async function insertProject(options: {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string;
}): Promise<void> {
  await db.query(
    `insert into public.projects
       (id, workspace_id, name, slug, description, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      options.id,
      options.workspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      "2026-01-01T00:00:00.000Z",
    ],
  );
}

async function insertAsset(options: {
  id: string;
  workspaceId: string;
  projectId: string | null;
  createdBy: string;
  objectPath: string;
}): Promise<void> {
  await db.query(
    `insert into public.asset_objects
       (id, workspace_id, project_id, bucket, object_path, mime_type,
        byte_size, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      options.id,
      options.workspaceId,
      options.projectId,
      BUCKET,
      options.objectPath,
      "image/png",
      4096,
      options.createdBy,
      CREATED_AT,
    ],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createAssetWriteRepository({ getTransactionPool: () => pool });

  await createUser(db, AUTHOR_ID, "asset-write-author@hahart.test");
  await createUser(db, ADMIN_ID, "asset-write-admin@hahart.test");
  await createUser(db, OWNER_ID, "asset-write-owner@hahart.test");
  await createUser(db, MEMBER_ID, "asset-write-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "asset-write-outsider@hahart.test");
  await createUser(db, FORMER_MEMBER_ID, "asset-write-former@hahart.test");

  authorPersonalWorkspaceId = await personalWorkspaceIdOf(AUTHOR_ID);

  teamWorkspaceId = (
    await firstRow(
      (
        await db.query<{ id: string }>(
          `insert into public.workspaces (type, name, owner_user_id)
           values ('team', 'HaHart Team', $1)
           returning id`,
          [OWNER_ID],
        )
      ).rows,
    )
  ).id;

  // AUTHOR is an ordinary member, ADMIN an admin, OWNER the owner. OUTSIDER and
  // FORMER_MEMBER hold no membership row at all — and still own assets, so "not a
  // member" is proven by the SQL rather than by the absence of data.
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
    id: AUTHOR_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Author project",
    createdBy: AUTHOR_ID,
  });
  await insertProject({
    id: MEMBER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Member project",
    createdBy: MEMBER_ID,
  });

  await insertAsset({
    id: ASSET_OWN_NO_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: AUTHOR_ID,
    objectPath: "team/author-no-project.png",
  });
  await insertAsset({
    id: ASSET_OWN_IN_OWN_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: AUTHOR_PROJECT,
    createdBy: AUTHOR_ID,
    objectPath: "team/author-own-project.png",
  });
  // `created_by` is the caller, but the PROJECT is somebody else's: only the
  // `can_write_project` branch refuses this one.
  await insertAsset({
    id: ASSET_OWN_IN_MEMBER_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: MEMBER_PROJECT,
    createdBy: AUTHOR_ID,
    objectPath: "team/author-in-member-project.png",
  });
  await insertAsset({
    id: ASSET_MEMBER_NO_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: MEMBER_ID,
    objectPath: "team/member-no-project.png",
  });
  await insertAsset({
    id: ASSET_ADMIN_TARGET,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: MEMBER_ID,
    objectPath: "team/admin-target.png",
  });
  await insertAsset({
    id: ASSET_OUTSIDER_NO_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: OUTSIDER_ID,
    objectPath: "team/outsider-no-project.png",
  });
  await insertAsset({
    id: ASSET_FORMER_NO_PROJECT,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: FORMER_MEMBER_ID,
    objectPath: "team/former-no-project.png",
  });
  await insertAsset({
    id: ASSET_PERSONAL,
    workspaceId: authorPersonalWorkspaceId,
    projectId: null,
    createdBy: AUTHOR_ID,
    objectPath: "personal/author.png",
  });
  await insertAsset({
    id: ASSET_POLICY_AGREEMENT,
    workspaceId: teamWorkspaceId,
    projectId: null,
    createdBy: AUTHOR_ID,
    objectPath: "team/policy-agreement.png",
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("asset write repository: the author deletes their own row", () => {
  it("case 1: a project-less asset the author created is deleted, and only that row", async () => {
    const before = await assetIds();
    expect(before).toContain(ASSET_OWN_NO_PROJECT);

    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_OWN_NO_PROJECT,
      }),
    ).resolves.toEqual({ deleted: 1 });

    const after = await assetIds();
    expect(after).not.toContain(ASSET_OWN_NO_PROJECT);
    expect(after).toEqual(before.filter((id) => id !== ASSET_OWN_NO_PROJECT));
  });

  it("case 2: an asset attached to the author's OWN project is deleted too", async () => {
    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_OWN_IN_OWN_PROJECT,
      }),
    ).resolves.toEqual({ deleted: 1 });

    expect(await assetIds()).not.toContain(ASSET_OWN_IN_OWN_PROJECT);
  });

  it("case 3: an asset attached to SOMEBODY ELSE's project is refused, even though the author created it", async () => {
    const before = await allAssets();

    // `created_by` is the caller and the workspace membership holds — the only thing
    // that refuses this row is the `can_write_project(project_id)` branch.
    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_OWN_IN_MEMBER_PROJECT,
      }),
    ).resolves.toEqual({ deleted: 0 });

    expect(await allAssets()).toEqual(before);
    expect(await assetIds()).toContain(ASSET_OWN_IN_MEMBER_PROJECT);
  });

  it("case 4: an asset in the author's PERSONAL workspace is deleted (membership there is real)", async () => {
    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_PERSONAL,
      }),
    ).resolves.toEqual({ deleted: 1 });

    expect(await assetIds()).not.toContain(ASSET_PERSONAL);
  });
});

describe("asset write repository: repository and policy answer the same thing", () => {
  it("case 5: the author's delete is one row BOTH through the repository and through the policy", async () => {
    const before = await assetIds();
    expect(before).toContain(ASSET_POLICY_AGREEMENT);

    const viaPolicy = await asUserDelete(AUTHOR_ID, ASSET_POLICY_AGREEMENT);
    const viaRepository = await repository.deleteOwnAsset({
      actorId: AUTHOR_ID,
      assetId: ASSET_POLICY_AGREEMENT,
    });

    expect(viaPolicy).toBe(1);
    // The row is already gone by the time the repository runs: zero rows, and that
    // is still not an error.
    expect(viaRepository.deleted).toBe(0);
    expect(await assetIds()).not.toContain(ASSET_POLICY_AGREEMENT);
  });

  it("case 6: an ordinary member who is not the creator deletes nothing", async () => {
    const before = await allAssets();

    const viaRepository = await repository.deleteOwnAsset({
      actorId: AUTHOR_ID,
      assetId: ASSET_MEMBER_NO_PROJECT,
    });
    const viaPolicy = await asUserDelete(AUTHOR_ID, ASSET_MEMBER_NO_PROJECT);

    expect(viaRepository.deleted).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await allAssets()).toEqual(before);
  });

  it("case 7: the admin can READ the row but neither path deletes it", async () => {
    const before = await allAssets();
    const readable = (
      await asUser(db, ADMIN_ID, async (tx) =>
        tx.query<{ id: string }>(
          "select id from public.asset_objects where id = $1",
          [ASSET_ADMIN_TARGET],
        ),
      )
    ).rows;
    // The refusal below is about DELETING; the admin really can see it.
    expect(readable.map((row) => row.id)).toEqual([ASSET_ADMIN_TARGET]);

    const viaRepository = await repository.deleteOwnAsset({
      actorId: ADMIN_ID,
      assetId: ASSET_ADMIN_TARGET,
    });
    const viaPolicy = await asUserDelete(ADMIN_ID, ASSET_ADMIN_TARGET);

    expect(viaRepository.deleted).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await allAssets()).toEqual(before);
  });

  it("case 8: an outsider — creator but NOT a member — deletes nothing", async () => {
    const before = await allAssets();

    const viaRepository = await repository.deleteOwnAsset({
      actorId: OUTSIDER_ID,
      assetId: ASSET_OUTSIDER_NO_PROJECT,
    });
    const viaPolicy = await asUserDelete(OUTSIDER_ID, ASSET_OUTSIDER_NO_PROJECT);

    // `created_by = auth.uid()` is true and the membership conjunct is false.
    expect(viaRepository.deleted).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await allAssets()).toEqual(before);
  });

  it("case 9: a creator whose membership was removed deletes nothing", async () => {
    const before = await allAssets();

    const viaRepository = await repository.deleteOwnAsset({
      actorId: FORMER_MEMBER_ID,
      assetId: ASSET_FORMER_NO_PROJECT,
    });
    const viaPolicy = await asUserDelete(
      FORMER_MEMBER_ID,
      ASSET_FORMER_NO_PROJECT,
    );

    expect(viaRepository.deleted).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await allAssets()).toEqual(before);
  });

  it("case 10: an unknown asset id is a zero count, not a throw", async () => {
    const before = await allAssets();

    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: UNKNOWN_ASSET,
      }),
    ).resolves.toEqual({ deleted: 0 });

    expect(await allAssets()).toEqual(before);
  });
});

describe("asset write repository: bad binds change nothing", () => {
  it("case 11: a malformed uuid is 22P02, wrapped, and no row moves", async () => {
    const before = await allAssets();

    const calls: Array<() => Promise<unknown>> = [
      () => repository.deleteOwnAsset({ actorId: INVALID_ID, assetId: UNKNOWN_ASSET }),
      () => repository.deleteOwnAsset({ actorId: AUTHOR_ID, assetId: INVALID_ID }),
      () => repository.deleteOwnAsset({ actorId: AUTHOR_ID, assetId: INJECTION_ID }),
      () => repository.deleteOwnAsset({ actorId: INJECTION_ID, assetId: UNKNOWN_ASSET }),
    ];

    for (const call of calls) {
      const error = await call().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AssetWriteError);
      expect((error as AssetWriteError).operation).toBe(DELETE_OWN_ASSET);
      expect(((error as AssetWriteError).cause as { code?: string }).code).toBe(
        "22P02",
      );
      expect((error as AssetWriteError).message).not.toMatch(
        /public\.|created_by|postgres:\/\//i,
      );
    }

    expect(await allAssets()).toEqual(before);
  });

  it("case 12: the pool is usable again after a failed delete (the transaction rolled back)", async () => {
    const error = await repository
      .deleteOwnAsset({ actorId: AUTHOR_ID, assetId: INVALID_ID })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AssetWriteError);

    // A real delete still works on the same pool: the rollback released the session
    // cleanly and no transaction was left open.
    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_OUTSIDER_NO_PROJECT,
      }),
    ).resolves.toEqual({ deleted: 0 });

    await expect(
      repository.deleteOwnAsset({
        actorId: AUTHOR_ID,
        assetId: ASSET_OWN_IN_MEMBER_PROJECT,
      }),
    ).resolves.toEqual({ deleted: 0 });
  });
});
