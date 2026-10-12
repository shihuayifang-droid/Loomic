import type { ViewerResponse } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  createProjectService,
  ProjectServiceError,
} from "./project-service.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "00000000-0000-0000-0000-00000000000a";

const USER: AuthenticatedUser = {
  accessToken: "test-token",
  email: "a@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

type RecordedQuery = {
  table: string;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
  is: Array<[string, unknown]>;
};

function makeClientStub(config: { projects?: unknown[]; canvases?: unknown[] }) {
  const rpcs: Array<{ name: string; params: Record<string, unknown> }> = [];
  const queries: RecordedQuery[] = [];

  const client = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcs.push({ name, params });
      return {
        data: {
          project: {
            id: "project-1",
            name: params.p_name,
            slug: params.p_slug,
            description: null,
            created_at: "2026-09-29T00:00:00.000Z",
            updated_at: "2026-09-29T00:00:00.000Z",
            workspace_id: params.p_workspace_id,
          },
          canvas: { id: "canvas-1", name: "Main Canvas", is_primary: true },
        },
        error: null,
      };
    },
    from(table: string) {
      const record: RecordedQuery = { table, eqs: [], ins: [], is: [] };
      let recorded = false;

      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          record.eqs.push([column, value]);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          record.ins.push([column, values]);
          return builder;
        },
        is: (column: string, value: unknown) => {
          record.is.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        then: (resolve: (value: unknown) => unknown) => {
          if (!recorded) {
            recorded = true;
            queries.push(record);
          }
          const data =
            table === "projects"
              ? (config.projects ?? [])
              : table === "canvases"
                ? (config.canvases ?? [])
                : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };

      return builder;
    },
  };

  return { client: client as unknown as UserSupabaseClient, queries, rpcs };
}

function makeViewerStub(teamWorkspace: {
  id: string;
  name: string;
  ownerUserId: string;
  type: "team";
} | null): ViewerService {
  return {
    async ensureViewer(user) {
      return {
        profile: {
          avatarUrl: null,
          displayName: "A",
          email: user.email,
          id: user.id,
        },
        workspace: {
          id: PERSONAL_ID,
          name: "Personal",
          ownerUserId: user.id,
          type: "personal",
        },
        membership: {
          role: "owner",
          userId: user.id,
          workspaceId: PERSONAL_ID,
        },
        teamWorkspace,
        teamMembership: teamWorkspace
          ? { role: "member", userId: user.id, workspaceId: teamWorkspace.id }
          : null,
      } as unknown as ViewerResponse;
    },
  };
}

const TEAM_WORKSPACE = {
  id: TEAM_ID,
  name: "HaHart 团队",
  ownerUserId: "owner-1",
  type: "team" as const,
};

describe("createProjectService with the team workspace", () => {
  it("case 1: createProject sends the team workspace id to the RPC", async () => {
    const { client, rpcs } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      // X-52 工单12: the service now records asset metadata through the admin
      // client. These cases exercise create/list only, so it is never called.
      getAdminClient: () => client as unknown as never,
    });

    const project = await service.createProject(USER, { name: "My Project" });

    expect(rpcs.length).toBe(1);
    expect(rpcs[0]?.name).toBe("create_project_with_canvas");
    expect(rpcs[0]?.params.p_workspace_id).toBe(TEAM_ID);
    expect(project.workspace).toEqual({
      id: TEAM_ID,
      name: "HaHart 团队",
      ownerUserId: "owner-1",
      type: "team",
    });
  });

  it("case 2: listProjects filters by team workspace AND created_by", async () => {
    const { client, queries } = makeClientStub({
      projects: [
        {
          id: "project-1",
          name: "Mine",
          slug: "mine-abc123",
          description: null,
          created_at: "2026-09-29T00:00:00.000Z",
          updated_at: "2026-09-29T00:00:00.000Z",
          workspace_id: TEAM_ID,
          thumbnail_path: null,
        },
      ],
      canvases: [{ id: "canvas-1", name: "Main Canvas", is_primary: true, project_id: "project-1" }],
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
    });

    const projects = await service.listProjects(USER);

    const projectQuery = queries.find((query) => query.table === "projects");
    expect(projectQuery?.eqs).toEqual([
      ["workspace_id", TEAM_ID],
      ["created_by", USER_ID],
    ]);
    expect(projectQuery?.is).toEqual([["archived_at", null]]);
    expect(projects.length).toBe(1);
    expect(projects[0]?.workspace.id).toBe(TEAM_ID);
  });

  it("case 3: no team workspace means 403 and no RPC call", async () => {
    const { client, rpcs } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(null),
      getAdminClient: () => client as unknown as never,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(403);
    expect((error as ProjectServiceError).code).toBe("not_team_member");
    expect(rpcs.length).toBe(0);
  });
});

// X-52: a thumbnail URL is a project asset URL, so it is signed — and when it
// cannot be signed the answer is an error, never a permanent public address.
describe("saveThumbnail answers with a signed URL", () => {
  function makeThumbnailService(options: { signError?: { message: string } | null }) {
    const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];

    const client = {
      from(table: string) {
        const chain = {
          select: () => chain,
          update: () => chain,
          eq: () => chain,
          single: async () => ({
            data: table === "projects" ? { workspace_id: TEAM_ID } : null,
            error: null,
          }),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return chain;
      },
      storage: {
        from(bucket: string) {
          return {
            upload: async (path: string) => ({ data: { path }, error: null }),
            createSignedUrl: async (path: string, expiresIn: number) => {
              signedCalls.push({ bucket, path, expiresIn });
              if (options.signError) return { data: null, error: options.signError };
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
      rpc: async () => ({ data: { asset_id: "asset-thumb" }, error: null }),
    };

    const service = createProjectService({
      createUserClient: () => client as unknown as UserSupabaseClient,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
    });

    return { service, signedCalls };
  }

  it("case 4: the thumbnail URL is a signature, not a public URL", async () => {
    const stub = makeThumbnailService({});

    const result = await stub.service.saveThumbnail(
      USER,
      "project-1",
      Buffer.from("thumb"),
      "image/png",
    );

    expect(result.thumbnailUrl).toContain("token=sig");
    expect(result.thumbnailUrl).not.toContain("cdn.test");
    expect(stub.signedCalls).toEqual([
      {
        bucket: "project-assets",
        path: `${TEAM_ID}/project-1/thumbnail.png`,
        expiresIn: 3600,
      },
    ]);
  });

  it("case 5: a signing failure is reported instead of falling back to a public URL", async () => {
    const stub = makeThumbnailService({ signError: { message: "permission denied" } });

    const error = await stub.service
      .saveThumbnail(USER, "project-1", Buffer.from("thumb"), "image/png")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.message).not.toContain("http");
  });
});
