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
import {
  ARCHIVE_OWN_PROJECT,
  SET_OWN_PROJECT_THUMBNAIL,
  UPDATE_OWN_PROJECT,
  ProjectWriteError,
  type ProjectWriteRepository,
} from "../../db/project-write-repository.js";
import type { AssetRecordRepository } from "../../db/asset-record-repository.js";
import type {
  CreatedProjectRow,
  ProjectCreateRepository,
} from "../../db/project-create-repository.js";
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

/**
 * GN-14: same shape as `makeSigningClient`, but also records the THIRD argument
 * (`createSignedUrl(path, ttl, options)`), which is how the list thumbnail's
 * storage-side transform is observed from the service boundary.
 */
function makeTransformSigningClient() {
  const calls: Array<{ bucket: string; path: string; options: unknown }> = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (
            path: string,
            _expiresIn: number,
            options?: unknown,
          ) => {
            calls.push({ bucket, path, options });
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

  return { client: client as unknown as UserSupabaseClient, calls };
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

type WriteRepositoryCall = { method: string; input: Record<string, unknown> };

/**
 * Workorder 21AA: the three project WRITES are the PostgreSQL repository's. The
 * fake records the calls and answers a row count, so the service contract — which
 * ids and which patch it passes down, how it classifies a throw and a zero count —
 * is what gets asserted. `updated: 0` is the interesting answer on three paths
 * (archive, thumbnail, patch) because it must stay silent, so the default is 1 and
 * each case opts into 0 explicitly.
 */
function makeWriteRepositoryStub(
  config: {
    archiveUpdated?: number;
    archiveError?: Error;
    thumbnailUpdated?: number;
    thumbnailError?: Error;
    /** Thrown by the first calls, one per call, before `thumbnailError` applies. */
    thumbnailErrorsBefore?: Error[];
    updateUpdated?: number;
    updateError?: Error;
  } = {},
) {
  const calls: WriteRepositoryCall[] = [];

  const repository = {
    async archiveOwnProject(input: Record<string, unknown>) {
      calls.push({ method: ARCHIVE_OWN_PROJECT, input });
      if (config.archiveError) throw config.archiveError;
      return { updated: config.archiveUpdated ?? 1 };
    },
    async setOwnProjectThumbnail(input: Record<string, unknown>) {
      calls.push({ method: SET_OWN_PROJECT_THUMBNAIL, input });
      const queued = config.thumbnailErrorsBefore;
      if (queued && queued.length > 0) throw queued.shift() as Error;
      if (config.thumbnailError) throw config.thumbnailError;
      return { updated: config.thumbnailUpdated ?? 1 };
    },
    async updateOwnProject(input: Record<string, unknown>) {
      calls.push({ method: UPDATE_OWN_PROJECT, input });
      if (config.updateError) throw config.updateError;
      return { updated: config.updateUpdated ?? 1 };
    },
  };

  return { repository: repository as unknown as ProjectWriteRepository, calls };
}

/**
 * Workorder 21AA: a user client that carries ONLY the two surfaces these flows are
 * still allowed to use — Storage. Reading
 * the table accessor throws, so a regression back to PostgREST for any of the three
 * project writes fails here loudly instead of passing quietly against a builder
 * nobody forbade.
 */
function makeStorageOnlyClient(options: {
  signedPath?: string;
} = {}) {
  const uploads: string[] = [];

  const client = {
    get from(): never {
      throw new Error("the project write flows must not touch a table");
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
  };

  return { client: client as unknown as UserSupabaseClient, uploads };
}

/**
 * Workorder 44C: the thumbnail's asset row is recorded through the asset record
 * repository; this fake records the camelCase input.
 */
function makeRecordRepositoryStub() {
  const calls: Array<Record<string, unknown>> = [];
  const repository = {
    async recordProjectAsset(input: Record<string, unknown>) {
      calls.push(input);
      return { assetId: "asset-thumb", workspaceId: TEAM_ID, projectId: "project-1" };
    },
  } as unknown as AssetRecordRepository;
  return { repository, calls };
}

/**
 * Workorder 44O: a fake project create repository. It records the camelCase
 * input; `failWith` makes it throw, `result` overrides what it returns.
 */
function makeCreateRepositoryStub(
  config: { failWith?: unknown; result?: CreatedProjectRow | null } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const repository: ProjectCreateRepository = {
    async createProjectWithCanvas(input) {
      calls.push({ ...input });
      if (config.failWith !== undefined) throw config.failWith;
      if (config.result !== undefined) {
        return config.result as unknown as CreatedProjectRow;
      }
      return {
        project: {
          id: "project-1",
          name: input.name,
          slug: input.slug,
          description: input.description,
          created_at: "2026-09-29T00:00:00.000Z",
          updated_at: "2026-09-29T00:00:00.000Z",
          workspace_id: input.workspaceId,
        },
        canvas: { id: "canvas-1", name: input.canvasName, is_primary: true },
      };
    },
  };
  return { repository, calls };
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
  it("case 1: createProject hands the actor and the team workspace to the create repository", async () => {
    const { client } = makeClientStub({});
    const create = makeCreateRepositoryStub();
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      // These cases exercise create/list only, so no asset is ever recorded.
      projectWriteRepository: makeWriteRepositoryStub().repository,
      projectCreateRepository: create.repository,
    });

    const project = await service.createProject(USER, { name: "My Project" });

    expect(create.calls.length).toBe(1);
    expect(create.calls[0]).toEqual({
      actorId: USER_ID,
      workspaceId: TEAM_ID,
      name: "My Project",
      slug: expect.stringMatching(/^my-project-[a-z0-9]+$/),
      description: "",
      canvasName: "Main Canvas",
    });
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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

  it("case 3: no team workspace means 403 and the create repository is not called", async () => {
    const { client } = makeClientStub({});
    const create = makeCreateRepositoryStub();
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(null),
      projectWriteRepository: makeWriteRepositoryStub().repository,
      projectCreateRepository: create.repository,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(403);
    expect((error as ProjectServiceError).code).toBe("not_team_member");
    expect(create.calls.length).toBe(0);
  });

  it("case 3b: a duplicate slug (23505) is 409 project_slug_taken", async () => {
    const { client } = makeClientStub({});
    const create = makeCreateRepositoryStub({
      failWith: Object.assign(new Error("duplicate"), { code: "23505" }),
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectWriteRepository: makeWriteRepositoryStub().repository,
      projectCreateRepository: create.repository,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(409);
    expect((error as ProjectServiceError).code).toBe("project_slug_taken");
  });

  it("case 3c: any other repository failure is 500 project_create_failed", async () => {
    const { client } = makeClientStub({});
    const create = makeCreateRepositoryStub({
      failWith: Object.assign(new Error("boom"), { code: "42501" }),
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectWriteRepository: makeWriteRepositoryStub().repository,
      projectCreateRepository: create.repository,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(500);
    expect((error as ProjectServiceError).code).toBe("project_create_failed");
  });

  it("case 3d: a result without ids is 500 project_create_failed", async () => {
    const { client } = makeClientStub({});
    const create = makeCreateRepositoryStub({ result: null });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectWriteRepository: makeWriteRepositoryStub().repository,
      projectCreateRepository: create.repository,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(500);
    expect((error as ProjectServiceError).code).toBe("project_create_failed");
  });

  it("case 3e: a service built without the create repository answers 500 project_create_failed", async () => {
    const { client } = makeClientStub({});
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectWriteRepository: makeWriteRepositoryStub().repository,
    });

    const error = await service
      .createProject(USER, { name: "My Project" })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect((error as ProjectServiceError).statusCode).toBe(500);
    expect((error as ProjectServiceError).code).toBe("project_create_failed");
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
    const writeStub = makeWriteRepositoryStub();
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      ...(options.withRepository
        ? { projectReadRepository: stub.repository }
        : {}),
      projectWriteRepository: writeStub.repository,
    });

    return { service, calls: stub.calls, writeCalls: writeStub.calls };
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

  it("case 9b: the read path never reaches the write repository", async () => {
    const { service, writeCalls } = makeService({ detail: DETAIL_ROW });

    await service.getProject(USER, "project-1");

    expect(writeCalls).toEqual([]);
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
      projectWriteRepository: makeWriteRepositoryStub().repository,
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
//
// ADR-0001 / workorder 21AA: the reference write is the write repository's now, and
// the user client carries ONLY Storage — its table accessor throws, so a regression
// back to PostgREST on this path cannot pass.
describe("saveThumbnail answers with a signed URL", () => {
  function makeThumbnailService(options: {
    signError?: { message: string } | null;
    writeUpdated?: number;
    writeError?: Error;
    writeErrorsBefore?: Error[];
  }) {
    const signedCalls: Array<{ bucket: string; path: string; expiresIn: number }> = [];
    // 工单20E: the workspace lookup is the repository's now, so the fixture has to
    // answer it — a client stub can no longer carry the lookup.
    const lookupCalls: Array<{ actorId: string; projectId: string }> = [];

    const client = {
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
      get from(): never {
        throw new Error("saveThumbnail must not touch a table");
      },
    };

    const repository = {
      async findReadableProjectWorkspaceForMutation(
        input: { actorId: string; projectId: string },
      ) {
        lookupCalls.push(input);
        return { workspace_id: TEAM_ID };
      },
    };

    const writeStub = makeWriteRepositoryStub({
      thumbnailUpdated: options.writeUpdated ?? 1,
      ...(options.writeError ? { thumbnailError: options.writeError } : {}),
      ...(options.writeErrorsBefore ? { thumbnailErrorsBefore: options.writeErrorsBefore } : {}),
    });

    const service = createProjectService({
      createUserClient: () => client as unknown as UserSupabaseClient,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      assetRecordRepository: makeRecordRepositoryStub().repository,
      projectReadRepository: repository as unknown as ProjectReadRepository,
      projectWriteRepository: writeStub.repository,
    });

    return { service, signedCalls, lookupCalls, writeCalls: writeStub.calls };
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
    // 21AA: the reference went through the write repository, with the same object
    // path the bucket received.
    expect(stub.writeCalls).toEqual([
      {
        method: SET_OWN_PROJECT_THUMBNAIL,
        input: {
          actorId: USER_ID,
          projectId: "project-1",
          thumbnailPath: `${TEAM_ID}/project-1/thumbnail.png`,
        },
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

  it("case 5b: a failed reference write is the existing 500 with its own message", async () => {
    const stub = makeThumbnailService({
      writeError: new ProjectWriteError(SET_OWN_PROJECT_THUMBNAIL, new Error("boom")),
    });

    const error = await stub.service
      .saveThumbnail(USER, "project-1", Buffer.from("thumb"), "image/png")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_create_failed");
    expect(error?.message).toBe("Failed to save thumbnail reference.");
    // The repository's own text is not what the client is shown.
    expect(error?.message).not.toContain("setOwnProjectThumbnail");
    // The reference was attempted once, and the signing step never ran.
    expect(stub.writeCalls).toHaveLength(1);
    expect(stub.signedCalls).toEqual([]);
  });

  it("case 5c: a reference write that touches no row is still the existing success", async () => {
    // The object and the metadata row are already in place by then; the removed
    // write did not inspect the count, so a zero count must not turn into an error.
    const stub = makeThumbnailService({ writeUpdated: 0 });

    const result = await stub.service.saveThumbnail(
      USER,
      "project-1",
      Buffer.from("thumb"),
      "image/png",
    );

    expect(result.thumbnailUrl).toContain("token=sig");
    expect(stub.writeCalls).toHaveLength(1);
  });

  // AG-35 §1: the reference write is a fixed-patch UPDATE by id, so a transport
  // failure (the proxy resetting mid-flight) is replayed instead of answering 500.
  it("AG-35: a transport failure on the thumbnail reference is retried and the save succeeds", async () => {
    const stub = makeThumbnailService({
      writeErrorsBefore: [
        new ProjectWriteError(
          SET_OWN_PROJECT_THUMBNAIL,
          Object.assign(new Error("fetch failed"), { code: "" }),
        ),
      ],
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const promise = stub.service.saveThumbnail(
        USER,
        "project-1",
        Buffer.from("thumb"),
        "image/png",
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(stub.writeCalls).toHaveLength(1);

      // The backoff before the replay is one step (400ms).
      await vi.advanceTimersByTimeAsync(400);

      const result = await promise;

      expect(result.thumbnailUrl).toContain("token=sig");
      expect(result.thumbnailUrl).not.toContain("cdn.test");
      // The reference was replayed once, with the same patch both times.
      expect(stub.writeCalls).toEqual([
        {
          method: SET_OWN_PROJECT_THUMBNAIL,
          input: {
            actorId: USER_ID,
            projectId: "project-1",
            thumbnailPath: `${TEAM_ID}/project-1/thumbnail.png`,
          },
        },
        {
          method: SET_OWN_PROJECT_THUMBNAIL,
          input: {
            actorId: USER_ID,
            projectId: "project-1",
            thumbnailPath: `${TEAM_ID}/project-1/thumbnail.png`,
          },
        },
      ]);
      expect(stub.signedCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AG-35: a non-transport failure is still answered once", async () => {
    const stub = makeThumbnailService({
      writeErrorsBefore: [
        new ProjectWriteError(SET_OWN_PROJECT_THUMBNAIL, new Error("boom")),
      ],
    });

    const error = await stub.service
      .saveThumbnail(USER, "project-1", Buffer.from("thumb"), "image/png")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_create_failed");
    expect(error?.message).toBe("Failed to save thumbnail reference.");
    // A real answer from the database is not replayed: one attempt, no signing.
    expect(stub.writeCalls).toHaveLength(1);
    expect(stub.signedCalls).toEqual([]);
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
      writeUpdated?: number;
      withRepository?: boolean;
    } = {},
  ) {
    const calls: RepositoryCall[] = [];
    const client = makeStorageOnlyClient();

    const repository = {
      async findReadableProject(input: Record<string, unknown>) {
        calls.push({ method: "findReadableProject", input });
        if (config.detailError) throw config.detailError;
        return config.detail ?? null;
      },
    };

    const writeStub = makeWriteRepositoryStub({
      archiveUpdated: config.writeUpdated ?? 1,
      ...(config.updateError ? { archiveError: config.updateError as Error } : {}),
    });

    const service = createProjectService({
      createUserClient: () => client.client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      ...(config.withRepository === false
        ? {}
        : {
            projectReadRepository:
              repository as unknown as ProjectReadRepository,
          }),
      projectWriteRepository: writeStub.repository,
    });

    return { service, calls, writeCalls: writeStub.calls };
  }

  it("case 16: the lookup asks the repository first, then the archive write runs once", async () => {
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
    // Exactly one write, with the actor and the project: the timestamp is the
    // statement's `now()` now, so nothing here carries a value any more.
    expect(harness.writeCalls).toEqual([
      {
        method: ARCHIVE_OWN_PROJECT,
        input: { actorId: USER_ID, projectId: "project-1" },
      },
    ]);
  });

  it("case 16b: a write that touches no row is still the existing success, not a 404", async () => {
    // This is the administrator's path: readable, not writable. The removed write
    // answered 204 as well, because an update behind `USING` that matched nothing
    // is not an error.
    const harness = makeArchiveHarness({ detail: DETAIL_ROW, writeUpdated: 0 });

    await expect(
      harness.service.archiveProject(USER, "project-1"),
    ).resolves.toBeUndefined();

    expect(harness.writeCalls).toHaveLength(1);
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
    expect(harness.writeCalls).toEqual([]);
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
    expect(harness.writeCalls).toEqual([]);
  });

  it("case 18b: a failed archive write is the same fixed 500 project_delete_failed", async () => {
    const harness = makeArchiveHarness({
      detail: DETAIL_ROW,
      updateError: new Error("project write failed (archiveOwnProject)"),
    });

    const error = await harness.service
      .archiveProject(USER, "project-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_delete_failed");
    expect(error?.message).toBe("Unable to delete project.");
    expect(error?.message).not.toContain("archiveOwnProject");
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
    expect(harness.writeCalls).toEqual([]);
  });
});

// ADR-0001 / workorder 21AA: `PATCH /api/projects/:projectId` is one fixed statement
// in the write repository's hands. What has to hold at the service boundary: the
// patch that goes down, the empty patch that goes nowhere, the 500 on a throw, and
// the 204 on a zero count (the removed 404 branch was unreachable, because the
// update never asked for a row count).
describe("updateProject delegating to the project write repository", () => {
  function makeUpdateHarness(
    config: { writeUpdated?: number; writeError?: Error } = {},
  ) {
    const client = makeStorageOnlyClient();
    const writeStub = makeWriteRepositoryStub({
      updateUpdated: config.writeUpdated ?? 1,
      ...(config.writeError ? { updateError: config.writeError } : {}),
    });

    const service = createProjectService({
      createUserClient: () => client.client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectWriteRepository: writeStub.repository,
    });

    return { service, writeCalls: writeStub.calls };
  }

  it("case 23: a name-only patch reaches the repository with the actor and the project", async () => {
    const harness = makeUpdateHarness();

    await expect(
      harness.service.updateProject(USER, "project-1", { name: "Renamed" }),
    ).resolves.toBeUndefined();

    expect(harness.writeCalls).toEqual([
      {
        method: UPDATE_OWN_PROJECT,
        input: {
          actorId: USER_ID,
          projectId: "project-1",
          patch: { name: "Renamed" },
        },
      },
    ]);
  });

  it("case 24: a brand-kit patch keeps an explicit null, so clearing is distinguishable", async () => {
    const harness = makeUpdateHarness();

    await harness.service.updateProject(USER, "project-1", {
      brand_kit_id: null,
    });

    expect(harness.writeCalls).toEqual([
      {
        method: UPDATE_OWN_PROJECT,
        input: {
          actorId: USER_ID,
          projectId: "project-1",
          patch: { brand_kit_id: null },
        },
      },
    ]);
  });

  it("case 25: an empty patch calls the repository zero times", async () => {
    const harness = makeUpdateHarness();

    await expect(
      harness.service.updateProject(USER, "project-1", {}),
    ).resolves.toBeUndefined();

    expect(harness.writeCalls).toEqual([]);
  });

  it("case 26: a failed write is the existing project_update_failed 500", async () => {
    const harness = makeUpdateHarness({
      writeError: new Error("project write failed (updateOwnProject)"),
    });

    const error = await harness.service
      .updateProject(USER, "project-1", { name: "Renamed" })
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectServiceError);

    expect(error).toBeInstanceOf(ProjectServiceError);
    expect(error?.statusCode).toBe(500);
    expect(error?.code).toBe("project_update_failed");
    expect(error?.message).toBe("Unable to update project.");
    expect(error?.message).not.toContain("updateOwnProject");
  });

  it("case 27: a zero-row patch is still a 204, never the old unreachable 404", async () => {
    const harness = makeUpdateHarness({ writeUpdated: 0 });

    await expect(
      harness.service.updateProject(USER, "project-1", { name: "Renamed" }),
    ).resolves.toBeUndefined();

    expect(harness.writeCalls).toHaveLength(1);
  });
});

// 工单20E: the thumbnail's workspace lookup is still a plain SELECT, so it keeps
// its transport retry (3 attempts, 400ms/800ms) — but only for transport
// failures, and the final answer is a fixed 503 that names nothing.
describe("saveThumbnail lookup retry", () => {
  // 工单20E fixup: this lookup now runs through the pg repository, so the retry
  // contract is pinned against the shapes that driver really produces — not the
  // PostgREST/proxy `TypeError: fetch failed` this path used to see. A
  // node-postgres disconnect has NO code (`Connection terminated unexpectedly`);
  // the socket error underneath it carries a Node code.
  const PG_DISCONNECT_CAUSE = new Error("Connection terminated unexpectedly");
  const ECONNRESET_CAUSE = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });
  const ETIMEDOUT_CAUSE = Object.assign(
    new Error("connect ETIMEDOUT 198.18.0.20:5432"),
    { code: "ETIMEDOUT" },
  );
  const PG_CAUSE = Object.assign(
    new Error("invalid input syntax for type uuid"),
    { code: "22P02" },
  );

  function makeRetryHarness(options: {
    failures: number;
    /** Cause for failure N (the last entry repeats if there are more failures). */
    causes: readonly unknown[];
  }) {
    const attempts: number[] = [];
    const inputs: Array<Record<string, unknown>> = [];
    const uploads: string[] = [];
    const recordStub = makeRecordRepositoryStub();

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
            options.causes[
              Math.min(attempts.length - 1, options.causes.length - 1)
            ],
          );
        }

        return { workspace_id: TEAM_ID };
      },
    };

    // ADR-0001 / workorder 21AA: the reference write is the write repository's, and
    // the client below carries ONLY Storage and the RPC — its table accessor throws.
    const client = makeStorageOnlyClient();
    const writeStub = makeWriteRepositoryStub();

    const service = createProjectService({
      createUserClient: () => client.client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      assetRecordRepository: recordStub.repository,
      projectReadRepository: repository as unknown as ProjectReadRepository,
      projectWriteRepository: writeStub.repository,
    });

    return {
      service,
      attempts,
      inputs,
      uploads: client.uploads,
      recordCalls: recordStub.calls,
      writeCalls: writeStub.calls,
    };
  }

  // The two failures below are the two real pg transport shapes: the driver's own
  // no-code disconnect first, then the socket error underneath it.
  it("case 20: two transport failures are replayed after 400ms and 800ms, and the third attempt succeeds", async () => {
    const harness = makeRetryHarness({
      failures: 2,
      causes: [PG_DISCONNECT_CAUSE, ECONNRESET_CAUSE],
    });

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
      expect(harness.recordCalls).toHaveLength(1);
      expect(harness.recordCalls[0]).toMatchObject({
        bucket: "project-assets",
        objectPath: `${TEAM_ID}/project-1/thumbnail.png`,
        createdBy: USER_ID,
        fallbackWorkspaceId: TEAM_ID,
        projectId: "project-1",
        canvasId: null,
      });
      expect(harness.writeCalls).toEqual([
        {
          method: SET_OWN_PROJECT_THUMBNAIL,
          input: {
            actorId: USER_ID,
            projectId: "project-1",
            thumbnailPath: `${TEAM_ID}/project-1/thumbnail.png`,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 21: a real database failure is not replayed and the fixed 503 leaks nothing", async () => {
    // 22P02 keeps failing: if the predicate ever treated a SQLSTATE as transport,
    // this case would retry it three times instead of one.
    const harness = makeRetryHarness({ failures: 3, causes: [PG_CAUSE] });

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
    expect(harness.recordCalls).toEqual([]);
    expect(harness.writeCalls).toEqual([]);
  });

  it("case 22: three transport failures stop after three attempts with the same fixed 503", async () => {
    // Three consecutive real pg/Node transport failures — no Supabase fetch shape
    // anywhere in this path any more.
    const harness = makeRetryHarness({
      failures: 3,
      causes: [PG_DISCONNECT_CAUSE, ECONNRESET_CAUSE, ETIMEDOUT_CAUSE],
    });

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
      expect(harness.recordCalls).toEqual([]);
      expect(harness.writeCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// GN-14: a list card shows a 400px cover thumbnail rendered by storage — never the
// stored original — unless the deployment has switched the renderer off, in which
// case the list keeps the plain stored-object signature (same switch as the canvas).
describe("GN-14 list thumbnails go through the storage renderer", () => {
  it("GN-14: list thumbnails are signed as a 400px cover transform in webp", async () => {
    const withThumbnail = {
      ...PROJECT_ROW,
      thumbnail_path: `${TEAM_ID}/project-1/thumbnail.webp`,
    };
    const { client, calls } = makeTransformSigningClient();
    const { repository } = makeRepositoryStub({
      projects: [withThumbnail],
      canvases: [CANVAS_ROW],
    });
    const service = createProjectService({
      createUserClient: () => client,
      viewerService: makeViewerStub(TEAM_WORKSPACE),
      projectReadRepository: repository,
      projectWriteRepository: makeWriteRepositoryStub().repository,
    });

    const projects = await service.listProjects(USER);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      transform: { width: 400, height: 400, resize: "cover" },
    });
    expect(projects[0]?.thumbnailUrl).toContain("format=webp");
  });

  it("GN-14: with the renderer switched off the list falls back to the plain signature", async () => {
    vi.stubEnv("LOOMIC_CANVAS_DISPLAY_TRANSFORM", "0");
    try {
      const withThumbnail = {
        ...PROJECT_ROW,
        thumbnail_path: `${TEAM_ID}/project-1/thumbnail.webp`,
      };
      const { client, calls } = makeTransformSigningClient();
      const { repository } = makeRepositoryStub({
        projects: [withThumbnail],
        canvases: [CANVAS_ROW],
      });
      const service = createProjectService({
        createUserClient: () => client,
        viewerService: makeViewerStub(TEAM_WORKSPACE),
        projectReadRepository: repository,
        projectWriteRepository: makeWriteRepositoryStub().repository,
      });

      const projects = await service.listProjects(USER);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.options).toBeUndefined();
      expect(projects[0]?.thumbnailUrl).not.toContain("format=webp");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
