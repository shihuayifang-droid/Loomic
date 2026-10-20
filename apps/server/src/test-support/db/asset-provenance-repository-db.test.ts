import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAssetProvenanceRepository,
  type AssetProvenance,
  type AssetProvenanceRepository,
} from "../../db/asset-provenance-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL measurement of the asset provenance columns and repository
 * (GN-11, workorder 33F). PGlite runs in-process: no server, no socket.
 */

const USER_ID = "00000000-0000-0000-0000-0000000000c1";
const JOB_ID = "eeee0000-0000-4000-8000-0000000000c1";
const PARENT_ASSET_ID = "dddd0000-0000-4000-8000-0000000000c1";
const CHILD_ASSET_ID = "dddd0000-0000-4000-8000-0000000000c2";
const UNKNOWN_ASSET_ID = "dddd0000-0000-4000-8000-0000000000ff";

let db: PGlite;
let repository: AssetProvenanceRepository;
let workspaceId: string;

function provenance(overrides: Partial<AssetProvenance> = {}): AssetProvenance {
  return {
    source: "generator",
    operation: "image_generation",
    modelId: "black-forest-labs/flux-kontext-pro",
    prompt: "a red panda",
    creditsCharged: 0,
    actionId: "act-1",
    sourceJobId: JOB_ID,
    parentArtifactId: PARENT_ASSET_ID,
    ...overrides,
  };
}

async function insertAsset(id: string, objectPath: string): Promise<void> {
  await db.query(
    `insert into public.asset_objects (id, workspace_id, project_id, bucket, object_path, created_by)
     values ($1::uuid, $2::uuid, null, 'project-assets', $3, $4::uuid)`,
    [id, workspaceId, objectPath, USER_ID],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  repository = createAssetProvenanceRepository({
    getTransactionPool: () => createPGliteTransactionPool(db),
  });

  await createUser(db, USER_ID, "asset-provenance@hahart.test");
  workspaceId = (
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_ID],
      )
    ).rows[0] as { id: string }
  ).id;

  await db.query(
    `insert into public.background_jobs (id, workspace_id, queue_name, job_type, status, created_by)
     values ($1, $2, 'image_generation_jobs', 'image_generation', 'queued', $3)`,
    [JOB_ID, workspaceId, USER_ID],
  );

  await insertAsset(PARENT_ASSET_ID, `${workspaceId}/provenance/parent.png`);
  await insertAsset(CHILD_ASSET_ID, `${workspaceId}/provenance/child.png`);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("asset provenance repository: real SQL (GN-11)", () => {
  it("GN-11: recorded provenance reads back field by field", async () => {
    const expected = provenance();

    await expect(
      repository.recordProvenance({
        actorId: USER_ID,
        assetId: CHILD_ASSET_ID,
        provenance: expected,
      }),
    ).resolves.toEqual({ updated: 1 });

    await expect(
      repository.readProvenance({ assetId: CHILD_ASSET_ID }),
    ).resolves.toEqual({ assetId: CHILD_ASSET_ID, ...expected });
  });

  it("GN-11: provenance survives the job row being deleted", async () => {
    await db.query("delete from public.background_jobs where id = $1::uuid", [
      JOB_ID,
    ]);

    const after = await repository.readProvenance({ assetId: CHILD_ASSET_ID });

    expect(after).not.toBeNull();
    expect(after?.modelId).toBe("black-forest-labs/flux-kontext-pro");
    expect(after?.creditsCharged).toBe(0);
    expect(after?.operation).toBe("image_generation");
    expect(after?.source).toBe("generator");
    expect(after?.sourceJobId).toBe(JOB_ID);
  });

  it("GN-11: a tool artifact is recorded as tool:*, not user_upload", async () => {
    await expect(
      repository.recordProvenance({
        actorId: USER_ID,
        assetId: CHILD_ASSET_ID,
        provenance: provenance({ source: "tool:adjust" }),
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await repository.readProvenance({ assetId: CHILD_ASSET_ID });

    expect(after?.source).toBe("tool:adjust");
  });

  it("GN-11: the CHECK refuses an unknown source written directly", async () => {
    await expect(
      db.query(
        "update public.asset_objects set source = 'upload' where id = $1::uuid",
        [CHILD_ASSET_ID],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("GN-11: an unknown asset id updates zero rows", async () => {
    await expect(
      repository.recordProvenance({
        actorId: USER_ID,
        assetId: UNKNOWN_ASSET_ID,
        provenance: provenance(),
      }),
    ).resolves.toEqual({ updated: 0 });
  });

  it("GN-11: deleting the parent artifact nulls the child's parent link", async () => {
    await repository.recordProvenance({
      actorId: USER_ID,
      assetId: CHILD_ASSET_ID,
      provenance: provenance(),
    });
    await db.query("delete from public.asset_objects where id = $1::uuid", [
      PARENT_ASSET_ID,
    ]);

    const after = await repository.readProvenance({ assetId: CHILD_ASSET_ID });

    expect(after?.parentArtifactId).toBeNull();
  });
});
