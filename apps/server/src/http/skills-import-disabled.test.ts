import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_ID = "00000000-0000-0000-0000-00000000000a";
const STRANGER_ID = "00000000-0000-0000-0000-00000000000c";

const MEMBER_TOKEN = "member-token";
const STRANGER_TOKEN = "stranger-token";

let outboundFetches = 0;

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const id = token === MEMBER_TOKEN ? MEMBER_ID : token === STRANGER_TOKEN ? STRANGER_ID : null;
    if (!id) return null;
    return {
      accessToken: token,
      email: "member@hahart.test",
      id,
      userMetadata: {},
    } satisfies AuthenticatedUser;
  },
};

const teamMembership: TeamMembershipService = {
  async get(userId) {
    if (userId !== MEMBER_ID) return null;
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: "owner-1",
      },
      role: "member",
    };
  },
  invalidate() {},
};

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
      teamWorkspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        ownerUserId: "owner-1",
        type: "team",
      },
      teamMembership: { role: "member", userId: user.id, workspaceId: TEAM_ID },
    } as never;
  },
} as unknown as ViewerService;

const projectService = {
  async listProjects() {
    return [];
  },
} as unknown as ProjectService;

const teamAdminService = {
  async listMembers() {
    return [];
  },
  async recordForeignRead() {},
} as unknown as TeamAdminService;

const uploadService = {
  async getAssetUrl() {
    return "";
  },
} as unknown as UploadService;

let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const IMPORT_URL = "/api/skills/import";

beforeEach(() => {
  outboundFetches = 0;
  // Counts (and refuses) any outbound request the route might try to make.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    outboundFetches += 1;
    throw new Error("outbound fetch is not allowed in this test");
  });
  app = buildApp({
    auth,
    env: {},
    projectService,
    teamAdminService,
    teamMembershipService: teamMembership,
    uploadService,
    viewerService,
  });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe("skill link import is disabled", () => {
  it("case 1: a member gets 410 and the process makes no outbound request", async () => {
    const response = await app.inject({
      method: "POST",
      url: IMPORT_URL,
      headers: bearer(MEMBER_TOKEN),
      payload: { url: "http://127.0.0.1:8080/x.tgz" },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: {
        code: "feature_disabled",
        message: "Importing skills from a link is disabled in this release.",
      },
    });
    expect(outboundFetches).toBe(0);
  });

  it("case 2: the answer does not depend on the body being usable", async () => {
    const noBody = await app.inject({
      method: "POST",
      url: IMPORT_URL,
      headers: bearer(MEMBER_TOKEN),
    });
    expect(noBody.statusCode).toBe(410);
    expect(noBody.json().error.code).toBe("feature_disabled");

    const notJson = await app.inject({
      method: "POST",
      url: IMPORT_URL,
      headers: { ...bearer(MEMBER_TOKEN), "content-type": "text/plain" },
      payload: "this is not json at all",
    });
    expect(notJson.statusCode).toBe(410);
    expect(notJson.json().error.code).toBe("feature_disabled");

    expect(outboundFetches).toBe(0);
  });

  it("case 3: no token is still a 401", async () => {
    const response = await app.inject({ method: "POST", url: IMPORT_URL });

    expect(response.statusCode).toBe(401);
  });

  it("case 4: a non-member is stopped by the team gate", async () => {
    const response = await app.inject({
      method: "POST",
      url: IMPORT_URL,
      headers: bearer(STRANGER_TOKEN),
      payload: { url: "http://127.0.0.1:8080/x.tgz" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("not_team_member");
  });
});
