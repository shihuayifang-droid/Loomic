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

  const userClient = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: table === "projects" ? (options.project ?? null) : null,
          error: options.projectError ?? null,
        }),
        single: async () => {
          if (table === "asset_objects") {
            return {
              data:
                options.assetRow === undefined
                  ? {
                      id: "asset-1",
                      bucket: "project-assets",
                      object_path: "unused",
                      mime_type: "image/png",
                      byte_size: 3,
                      workspace_id: TEAM_WORKSPACE,
                      project_id: PROJECT,
                      created_at: "2026-10-02T00:00:00.000Z",
                    }
                  : options.assetRow,
              error: options.assetReadError ?? null,
            };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, buffer: { length: number }) => {
            if (options.uploadError) return { data: null, error: options.uploadError };
            uploads.push({ bucket, path, bytes: buffer.length });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            removals.push(...paths);
            return { data: null, error: null };
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        };
      },
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: "asset-1", workspace_id: TEAM_WORKSPACE, project_id: PROJECT }, error: null };
    },
  };

  const adminClient = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      if (options.rpcError) return { data: null, error: options.rpcError };
      return { data: { asset_id: "asset-1", workspace_id: TEAM_WORKSPACE, project_id: PROJECT }, error: null };
    },
  };

  const service = createUploadService({
    createUserClient: () => userClient as unknown as UserSupabaseClient,
    getAdminClient: () => adminClient as unknown as AdminSupabaseClient,
  });

  return { service, rpcs, uploads, removals, userClient };
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
    expect(result.url).toContain("https://cdn.test/project-assets/");
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
