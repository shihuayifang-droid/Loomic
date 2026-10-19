import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import { SkillRepositoryError } from "../db/skill-repository.js";
import type {
  SkillFileInput,
  SkillFileRecord,
  SkillInsertFields,
  SkillPatch,
  SkillRepository,
  SkillRow,
  WorkspaceInstalledSkillRow,
} from "../db/skill-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  MarketplaceError,
  installFromMarketplace,
} from "../features/skills/marketplace-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";

/**
 * Route-level contract tests for the two skill files (workorder 21AE).
 *
 * The whole point of this ticket is that the ROUTES did not change: they swapped
 * the call target from a PostgREST wrapper to `SkillRepository`, and every status
 * code, error code, message and swallowed failure has to stay exactly where it
 * was. So every case here asserts the three published facts (`status`, `code`,
 * `message`) of the §1 table, and the six swallowed failures are each driven with
 * a throwing repository double to prove they do not travel outwards.
 *
 * Two things are observed rather than asserted in prose:
 *
 * - `createUserClient` is injected as a factory that RECORDS its calls and throws.
 *   `afterEach` demands that no case ever built a user-scoped Supabase client,
 *   which is the machine-checkable half of "these routes no longer reach
 *   PostgREST".
 * - the repository double records every call with its arguments, so "the route
 *   passed the actor, the workspace and the flag down" is a fact of the run.
 *
 * The app-wide member gate (`http/team-gate.ts`) runs BEFORE every `/api/` route
 * and answers 403/503 when the membership lookup fails. It is unchanged by this
 * ticket, so the harness satisfies it.
 */

/**
 * The install route's one outbound step is replaced, so a case can drive its
 * SUCCESS and its `MarketplaceError` without an npm request. Everything else in
 * that module (the `MarketplaceError` class included) stays real, so the route's
 * `instanceof` check is exercised against the production class.
 */
vi.mock("../features/skills/marketplace-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../features/skills/marketplace-service.js")
    >();
  return { ...actual, installFromMarketplace: vi.fn() };
});

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_ID = "00000000-0000-0000-0000-00000000000a";
const MEMBER_TOKEN = "member-token";

const SKILL_ID = "00000000-0000-0000-0000-0000000f4001";
const SECOND_SKILL_ID = "00000000-0000-0000-0000-0000000f4002";
const FILE_ID = "00000000-0000-0000-0000-0000000f4101";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    if (token !== MEMBER_TOKEN) return null;
    return {
      accessToken: token,
      email: "member@hahart.test",
      id: MEMBER_ID,
      userMetadata: {},
    } satisfies AuthenticatedUser;
  },
};

const teamMembershipService = {
  async get() {
    return {
      workspace: { id: TEAM_ID, name: "HaHart 团队", type: "team", ownerUserId: MEMBER_ID },
      role: "member",
    };
  },
  invalidate() {},
} as unknown as TeamMembershipService;

const viewerService = {
  async ensureViewer(user: AuthenticatedUser) {
    return {
      profile: { avatarUrl: null, displayName: "A", email: user.email, id: user.id },
      workspace: {
        id: PERSONAL_ID,
        name: "Personal",
        ownerUserId: user.id,
        type: "personal",
      },
      membership: { role: "owner", userId: user.id, workspaceId: PERSONAL_ID },
    } as never;
  },
} as unknown as ViewerService;

let userFactoryCalls: string[];

/**
 * A user-scoped Supabase client must never be built by these two files again. The
 * factory records the call and throws, so a regression fails loudly instead of
 * quietly talking to PostgREST.
 */
function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);
  throw new Error(
    "the skill routes must not build a user-scoped Supabase client any more",
  );
}

// ---------------------------------------------------------------------------
// The repository double
// ---------------------------------------------------------------------------

type Handlers = {
  listVisibleSkills?: (actorId: string) => Promise<SkillRow[]>;
  findVisibleSkill?: (
    actorId: string,
    skillId: string,
  ) => Promise<SkillRow | null>;
  listVisibleSkillFiles?: (
    actorId: string,
    skillId: string,
  ) => Promise<SkillFileRecord[]>;
  listWorkspaceInstalledSkills?: (
    actorId: string,
    workspaceId: string,
  ) => Promise<WorkspaceInstalledSkillRow[]>;
  insertOwnSkill?: (
    actorId: string,
    fields: SkillInsertFields,
  ) => Promise<SkillRow>;
  insertOwnSkillFiles?: (
    actorId: string,
    skillId: string,
    files: readonly SkillFileInput[],
  ) => Promise<{ inserted: number }>;
  updateOwnSkill?: (
    actorId: string,
    skillId: string,
    patch: SkillPatch,
  ) => Promise<SkillRow | null>;
  deleteOwnSkill?: (
    actorId: string,
    skillId: string,
  ) => Promise<{ deleted: number }>;
  upsertWorkspaceSkill?: (
    actorId: string,
    workspaceId: string,
    skillId: string,
    enabled: boolean,
  ) => Promise<void>;
  deleteWorkspaceSkill?: (
    actorId: string,
    workspaceId: string,
    skillId: string,
  ) => Promise<{ deleted: number }>;
};

type RecordedCall = { method: keyof Handlers; args: readonly unknown[] };

/** A call the case did not authorise: a route reaching for something it should not. */
function unexpected(method: string): never {
  throw new Error(`unexpected repository call: ${method}`);
}

function createStubRepository(handlers: Handlers): {
  repository: SkillRepository;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const repository: SkillRepository = {
    async listVisibleSkills(actorId) {
      calls.push({ method: "listVisibleSkills", args: [actorId] });
      return (
        handlers.listVisibleSkills ?? (() => unexpected("listVisibleSkills"))
      )(actorId);
    },
    async findVisibleSkill(actorId, skillId) {
      calls.push({ method: "findVisibleSkill", args: [actorId, skillId] });
      return (
        handlers.findVisibleSkill ?? (() => unexpected("findVisibleSkill"))
      )(actorId, skillId);
    },
    async listVisibleSkillFiles(actorId, skillId) {
      calls.push({ method: "listVisibleSkillFiles", args: [actorId, skillId] });
      return (
        handlers.listVisibleSkillFiles ??
        (() => unexpected("listVisibleSkillFiles"))
      )(actorId, skillId);
    },
    async listWorkspaceInstalledSkills(actorId, workspaceId) {
      calls.push({
        method: "listWorkspaceInstalledSkills",
        args: [actorId, workspaceId],
      });
      return (
        handlers.listWorkspaceInstalledSkills ??
        (() => unexpected("listWorkspaceInstalledSkills"))
      )(actorId, workspaceId);
    },
    async insertOwnSkill(actorId, fields) {
      calls.push({ method: "insertOwnSkill", args: [actorId, fields] });
      return (handlers.insertOwnSkill ?? (() => unexpected("insertOwnSkill")))(
        actorId,
        fields,
      );
    },
    async insertOwnSkillFiles(actorId, skillId, files) {
      calls.push({
        method: "insertOwnSkillFiles",
        args: [actorId, skillId, files],
      });
      return (
        handlers.insertOwnSkillFiles ??
        (() => unexpected("insertOwnSkillFiles"))
      )(actorId, skillId, files);
    },
    async updateOwnSkill(actorId, skillId, patch) {
      calls.push({ method: "updateOwnSkill", args: [actorId, skillId, patch] });
      return (
        handlers.updateOwnSkill ?? (() => unexpected("updateOwnSkill"))
      )(actorId, skillId, patch);
    },
    async deleteOwnSkill(actorId, skillId) {
      calls.push({ method: "deleteOwnSkill", args: [actorId, skillId] });
      return (
        handlers.deleteOwnSkill ?? (() => unexpected("deleteOwnSkill"))
      )(actorId, skillId);
    },
    async upsertWorkspaceSkill(actorId, workspaceId, skillId, enabled) {
      calls.push({
        method: "upsertWorkspaceSkill",
        args: [actorId, workspaceId, skillId, enabled],
      });
      return (
        handlers.upsertWorkspaceSkill ??
        (() => unexpected("upsertWorkspaceSkill"))
      )(actorId, workspaceId, skillId, enabled);
    },
    async deleteWorkspaceSkill(actorId, workspaceId, skillId) {
      calls.push({
        method: "deleteWorkspaceSkill",
        args: [actorId, workspaceId, skillId],
      });
      return (
        handlers.deleteWorkspaceSkill ??
        (() => unexpected("deleteWorkspaceSkill"))
      )(actorId, workspaceId, skillId);
    },
  };

  return { repository, calls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILL_ROW: SkillRow = {
  id: SKILL_ID,
  name: "Canvas Design",
  slug: "canvas-design",
  description: "Design on the canvas",
  author: "anthropic",
  version: "1.0",
  license: "Apache-2.0",
  category: "design",
  icon_name: "palette",
  source: "system",
  skill_content: "# SKILL\nDo the thing.",
  metadata: { tags: ["design"] },
  is_featured: true,
  created_by: null,
  created_at: "2026-10-19T12:00:00.000Z",
  updated_at: "2026-10-19T12:05:00.000Z",
  source_url: null,
  package_name: null,
};

const FILE_RECORD: SkillFileRecord = {
  id: FILE_ID,
  skill_id: SKILL_ID,
  file_path: "scripts/analyze.py",
  content: "print('hi')\n",
  mime_type: "text/plain",
  created_at: "2026-10-19T12:00:00.000Z",
  updated_at: "2026-10-19T12:00:00.000Z",
};

/** What `mapSkillFileRow` publishes, i.e. the JSON the response carries. */
const MAPPED_FILE = {
  id: FILE_ID,
  filePath: "scripts/analyze.py",
  content: "print('hi')\n",
  mimeType: "text/plain",
  createdAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
};

/** The `SkillRepositoryError` shape a driver failure reaches the route as. */
function repositoryError(operation: string, sqlstate: string | null): SkillRepositoryError {
  return new SkillRepositoryError(
    operation as never,
    Object.assign(new Error("driver failure carrying SQL text"), {
      ...(sqlstate === null ? {} : { code: sqlstate }),
    }),
  );
}

let app: FastifyInstance | undefined;
let repositoryCalls: RecordedCall[];

function buildAppWith(handlers: Handlers): void {
  const stub = createStubRepository(handlers);
  repositoryCalls = stub.calls;

  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    env: {},
    skillRepository: stub.repository,
    teamMembershipService,
    viewerService,
  });
}

/**
 * Swap the double MID-TEST (two status codes of the same route in one case). The
 * previous app has to be closed first, otherwise its hooks outlive the assertion.
 */
async function switchRepository(handlers: Handlers): Promise<void> {
  await app?.close();
  buildAppWith(handlers);
}

const bearer = () => ({ authorization: `Bearer ${MEMBER_TOKEN}` });

async function inject(options: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  payload?: unknown;
  authorized?: boolean;
}) {
  return (app as FastifyInstance).inject({
    method: options.method,
    url: options.url,
    headers: options.authorized === false ? {} : bearer(),
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

beforeEach(() => {
  userFactoryCalls = [];
  // Any outbound request the marketplace search/detail routes might try is refused.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("outbound fetch is not allowed in this test");
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  // The machine-checkable half of "these routes no longer reach PostgREST".
  expect(userFactoryCalls).toEqual([]);
});

// ---------------------------------------------------------------------------
// GET /api/skills (R1)
// ---------------------------------------------------------------------------

describe("GET /api/skills", () => {
  it("case 1: answers the visible catalogue through the repository for the authenticated actor", async () => {
    buildAppWith({ listVisibleSkills: async () => [SKILL_ROW] });

    const response = await inject({ method: "GET", url: "/api/skills" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      skills: [
        {
          id: SKILL_ID,
          name: "Canvas Design",
          slug: "canvas-design",
          description: "Design on the canvas",
          author: "anthropic",
          version: "1.0",
          category: "design",
          iconName: "palette",
          source: "system",
          isFeatured: true,
          metadata: { tags: ["design"] },
          createdAt: "2026-10-19T12:00:00.000Z",
          updatedAt: "2026-10-19T12:05:00.000Z",
        },
      ],
    });
    expect(repositoryCalls).toEqual([
      { method: "listVisibleSkills", args: [MEMBER_ID] },
    ]);
  });

  it("case 2: a read failure is 500 skill_query_failed with the published message", async () => {
    buildAppWith({
      listVisibleSkills: async () => {
        throw repositoryError("listVisibleSkills", null);
      },
    });

    const response = await inject({ method: "GET", url: "/api/skills" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "skill_query_failed",
        message: "Unable to load skills.",
      },
    });
  });

  it("case 3: no token is still a 401 and the repository is never consulted", async () => {
    buildAppWith({ listVisibleSkills: async () => [SKILL_ROW] });

    const response = await inject({
      method: "GET",
      url: "/api/skills",
      authorized: false,
    });

    expect(response.statusCode).toBe(401);
    expect(repositoryCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/skills/:id (R2 + R3)
// ---------------------------------------------------------------------------

describe("GET /api/skills/:id", () => {
  it("case 4: answers the skill detail WITH its files, both through the repository", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      listVisibleSkillFiles: async () => [FILE_RECORD],
    });

    const response = await inject({ method: "GET", url: `/api/skills/${SKILL_ID}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.skill.id).toBe(SKILL_ID);
    expect(body.skill.skillContent).toBe("# SKILL\nDo the thing.");
    expect(body.skill.license).toBe("Apache-2.0");
    expect(body.skill.createdBy).toBeNull();
    expect(body.skill.sourceUrl).toBeNull();
    expect(body.skill.packageName).toBeNull();
    expect(body.skill.files).toEqual([MAPPED_FILE]);

    expect(repositoryCalls).toEqual([
      { method: "findVisibleSkill", args: [MEMBER_ID, SKILL_ID] },
      { method: "listVisibleSkillFiles", args: [MEMBER_ID, SKILL_ID] },
    ]);
  });

  it("case 5: a FAILED file read is swallowed, so the detail still answers 200 with no files", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      listVisibleSkillFiles: async () => {
        throw repositoryError("listVisibleSkillFiles", "22P02");
      },
    });

    const response = await inject({ method: "GET", url: `/api/skills/${SKILL_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().skill.id).toBe(SKILL_ID);
    expect(response.json().skill.files).toEqual([]);
  });

  it("case 6: an invisible or missing skill is 404 skill_not_found", async () => {
    buildAppWith({
      findVisibleSkill: async () => null,
      listVisibleSkillFiles: async () => unexpected("listVisibleSkillFiles"),
    });

    const response = await inject({ method: "GET", url: `/api/skills/${SKILL_ID}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "skill_not_found", message: "Skill not found." },
    });
  });

  it("case 7: a malformed uuid is a 500 skill_query_failed, exactly as the removed read answered", async () => {
    buildAppWith({
      findVisibleSkill: async () => {
        throw repositoryError("findVisibleSkill", "22P02");
      },
    });

    const response = await inject({ method: "GET", url: "/api/skills/not-a-uuid" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "skill_query_failed", message: "Unable to load skill." },
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/skills/:id/files (R4)
// ---------------------------------------------------------------------------

describe("GET /api/skills/:id/files", () => {
  it("case 8: answers the raw `{ files }` object — no response schema, no wrapper", async () => {
    buildAppWith({ listVisibleSkillFiles: async () => [FILE_RECORD] });

    const response = await inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}/files`,
    });

    expect(response.statusCode).toBe(200);
    // Exactly one key: the route never sent this body through a schema.
    expect(Object.keys(response.json())).toEqual(["files"]);
    expect(response.json()).toEqual({ files: [MAPPED_FILE] });
  });

  it("case 9: an invisible or missing skill is 200 with an EMPTY array", async () => {
    buildAppWith({ listVisibleSkillFiles: async () => [] });

    const response = await inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}/files`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ files: [] });
  });

  it("case 10: a read failure is 500 skill_file_query_failed", async () => {
    buildAppWith({
      listVisibleSkillFiles: async () => {
        throw repositoryError("listVisibleSkillFiles", "22P02");
      },
    });

    const response = await inject({
      method: "GET",
      url: `/api/skills/${SKILL_ID}/files`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "skill_file_query_failed",
        message: "Unable to load skill files.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/skills (R5 + R6 + R7)
// ---------------------------------------------------------------------------

describe("POST /api/skills", () => {
  const payload = {
    name: "My Skill",
    description: "Does things",
    category: "custom",
    skillContent: "# my skill",
  };

  it("case 11: creates the skill for the actor and answers 201 with the files read back", async () => {
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      listVisibleSkillFiles: async () => [FILE_RECORD],
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills",
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.id).toBe(SKILL_ID);
    expect(response.json().skill.files).toEqual([MAPPED_FILE]);

    // The route derived the slug and kept `icon_name` explicitly null, exactly as
    // the removed insert payload did.
    expect(repositoryCalls[0]).toEqual({
      method: "insertOwnSkill",
      args: [
        MEMBER_ID,
        {
          name: "My Skill",
          slug: "my-skill",
          description: "Does things",
          category: "custom",
          skillContent: "# my skill",
          iconName: null,
        },
      ],
    });
    // No files were sent, so no file insert was attempted.
    expect(repositoryCalls.some((call) => call.method === "insertOwnSkillFiles")).toBe(
      false,
    );
  });

  it("case 12: a unique-slug conflict is 409 with its own message", async () => {
    buildAppWith({
      insertOwnSkill: async () => {
        throw repositoryError("insertOwnSkill", "23505");
      },
    });

    const response = await inject({ method: "POST", url: "/api/skills", payload });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "skill_create_failed",
        message:
          "A skill with a similar name already exists. Please choose a different name.",
      },
    });
  });

  it("case 13: any other insert failure is 500 with the published message", async () => {
    buildAppWith({
      insertOwnSkill: async () => {
        throw repositoryError("insertOwnSkill", "42501");
      },
    });

    const response = await inject({ method: "POST", url: "/api/skills", payload });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "skill_create_failed", message: "Unable to create skill." },
    });
  });

  it("case 14: a FAILED file insert is swallowed — the skill is still 201", async () => {
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      insertOwnSkillFiles: async () => {
        throw repositoryError("insertOwnSkillFiles", "23514");
      },
      listVisibleSkillFiles: async () => [],
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        ...payload,
        files: [{ filePath: "scripts/a.py", content: "print(1)\n" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.id).toBe(SKILL_ID);
    expect(response.json().skill.files).toEqual([]);

    // The insert WAS attempted, with the default mime type filled in.
    const insert = repositoryCalls.find(
      (call) => call.method === "insertOwnSkillFiles",
    );
    expect(insert?.args).toEqual([
      MEMBER_ID,
      SKILL_ID,
      [{ filePath: "scripts/a.py", content: "print(1)\n", mimeType: "text/plain" }],
    ]);
  });

  it("case 15: a FAILED read-back is swallowed — 201 with an empty file list", async () => {
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      listVisibleSkillFiles: async () => {
        throw repositoryError("listVisibleSkillFiles", null);
      },
    });

    const response = await inject({ method: "POST", url: "/api/skills", payload });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.files).toEqual([]);
  });

  it("case 16: an invalid body is still 400 with the Zod issues", async () => {
    buildAppWith({ insertOwnSkill: async () => SKILL_ROW });

    const response = await inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "x" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid request body");
    expect(Array.isArray(response.json().issues)).toBe(true);
    expect(repositoryCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/skills/:id (R8)
// ---------------------------------------------------------------------------

describe("PUT /api/skills/:id", () => {
  it("case 17: 'no fields to update' is still a 400 answered BEFORE the database", async () => {
    buildAppWith({ updateOwnSkill: async () => unexpected("updateOwnSkill") });

    const response = await inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "skill_update_failed", message: "No fields to update." },
    });
    expect(repositoryCalls).toEqual([]);
  });

  it("case 18: a rename recomputes the slug, updates through the repository and answers WITHOUT files", async () => {
    buildAppWith({
      updateOwnSkill: async (_actorId, _skillId, patch) => ({
        ...SKILL_ROW,
        name: patch.name ?? SKILL_ROW.name,
        slug: patch.slug ?? SKILL_ROW.slug,
      }),
    });

    const response = await inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: { name: "Renamed Skill" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().skill.name).toBe("Renamed Skill");
    expect(response.json().skill.slug).toBe("renamed-skill");
    // The update answer never carries files.
    expect(response.json().skill.files).toBeUndefined();

    expect(repositoryCalls).toEqual([
      {
        method: "updateOwnSkill",
        args: [
          MEMBER_ID,
          SKILL_ID,
          { name: "Renamed Skill", slug: "renamed-skill" },
        ],
      },
    ]);
  });

  it("case 19: a unique-slug conflict is 409 with its own message", async () => {
    buildAppWith({
      updateOwnSkill: async () => {
        throw repositoryError("updateOwnSkill", "23505");
      },
    });

    const response = await inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: { name: "Taken" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "skill_update_failed",
        message: "A skill with a similar name already exists.",
      },
    });
  });

  it("case 20: zero rows is 404 with the 'or you do not have permission' message, and any other failure is 500", async () => {
    buildAppWith({ updateOwnSkill: async () => null });

    const notFound = await inject({
      method: "PUT",
      url: `/api/skills/${SKILL_ID}`,
      payload: { description: "x" },
    });

    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({
      error: {
        code: "skill_not_found",
        message: "Skill not found or you do not have permission to update it.",
      },
    });

    await switchRepository({
      updateOwnSkill: async () => {
        throw repositoryError("updateOwnSkill", "22P02");
      },
    });

    const failure = await inject({
      method: "PUT",
      url: "/api/skills/not-a-uuid",
      payload: { description: "x" },
    });

    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({
      error: { code: "skill_update_failed", message: "Unable to update skill." },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/skills/:id (R9)
// ---------------------------------------------------------------------------

describe("DELETE /api/skills/:id", () => {
  it("case 21: a deleted row answers 204, and zero rows answers 404 with its own message", async () => {
    buildAppWith({ deleteOwnSkill: async () => ({ deleted: 1 }) });

    const deleted = await inject({
      method: "DELETE",
      url: `/api/skills/${SKILL_ID}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(repositoryCalls).toEqual([
      { method: "deleteOwnSkill", args: [MEMBER_ID, SKILL_ID] },
    ]);

    await switchRepository({ deleteOwnSkill: async () => ({ deleted: 0 }) });

    const missing = await inject({
      method: "DELETE",
      url: `/api/skills/${SKILL_ID}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: {
        code: "skill_not_found",
        message: "Skill not found or you do not have permission to delete it.",
      },
    });
  });

  it("case 22: a delete failure is 500 skill_delete_failed", async () => {
    buildAppWith({
      deleteOwnSkill: async () => {
        throw repositoryError("deleteOwnSkill", "22P02");
      },
    });

    const response = await inject({
      method: "DELETE",
      url: "/api/skills/not-a-uuid",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "skill_delete_failed", message: "Unable to delete skill." },
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/skills (R10)
// ---------------------------------------------------------------------------

describe("GET /api/workspaces/skills", () => {
  it("case 23: publishes installed skills with their install status, disabled ones included", async () => {
    buildAppWith({
      listWorkspaceInstalledSkills: async () => [
        {
          ...SKILL_ROW,
          enabled: false,
          installed_at: "2026-10-18T09:30:00.000Z",
        },
      ],
    });

    const response = await inject({ method: "GET", url: "/api/workspaces/skills" });

    expect(response.statusCode).toBe(200);
    const [skill] = response.json().skills;
    expect(skill.id).toBe(SKILL_ID);
    expect(skill.installed).toBe(true);
    expect(skill.enabled).toBe(false);
    expect(skill.installedAt).toBe("2026-10-18T09:30:00.000Z");

    // The route asked for the VIEWER's workspace, not the query string.
    expect(repositoryCalls).toEqual([
      { method: "listWorkspaceInstalledSkills", args: [MEMBER_ID, PERSONAL_ID] },
    ]);
  });

  it("case 24: a read failure is 500 skill_query_failed 'Unable to load workspace skills.'", async () => {
    buildAppWith({
      listWorkspaceInstalledSkills: async () => {
        throw repositoryError("listWorkspaceInstalledSkills", null);
      },
    });

    const response = await inject({ method: "GET", url: "/api/workspaces/skills" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "skill_query_failed",
        message: "Unable to load workspace skills.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/skills (R11 + R12)
// ---------------------------------------------------------------------------

describe("POST /api/workspaces/skills", () => {
  it("case 25: a missing skillId is 400 'skillId is required.' before any query", async () => {
    buildAppWith({ findVisibleSkill: async () => unexpected("findVisibleSkill") });

    const response = await inject({
      method: "POST",
      url: "/api/workspaces/skills",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "skill_install_failed", message: "skillId is required." },
    });
    expect(repositoryCalls).toEqual([]);
  });

  it("case 26: no body at all is still a 500 — the frozen T-61 behaviour, not a fix", async () => {
    buildAppWith({ findVisibleSkill: async () => unexpected("findVisibleSkill") });

    const response = await inject({ method: "POST", url: "/api/workspaces/skills" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "skill_install_failed", message: "Unable to install skill." },
    });
  });

  it("case 27: an invisible AND a failing lookup both answer 404 'Skill not found.'", async () => {
    buildAppWith({ findVisibleSkill: async () => null });

    const missing = await inject({
      method: "POST",
      url: "/api/workspaces/skills",
      payload: { skillId: SKILL_ID },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: "skill_not_found", message: "Skill not found." },
    });

    // The lookup's own failure is swallowed into the same 404 — a malformed uuid
    // must not become a 500 on this route.
    await switchRepository({
      findVisibleSkill: async () => {
        throw repositoryError("findVisibleSkill", "22P02");
      },
    });

    const failing = await inject({
      method: "POST",
      url: "/api/workspaces/skills",
      payload: { skillId: "not-a-uuid" },
    });

    expect(failing.statusCode).toBe(404);
    expect(failing.json()).toEqual({
      error: { code: "skill_not_found", message: "Skill not found." },
    });
  });

  it("case 28: a successful install is 204 and enables the skill in the viewer's workspace", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      upsertWorkspaceSkill: async () => undefined,
    });

    const response = await inject({
      method: "POST",
      url: "/api/workspaces/skills",
      payload: { skillId: SKILL_ID },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(repositoryCalls).toEqual([
      { method: "findVisibleSkill", args: [MEMBER_ID, SKILL_ID] },
      {
        method: "upsertWorkspaceSkill",
        args: [MEMBER_ID, PERSONAL_ID, SKILL_ID, true],
      },
    ]);
  });

  it("case 29: a refused install — a non-admin — is 500 'Unable to install skill.'", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      upsertWorkspaceSkill: async () => {
        throw repositoryError("upsertWorkspaceSkill", null);
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/workspaces/skills",
      payload: { skillId: SKILL_ID },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "skill_install_failed", message: "Unable to install skill." },
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/skills/:skillId (R13)
// ---------------------------------------------------------------------------

describe("DELETE /api/workspaces/skills/:skillId", () => {
  it("case 30: a removed install is 204; zero rows is 404 'Skill is not installed in this workspace.' — not 403", async () => {
    buildAppWith({ deleteWorkspaceSkill: async () => ({ deleted: 1 }) });

    const removed = await inject({
      method: "DELETE",
      url: `/api/workspaces/skills/${SKILL_ID}`,
    });

    expect(removed.statusCode).toBe(204);
    expect(repositoryCalls).toEqual([
      {
        method: "deleteWorkspaceSkill",
        args: [MEMBER_ID, PERSONAL_ID, SKILL_ID],
      },
    ]);

    // A non-admin deletes zero rows. The status is 404 — the published behaviour of
    // this route, kept on purpose.
    await switchRepository({ deleteWorkspaceSkill: async () => ({ deleted: 0 }) });

    const refused = await inject({
      method: "DELETE",
      url: `/api/workspaces/skills/${SKILL_ID}`,
    });

    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({
      error: {
        code: "skill_not_found",
        message: "Skill is not installed in this workspace.",
      },
    });
  });

  it("case 31: a delete failure is 500 skill_uninstall_failed", async () => {
    buildAppWith({
      deleteWorkspaceSkill: async () => {
        throw repositoryError("deleteWorkspaceSkill", "22P02");
      },
    });

    const response = await inject({
      method: "DELETE",
      url: "/api/workspaces/skills/not-a-uuid",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "skill_uninstall_failed",
        message: "Unable to uninstall skill.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/skills/:skillId (R14 + R15)
// ---------------------------------------------------------------------------

describe("PATCH /api/workspaces/skills/:skillId", () => {
  it("case 32: a toggle that IMPLICITLY INSTALLS is 204, and the requested flag is passed down", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      upsertWorkspaceSkill: async () => undefined,
    });

    const response = await inject({
      method: "PATCH",
      url: `/api/workspaces/skills/${SKILL_ID}`,
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(204);
    expect(repositoryCalls).toEqual([
      { method: "findVisibleSkill", args: [MEMBER_ID, SKILL_ID] },
      {
        method: "upsertWorkspaceSkill",
        args: [MEMBER_ID, PERSONAL_ID, SKILL_ID, false],
      },
    ]);
  });

  it("case 33: an invisible skill is 404 'Skill not found.' and the toggle is never attempted", async () => {
    buildAppWith({
      findVisibleSkill: async () => null,
      upsertWorkspaceSkill: async () => unexpected("upsertWorkspaceSkill"),
    });

    const response = await inject({
      method: "PATCH",
      url: `/api/workspaces/skills/${SKILL_ID}`,
      payload: { enabled: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "skill_not_found", message: "Skill not found." },
    });
  });

  it("case 34: a toggle failure is 500 skill_toggle_failed, and an invalid body is 400", async () => {
    buildAppWith({
      findVisibleSkill: async () => SKILL_ROW,
      upsertWorkspaceSkill: async () => {
        throw repositoryError("upsertWorkspaceSkill", null);
      },
    });

    const failure = await inject({
      method: "PATCH",
      url: `/api/workspaces/skills/${SKILL_ID}`,
      payload: { enabled: true },
    });

    expect(failure.statusCode).toBe(500);
    expect(failure.json()).toEqual({
      error: { code: "skill_toggle_failed", message: "Unable to toggle skill." },
    });

    await switchRepository({ findVisibleSkill: async () => SKILL_ROW });

    const invalid = await inject({
      method: "PATCH",
      url: `/api/workspaces/skills/${SKILL_ID}`,
      payload: {},
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toBe("Invalid request body");
    expect(repositoryCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/skills/marketplace/install (M1..M4)
// ---------------------------------------------------------------------------

const IMPORTED = {
  manifest: {
    name: "Marketplace Skill",
    description: "From the registry",
    author: "someone",
    version: "2.0",
    license: "MIT",
    metadata: { tags: ["x"] },
  },
  skillContent: "# marketplace skill",
  files: [
    { filePath: "scripts/run.py", content: "print(1)\n", mimeType: "text/plain" },
  ],
  sourceUrl: "https://www.npmjs.com/package/pkg",
};

describe("POST /api/skills/marketplace/install", () => {
  beforeEach(() => {
    vi.mocked(installFromMarketplace).mockReset();
  });

  it("case 35: installs, auto-installs to the workspace and answers 201 with the files", async () => {
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "pkg",
    });
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      insertOwnSkillFiles: async () => ({ inserted: 1 }),
      upsertWorkspaceSkill: async () => undefined,
      listVisibleSkillFiles: async () => [FILE_RECORD],
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.id).toBe(SKILL_ID);
    expect(response.json().skill.files).toEqual([MAPPED_FILE]);

    // The marketplace columns AND the frozen T-61 shape: `source_url` /
    // `package_name` still travel inside `metadata`, not in their own columns.
    const insert = repositoryCalls.find(
      (call) => call.method === "insertOwnSkill",
    );
    expect(insert?.args).toEqual([
      MEMBER_ID,
      {
        name: "Marketplace Skill",
        slug: "marketplace-skill",
        description: "From the registry",
        author: "someone",
        version: "2.0",
        license: "MIT",
        category: "custom",
        skillContent: "# marketplace skill",
        metadata: {
          tags: ["x"],
          source_url: "https://www.npmjs.com/package/pkg",
          package_name: "pkg",
        },
      },
    ]);

    const install = repositoryCalls.find(
      (call) => call.method === "upsertWorkspaceSkill",
    );
    expect(install?.args).toEqual([MEMBER_ID, PERSONAL_ID, SKILL_ID, true]);
  });

  it("case 36: a duplicate slug is 409 'This skill is already installed.'", async () => {
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "pkg",
    });
    buildAppWith({
      insertOwnSkill: async () => {
        throw repositoryError("insertOwnSkill", "23505");
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "marketplace_install_failed",
        message: "This skill is already installed.",
      },
    });
  });

  it("case 37: any other insert failure is 500 'Failed to save marketplace skill.'", async () => {
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "pkg",
    });
    buildAppWith({
      insertOwnSkill: async () => {
        throw repositoryError("insertOwnSkill", "42501");
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "marketplace_install_failed",
        message: "Failed to save marketplace skill.",
      },
    });
  });

  it("case 38: a FAILED file insert and a FAILED workspace upsert are BOTH swallowed — still 201", async () => {
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "pkg",
    });
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      insertOwnSkillFiles: async () => {
        throw repositoryError("insertOwnSkillFiles", "23514");
      },
      // M3: the removed upsert's answer was never inspected, so a refusal cannot
      // change the status code.
      upsertWorkspaceSkill: async () => {
        throw repositoryError("upsertWorkspaceSkill", null);
      },
      listVisibleSkillFiles: async () => [],
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.files).toEqual([]);
    // Both were attempted: the swallow, not an omission.
    expect(
      repositoryCalls.map((call) => call.method).sort(),
    ).toEqual(["insertOwnSkill", "insertOwnSkillFiles", "listVisibleSkillFiles", "upsertWorkspaceSkill"]);
  });

  it("case 39: a FAILED read-back is swallowed — 201 with no files (M4)", async () => {
    vi.mocked(installFromMarketplace).mockResolvedValue({
      imported: IMPORTED,
      packageName: "pkg",
    });
    buildAppWith({
      insertOwnSkill: async () => SKILL_ROW,
      insertOwnSkillFiles: async () => ({ inserted: 1 }),
      upsertWorkspaceSkill: async () => undefined,
      listVisibleSkillFiles: async () => {
        throw repositoryError("listVisibleSkillFiles", null);
      },
    });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().skill.files).toEqual([]);
  });

  it("case 40: a MarketplaceError is 502 with its own message, before any database call", async () => {
    vi.mocked(installFromMarketplace).mockRejectedValue(
      new MarketplaceError("install_failed", "npm refused the download"),
    );
    buildAppWith({ insertOwnSkill: async () => SKILL_ROW });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { packageName: "pkg" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: {
        code: "marketplace_install_failed",
        message: "npm refused the download",
      },
    });
    expect(repositoryCalls).toEqual([]);
  });

  it("case 41: a ZodError on the request body is still a 500 — frozen T-61, not a 400", async () => {
    buildAppWith({ insertOwnSkill: async () => SKILL_ROW });

    const response = await inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: {},
    });

    // The route only special-cases `MarketplaceError`, so a ZodError falls through
    // to the generic 500. That is the behaviour this ticket freezes.
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "marketplace_install_failed",
        message: "Failed to install marketplace skill.",
      },
    });
    expect(repositoryCalls).toEqual([]);
  });
});
