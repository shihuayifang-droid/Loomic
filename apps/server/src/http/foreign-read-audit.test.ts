import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { CanvasService } from "../features/canvas/canvas-service.js";
import { CanvasServiceError } from "../features/canvas/canvas-service.js";
import type { ChatService } from "../features/chat/chat-service.js";
import { ChatServiceError } from "../features/chat/chat-service.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  ProjectServiceError,
  type ProjectService,
} from "../features/projects/project-service.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const ADMIN_ID = "00000000-0000-0000-0000-00000000000e";
const TOKEN = "admin-token";

const PROJECT_ID = "p-1";
const CANVAS_ID = "c-1";
const SESSION_ID = "s-1";

type AuditCall = {
  userId: string;
  via: string;
  target: Record<string, string>;
};

let auditCalls: AuditCall[] = [];
let auditFails = false;
let readsFail = false;

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (header !== `Bearer ${TOKEN}`) return null;
    return {
      accessToken: TOKEN,
      email: "admin@hahart.test",
      id: ADMIN_ID,
      userMetadata: {},
    } satisfies AuthenticatedUser;
  },
};

const teamMembership: TeamMembershipService = {
  async get() {
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: "owner-1",
      },
      role: "admin",
    };
  },
  invalidate() {},
};

const CANVAS = {
  id: CANVAS_ID,
  name: "Canvas",
  projectId: PROJECT_ID,
  content: { elements: [], appState: {}, files: {} },
  version: 1,
};

const projectService = {
  async getProject() {
    if (readsFail) {
      throw new ProjectServiceError("project_not_found", "Project not found.", 404);
    }
    return { id: PROJECT_ID, name: "Secret Project Alpha" };
  },
} as unknown as ProjectService;

const canvasService = {
  async getCanvas() {
    if (readsFail) {
      throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
    }
    return CANVAS;
  },
} as unknown as CanvasService;

const chatService = {
  async listSessions() {
    if (readsFail) {
      throw new ChatServiceError("session_not_found", "Canvas not found.", 404);
    }
    return [];
  },
  async listMessages() {
    if (readsFail) {
      throw new ChatServiceError("session_not_found", "Session not found.", 404);
    }
    return [];
  },
} as unknown as ChatService;

const teamAdminService = {
  async recordForeignRead(userId: string, via: string, target: Record<string, string>) {
    if (auditFails) throw new Error("audit insert failed");
    auditCalls.push({ userId, via, target });
  },
} as unknown as TeamAdminService;

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
      teamMembership: { role: "admin", userId: user.id, workspaceId: TEAM_ID },
    } as never;
  },
} as unknown as ViewerService;

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

const headers = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  auditCalls = [];
  auditFails = false;
  readsFail = false;
  app = buildApp({
    auth,
    env: {},
    canvasService,
    chatService,
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

describe("admin foreign-read auditing", () => {
  it("case 1: GET /api/projects/:projectId audits as 'project'", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(auditCalls).toEqual([
      { userId: ADMIN_ID, via: "project", target: { projectId: PROJECT_ID } },
    ]);
  });

  it("case 2: GET /api/canvases/:canvasId audits as 'canvas'", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/canvases/${CANVAS_ID}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(auditCalls).toEqual([
      { userId: ADMIN_ID, via: "canvas", target: { canvasId: CANVAS_ID } },
    ]);
  });

  it("case 3: GET /api/canvases/:canvasId/sessions audits as 'sessions'", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/canvases/${CANVAS_ID}/sessions`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(auditCalls).toEqual([
      { userId: ADMIN_ID, via: "sessions", target: { canvasId: CANVAS_ID } },
    ]);
  });

  it("case 4: GET /api/sessions/:sessionId/messages audits as 'messages'", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/messages`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(auditCalls).toEqual([
      { userId: ADMIN_ID, via: "messages", target: { sessionId: SESSION_ID } },
    ]);
  });

  it("case 5: a failed read is never audited", async () => {
    readsFail = true;

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/api/projects/${PROJECT_ID}`, headers }),
      app.inject({ method: "GET", url: `/api/canvases/${CANVAS_ID}`, headers }),
      app.inject({
        method: "GET",
        url: `/api/canvases/${CANVAS_ID}/sessions`,
        headers,
      }),
      app.inject({
        method: "GET",
        url: `/api/sessions/${SESSION_ID}/messages`,
        headers,
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
    }
    expect(auditCalls.length).toBe(0);
  });

  it("case 6: a failed audit is a 503 that returns no data", async () => {
    auditFails = true;

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}`,
      headers,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("application_error");
    expect(response.body).not.toContain("Secret Project Alpha");
    expect(response.json().project).toBeUndefined();
  });
});
