// X-52 prep (T3): a normal upload's project ownership is decided by the SERVER.
//
// `projectId` arrives from the client as an optional multipart field, and both the
// object path and the asset row are built from it. Without verification a client
// could file an object under a project (or workspace) it has nothing to do with,
// and nobody would notice until the bucket is private and the real project cannot
// read its own media.
//
// Every metadata write in this file goes through the service_role-only RPC, so the
// stub asserts on the RPC call rather than on an insert.
import { describe, expect, it } from "vitest";

import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import { createProjectService } from "../projects/project-service.js";
import type { AssetReadRepository } from "../../db/asset-read-repository.js";
import {
  DELETE_OWN_ASSET,
  AssetWriteError,
  type AssetWriteRepository,
} from "../../db/asset-write-repository.js";
import type { ProjectReadRepository } from "../../db/project-read-repository.js";
import type { ProjectWriteRepository } from "../../db/project-write-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import { createUploadService, UploadServiceError } from "./upload-service.js";

const USER = { id: "user-1", accessToken: "token", email: "a@t", userMetadata: {} } as AuthenticatedUser;

const TEAM_WORKSPACE = "ws-team";
const OTHER_WORKSPACE = "ws-other";
const PROJECT = "project-1";

type RpcCall = { name: string; params: Record<string, unknown> };

function makeStubs(options: {
  project?: { workspace_id: string } | null;
  projectError?: { code?: string; message: string } | null;
  rpcError?: { message: string } | null;
  uploadError?: { message: string } | null;
  assetRow?: Record<string, unknown> | null;
  assetReadError?: { message: string } | null;
  assetDeleteError?: { message: string } | null;
}) {
  const rpcs: RpcCall[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  const removals: string[] = [];
  const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  /** Ordered side effects, so "remove before delete" is provable. */
  const events: string[] = [];

  // 工单20E: both read-only lookups belong to the repositories now, so the fixture
  // answers them there.
  //
  // ADR-0001 / workorder 21AA: so does the asset row delete, and the `getAssetUrl`
  // read that used to be the last PostgREST call here. The user client below
  // therefore carries ONLY Storage and the `record_project_asset` RPC; its table
  // accessor throws, so any regression back to PostgREST explodes here instead of
  // passing quietly.
  const projectLookups: Array<{ actorId: string; projectId: string }> = [];
  const assetLookups: Array<{ actorId: string; assetId: string }> = [];
  const assetDeletes: Array<{ actorId: string; assetId: string }> = [];

  const projectRepository = {
    async findReadableProjectWorkspaceForMutation(input: {
      actorId: string;
      projectId: string;
    }) {
      projectLookups.push(input);
      if (options.projectError) throw options.projectError;
      return options.project ?? null;
    },
  };

  const defaultAssetRow = {
    id: "asset-1",
    bucket: "project-assets",
    object_path: "unused",
    mime_type: "image/png",
    byte_size: 3,
    workspace_id: TEAM_WORKSPACE,
    project_id: PROJECT,
    created_at: "2026-10-02T00:00:00.000Z",
  };

  const assetRepository = {
    async findReadableAsset(input: { actorId: string; assetId: string }) {
      assetLookups.push(input);
      if (options.assetReadError) throw options.assetReadError;
      if (options.assetRow === null) return null;
      return options.assetRow ?? defaultAssetRow;
    },
  };

  const assetWriteRepository = {
    async deleteOwnAsset(input: { actorId: string; assetId: string }) {
      assetDeletes.push(input);
      // Recorded in the SAME ordered log as the storage calls, so "the object goes
      // first, the row second" stays provable.
      events.push(`delete-row:${input.assetId}`);
      if (options.assetDeleteError) throw options.assetDeleteError;
      return { deleted: 1 };
    },
  };

  const userClient = {
    get from(): never {
      throw new Error("the upload write flows must not touch a table");
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, buffer: { length: number }) => {
            if (options.uploadError) return { data: null, error: options.uploadError };
            uploads.push({ bucket, path, bytes: buffer.length });
            events.push(`upload:${path}`);
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            removals.push(...paths);
            for (const path of paths) events.push(`remove:${path}`);
            return { data: null, error: null };
          },
          // X-52: asset URLs are signed through this call. `getPublicUrl` is kept
          // only so the stub would visibly explode if production code used it.
          createSignedUrl: async (path: string, expiresIn: number) => {
            signedCalls.push({ bucket, path, expiresIn });
            events.push(`sign:${path}`);
            return {
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
              error: null,
            };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      events.push(`rpc:${name}`);
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: "asset-1", workspace_id: TEAM_WORKSPACE, project_id: PROJECT }, error: null };
    },
  };

  const adminClient = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      events.push(`rpc:${name}`);
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: "asset-1", workspace_id: TEAM_WORKSPACE, project_id: PROJECT }, error: null };
    },
  };

  const service = createUploadService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    getAdminClient: () => adminClient as unknown as AdminSupabaseClient,
    projectReadRepository: projectRepository as unknown as ProjectReadRepository,
    assetReadRepository: assetRepository as unknown as AssetReadRepository,
    assetWriteRepository:
      assetWriteRepository as unknown as AssetWriteRepository,
  });

  return {
    service,
    rpcs,
    uploads,
    removals,
    signedCalls,
    events,
    projectLookups,
    assetLookups,
    assetDeletes,
    userClient,
  };
}

const FILE = {
  bucket: "project-assets" as const,
  fileName: "photo.png",
  fileBuffer: Buffer.from("abc"),
  mimeType: "image/png",
};

describe("uploadFile records project ownership", () => {
  it("case 1: a project upload records the project and its workspace", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.rpcs).toHaveLength(1);
    expect(stub.rpcs[0]?.name).toBe("record_project_asset");
    expect(stub.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_created_by: "user-1",
      p_project_id: PROJECT,
      p_canvas_id: null,
      p_fallback_workspace_id: TEAM_WORKSPACE,
    });
    expect(stub.rpcs[0]?.params.p_object_path).toBe(stub.uploads[0]?.path);
  });

  it("case 2: a workspace that is not the project's is refused before anything is written", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: OTHER_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(403);
    expect(error?.message).toContain("different workspace");
    expect(stub.uploads).toHaveLength(0);
    expect(stub.rpcs).toHaveLength(0);
  });

  it("case 3: an unreadable project is refused", async () => {
    const stub = makeStubs({ project: null });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(403);
    expect(stub.uploads).toHaveLength(0);
  });

  it("case 4: a plain upload keeps projectId null and uses the given workspace", async () => {
    const stub = makeStubs({});

    await stub.service.uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE });

    expect(stub.rpcs[0]?.params).toMatchObject({
      p_project_id: null,
      p_canvas_id: null,
      p_fallback_workspace_id: TEAM_WORKSPACE,
      p_created_by: "user-1",
    });
  });

  it("case 5: a failed metadata write removes the object instead of silently succeeding", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      rpcError: { message: "rpc exploded" },
    });

    const error = await stub.service
      .uploadFile(USER, { ...FILE, workspaceId: TEAM_WORKSPACE, projectId: PROJECT })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(500);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
  });

  it("case 6: the response comes from the row the RPC created, not from the request", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    const result = await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(result.asset.id).toBe("asset-1");
    expect(result.asset.createdAt).toBe("2026-10-02T00:00:00.000Z");
    // X-52: a short-lived signature, not a permanent public URL.
    expect(result.url).toContain("token=sig");
    expect(result.url).not.toContain("cdn.test");
    expect(stub.signedCalls).toEqual([
      { bucket: "project-assets", path: stub.uploads[0]?.path, expiresIn: 3600 },
    ]);
  });

  it("case 7: the object path starts with the verified workspace", async () => {
    const stub = makeStubs({ project: { workspace_id: TEAM_WORKSPACE } });

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.uploads[0]?.path.startsWith(`${TEAM_WORKSPACE}/${PROJECT}/`)).toBe(true);
  });
});

// `saveThumbnail` writes the same kind of row through the same RPC, so it is
// covered here rather than in a separate file: the subject is "an upload is
// recorded as a project asset", not which service performed it.
describe("saveThumbnail records the thumbnail as a project asset", () => {
  function makeProjectService(options: { rpcError?: { message: string } | null }) {
    const rpcs: RpcCall[] = [];
    const referenceWrites: Array<Record<string, unknown>> = [];

    // ADR-0001 / workorder 21AA: the reference write is the project write
    // repository's now, so the user client here carries ONLY Storage.
    const userClient = {
      get from(): never {
        throw new Error("saveThumbnail must not touch a table");
      },
      storage: {
        from(bucket: string) {
          return {
            upload: async (path: string) => ({ data: { path }, error: null }),
            // X-52: `saveThumbnail` answers with a signed URL too.
            createSignedUrl: async (path: string) => ({
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
              error: null,
            }),
            getPublicUrl: (path: string) => ({
              data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
            }),
          };
        },
      },
    };

    const projectWriteRepository = {
      async setOwnProjectThumbnail(input: Record<string, unknown>) {
        referenceWrites.push(input);
        return { updated: 1 };
      },
    };

    const service = createProjectService({
      createUserClient: () => userClient as unknown as UserSupabaseClient,
      viewerService: {} as ViewerService,
      // 工单20E: the workspace lookup is the repository's now.
      projectReadRepository: {
        async findReadableProjectWorkspaceForMutation() {
          return { workspace_id: TEAM_WORKSPACE };
        },
      } as unknown as ProjectReadRepository,
      projectWriteRepository:
        projectWriteRepository as unknown as ProjectWriteRepository,
      getAdminClient: () =>
        ({
          rpc: async (name: string, params: Record<string, unknown>) => {
            rpcs.push({ name, params });
            if (options.rpcError) return { data: null, error: options.rpcError };
            return { data: { asset_id: "asset-thumb" }, error: null };
          },
        }) as unknown as AdminSupabaseClient,
    });

    return { service, rpcs, referenceWrites };
  }

  it("case 8: the thumbnail is recorded against its project", async () => {
    const stub = makeProjectService({});

    await stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png");

    expect(stub.rpcs).toHaveLength(1);
    expect(stub.rpcs[0]?.params).toMatchObject({
      p_bucket: "project-assets",
      p_project_id: PROJECT,
      p_created_by: "user-1",
      p_fallback_workspace_id: TEAM_WORKSPACE,
    });
    expect(stub.rpcs[0]?.params.p_object_path).toBe(
      `${TEAM_WORKSPACE}/${PROJECT}/thumbnail.png`,
    );
    expect(stub.referenceWrites).toEqual([
      {
        actorId: "user-1",
        projectId: PROJECT,
        thumbnailPath: `${TEAM_WORKSPACE}/${PROJECT}/thumbnail.png`,
      },
    ]);
  });

  it("case 9: a metadata failure is reported and the reference is not saved", async () => {
    const stub = makeProjectService({ rpcError: { message: "rpc exploded" } });

    await expect(
      stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png"),
    ).rejects.toThrow(/thumbnail metadata/i);

    expect(stub.referenceWrites).toHaveLength(0);
  });
});

// X-52 stage 1C (工单18 T2): `getAssetUrl` is the read path for a historical object
// whose metadata row says `bucket = 'canvases'`. It must sign in that bucket — the
// bucket comes from the row, never from a hardcoded default — and it must not degrade
// to a public URL when the caller happens to be unable to read the object.
describe("getAssetUrl signs the bucket the metadata row names (工单18)", () => {
  it("case 10: a canvases asset is signed in canvases with no public fallback", async () => {
    const stub = makeStubs({
      assetRow: {
        id: "asset-canvas-1",
        bucket: "canvases",
        object_path: "canvases/team-project/legacy.png",
        mime_type: "image/png",
        byte_size: 3,
        workspace_id: TEAM_WORKSPACE,
        project_id: PROJECT,
        created_at: "2026-10-13T00:00:00.000Z",
      },
    });

    const url = await stub.service.getAssetUrl(USER, "asset-canvas-1");

    expect(stub.signedCalls).toEqual([
      {
        bucket: "canvases",
        path: "canvases/team-project/legacy.png",
        expiresIn: 3600,
      },
    ]);
    expect(url).toContain("token=sig");
    // The public-URL branch exists on the stub precisely so a fallback would be visible.
    expect(url).not.toContain("cdn.test");
  });
});

// 工单20E: the write flows' read-only lookups are the repositories' now — the
// project ownership check before an upload, the row read back after the RPC, and
// the row `deleteAsset` locates. What must NOT move is any write, the object
// path, the RPC, the signing, or the order of the delete's two steps.
describe("the migrated lookups of the upload write flows", () => {
  const CANVAS_ASSET_ROW = {
    id: "asset-1",
    bucket: "canvases",
    object_path: "canvases/legacy.png",
    mime_type: "image/png",
    byte_size: 3,
    workspace_id: TEAM_WORKSPACE,
    project_id: null,
    created_at: "2026-10-13T00:00:00.000Z",
  };

  it("case 11: a project lookup failure is the existing 500 with zero side effects", async () => {
    const stub = makeStubs({
      projectError: { code: "57P01", message: "connection reset by peer" },
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to verify the upload project.");
    // The question was asked of the repository, with the caller as the actor.
    expect(stub.projectLookups).toEqual([
      { actorId: "user-1", projectId: PROJECT },
    ]);
    expect(stub.uploads).toEqual([]);
    expect(stub.rpcs).toEqual([]);
    expect(stub.assetLookups).toEqual([]);
    expect(stub.events).toEqual([]);
  });

  it("case 12: an upload without a project never asks the project repository", async () => {
    const stub = makeStubs({});

    await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
    });

    expect(stub.projectLookups).toEqual([]);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.rpcs).toHaveLength(1);
  });

  it("case 13: the DTO comes from the row the asset repository answers, asked with the actor and the RPC's id", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetRow: {
        id: "asset-9",
        bucket: "project-assets",
        object_path: "stored/other-path.webp",
        mime_type: "image/webp",
        byte_size: 8192,
        workspace_id: TEAM_WORKSPACE,
        project_id: PROJECT,
        created_at: "2026-10-13T11:22:33.444Z",
      },
    });

    const result = await stub.service.uploadFile(USER, {
      ...FILE,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
    });

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(result.asset).toEqual({
      id: "asset-9",
      bucket: "project-assets",
      objectPath: "stored/other-path.webp",
      mimeType: "image/webp",
      byteSize: 8192,
      workspaceId: TEAM_WORKSPACE,
      projectId: PROJECT,
      createdAt: "2026-10-13T11:22:33.444Z",
    });
    // The signature still names the object that was uploaded, not the row's path.
    expect(stub.signedCalls).toEqual([
      { bucket: "project-assets", path: stub.uploads[0]?.path, expiresIn: 3600 },
    ]);
    expect(stub.removals).toEqual([]);
  });

  it("case 14: an unreadable row after the RPC removes the object once and keeps the fixed 500", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetReadError: { message: "asset read failed (findReadableAsset)" },
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record asset metadata.");
    expect(error?.message).not.toContain("findReadableAsset");
    expect(stub.uploads).toHaveLength(1);
    // Exactly one cleanup, and it is the same one as before the migration.
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
    expect(stub.rpcs).toHaveLength(1);
    expect(stub.signedCalls).toEqual([]);
  });

  it("case 15: a missing row after the RPC behaves identically", async () => {
    const stub = makeStubs({
      project: { workspace_id: TEAM_WORKSPACE },
      assetRow: null,
    });

    const error = await stub.service
      .uploadFile(USER, {
        ...FILE,
        workspaceId: TEAM_WORKSPACE,
        projectId: PROJECT,
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record asset metadata.");
    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.uploads).toHaveLength(1);
    expect(stub.removals).toEqual([stub.uploads[0]?.path]);
    expect(stub.signedCalls).toEqual([]);
  });

  it("case 16: deleteAsset locates through the repository and still removes the object before deleting the row", async () => {
    const stub = makeStubs({ assetRow: CANVAS_ASSET_ROW });

    await stub.service.deleteAsset(USER, "asset-1");

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    // The bucket and the path come from the row the repository answered, and the
    // order is the existing contract: object first, row second. The row delete is
    // the write repository's now, and it lands in the same ordered log.
    expect(stub.events).toEqual([
      "remove:canvases/legacy.png",
      "delete-row:asset-1",
    ]);
    expect(stub.removals).toEqual(["canvases/legacy.png"]);
    expect(stub.assetDeletes).toEqual([{ actorId: "user-1", assetId: "asset-1" }]);
  });

  it("case 16b: a failed row delete is the existing 500 upload_failed", async () => {
    const stub = makeStubs({
      assetRow: CANVAS_ASSET_ROW,
      assetDeleteError: new AssetWriteError(
        DELETE_OWN_ASSET,
        new Error("boom"),
      ),
    });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("upload_failed");
    expect(error?.message).toBe("Failed to delete asset record.");
    // The repository's own text is not what the client is shown.
    expect(error?.message).not.toContain("deleteOwnAsset");
    // The object was already gone when the row delete failed — the existing order.
    expect(stub.removals).toEqual(["canvases/legacy.png"]);
  });

  it("case 17: an unreadable asset is the existing 404 and removes nothing", async () => {
    const stub = makeStubs({
      assetReadError: { message: "asset read failed (findReadableAsset)" },
    });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error).toBeInstanceOf(UploadServiceError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("asset_not_found");
    expect(error?.message).toBe("Asset not found.");
    expect(stub.events).toEqual([]);
  });

  it("case 18: a missing asset row is the same 404, with no remove and no delete", async () => {
    const stub = makeStubs({ assetRow: null });

    const error = await stub.service
      .deleteAsset(USER, "asset-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as UploadServiceError);

    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("asset_not_found");
    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.events).toEqual([]);
  });

  // Workorder 21AA: this is the ONE deliberate contract change of the ticket. Case 19
  // used to assert that `getAssetUrl` was excluded from the migration and kept its
  // own table read. It is now the repository's read instead — the same
  // `findReadableAsset` `deleteAsset` already used — because the ticket's
  // "do not build a second read method" rule (an existing one answers exactly this
  // question) and the "no table access left" rule point at the same conclusion.
  it("case 19: getAssetUrl asks the repository and reads no table", async () => {
    const stub = makeStubs({ assetRow: CANVAS_ASSET_ROW });

    const url = await stub.service.getAssetUrl(USER, "asset-1");

    expect(stub.assetLookups).toEqual([
      { actorId: "user-1", assetId: "asset-1" },
    ]);
    expect(stub.signedCalls).toEqual([
      { bucket: "canvases", path: "canvases/legacy.png", expiresIn: 3600 },
    ]);
    expect(url).toContain("token=sig");
    // Nothing was deleted and nothing was written: this is a read path.
    expect(stub.events).toEqual(["sign:canvases/legacy.png"]);
    expect(stub.assetDeletes).toEqual([]);
  });

  it("case 19b: a repository failure and a missing row are both the existing 404", async () => {
    const failed = makeStubs({
      assetReadError: new Error("asset read failed (findReadableAsset)"),
    });
    const missing = makeStubs({ assetRow: null });

    for (const stub of [failed, missing]) {
      const error = await stub.service
        .getAssetUrl(USER, "asset-1")
        .then(() => null)
        .catch((thrown: unknown) => thrown as UploadServiceError);

      expect(error).toBeInstanceOf(UploadServiceError);
      expect(error?.statusCode).toBe(404);
      expect(error?.code).toBe("asset_not_found");
      expect(error?.message).toBe("Asset not found.");
      // Nothing was signed, and the client was never even built for a missing row.
      expect(stub.signedCalls).toEqual([]);
    }
  });
});
