import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  applicationErrorResponseSchema,
  toolListResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import { TOOL_DEFINITIONS } from "../features/tools/tool-definitions.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";

/**
 * `GET /api/tools` as the CLIENT sees it (workorder 21AB).
 *
 * The table itself is pinned in `features/tools/tool-definitions.test.ts`; this
 * file pins the HTTP surface around it: the 401 the brand-kit routes already
 * answer, the 200 whose body IS the table, the fact that `unavailable` tools are
 * shipped rather than filtered (ED-00k: the switch lives in the definition, so
 * turning a tool on must not need a release), and that the answer does not
 * depend on WHO asks — there is no per-user filtering in this ticket.
 *
 * One thing is observed rather than asserted in prose: `createUserClient` is
 * injected as a factory that RECORDS its calls and then throws, and every case
 * asserts it was never reached. The route is static configuration, so a call
 * there would mean it had grown a database dependency.
 */

const TOKEN_A = "tools-route-token-a";
const TOKEN_B = "tools-route-token-b";
const USER_A: AuthenticatedUser = {
  accessToken: TOKEN_A,
  email: "tools-route-a@hahart.test",
  id: "00000000-0000-0000-0000-0000000000a1",
  userMetadata: {},
};
const USER_B: AuthenticatedUser = {
  accessToken: TOKEN_B,
  email: "tools-route-b@hahart.test",
  id: "00000000-0000-0000-0000-0000000000b1",
  userMetadata: {},
};
const TEAM_ID = "33333333-3333-3333-3333-333333333333";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;

    const token = header.slice("Bearer ".length);
    if (token === TOKEN_A) return USER_A;
    if (token === TOKEN_B) return USER_B;
    return null;
  },
};

let userFactoryCalls: string[];

function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);
  throw new Error(
    "GET /api/tools is static configuration and must not build a user-scoped Supabase client",
  );
}

/**
 * The app-wide member gate (`http/team-gate.ts`) runs BEFORE every `/api/` route
 * and answers 403/503 when the lookup fails. It is unchanged by this ticket, so
 * the harness has to satisfy it — one case below drives it to `null` to show the
 * new route sits behind the same gate.
 */
let membership: unknown;

const teamMembershipService = {
  async get() {
    return membership;
  },
  invalidate() {},
} as unknown as TeamMembershipService;

const viewerService = {
  async ensureViewer() {
    return {
      workspace: {
        id: "00000000-0000-0000-0000-0000000000a2",
        name: "Personal",
        type: "personal" as const,
        ownerUserId: USER_A.id,
      },
    };
  },
} as unknown as ViewerService;

let app: FastifyInstance;

beforeEach(async () => {
  userFactoryCalls = [];
  membership = {
    workspace: {
      id: TEAM_ID,
      name: "HaHart 团队",
      type: "team" as const,
      ownerUserId: USER_A.id,
    },
    role: "member" as const,
  };

  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    env: {},
    teamMembershipService,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function getTools(options: { token?: string | null } = {}) {
  const headers =
    options.token === null || options.token === undefined
      ? {}
      : { authorization: `Bearer ${options.token}` };

  return app.inject({ method: "GET", url: "/api/tools", headers });
}

describe("GET /api/tools: authentication", () => {
  it("case 1: no token is the same 401 the brand-kit routes answer", async () => {
    const response = await getTools();

    expect(response.statusCode).toBe(401);
    expect(unauthenticatedErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    });
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 2: an unknown token is the same 401 — the table is not served anonymously", async () => {
    const response = await getTools({ token: "not-the-token" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(response.body).not.toContain("image-toolbar-upscale");
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 3: a non-team-member is refused by the unchanged member gate, not by this route", async () => {
    membership = null;

    const response = await getTools({ token: TOKEN_A });

    expect(response.statusCode).toBe(403);
    expect(applicationErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: "not_team_member",
        message: "Not a member of the HaHart team workspace.",
      },
    });
    expect(userFactoryCalls).toHaveLength(0);
  });
});

describe("GET /api/tools: the table on the wire", () => {
  it("case 4: 200 with the whole table, and the body parses as toolListResponseSchema", async () => {
    const response = await getTools({ token: TOKEN_A });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body = toolListResponseSchema.parse(response.json());

    expect(body.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(body.tools).toHaveLength(17);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 5: the body IS TOOL_DEFINITIONS — no projection, no reordering", async () => {
    const response = await getTools({ token: TOKEN_A });

    expect(response.json()).toEqual({ tools: TOOL_DEFINITIONS });
  });

  it("case 6: `unavailable` tools are shipped too, so the switch needs no release", async () => {
    const response = await getTools({ token: TOKEN_A });
    const body = toolListResponseSchema.parse(response.json());
    const shipped = new Set(body.tools.map((tool) => tool.id));

    // 去背景 was opened in 40T; every tool that is still unavailable must
    // travel with the table, because the definition carries the switch (ED-00k).
    for (const id of [
      "remove_background",
      "upscale",
      "edit_text",
      "layer_split_auto",
      "vectorize",
    ]) {
      expect(shipped.has(id)).toBe(true);
    }

    const unavailable = body.tools.filter((tool) => tool.availability === "unavailable");
    const sent = new Set(
      TOOL_DEFINITIONS.filter((tool) => tool.availability === "unavailable").map(
        (tool) => tool.id,
      ),
    );

    expect(unavailable).toHaveLength(sent.size);
    expect(unavailable).toHaveLength(11);
    for (const tool of unavailable) {
      expect(sent.has(tool.id)).toBe(true);
    }
  });

  it("case 7: two different users get byte-identical bodies — nothing is filtered per user", async () => {
    const first = await getTools({ token: TOKEN_A });
    const second = await getTools({ token: TOKEN_B });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(userFactoryCalls).toHaveLength(0);
  });
});
