import type { ViewerResponse } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
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
const STRANGER_TOKEN = "stranger-token";

const MEMBER: AuthenticatedUser = {
  accessToken: MEMBER_TOKEN,
  email: "member@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

type MembershipMode = "member" | "none" | "error";

let mode: MembershipMode = "none";
let projectListCalls = 0;
let uploadCalls: Array<{ workspaceId: string; projectId?: string }> = [];

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
    if (mode === "error") throw new Error("membership lookup exploded");
    if (mode === "none") return null;
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
    const onTeam = mode === "member";
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
      teamWorkspace: onTeam
        ? {
            id: TEAM_ID,
            name: "HaHart 团队",
            ownerUserId: "owner-1",
            type: "team",
          }
        : null,
      teamMembership: onTeam
        ? { role: "member", userId: user.id, workspaceId: TEAM_ID }
        : null,
    } as unknown as ViewerResponse;
  },
};

const projectService = {
  async listProjects() {
    projectListCalls += 1;
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
  async uploadFile(_user: AuthenticatedUser, input: { workspaceId: string; projectId?: string }) {
    uploadCalls.push(input);
    return {
      asset: {
        id: "asset-1",
        bucket: "project-assets",
        objectPath: `${input.workspaceId}/file.png`,
        mimeType: "image/png",
        byteSize: 3,
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        createdAt: new Date().toISOString(),
      },
      url: "https://example.invalid/signed",
    };
  },
  async getAssetUrl() {
    return "https://example.invalid/signed";
  },
  async deleteAsset() {},
} as unknown as UploadService;

let app: FastifyInstance;

let getBalanceCalls = 0;
let claimDailyCreditsCalls = 0;

const creditService = {
  async getBalance() {
    getBalanceCalls += 1;
    return { balance: 0, plan: "free", dailyClaimed: false };
  },
  async claimDailyCredits() {
    claimDailyCreditsCalls += 1;
    return { success: true, balance: 100 };
  },
} as unknown as CreditService;

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

function buildTestAppWithCredits() {
  return buildApp({
    auth,
    creditService,
    env: {},
    projectService,
    teamMembershipService: membershipService,
    uploadService,
    viewerService,
  });
}

beforeEach(() => {
  mode = "none";
  projectListCalls = 0;
  uploadCalls = [];
  getBalanceCalls = 0;
  claimDailyCreditsCalls = 0;
  app = buildTestApp();
});

afterEach(async () => {
  await app.close();
});

describe("team member gate", () => {
  it("case 1: no token on GET /api/projects is a 401 from the route", async () => {
    const response = await app.inject({ method: "GET", url: "/api/projects" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("case 2: a non-member is rejected with 403 and never reaches the service", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("not_team_member");
    expect(response.json().error.message).toBe(
      "Not a member of the HaHart team workspace.",
    );
    expect(projectListCalls).toBe(0);
  });

  it("case 3: a member reaches the route", async () => {
    mode = "member";

    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(projectListCalls).toBe(1);
  });

  it("case 4: a non-member can still reach /api/health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
  });

  it("case 5: a non-member can still read /api/viewer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/viewer",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().teamWorkspace).toBeNull();
  });

  it("case 6: /api/viewer/profile is NOT exempt (exact match, not prefix)", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/viewer/profile",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      payload: { displayName: "x" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("not_team_member");
  });

  it("case 7: a membership lookup failure is a 503, not a pass and not a 403", async () => {
    mode = "error";

    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("application_error");
    expect(projectListCalls).toBe(0);
  });

  it("case 8: the gate keeps no cache of its own — flipping membership flips the answer", async () => {
    mode = "member";
    const first = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });
    expect(first.statusCode).toBe(200);

    mode = "none";
    const second = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });
    expect(second.statusCode).toBe(403);
  });

  it("case 9: an upload by a member carries the team workspace id", async () => {
    mode = "member";

    const boundary = "----loomicboundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\nproject-1\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      Buffer.from([1, 2, 3]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: {
        authorization: `Bearer ${MEMBER_TOKEN}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(uploadCalls.length).toBe(1);
    expect(uploadCalls[0]?.workspaceId).toBe(TEAM_ID);
    expect(uploadCalls[0]?.projectId).toBe("project-1");
  });

  it("case 10: a non-member websocket is closed with 4003", async () => {
    mode = "none";
    const address = await app.listen({ port: 0 });
    const socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/api/ws?token=${MEMBER_TOKEN}`,
    );

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket was never closed")), 5_000);
      socket.on("close", (received: number) => {
        clearTimeout(timer);
        resolve(received);
      });
      socket.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(code).toBe(4003);
    socket.terminate();
  });

  it("case 11: a member websocket is not closed", async () => {
    mode = "member";
    const address = await app.listen({ port: 0 });
    const socket = new WebSocket(
      `${address.replace(/^http/, "ws")}/api/ws?token=${MEMBER_TOKEN}`,
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket never opened")), 5_000);
      socket.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const closed = await new Promise<boolean>((resolve) => {
      socket.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    expect(closed).toBe(false);
    socket.close();
  });

  it("AD-00 / T-04: a non-member reading /api/viewer is not given the daily grant", async () => {
    mode = "none";
    await app.close();
    app = buildTestAppWithCredits();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/viewer",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(claimDailyCreditsCalls).toBe(0);
    expect(getBalanceCalls).toBeGreaterThanOrEqual(1);
  });

  it("AD-00 / T-04: a team member reading /api/viewer still gets the daily grant", async () => {
    mode = "member";
    await app.close();
    app = buildTestAppWithCredits();
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/viewer",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(claimDailyCreditsCalls).toBe(1);
  });

  it("工单42D: the four /api/auth/* paths are not stopped by the gate", async () => {
    mode = "none";

    for (const path of [
      "/api/auth/sign-up",
      "/api/auth/sign-in",
      "/api/auth/refresh",
      "/api/auth/sign-out",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
        payload: {},
      });

      // The routes are not mounted under the default provider, so the answer is
      // Fastify's 404 - what matters is that it is not the gate's 403/503.
      expect(response.statusCode).not.toBe(403);
      expect(response.statusCode).not.toBe(503);
    }
  });

  it("工单42E: /api/auth/change-password is exempt (a new user may not be on the team yet)", async () => {
    mode = "none";

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      payload: { currentPassword: "a", newPassword: "b" },
    });

    // The route is not mounted under the default provider, so the answer is
    // Fastify's 404 - what matters is that it is not the gate's 403/503.
    expect(response.statusCode).not.toBe(403);
    expect(response.statusCode).not.toBe(503);
  });

  it("工单42E: /api/admin/auth/reset-password is NOT exempt, a non-member gets 403", async () => {
    mode = "none";

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/auth/reset-password",
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
      payload: { email: "someone@hahart.test" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("not_team_member");
  });
});
