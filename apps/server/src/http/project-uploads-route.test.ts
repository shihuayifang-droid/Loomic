// AS-06: GET /api/projects/:projectId/uploads — the reference tab's list.
//
// The route is thin on purpose: authentication, the two enum checks, and the
// service. What is proved here is that the enums are refused BEFORE the service is
// asked (a silently ignored `?order=random` would answer a list nobody asked for)
// and that the query is translated into the service's own vocabulary
// (`type=pdf` -> `mediaType: "pdf"`), not passed through as HTTP words.
//
// The fixture is upload-constraints-route.test.ts's: same app, same stub services.
import type { ViewerResponse } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "00000000-0000-0000-0000-00000000000a";
const MEMBER_TOKEN = "member-token";
const PROJECT_ID = "project-1";

const MEMBER: AuthenticatedUser = {
  accessToken: MEMBER_TOKEN,
  email: "member@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

/** AS-06: what the service answers, in the shape the route publishes unchanged. */
const UPLOADS = [
  {
    id: "asset-1",
    name: "角色-小橘.png",
    mimeType: "image/png",
    byteSize: 3,
    createdAt: "2026-10-13T00:00:00.000Z",
    url: "https://example.invalid/signed?token=sig",
  },
  {
    id: "asset-2",
    name: "123-a.pdf",
    mimeType: "application/pdf",
    byteSize: 4096,
    createdAt: "2026-10-12T00:00:00.000Z",
    url: null,
  },
];

let listCalls: Array<Record<string, unknown>> = [];

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    return token === MEMBER_TOKEN ? MEMBER : null;
  },
};

const membershipService: TeamMembershipService = {
  async get() {
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

const viewerService: ViewerService = {
  async ensureViewer(user) {
    return {
      profile: {
        avatarUrl: null,
        displayName: "Member",
        email: user.email,
        id: user.id,
      },
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
    } as unknown as ViewerResponse;
  },
};

const projectService = {
  async listProjects() {
    return [];
  },
  async createProject() {
    throw new Error("not used");
  },
  async getProject() {
    throw new Error("not used");
  },
  async updateProject() {},
  async archiveProject() {},
  async saveThumbnail() {
    throw new Error("not used");
  },
} as unknown as ProjectService;

const uploadService = {
  async listProjectUploads(
    _user: AuthenticatedUser,
    input: Record<string, unknown>,
  ) {
    listCalls.push(input);
    return UPLOADS;
  },
  async uploadFile() {
    throw new Error("not used");
  },
  async getAssetUrl() {
    throw new Error("not used");
  },
  async deleteAsset() {},
} as unknown as UploadService;

let app: FastifyInstance;

function buildTestApp() {
  return buildApp({
    auth,
    env: {},
    projectService,
    teamMembershipService: membershipService,
    uploadService,
    viewerService,
  });
}

function get(url: string, options: { authenticated?: boolean } = {}) {
  return app.inject({
    method: "GET",
    url,
    headers:
      options.authenticated === false
        ? {}
        : { authorization: `Bearer ${MEMBER_TOKEN}` },
  });
}

beforeEach(() => {
  listCalls = [];
  app = buildTestApp();
});

afterEach(async () => {
  await app.close();
});

describe("AS-06 project uploads on GET /api/projects/:projectId/uploads", () => {
  it("AS-06: GET returns the service's list", async () => {
    const response = await get(
      `/api/projects/${PROJECT_ID}/uploads?order=oldest&type=pdf`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().uploads).toEqual(UPLOADS);
    // `type=pdf` is the HTTP word; the service is asked for `mediaType`.
    expect(listCalls).toEqual([
      { projectId: PROJECT_ID, order: "oldest", mediaType: "pdf" },
    ]);
  });

  it("AS-06: an unknown order is a 400", async () => {
    const response = await get(
      `/api/projects/${PROJECT_ID}/uploads?order=random`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upload_failed");
    expect(response.json().error.message).toBe("请求参数无效");
    // Refused before the service saw the request at all.
    expect(listCalls).toEqual([]);
  });

  it("AS-06: unauthenticated is a 401", async () => {
    const response = await get(`/api/projects/${PROJECT_ID}/uploads`, {
      authenticated: false,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(listCalls).toEqual([]);
  });
});
