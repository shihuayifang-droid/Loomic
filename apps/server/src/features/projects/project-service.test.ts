import type { ViewerResponse } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createProjectService,
  ProjectServiceError,
} from "./project-service.js";
import {
  FIND_READABLE_PROJECT_WORKSPACE_FOR_MUTATION,
  ProjectReadError,
  type ProjectReadRepository,
} from "../../db/project-read-repository.js";
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

/** A client whose only useful surface is the X-52 storage signature. */
function makeSigningClient() {
  const signed: Array<{ bucket: string; path: string }> = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string) => {
            signed.push({ bucket, path });
            return {
              data: {
                signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
              error: null,
            };
          },
        };
      },
    },
  };

  return { client: client as unknown as UserSupabaseClient, signed };
}

type RepositoryCall = { method: string; input: Record<string, unknown> };

/**
 * Workorder 20B: the three project reads are the PostgreSQL repository's. The
 * fake records the calls so the service contract — which ids it asks for, which
 * DTO it publishes, how it classifies null and failure — is what gets asserted.
 */
function makeRepositoryStub(
  config: {
    detail?: unknown;
    detailError?: Error;
    projects?: unknown[];
    projectsError?: Error;
    canvases?: unknown[];
    canvasesError?: Error;
  } = {},
) {
  const calls: RepositoryCall[] = [];

  const repository = {
    async findReadableProject(input: Record<string, unknown>) {
      calls.push({ method: "findReadableProject", input });
      if (config.detailError) throw config.detailError;
      return config.detail ?? null;
    },
    async listOwnProjects(input: Record<string, unknown>) {
      calls.push({ method: "listOwnProjects", input });
      if (config.projectsError) throw config.projectsError;
      return config.projects ?? [];
    },
    async listReadablePrimaryCanvases(input: Record<string, unknown>) {
      calls.push({ method: "listReadablePrimaryCanvases", input });
      if (config.canvasesError) throw config.canvasesError;
      return config.canvases ?? [];
    },
  };

  return { repository: repository as unknown as ProjectReadRepository, calls };
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

const PROJECT_ROW = {
  id: "project-1",
  name: "Mine",
  slug: "mine-abc123",
  description: null,
  created_at: "2026-09-29T00:00:00.000Z",
  updated_at: "2026-09-29T00:00:00.000Z",
  workspace_id: TEAM_ID,
  thumbnail_path: null,
};

const CANVAS_ROW = {
  id: "canvas-1",
  name: "Main Canvas",
  is_primary: true,
  project_id: "project-1",
};

const DETAIL_ROW = {
  id: "project-1",
  name: "Mine",
  slug: "mine-abc123",
  description: null,
  workspace_id: TEAM_ID,
  brand_kit_id: null,
  created_at: "2026-09-29T00:00:00.000Z",
  updated_at: "2026-09-29T00:00:00.000Z",
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

  it("case 2: listProjects asks the repository for this workspace and this author, not for a table", async () => {
    // 20B: the team-workspace AND created_by filters did not disappear, they
    // moved into the repository SQL (asserted in project-read-repository.test.ts
    // cases 8 and 11). What this case nails down at the service boundary is that
    // the read is scoped to the viewer's team workspace and the caller, and that
    // the PostgREST path is no longer used at all.
    const { client, queries } = makeClientStub({
      projects: [PROJECT_ROW],
      canvases: [CANVAS_ROW],
    });
    const { repository, calls } = makeRepositoryStub({
      projects: [PROJECT_ROW],
      canvases: [CANVAS_ROW],
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    const projects = await service.listProjects(USER);

    expect(calls).toEqual([
      {
        method: "listOwnProjects",
        input: { actorId: USER_ID, workspaceId: TEAM_ID },
      },
      {
        method: "listReadablePrimaryCanvases",
        input: {
          actorId: USER_ID,
          workspaceId: TEAM_ID,
          projectIds: ["project-1"],
        },
      },
    ]);
    expect(queries).toEqual([]);
    expect(projects.length).toBe(1);
    expect(projects[0]?.workspace.id).toBe(TEAM_ID);
    expect(projects[0]?.primaryCanvas.id).toBe("canvas-1");
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

// ADR-0001 step 2b: `getProject` is the repository's read, and the service keeps
// the existing 404 / 500 contract around it — including the anti-enumeration
// rule that "missing", "archived" and "forbidden" are one answer.
describe("getProject delegating to the project read repository", () => {
  function makeService(
    config: Parameters<typeof makeRepositoryStub>[0] = {},
    options: { withRepository?: boolean } = { withRepository: true },
  ) {
    const { client } = makeClientStub({});
    const stub = makeRepositoryStub(config);
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      ...(options.withRepository
        ? { projectReadRepository: stub.repository }
        : {}),
    });

    return { service, calls: stub.calls };
  }

  it("case 6: the repository's detail row is the DTO, with the caller as actor", async () => {
    const { service, calls } = makeService({ detail: DETAIL_ROW });

    const project = await service.getProject(USER, "project-1");

    expect(calls).toEqual([
      {
        method: "findReadableProject",
        input: { actorId: USER_ID, projectId: "project-1" },
      },
    ]);
    expect(project).toEqual(DETAIL_ROW);
    expect(project.brand_kit_id).toBeNull();
  });

  it("case 7: null stays the existing 404 project_not_found", async () => {
    const { service } = makeService({ detail: null });

    const error = await service
      .getProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("project_not_found");
    expect(error?.message).toBe("Project not found.");
  });

  it("case 8: a repository failure stays the existing 500 project_query_failed", async () => {
    const { service } = makeService({
      detailError: new Error("project read failed (findReadableProject)"),
    });

    const error = await service
      .getProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(error?.message).toBe("Failed to load project.");
    // The repository's own text (which names the statement's operation) is not
    // what the client is shown.
    expect(error?.message).not.toContain("findReadableProject");
  });

  it("case 9: a service built without the repository answers 500 instead of falling back", async () => {
    const { service, calls } = makeService({}, { withRepository: false });

    const error = await service
      .getProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(calls).toEqual([]);
  });
});

describe("listProjects delegating to the project read repository", () => {
  it("case 10: thumbnails are signed through the user client, and only the own ids reach the canvas read", async () => {
    const withThumbnail = {
      ...PROJECT_ROW,
      thumbnail_path: `${TEAM_ID}/project-1/thumbnail.webp`,
    };
    const { client, signed } = makeSigningClient();
    const { repository, calls } = makeRepositoryStub({
      projects: [withThumbnail],
      canvases: [CANVAS_ROW],
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    const projects = await service.listProjects(USER);

    expect(signed).toEqual([
      {
        bucket: "project-assets",
        path: `${TEAM_ID}/project-1/thumbnail.webp`,
      },
    ]);
    expect(projects[0]?.thumbnailUrl).toContain("token=sig");
    expect(calls[1]).toEqual({
      method: "listReadablePrimaryCanvases",
      input: {
        actorId: USER_ID,
        workspaceId: TEAM_ID,
        projectIds: ["project-1"],
      },
    });
  });

  it("case 11: no own projects is an empty list, and no canvas read is issued", async () => {
    const { repository, calls } = makeRepositoryStub({ projects: [] });
    const { client, signed } = makeSigningClient();
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    await expect(service.listProjects(USER)).resolves.toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["listOwnProjects"]);
    expect(signed).toEqual([]);
  });

  it("case 12: a project without a primary canvas is still the existing 500", async () => {
    const { repository } = makeRepositoryStub({
      projects: [PROJECT_ROW],
      canvases: [],
    });
    const { client } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    const error = await service
      .listProjects(USER)
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(error?.message).toBe("Unable to load projects.");
  });

  it("case 13: a repository failure is the existing 500, never a partial list", async () => {
    const { repository } = makeRepositoryStub({
      projectsError: new Error("project read failed (listOwnProjects)"),
    });
    const { client } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    const error = await service
      .listProjects(USER)
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(error?.message).toBe("Unable to load projects.");
  });

  it("case 14: a failing canvas read is the existing 500 and signs nothing", async () => {
    const { repository } = makeRepositoryStub({
      projects: [PROJECT_ROW],
      canvasesError: new Error("project read failed (listReadablePrimaryCanvases)"),
    });
    const { client, signed } = makeSigningClient();
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository,
    });

    const error = await service
      .listProjects(USER)
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(signed).toEqual([]);
  });

  it("case 15: a service built without the repository answers 500 and reads nothing", async () => {
    const { client, queries } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
    });

    const error = await service
      .listProjects(USER)
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_query_failed");
    expect(queries).toEqual([]);
  });
});

// X-52: a thumbnail URL is a project asset URL, so it is signed — and when it
// cannot be signed the answer is an error, never a permanent public address.
describe("saveThumbnail answers with a signed URL", () => {
  function makeThumbnailService(options: { signError?: { message: string } | null }) {
    const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
    // 工单20E: the workspace lookup is the repository's now, so the fixture has to
    // answer it — a client stub can no longer carry the lookup.
    const lookupCalls: Array<{ actorId: string; projectId: string }> = [];

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

    const repository = {
      async findReadableProjectWorkspaceForMutation(
        input: { actorId: string; projectId: string },
      ) {
        lookupCalls.push(input);
        return { workspace_id: TEAM_ID };
      },
    };

    const service = createProjectService({
      createUserClient: () => client as unknown as UserSupabaseClient,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository as unknown as ProjectReadRepository,
    });

    return { service, signedCalls, lookupCalls };
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

// ADR-0001 step 2e (工单20E): `archiveProject`'s existence and visibility check is
// the repository's read. Only the lookup moved — the UPDATE, its timestamp and
// the number of calls are frozen, and the two are deliberately not merged.
describe("archiveProject delegating to the project read repository", () => {
  function makeArchiveHarness(
    config: {
      detail?: unknown;
      detailError?: Error;
      updateError?: { message: string } | null;
      withRepository?: boolean;
    } = {},
  ) {
    const updatePatches: Array<Record<string, unknown>> = [];
    const tables: string[] = [];
    const calls: RepositoryCall[] = [];

    const client = {
      from(table: string) {
        tables.push(table);
        const chain = {
          update: (patch: Record<string, unknown>) => {
            updatePatches.push(patch);
            return chain;
          },
          eq: () => chain,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: null,
              error: config.updateError ?? null,
            }).then(resolve),
        };
        return chain;
      },
    };

    const repository = {
      async findReadableProject(input: Record<string, unknown>) {
        calls.push({ method: "findReadableProject", input });
        if (config.detailError) throw config.detailError;
        return config.detail ?? null;
      },
    };

    const service = createProjectService({
      createUserClient: () => client as unknown as UserSupabaseClient,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      ...(config.withRepository === false
        ? {}
        : {
            projectReadRepository:
              repository as unknown as ProjectReadRepository,
          }),
    });

    return { service, calls, updatePatches, tables };
  }

  it("case 16: the lookup asks the repository first, then the single UPDATE runs with an ISO archived_at", async () => {
    const harness = makeArchiveHarness({ detail: DETAIL_ROW });

    await expect(
      harness.service.archiveProject(USER, "project-1"),
    ).resolves.toBeUndefined();

    expect(harness.calls).toEqual([
      {
        method: "findReadableProject",
        input: { actorId: USER_ID, projectId: "project-1" },
      },
    ]);
    // Exactly one write, and it is the unchanged one: same table, one column, and
    // the timestamp is still generated at call time.
    expect(harness.tables).toEqual(["projects"]);
    expect(harness.updatePatches).toHaveLength(1);
    const patch = harness.updatePatches[0] ?? {};
    expect(Object.keys(patch)).toEqual(["archived_at"]);
    expect(patch["archived_at"]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(
      Number.isNaN(Date.parse(String(patch["archived_at"]))),
    ).toBe(false);
  });

  it("case 17: a null lookup is the existing 404 and nothing is written", async () => {
    const harness = makeArchiveHarness({ detail: null });

    const error = await harness.service
      .archiveProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(404);
    expect(error?.code).toBe("project_not_found");
    expect(error?.message).toBe("Project not found.");
    expect(harness.updatePatches).toEqual([]);
    expect(harness.tables).toEqual([]);
  });

  it("case 18: a repository failure is the existing project_delete_failed 500 and nothing is written", async () => {
    const harness = makeArchiveHarness({
      detailError: new Error("project read failed (findReadableProject)"),
    });

    const error = await harness.service
      .archiveProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_delete_failed");
    expect(error?.message).toBe("Unable to delete project.");
    // The repository's own text is not what the client is shown.
    expect(error?.message).not.toContain("findReadableProject");
    expect(harness.updatePatches).toEqual([]);
    expect(harness.tables).toEqual([]);
  });

  it("case 19: a service built without the repository answers 500 and touches no table", async () => {
    const harness = makeArchiveHarness({ withRepository: false });

    const error = await harness.service
      .archiveProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_delete_failed");
    expect(harness.calls).toEqual([]);
    expect(harness.updatePatches).toEqual([]);
    expect(harness.tables).toEqual([]);
  });
});

// 工单20E: the thumbnail's workspace lookup is still a plain SELECT, so it keeps
// its transport retry (3 attempts, 400ms/800ms) — but only for transport
// failures, and the final answer is a fixed 503 that names nothing.
describe("saveThumbnail lookup retry", () => {
  const TRANSPORT_CAUSE = new Error("TypeError: fetch failed");
  const PG_CAUSE = Object.assign(
    new Error("invalid input syntax for type uuid"),
    { code: "22P02" },
  );

  function makeRetryHarness(options: { failures: number; cause?: unknown }) {
    const attempts: number[] = [];
    const inputs: Array<Record<string, unknown>> = [];
    const uploads: string[] = [];
    const rpcs: string[] = [];
    const updatePatches: Array<Record<string, unknown>> = [];

    const repository = {
      async findReadableProjectWorkspaceForMutation(input: {
        actorId: string;
        projectId: string;
      }) {
        attempts.push(Date.now());
        inputs.push(input);
        if (attempts.length <= options.failures) {
          throw new ProjectReadError(
            FIND_READABLE_PROJECT_WORKSPACE_FOR_MUTATION,
            options.cause ?? TRANSPORT_CAUSE,
          );
        }

        return { workspace_id: TEAM_ID };
      },
    };

    const client = {
      from(table: string) {
        const chain = {
          update: (patch: Record<string, unknown>) => {
            updatePatches.push(patch);
            return chain;
          },
          eq: () => chain,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return chain;
      },
      storage: {
        from(bucket: string) {
          return {
            upload: async (path: string) => {
              uploads.push(path);
              return { data: { path }, error: null };
            },
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
      rpc: async (name: string) => {
        rpcs.push(name);
        return { data: { asset_id: "asset-thumb" }, error: null };
      },
    };

    const service = createProjectService({
      createUserClient: () => client as unknown as UserSupabaseClient,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      getAdminClient: () => client as unknown as never,
      projectReadRepository: repository as unknown as ProjectReadRepository,
    });

    return { service, attempts, inputs, uploads, rpcs, updatePatches };
  }

  it("case 20: two transport failures are replayed after 400ms and 800ms, and the third attempt succeeds", async () => {
    const harness = makeRetryHarness({ failures: 2 });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const promise = harness.service.saveThumbnail(
        USER,
        "project-1",
        Buffer.from("thumb"),
        "image/png",
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(harness.attempts).toEqual([0]);

      await vi.advanceTimersByTimeAsync(399);
      expect(harness.attempts).toEqual([0]);

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.attempts).toEqual([0, 400]);

      await vi.advanceTimersByTimeAsync(799);
      expect(harness.attempts).toEqual([0, 400]);

      await vi.advanceTimersByTimeAsync(1);
      expect(harness.attempts).toEqual([0, 400, 1200]);

      const result = await promise;
      expect(result.thumbnailUrl).toContain("token=sig");
      expect(result.thumbnailUrl).not.toContain("cdn.test");

      // Every attempt asked the same question, and the write path then ran once.
      expect(harness.inputs).toEqual([
        { actorId: USER_ID, projectId: "project-1" },
        { actorId: USER_ID, projectId: "project-1" },
        { actorId: USER_ID, projectId: "project-1" },
      ]);
      expect(harness.uploads).toEqual([
        `${TEAM_ID}/project-1/thumbnail.png`,
      ]);
      expect(harness.rpcs).toEqual(["record_project_asset"]);
      expect(harness.updatePatches).toEqual([
        { thumbnail_path: `${TEAM_ID}/project-1/thumbnail.png` },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 21: a real database failure is not replayed and the fixed 503 leaks nothing", async () => {
    const harness = makeRetryHarness({ failures: 3, cause: PG_CAUSE });

    const error = await harness.service
      .saveThumbnail(USER, "project-1", Buffer.from("thumb"), "image/png")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(harness.attempts).toHaveLength(1);
    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(503);
    expect(error?.code).toBe("project_query_failed");
    expect(error?.message).toBe("Unable to look up project.");
    expect(error?.message).not.toMatch(
      /select|public\.|uuid|22P02|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // Nothing was written: no object, no metadata row, no reference.
    expect(harness.uploads).toEqual([]);
    expect(harness.rpcs).toEqual([]);
    expect(harness.updatePatches).toEqual([]);
  });

  it("case 22: three transport failures stop after three attempts with the same fixed 503", async () => {
    const harness = makeRetryHarness({ failures: 3 });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const settled = harness.service
        .saveThumbnail(USER, "project-1", Buffer.from("thumb"), "image/png")
        .then(() => null)
        .catch((thrown: unknown) => thrown as ProjectServiceError);

      await vi.runAllTimersAsync();
      const error = await settled;

      expect(harness.attempts).toEqual([0, 400, 1200]);
      expect(error?.statusCode).toBe(503);
      expect(error?.code).toBe("project_query_failed");
      expect(error?.message).toBe("Unable to look up project.");
      expect(harness.uploads).toEqual([]);
      expect(harness.rpcs).toEqual([]);
      expect(harness.updatePatches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
