import { teamMemberListResponseSchema } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectService } from "../features/projects/project-service.js";
import {
  TeamAdminError,
  type TeamAdminService,
} from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";

const MEMBER_ID = "00000000-0000-0000-0000-00000000000a";
const ADMIN_ID = "00000000-0000-0000-0000-00000000000e";
const OWNER_ID = "00000000-0000-0000-0000-00000000000f";
const STRANGER_ID = "00000000-0000-0000-0000-00000000000c";
const TARGET_ID = "00000000-0000-0000-0000-00000000000b";

const ROLES: Record<string, string | null> = {
  "member-token": "member",
  "admin-token": "admin",
  "owner-token": "owner",
  "stranger-token": null,
};

const IDS: Record<string, string> = {
  "member-token": MEMBER_ID,
  "admin-token": ADMIN_ID,
  "owner-token": OWNER_ID,
  "stranger-token": STRANGER_ID,
};

let teamAdminCalls: string[] = [];
let adminFailure: TeamAdminError | null = null;
let addedResult = true;

const MEMBER_ROW = {
  userId: ADMIN_ID,
  email: "admin@hahart.test",
  displayName: "Admin",
  role: "admin" as const,
  joinedAt: new Date().toISOString(),
};

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const id = IDS[token];
    if (!id) return null;
    return {
      accessToken: token,
      email: `${token}@hahart.test`,
      id,
      userMetadata: {},
    } satisfies AuthenticatedUser;
  },
};

const teamMembership: TeamMembershipService = {
  async get(userId) {
    const role = Object.entries(IDS).find(([, id]) => id === userId)?.[0];
    const membershipRole = role ? ROLES[role] : null;
    if (!membershipRole) return null;
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: OWNER_ID,
      },
      role: membershipRole as "owner" | "admin" | "member",
    };
  },
  invalidate() {},
};

const teamAdminService: TeamAdminService = {
  async listMembers() {
    teamAdminCalls.push("listMembers");
    if (adminFailure) throw adminFailure;
    return [MEMBER_ROW];
  },
  async addMember() {
    teamAdminCalls.push("addMember");
    if (adminFailure) throw adminFailure;
    return { added: addedResult };
  },
  async setRole() {
    teamAdminCalls.push("setRole");
    if (adminFailure) throw adminFailure;
    return { changed: true };
  },
  async removeMember() {
    teamAdminCalls.push("removeMember");
    if (adminFailure) throw adminFailure;
    return { removed: 1, transferred: { projects: 2, assets: 3, objects: 1 } };
  },
  async recordForeignRead() {
    teamAdminCalls.push("recordForeignRead");
  },
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
        ownerUserId: OWNER_ID,
        type: "team",
      },
      teamMembership: { role: "member", userId: user.id, workspaceId: TEAM_ID },
    } as never;
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
  async uploadFile() {
    throw new Error("not used");
  },
  async getAssetUrl() {
    return "";
  },
  async deleteAsset() {},
} as unknown as UploadService;

let app: FastifyInstance;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  teamAdminCalls = [];
  adminFailure = null;
  addedResult = true;
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
});

describe("admin team member routes", () => {
  it("case 1: no token is a 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members",
    });

    expect(response.statusCode).toBe(401);
  });

  it("case 2: a non-member is stopped by the team gate", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members",
      headers: bearer("stranger-token"),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("not_team_member");
  });

  it("case 3: a plain member gets 403 on all four routes and never reaches the service", async () => {
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/admin/team/members",
        headers: bearer("member-token"),
      }),
      app.inject({
        method: "POST",
        url: "/api/admin/team/members",
        headers: bearer("member-token"),
        payload: { email: "x@hahart.test", role: "member" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/admin/team/members/${TARGET_ID}`,
        headers: bearer("member-token"),
        payload: { role: "admin" },
      }),
      app.inject({
        method: "DELETE",
        url: `/api/admin/team/members/${TARGET_ID}`,
        headers: bearer("member-token"),
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("forbidden");
    }
    expect(teamAdminCalls.length).toBe(0);
  });

  it("case 4: an admin lists members through the response schema", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members",
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(200);
    const parsed = teamMemberListResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    expect(response.json().members.length).toBe(1);
  });

  it("case 5: a new member is a 201, an existing one a 200", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/team/members",
      headers: bearer("admin-token"),
      payload: { email: "b@hahart.test", role: "member" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ added: true });

    addedResult = false;
    const existing = await app.inject({
      method: "POST",
      url: "/api/admin/team/members",
      headers: bearer("admin-token"),
      payload: { email: "b@hahart.test", role: "member" },
    });
    expect(existing.statusCode).toBe(200);
    expect(existing.json()).toEqual({ added: false });
  });

  it("case 6: role 'owner' is rejected before the service is called", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/team/members",
      headers: bearer("admin-token"),
      payload: { email: "b@hahart.test", role: "owner" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
    expect(teamAdminCalls.length).toBe(0);
  });

  it("case 7: an admin changes a role", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/team/members/${TARGET_ID}`,
      headers: bearer("admin-token"),
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true });
  });

  it("case 8: an admin removes a member and the transfer counts pass through", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/team/members/${TARGET_ID}`,
      headers: bearer("admin-token"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      removed: 1,
      transferred: { projects: 2, assets: 3, objects: 1 },
    });
  });

  it("case 9: a TeamAdminError keeps its status code and error code", async () => {
    adminFailure = new TeamAdminError("user_not_found", "No such user.", 404);
    const notFound = await app.inject({
      method: "GET",
      url: "/api/admin/team/members",
      headers: bearer("admin-token"),
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe("user_not_found");

    adminFailure = new TeamAdminError("invalid_request", "Bad role.", 400);
    const badRequest = await app.inject({
      method: "PATCH",
      url: `/api/admin/team/members/${TARGET_ID}`,
      headers: bearer("admin-token"),
      payload: { role: "member" },
    });
    expect(badRequest.statusCode).toBe(400);
    expect(badRequest.json().error.code).toBe("invalid_request");
  });

  it("case 10: the team owner may list members", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/team/members",
      headers: bearer("owner-token"),
    });

    expect(response.statusCode).toBe(200);
  });
});
