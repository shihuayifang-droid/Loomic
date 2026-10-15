import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applicationErrorResponseSchema,
  profileUpdateResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import {
  ProfileWriteError,
  UPDATE_DISPLAY_NAME,
  type ProfileWriteRepository,
  type ProfileWriteRow,
} from "../db/profile-write-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import { registerViewerRoutes } from "./viewer.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";

/**
 * `PATCH /api/viewer/profile` as the CLIENT sees it (workorder 21D).
 *
 * The Supabase write this route used to perform is gone; what this file pins is
 * that the ROUTE CONTRACT did not move with it — the 401 without a token, the
 * 400 for an invalid body, the unchanged 200 projection, and the single 500
 * `profile_update_failed` that every failure of the write collapses into.
 *
 * Two things are observed rather than asserted in prose:
 *
 * - `createUserClient` is injected as a factory that RECORDS its calls and then
 *   throws. Every case asserts it was never reached, which is the direct
 *   evidence that no success or failure path of this route goes back to
 *   PostgREST. (It is also absent from `registerViewerRoutes`' signature: the
 *   route cannot reach a user-scoped client even by mistake.)
 * - The repository is a DOUBLE, so the arguments the route passes down are
 *   recorded. These cases are therefore NOT authorization evidence: who may
 *   write which profile row is proven against real SQL in
 *   `test-support/db/profile-write-repository-db.test.ts` (and the statement
 *   itself in `db/profile-write-repository.test.ts`). This file only proves the
 *   HTTP surface is unchanged.
 */

const USER_ID = "00000000-0000-0000-0000-0000000000f1";
const USER_EMAIL = "profile-route@hahart.test";
const TOKEN = "profile-route-token";
const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const AVATAR_URL = "https://cdn.invalid/profile-route.png";

const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: USER_EMAIL,
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

let userFactoryCalls: string[] = [];

/**
 * The user-scoped Supabase factory, replaced by one that CANNOT succeed. A call
 * to it is recorded and then throws, so a route that still reached for
 * PostgREST would answer a different status than a 200 — the recorded array is
 * the primary evidence, this is the backstop.
 */
function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);
  throw new Error(
    "the user-scoped Supabase factory must not be reached by the profile route",
  );
}

type WriteCall = { actorId: string; displayName: string };

let writeCalls: WriteCall[];
let writeRow: ProfileWriteRow | undefined;
let writeError: unknown;

/**
 * A double for the repository that records the arguments the ROUTE passed down.
 */
const profileWriteRepository: ProfileWriteRepository = {
  async updateDisplayName(input) {
    writeCalls.push({ actorId: input.actorId, displayName: input.displayName });
    if (writeError !== undefined) throw writeError;
    return (
      writeRow ?? {
        id: USER_ID,
        email: USER_EMAIL,
        displayName: input.displayName,
        avatarUrl: null,
      }
    );
  },
};

/**
 * The app-wide member gate (`http/team-gate.ts`) runs BEFORE every `/api/` route
 * for an authenticated caller and answers 503 when the lookup fails. It is
 * unchanged by this ticket, so the harness has to satisfy it — exactly as
 * `team-gate.test.ts` and `chat.test.ts` do — or every write case would measure
 * the gate instead of the profile route.
 */
const teamMembershipService = {
  async get() {
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team" as const,
        ownerUserId: USER_ID,
      },
      role: "member" as const,
    };
  },
  invalidate() {},
} as unknown as TeamMembershipService;

const viewerService = {
  async ensureViewer() {
    throw new Error("not used by the profile route");
  },
} as unknown as ViewerService;

let app: FastifyInstance;

beforeEach(async () => {
  writeCalls = [];
  writeRow = undefined;
  writeError = undefined;
  userFactoryCalls = [];

  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    env: {},
    profileWriteRepository,
    teamMembershipService,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function patchProfile(
  options: {
    token?: string | null;
    payload?: unknown;
  } = {},
) {
  const headers =
    options.token === null || options.token === undefined
      ? {}
      : { authorization: `Bearer ${options.token}` };

  return app.inject({
    method: "PATCH",
    url: "/api/viewer/profile",
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

describe("PATCH /api/viewer/profile: authentication and validation", () => {
  it("case 1: no token is the existing 401 and reaches neither the repository nor the factory", async () => {
    const response = await patchProfile({ payload: { displayName: "x" } });

    expect(response.statusCode).toBe(401);
    expect(unauthenticatedErrorResponseSchema.parse(response.json())).toBeDefined();
    expect(writeCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 2: an unknown token is the same 401, with no write attempted", async () => {
    const response = await patchProfile({
      token: "not-the-token",
      payload: { displayName: "x" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(writeCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 3: an empty display name is the existing 400 and never reaches the repository", async () => {
    const response = await patchProfile({ token: TOKEN, payload: { displayName: "" } });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid request body");
    expect(Array.isArray(response.json().issues)).toBe(true);
    expect(writeCalls).toHaveLength(0);
  });

  it("case 4: a whitespace-only display name is trimmed to nothing and rejected", async () => {
    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "     " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid request body");
    expect(writeCalls).toHaveLength(0);
  });

  it("case 5: a 101-character display name is rejected by the same request schema", async () => {
    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "x".repeat(101) },
    });

    expect(response.statusCode).toBe(400);
    expect(writeCalls).toHaveLength(0);
  });

  it("case 6: a missing display name is a 400, not a silent empty write", async () => {
    const response = await patchProfile({ token: TOKEN, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid request body");
    expect(writeCalls).toHaveLength(0);
  });
});

describe("PATCH /api/viewer/profile: the successful write", () => {
  it("case 7: the actor's own name is written and the EXISTING 200 body comes back", async () => {
    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "  Trimmed By The Schema  " },
    });

    expect(response.statusCode).toBe(200);
    expect(profileUpdateResponseSchema.parse(response.json())).toEqual({
      profile: {
        id: USER_ID,
        email: USER_EMAIL,
        displayName: "Trimmed By The Schema",
        avatarUrl: null,
      },
    });

    // The route passes the AUTHENTICATED actor and the trimmed name down: the
    // repository is the only thing that decides which row that is.
    expect(writeCalls).toEqual([
      { actorId: USER_ID, displayName: "Trimmed By The Schema" },
    ]);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 8: an avatar is projected through unchanged", async () => {
    writeRow = {
      id: USER_ID,
      email: USER_EMAIL,
      displayName: "With Avatar",
      avatarUrl: AVATAR_URL,
    };

    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "With Avatar" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().profile.avatarUrl).toBe(AVATAR_URL);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 9: the body cannot choose the target profile — extra keys are stripped", async () => {
    const response = await patchProfile({
      token: TOKEN,
      payload: {
        displayName: "Body Cannot Retarget",
        // Neither of these is part of the request contract, and neither may
        // become the row that is written.
        id: "00000000-0000-0000-0000-0000000000f9",
        actorId: "00000000-0000-0000-0000-0000000000f9",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(writeCalls).toEqual([
      { actorId: USER_ID, displayName: "Body Cannot Retarget" },
    ]);
  });

  it("case 10: an email the repository reports as NULL projects to '' exactly as before", async () => {
    // Pre-existing projection, pinned rather than changed: the old PostgREST path
    // read `data.email ?? ""` and the response schema then refuses an empty
    // e-mail. The write really happened; the 400 is the RESPONSE contract's.
    writeRow = {
      id: USER_ID,
      email: null,
      displayName: "No Email On The Row",
      avatarUrl: null,
    };

    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "No Email On The Row" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid request body");
    expect(writeCalls).toHaveLength(1);
    expect(userFactoryCalls).toHaveLength(0);
  });
});

describe("PATCH /api/viewer/profile: every write failure is the same 500", () => {
  it("case 11: a refused write (zero rows) keeps the existing 500 projection", async () => {
    writeError = new ProfileWriteError(
      UPDATE_DISPLAY_NAME,
      new Error("profile write updated no row"),
    );

    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "Never Stored" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "profile_update_failed",
        message: "Unable to update profile.",
      },
    });
    expect(applicationErrorResponseSchema.parse(response.json())).toBeDefined();
    expect(writeCalls).toHaveLength(1);
    // NOT a 403 and NOT a 404: the failure must not answer whether the profile
    // exists.
    expect([403, 404]).not.toContain(response.statusCode);
  });

  it("case 12: a SQL or connection failure is the SAME fixed 500, leaking nothing", async () => {
    writeError = new ProfileWriteError(
      UPDATE_DISPLAY_NAME,
      Object.assign(
        new Error(
          "update public.profiles set display_name = $2 where id = $1: " +
            "connect ECONNREFUSED db.internal:5432",
        ),
        { code: "ECONNREFUSED" },
      ),
    );

    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "Never Stored" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "profile_update_failed",
        message: "Unable to update profile.",
      },
    });
    for (const leak of [
      "db.internal",
      "ECONNREFUSED",
      "public.profiles",
      "display_name",
      "select",
      USER_ID,
    ]) {
      expect(response.body).not.toContain(leak);
    }
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 13: a repository failure that is not a ProfileWriteError is still the same 500", async () => {
    writeError = new Error("something the repository never throws");

    const response = await patchProfile({
      token: TOKEN,
      payload: { displayName: "Never Stored" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("profile_update_failed");
    expect(response.body).not.toContain("something the repository never throws");
  });

  it("case 14: with NO repository injected the route fails closed — no PostgREST fallback", async () => {
    // The route is registered on its own here, so the option really is absent
    // rather than replaced by a default. Nothing else is wired either: this app
    // has no user-scoped client to fall back to, and the answer is the same 500.
    const bare = Fastify();
    await registerViewerRoutes(bare, { auth, viewerService });
    await bare.ready();

    try {
      const response = await bare.inject({
        method: "PATCH",
        url: "/api/viewer/profile",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { displayName: "Never Stored" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "profile_update_failed",
          message: "Unable to update profile.",
        },
      });
      expect(userFactoryCalls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });

  it("case 15: every path above ran with the user Supabase factory untouched", async () => {
    // The settled count for the whole file: a factory double that records and
    // then throws was injected into every app built here, and nothing reached it.
    const ok = await patchProfile({ token: TOKEN, payload: { displayName: "Fine" } });
    expect(ok.statusCode).toBe(200);

    writeError = new ProfileWriteError(UPDATE_DISPLAY_NAME, new Error("no row"));
    const failed = await patchProfile({
      token: TOKEN,
      payload: { displayName: "Fine" },
    });
    expect(failed.statusCode).toBe(500);

    await patchProfile({ token: TOKEN, payload: { displayName: "" } });

    expect(userFactoryCalls).toEqual([]);
  });
});
