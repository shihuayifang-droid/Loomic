import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  sessionCreateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import { ChatServiceError, type ChatService } from "../features/chat/chat-service.js";
import type { TeamAdminService } from "../features/team/team-admin.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

/**
 * The chat routes as the CLIENT sees them (workorder 21C).
 *
 * `http/chat.ts` is deliberately NOT modified by this ticket — the session CRUD
 * moved to a pure `pg` repository BEHIND the service, so what this file pins is
 * that the route contract did not move with it: the 401 without a token, the
 * existing response schemas, the success bodies of patch/delete, and the mapping
 * of a service error onto its status and text.
 *
 * These cases must NOT be read as authorization evidence. The service here is a
 * DOUBLE: it answers whatever the case scripts, so nothing below says who may
 * write which session. The write ACL is proven against real SQL in
 * `test-support/db/chat-session-write-repository-db.test.ts` and
 * `test-support/db/chat-write-permissions-db.test.ts`; this file only proves the
 * HTTP surface is unchanged.
 */

const USER_ID = "00000000-0000-0000-0000-0000000000c1";
const TOKEN = "chat-route-token";
const CANVAS_ID = "bb4c0000-0000-4000-8000-0000000000c1";
const SESSION_ID = "cc4c0000-0000-4000-8000-0000000000c1";
const UPDATED_AT = "2026-10-15T00:00:00.000Z";

const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "chat-route@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

type ChatCalls = {
  created: Array<{ userId: string; canvasId: string; title: string | undefined }>;
  renamed: Array<{ userId: string; sessionId: string; title: string }>;
  deleted: Array<{ userId: string; sessionId: string }>;
};

type ChatScript = {
  create?: { session?: { id: string; title: string; updatedAt: string }; error?: unknown };
  update?: { error?: unknown };
  delete?: { error?: unknown };
};

let calls: ChatCalls;
let script: ChatScript;

function resetState(): void {
  calls = { created: [], renamed: [], deleted: [] };
  script = {};
}

/**
 * A double for `ChatService` that records the arguments the ROUTE passed down.
 * Only the four session-CRUD entry points are exercised here; the rest answer a
 * fixed failure so a route that unexpectedly reaches them is visible.
 */
const chatServiceDouble = {
  async listSessions() {
    return [];
  },
  async createSession(user: AuthenticatedUser, canvasId: string, title?: string) {
    calls.created.push({ userId: user.id, canvasId, title });
    if (script.create?.error) throw script.create.error;
    return (
      script.create?.session ?? { id: SESSION_ID, title: "New Chat", updatedAt: UPDATED_AT }
    );
  },
  async updateSessionTitle(user: AuthenticatedUser, sessionId: string, title: string) {
    calls.renamed.push({ userId: user.id, sessionId, title });
    if (script.update?.error) throw script.update.error;
  },
  async deleteSession(user: AuthenticatedUser, sessionId: string) {
    calls.deleted.push({ userId: user.id, sessionId });
    if (script.delete?.error) throw script.delete.error;
  },
  async listMessages() {
    return [];
  },
  async createMessage() {
    throw new Error("not used by the session CRUD routes");
  },
} as unknown as ChatService;

/** `recordForeignRead` is only reached by the LIST routes; it stays inert here. */
const teamAdminService = {
  async recordForeignRead() {
    throw new Error("not used by the session CRUD routes");
  },
} as unknown as TeamAdminService;

/**
 * The app-wide member gate (`http/team-gate.ts`) runs BEFORE every `/api/` route
 * for an authenticated caller and answers 503 when the lookup fails. It is
 * unchanged by this ticket, so the harness has to satisfy it — exactly as
 * `team-gate.test.ts` does — or every write case would measure the gate instead
 * of the chat route.
 */
const teamMembershipService = {
  async get() {
    return {
      workspace: {
        id: "11111111-1111-1111-1111-111111111111",
        name: "HaHart 团队",
        type: "team" as const,
        ownerUserId: USER_ID,
      },
      role: "member" as const,
    };
  },
  invalidate() {},
} as unknown as TeamMembershipService;

let app: FastifyInstance;

beforeEach(async () => {
  resetState();
  app = buildApp({
    auth,
    chatService: chatServiceDouble,
    env: {},
    teamAdminService,
    teamMembershipService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("chat session CRUD routes", () => {
  it("case 1: no token on POST sessions is the existing 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/canvases/${CANVAS_ID}/sessions`,
    });

    expect(response.statusCode).toBe(401);
    expect(unauthenticatedErrorResponseSchema.parse(response.json())).toBeDefined();
    // The route returns BEFORE the service, so nothing was attempted.
    expect(calls.created).toHaveLength(0);
  });

  it("case 2: a create returns 201 in the EXISTING response schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/canvases/${CANVAS_ID}/sessions`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { title: "From the client" },
    });

    expect(response.statusCode).toBe(201);
    const body = sessionCreateResponseSchema.parse(response.json());
    expect(body.session).toEqual({
      id: SESSION_ID,
      title: "New Chat",
      updatedAt: UPDATED_AT,
    });

    // The route hands the service the REAL actor and the path's canvas id.
    expect(calls.created).toEqual([
      { userId: USER_ID, canvasId: CANVAS_ID, title: "From the client" },
    ]);
  });

  it("case 3: a create with no body still creates, with an undefined title", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/canvases/${CANVAS_ID}/sessions`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(201);
    expect(calls.created).toEqual([
      { userId: USER_ID, canvasId: CANVAS_ID, title: undefined },
    ]);
  });

  it("case 4: renaming a session is 200 {ok:true} and passes the title down", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { title: "Renamed by the client" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(calls.renamed).toEqual([
      { userId: USER_ID, sessionId: SESSION_ID, title: "Renamed by the client" },
    ]);
  });

  it("case 5: a PATCH with no title is a no-op success, exactly as before", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    // The route only calls the service when a title is present; that guard is
    // part of the contract being pinned, not something this ticket may change.
    expect(calls.renamed).toHaveLength(0);
  });

  it("case 6: deleting a session is 200 {ok:true} and passes the session down", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(calls.deleted).toEqual([{ userId: USER_ID, sessionId: SESSION_ID }]);
  });

  it("case 7: a create failure is the service's own status, text and code", async () => {
    script.create = {
      error: new ChatServiceError("chat_error", "Failed to create session.", 500),
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/canvases/${CANVAS_ID}/sessions`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { title: "x" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "chat_error", message: "Failed to create session." },
    });
  });

  it("case 8: a rename failure keeps the existing 500 mapping", async () => {
    script.update = {
      error: new ChatServiceError("chat_error", "Failed to update session title.", 500),
    };

    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { title: "x" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "chat_error", message: "Failed to update session title." },
    });
  });

  it("case 9: a delete failure keeps the existing 404 wording", async () => {
    script.delete = {
      error: new ChatServiceError("session_not_found", "Session not found.", 404),
    };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "session_not_found", message: "Session not found." },
    });
  });

  it("case 10: an unexpected failure is the generic 500 and leaks nothing", async () => {
    script.delete = {
      error: Object.assign(new Error("connect ECONNREFUSED db.internal:5432"), {
        code: "ECONNREFUSED",
      }),
    };

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "application_error", message: "Internal server error." },
    });
    // No host, no port, no driver text may reach the client.
    expect(response.body).not.toContain("db.internal");
    expect(response.body).not.toContain("ECONNREFUSED");
  });

  it("case 11: no token on PATCH and DELETE is the same 401, with no service call", async () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/sessions/${SESSION_ID}`,
        ...(method === "PATCH" ? { payload: { title: "x" } } : {}),
      });

      expect(response.statusCode).toBe(401);
      expect(unauthenticatedErrorResponseSchema.parse(response.json())).toBeDefined();
    }

    expect(calls.renamed).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
  });
});
