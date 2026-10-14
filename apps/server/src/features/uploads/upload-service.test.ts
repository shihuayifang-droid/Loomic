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
import type { ProjectReadRepository } from "../../db/project-read-repository.js";
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
}) {
  const rpcs: RpcCall[] = [];
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  const removals: string[] = [];
  const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
  /** Ordered side effects, so "remove before delete" is provable. */
  const events: string[] = [];

  // 工单20E: both read-only lookups belong to the repositories now, so the fixture
  // answers them there. A regression back to PostgREST would find no query builder
  // for `projects` at all and explode rather than pass quietly.
  const projectLookups: Array<{ actorId: string; projectId: string }> = [];
  const assetLookups: Array<{ actorId: string; assetId: string }> = [];

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

  const userClient = {
    from(table: string) {
      const chain = {
        select: () => chain,
        delete: () => {
          events.push(`delete:${table}`);
          return chain;
        },
        eq: () => chain,
        single: async () => {
          if (table === "asset_objects") {
            return {
              data:
                options.assetRow === undefined ? defaultAssetRow : options.assetRow,
              error: options.assetReadError ?? null,
            };
          }
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return chain;
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
    const updates: Array<Record<string, unknown>> = [];

    const userClient = {
      from(table: string) {
        const chain = {
          select: () => chain,
          update: (patch: Record<string, unknown>) => {
            updates.push(patch);
            return chain;
          },
          eq: () => chain,
          single: async () => ({
            data: table === "projects" ? { workspace_id: TEAM_WORKSPACE } : null,
            error: null,
          }),
        };
        return chain;
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

    const service = createProjectService({
      createUserClient: () => userClient as unknown as UserSupabaseClient,
      viewerService: {} as ViewerService,
      // 工单20E: the workspace lookup is the repository's now.
      projectReadRepository: {
        async findReadableProjectWorkspaceForMutation() {
          return { workspace_id: TEAM_WORKSPACE };
        },
      } as unknown as ProjectReadRepository,
      getAdminClient: () =>
        ({
          rpc: async (name: string, params: Record<string, unknown>) => {
            rpcs.push({ name, params });
            if (options.rpcError) return { data: null, error: options.rpcError };
            return { data: { asset_id: "asset-thumb" }, error: null };
          },
        }) as unknown as AdminSupabaseClient,
    });

    return { service, rpcs, updates };
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
  });

  it("case 9: a metadata failure is reported and the reference is not saved", async () => {
    const stub = makeProjectService({ rpcError: { message: "rpc exploded" } });

    await expect(
      stub.service.saveThumbnail(USER, PROJECT, Buffer.from("thumb"), "image/png"),
    ).rejects.toThrow(/thumbnail metadata/i);

    expect(stub.updates).toHaveLength(0);
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
    // order is the existing contract: object first, row second.
    expect(stub.events).toEqual([
      "remove:canvases/legacy.png",
      "delete:asset_objects",
    ]);
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

  it("case 19: getAssetUrl is not part of the migration and still reads through the caller's client", async () => {
    const stub = makeStubs({ assetRow: CANVAS_ASSET_ROW });

    const url = await stub.service.getAssetUrl(USER, "asset-1");

    // The independent read API keeps its own PostgREST read: the repository is not
    // asked at all.
    expect(stub.assetLookups).toEqual([]);
    expect(stub.signedCalls).toEqual([
      { bucket: "canvases", path: "canvases/legacy.png", expiresIn: 3600 },
    ]);
    expect(url).toContain("token=sig");
  });
});
