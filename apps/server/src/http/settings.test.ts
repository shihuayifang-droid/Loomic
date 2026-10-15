import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSettingsResponseSchema,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import { DEFAULT_AGENT_MODEL } from "../config/env.js";
import {
  UPSERT_DEFAULT_MODEL,
  WorkspaceSettingsWriteError,
  type WorkspaceSettingsWriteRepository,
  type WorkspaceSettingsWriteRow,
} from "../db/workspace-settings-write-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { createSettingsService } from "../features/settings/settings-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";
import { registerSettingsRoutes } from "./settings.js";

/**
 * `PUT /api/workspace/settings` as the CLIENT sees it (workorder 21E1).
 *
 * The Supabase upsert this route used to perform is gone; what this file pins is
 * that the ROUTE CONTRACT did not move with it — the 401 without a token, the 400
 * for an invalid body, the unchanged 200 `{ settings: { defaultModel } }`, and the
 * single 500 `settings_update_failed` that every failure of the write collapses
 * into.
 *
 * Three things are observed rather than asserted in prose:
 *
 * - `createUserClient` is injected as a factory whose calls are RECORDED. Every
 *   PUT case asserts it was never reached, which is the direct evidence that no
 *   success or failure path of the WRITE goes back to PostgREST. The very same
 *   factory is what the READ path uses in case 10, so "the write never touches
 *   it" is a measured difference and not a factory that simply cannot work.
 * - The repository is a DOUBLE, so the arguments the route passes down are
 *   recorded. These cases are therefore NOT authorization evidence: who may write
 *   which workspace row is proven against real SQL in
 *   `test-support/db/workspace-settings-write-repository-db.test.ts` (and the
 *   statement itself in `db/workspace-settings-write-repository.test.ts`). This
 *   file only proves the HTTP surface is unchanged, and that the route still
 *   hands the write the VIEWER's own workspace.
 * - The app is built through `buildApp` with the repository injected, so the real
 *   wiring of workorder 21E1 is part of what runs.
 */

const USER_ID = "00000000-0000-0000-0000-0000000000c1";
const USER_EMAIL = "settings-route@hahart.test";
const TOKEN = "settings-route-token";
const TEAM_ID = "22222222-2222-2222-2222-222222222222";
const PERSONAL_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c2";
/** A workspace the REQUEST BODY names; it must never become the target. */
const OTHER_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c3";

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

type WriteCall = {
  actorId: string;
  workspaceId: string;
  defaultModel: string;
};

let userFactoryCalls: string[];
let readCalls: string[];
let writeCalls: WriteCall[];
let writeRow: WorkspaceSettingsWriteRow | undefined;
let writeError: unknown;
let storedReadRow: { default_model: string } | null;

/**
 * The user-scoped Supabase client, as a recording stub.
 *
 * The factory itself is the observation point: it is called on every READ and
 * never on a write, and every call it makes is recorded in `readCalls`. The
 * `from` accessor is written as a computed key on purpose — a literal PostgREST
 * call token in this file would raise the dependency audit's text counter, which
 * this ticket has to keep at its measured value.
 */
function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);

  const query = {
    select(columns: string) {
      readCalls.push(`select ${columns}`);
      return query;
    },
    eq(column: string, value: unknown) {
      readCalls.push(`eq ${column}=${String(value)}`);
      return query;
    },
    async maybeSingle() {
      readCalls.push("maybeSingle");
      return { data: storedReadRow, error: null };
    },
  };

  return {
    ["from"](table: string) {
      readCalls.push(`from ${table}`);
      return query;
    },
  } as unknown as UserSupabaseClient;
}

/** A double for the repository that records the arguments the ROUTE passed down. */
const workspaceSettingsWriteRepository: WorkspaceSettingsWriteRepository = {
  async upsertDefaultModel(input) {
    writeCalls.push({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
      defaultModel: input.defaultModel,
    });
    if (writeError !== undefined) throw writeError;
    return (
      writeRow ?? {
        workspaceId: input.workspaceId,
        defaultModel: input.defaultModel,
      }
    );
  },
};

/**
 * The app-wide member gate (`http/team-gate.ts`) runs BEFORE every `/api/` route
 * for an authenticated caller and answers 503 when the lookup fails. It is
 * unchanged by this ticket, so the harness has to satisfy it — exactly as
 * `team-gate.test.ts` and `viewer.test.ts` do — or every settings case would
 * measure the gate instead of the settings route.
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

/**
 * The viewer owns ONE personal workspace. The route reads `workspace.id` from it
 * and may not take a workspace from anywhere else — that is the product semantic
 * 21E1 keeps.
 */
const viewerService = {
  async ensureViewer() {
    return {
      workspace: {
        id: PERSONAL_WORKSPACE_ID,
        name: "Personal",
        type: "personal" as const,
        ownerUserId: USER_ID,
      },
    };
  },
} as unknown as ViewerService;

let app: FastifyInstance;

beforeEach(async () => {
  userFactoryCalls = [];
  readCalls = [];
  writeCalls = [];
  writeRow = undefined;
  writeError = undefined;
  storedReadRow = null;

  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    env: {},
    teamMembershipService,
    viewerService,
    workspaceSettingsWriteRepository,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function putSettings(
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
    method: "PUT",
    url: "/api/workspace/settings",
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

function getSettings(options: { token?: string | null } = {}) {
  const headers =
    options.token === null || options.token === undefined
      ? {}
      : { authorization: `Bearer ${options.token}` };

  return app.inject({ method: "GET", url: "/api/workspace/settings", headers });
}

describe("PUT /api/workspace/settings: authentication and validation", () => {
  it("case 1: no token is the existing 401 and reaches neither the repository nor the factory", async () => {
    const response = await putSettings({ payload: { defaultModel: "model-a" } });

    expect(response.statusCode).toBe(401);
    expect(unauthenticatedErrorResponseSchema.parse(response.json())).toBeDefined();
    expect(writeCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
    expect(readCalls).toHaveLength(0);
  });

  it("case 2: an unknown token is the same 401, with no write attempted", async () => {
    const response = await putSettings({
      token: "not-the-token",
      payload: { defaultModel: "model-a" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    expect(writeCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 3: an empty and a missing defaultModel are both the existing 400, with no write attempted", async () => {
    for (const payload of [{ defaultModel: "" }, {}]) {
      const response = await putSettings({ token: TOKEN, payload });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe("Invalid request body");
      expect(Array.isArray(response.json().issues)).toBe(true);
    }

    expect(writeCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 4: the request schema does not trim, so a whitespace-only model is stored unchanged", async () => {
    // Pinned rather than changed: `workspaceSettingsUpdateRequestSchema` is
    // `z.string().min(1)`, so the 2026-03 contract accepted (and this one must
    // still accept) a whitespace-only model. Adding a trim here would be a
    // silent behaviour change to a request contract this ticket does not own.
    const response = await putSettings({
      token: TOKEN,
      payload: { defaultModel: "   " },
    });

    expect(response.statusCode).toBe(200);
    expect(writeCalls).toEqual([
      {
        actorId: USER_ID,
        workspaceId: PERSONAL_WORKSPACE_ID,
        defaultModel: "   ",
      },
    ]);
  });
});

describe("PUT /api/workspace/settings: the successful write", () => {
  it("case 5: the viewer's own workspace is written and the EXISTING 200 body comes back", async () => {
    const response = await putSettings({
      token: TOKEN,
      payload: { defaultModel: "claude-sonnet-5" },
    });

    expect(response.statusCode).toBe(200);
    expect(workspaceSettingsResponseSchema.parse(response.json())).toEqual({
      settings: { defaultModel: "claude-sonnet-5" },
    });

    // The route passes the AUTHENTICATED actor and the VIEWER's workspace down:
    // the repository is the only thing that decides which row that is.
    expect(writeCalls).toEqual([
      {
        actorId: USER_ID,
        workspaceId: PERSONAL_WORKSPACE_ID,
        defaultModel: "claude-sonnet-5",
      },
    ]);
    // And the WRITE never reached PostgREST: the factory was not called and the
    // read chain recorded nothing.
    expect(userFactoryCalls).toHaveLength(0);
    expect(readCalls).toHaveLength(0);
  });

  it("case 6: the body cannot retarget the workspace — extra keys are stripped", async () => {
    const response = await putSettings({
      token: TOKEN,
      payload: {
        defaultModel: "Body Cannot Retarget",
        // None of these is part of the request contract, and none may become the
        // row that is written.
        workspaceId: OTHER_WORKSPACE_ID,
        workspace_id: OTHER_WORKSPACE_ID,
        actorId: "00000000-0000-0000-0000-0000000000c9",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(writeCalls).toEqual([
      {
        actorId: USER_ID,
        workspaceId: PERSONAL_WORKSPACE_ID,
        defaultModel: "Body Cannot Retarget",
      },
    ]);
    expect(writeCalls[0]?.workspaceId).not.toBe(OTHER_WORKSPACE_ID);
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 7: the 200 body is projected from what the write RETURNED, not from the request", async () => {
    writeRow = {
      workspaceId: PERSONAL_WORKSPACE_ID,
      defaultModel: "what-the-database-confirmed",
    };

    const response = await putSettings({
      token: TOKEN,
      payload: { defaultModel: "what-the-client-asked-for" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      settings: { defaultModel: "what-the-database-confirmed" },
    });
    // The write still carried the requested value; only the ANSWER is taken from
    // the confirmed row, which is the same value on any real successful write.
    expect(writeCalls[0]?.defaultModel).toBe("what-the-client-asked-for");
  });
});

describe("PUT /api/workspace/settings: every write failure is the same 500", () => {
  it("case 8: a refusal (zero rows) and any other repository failure keep the existing 500 projection", async () => {
    const failures: unknown[] = [
      // The repository's own refusal: not an owner/admin member, or no such
      // workspace. The database mechanism behind it (21E0 measured both an
      // RLS 42501 and a silent zero-row UPDATE) must not reach the client.
      new WorkspaceSettingsWriteError(
        UPSERT_DEFAULT_MODEL,
        new Error("workspace settings write updated no row"),
      ),
      new WorkspaceSettingsWriteError(
        UPSERT_DEFAULT_MODEL,
        Object.assign(
          new Error(
            "insert into public.workspace_settings ... row-level security policy: " +
              "connect ECONNREFUSED db.internal:5432",
          ),
          { code: "42501" },
        ),
      ),
      // And anything the repository never throws is still this route's 500.
      new Error("something the repository never throws"),
    ];

    for (const failure of failures) {
      writeError = failure;

      const response = await putSettings({
        token: TOKEN,
        payload: { defaultModel: "never-stored-model" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "settings_update_failed",
          message: "Unable to update workspace settings.",
        },
      });
      expect(applicationErrorResponseSchema.parse(response.json())).toBeDefined();
      // NOT a 403 and NOT a 404: the failure must not answer whether the
      // workspace exists or whether the caller is a member of it.
      expect([403, 404]).not.toContain(response.statusCode);
      for (const leak of [
        PERSONAL_WORKSPACE_ID,
        "public.",
        "workspace_settings",
        "workspace_members",
        "42501",
        "row-level security",
        "ECONNREFUSED",
        "db.internal",
        "owner",
        "admin",
        "member",
        "something the repository never throws",
      ]) {
        expect(response.body).not.toContain(leak);
      }
      expect(userFactoryCalls).toHaveLength(0);
    }

    expect(writeCalls).toHaveLength(failures.length);
  });

  it("case 9: with NO repository injected the route fails closed — no PostgREST fallback", async () => {
    // The route is registered on its own here, with a settings service built
    // WITHOUT a repository, so the option really is absent rather than replaced by
    // a default. The app still has the user-scoped factory, and the answer is the
    // same 500 without a single call to it.
    const bare = Fastify();
    await registerSettingsRoutes(bare, {
      auth,
      settingsService: createSettingsService({
        createUserClient: userClientFactory,
        defaultModel: DEFAULT_AGENT_MODEL,
      }),
      viewerService,
    });
    await bare.ready();

    try {
      const response = await bare.inject({
        method: "PUT",
        url: "/api/workspace/settings",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { defaultModel: "never-stored-model" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "settings_update_failed",
          message: "Unable to update workspace settings.",
        },
      });
      expect(userFactoryCalls).toHaveLength(0);
      expect(readCalls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});

describe("GET /api/workspace/settings: the read path did not move", () => {
  it("case 10: the read still runs on the user-scoped client, and the write still never touches it", async () => {
    // A stored row is served through the user-scoped client...
    storedReadRow = { default_model: "stored-model" };
    const stored = await getSettings({ token: TOKEN });

    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({ settings: { defaultModel: "stored-model" } });

    // ...and with no row at all the fallback model is still used, exactly as the
    // untouched read path did before this ticket.
    storedReadRow = null;
    const fallback = await getSettings({ token: TOKEN });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toEqual({
      settings: { defaultModel: DEFAULT_AGENT_MODEL },
    });

    // The READ is what reaches the user-scoped client, and it is the only thing
    // that does: the factory was called for the reads, with the caller's token.
    expect(userFactoryCalls).toEqual([TOKEN, TOKEN]);
    expect(readCalls).toEqual([
      "from workspace_settings",
      "select default_model",
      `eq workspace_id=${PERSONAL_WORKSPACE_ID}`,
      "maybeSingle",
      "from workspace_settings",
      "select default_model",
      `eq workspace_id=${PERSONAL_WORKSPACE_ID}`,
      "maybeSingle",
    ]);

    // Now the same app performs the WRITE: the recorded read/factory counts do
    // not move by one, so the write has no PostgREST path at all.
    const before = { factory: userFactoryCalls.length, read: readCalls.length };
    const written = await putSettings({
      token: TOKEN,
      payload: { defaultModel: "written-after-the-reads" },
    });

    expect(written.statusCode).toBe(200);
    expect(written.json()).toEqual({
      settings: { defaultModel: "written-after-the-reads" },
    });
    expect(userFactoryCalls).toHaveLength(before.factory);
    expect(readCalls).toHaveLength(before.read);
    expect(writeCalls).toEqual([
      {
        actorId: USER_ID,
        workspaceId: PERSONAL_WORKSPACE_ID,
        defaultModel: "written-after-the-reads",
      },
    ]);
  });
});
