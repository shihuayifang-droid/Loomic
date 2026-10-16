import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applicationErrorCodeSchema,
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
  workspaceSettingsResponseSchema,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import { DEFAULT_AGENT_MODEL } from "../config/env.js";
import {
  READ_DEFAULT_MODEL,
  WorkspaceSettingsReadError,
  type WorkspaceSettingsReadRepository,
} from "../db/workspace-settings-read-repository.js";
import {
  UPSERT_DEFAULT_MODEL,
  WorkspaceSettingsWriteError,
  type WorkspaceSettingsWriteRepository,
  type WorkspaceSettingsWriteRow,
} from "../db/workspace-settings-write-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import {
  SettingsServiceError,
  createSettingsService,
} from "../features/settings/settings-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";
import { registerSettingsRoutes } from "./settings.js";

/**
 * `/api/workspace/settings` as the CLIENT sees it (workorders 21E1 and 21L).
 *
 * The Supabase upsert this route used to perform is gone (21E1), and so is the
 * Supabase read (21L); what this file pins is that the ROUTE CONTRACT did not
 * move with either of them — the 401 without a token, the 400 for an invalid
 * body, the unchanged 200 `{ settings: { defaultModel } }`, the
 * `settings_read_failed` 500 the GET answers when the read cannot be performed,
 * and the single 500 `settings_update_failed` that every failure of the write
 * collapses into.
 *
 * Three things are observed rather than asserted in prose:
 *
 * - `createUserClient` is injected as a factory whose calls are RECORDED, and
 *   since workorder 21L the settings service does not receive it at all. Every
 *   case asserts it was never reached, which is the direct evidence that neither
 *   the READ nor the WRITE has a PostgREST path left to fall back to.
 * - The repositories are DOUBLES, so the arguments the route passes down are
 *   recorded. These cases are therefore NOT authorization evidence: who may read
 *   or write which workspace row is proven against real SQL in
 *   `db/workspace-settings-read-repository.test.ts` and
 *   `test-support/db/workspace-settings-read-repository-db.test.ts` (and the
 *   21E1 pair for the write). This file only proves the HTTP surface is
 *   unchanged, and that the route still hands both directions the VIEWER's own
 *   workspace.
 * - The app is built through `buildApp` with the write repository injected, so
 *   the real wiring of workorder 21E1 is part of what runs. The GET cases build
 *   the service explicitly instead, because workorder 21L deliberately did NOT
 *   add an injectable read repository to `buildApp` — it is built inline at the
 *   one call site that needs it.
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

type ReadCall = {
  actorId: string;
  workspaceId: string;
};

let userFactoryCalls: string[];
let readCalls: string[];
let writeCalls: WriteCall[];
let readRepositoryCalls: ReadCall[];
let writeRow: WorkspaceSettingsWriteRow | undefined;
let writeError: unknown;
let readModel: string | null;
let readError: unknown;

/**
 * The user-scoped Supabase client, as a recording stub.
 *
 * The factory itself is the observation point, and since workorder 21L it is
 * only a tripwire: the settings service no longer receives it, so a call here —
 * recorded, with every step of the read chain it makes — means one of the two
 * directions went back to PostgREST. The `from` accessor is written as a
 * computed key on purpose: a literal PostgREST call token in this file would
 * raise the dependency audit's text counter, which this ticket has to keep at
 * its measured value.
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
      // Nothing to serve: no settings path may reach this stub any more, so the
      // only honest answer is an empty one, and the `readCalls` record above is
      // what a caller would have to explain.
      return { data: null, error: null };
    },
  };

  return {
    ["from"](table: string) {
      readCalls.push(`from ${table}`);
      return query;
    },
  } as unknown as UserSupabaseClient;
}

/** A double for the write repository that records the arguments the ROUTE passed down. */
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

/** A double for the read repository, recording the same way. */
const workspaceSettingsReadRepository: WorkspaceSettingsReadRepository = {
  async readDefaultModel(input) {
    readRepositoryCalls.push({
      actorId: input.actorId,
      workspaceId: input.workspaceId,
    });
    if (readError !== undefined) throw readError;
    return readModel;
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
  readRepositoryCalls = [];
  writeRow = undefined;
  writeError = undefined;
  readModel = null;
  readError = undefined;

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

function getSettings(
  options: {
    token?: string | null;
    /** Defaults to the app built in `beforeEach`. */
    instance?: FastifyInstance;
    /** Appended verbatim, so a case can try to smuggle a workspace in. */
    query?: string;
  } = {},
) {
  const headers =
    options.token === null || options.token === undefined
      ? {}
      : { authorization: `Bearer ${options.token}` };

  return (options.instance ?? app).inject({
    method: "GET",
    url: `/api/workspace/settings${options.query ?? ""}`,
    headers,
  });
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

describe("GET /api/workspace/settings: the read now runs on its repository", () => {
  /**
   * The same real app, with the settings service built around the two repository
   * doubles. `buildApp` deliberately has no injectable read repository (21L built
   * it inline at its one call site), so the read half is observed from here.
   */
  async function buildReadApp(): Promise<FastifyInstance> {
    const readsApp = buildApp({
      auth,
      createUserClient: userClientFactory,
      env: {},
      settingsService: createSettingsService({
        defaultModel: DEFAULT_AGENT_MODEL,
        workspaceSettingsReadRepository,
        workspaceSettingsWriteRepository,
      }),
      teamMembershipService,
      viewerService,
    });
    await readsApp.ready();
    return readsApp;
  }

  it("case 10: the stored model is served from the repository, a null answer falls back to the default, and any read failure is the existing 500", async () => {
    const readsApp = await buildReadApp();

    try {
      // A stored row is served from the repository... The query string names
      // another workspace on purpose: the route may only ever read the VIEWER's.
      readModel = "stored-model";
      const stored = await getSettings({
        instance: readsApp,
        query: `?workspaceId=${OTHER_WORKSPACE_ID}`,
        token: TOKEN,
      });

      expect(stored.statusCode).toBe(200);
      expect(stored.json()).toEqual({ settings: { defaultModel: "stored-model" } });

      // ...and with `null` — no settings row, or a caller who is not a member of
      // that workspace, the two answers this read cannot tell apart — the
      // fallback model is still used, exactly as the untouched read path did
      // before this ticket. NOT a 403: a non-member must still get a model, or
      // `/api/agent/runs` and the websocket handler would stop starting runs.
      readModel = null;
      const fallback = await getSettings({ instance: readsApp, token: TOKEN });

      expect(fallback.statusCode).toBe(200);
      expect(fallback.json()).toEqual({
        settings: { defaultModel: DEFAULT_AGENT_MODEL },
      });
      expect([403, 404]).not.toContain(fallback.statusCode);

      // Every failure of the read — the repository's own error and anything it
      // never throws — is the same 500 the PostgREST error used to produce, and
      // it answers nothing about the workspace.
      const failures: unknown[] = [
        new WorkspaceSettingsReadError(
          READ_DEFAULT_MODEL,
          Object.assign(
            new Error(
              "select s.default_model from public.workspace_settings s failed: " +
                "connect ECONNREFUSED db.internal:5432",
            ),
            { code: "42501" },
          ),
        ),
        new Error("something the read repository never throws"),
      ];

      for (const failure of failures) {
        readError = failure;

        const response = await getSettings({ instance: readsApp, token: TOKEN });

        expect(response.statusCode).toBe(500);
        // NOT a 403 and NOT a 404: the failure may not answer whether the
        // workspace exists or whether the caller is a member of it.
        expect([403, 404]).not.toContain(response.statusCode);
        // The failure reaches the client as its OWN code: `settings_read_failed`
        // is part of the shared wire enum (workorder 21L-fixup), so the shared
        // response schema below parses here instead of throwing inside this very
        // error path and leaving Fastify to answer with its generic 500.
        expect(response.json()).toEqual({
          error: {
            code: "settings_read_failed",
            message: "Unable to load workspace settings.",
          },
        });
        expect(applicationErrorResponseSchema.parse(response.json())).toBeDefined();
        // And the body is the route's own projection, not a zod dump.
        expect(response.body).not.toContain("Invalid enum value");
        for (const leak of [
          PERSONAL_WORKSPACE_ID,
          "workspace_settings",
          "workspace_members",
          "42501",
          "row-level security",
          "ECONNREFUSED",
          "db.internal",
          "something the read repository never throws",
        ]) {
          expect(response.body).not.toContain(leak);
        }
      }

      // The route passed the AUTHENTICATED actor and the VIEWER's workspace down
      // on every read, and the query string could not retarget it.
      expect(readRepositoryCalls).toEqual([
        { actorId: USER_ID, workspaceId: PERSONAL_WORKSPACE_ID },
        { actorId: USER_ID, workspaceId: PERSONAL_WORKSPACE_ID },
        { actorId: USER_ID, workspaceId: PERSONAL_WORKSPACE_ID },
        { actorId: USER_ID, workspaceId: PERSONAL_WORKSPACE_ID },
      ]);
      expect(
        readRepositoryCalls.every(
          (call) => call.workspaceId === PERSONAL_WORKSPACE_ID,
        ),
      ).toBe(true);
      expect(readRepositoryCalls.map((call) => call.workspaceId)).not.toContain(
        OTHER_WORKSPACE_ID,
      );

      // No part of the read went back to PostgREST: the user-scoped factory was
      // never called and its read chain recorded nothing.
      expect(userFactoryCalls).toHaveLength(0);
      expect(readCalls).toHaveLength(0);

      // Now the WRITE on the same app: it never touches the read repository, and
      // it is still what the read repository is NOT allowed to become.
      readError = undefined;
      const readsBefore = readRepositoryCalls.length;
      const written = await readsApp.inject({
        method: "PUT",
        url: "/api/workspace/settings",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { defaultModel: "written-after-the-reads" },
      });

      expect(written.statusCode).toBe(200);
      expect(written.json()).toEqual({
        settings: { defaultModel: "written-after-the-reads" },
      });
      expect(readRepositoryCalls).toHaveLength(readsBefore);
      expect(userFactoryCalls).toHaveLength(0);
      expect(readCalls).toHaveLength(0);
      expect(writeCalls).toEqual([
        {
          actorId: USER_ID,
          workspaceId: PERSONAL_WORKSPACE_ID,
          defaultModel: "written-after-the-reads",
        },
      ]);
    } finally {
      await readsApp.close();
    }
  });

  it("case 11: with NO read repository injected the GET fails closed — no PostgREST fallback", async () => {
    // The route is registered on its own here, with a settings service built
    // WITHOUT a read repository, so the option really is absent rather than
    // replaced by a default. This is the case a missing DATABASE_URL would hit in
    // production, and it must not be answered from PostgREST.
    const bare = Fastify();
    await registerSettingsRoutes(bare, {
      auth,
      settingsService: createSettingsService({
        defaultModel: DEFAULT_AGENT_MODEL,
      }),
      viewerService,
    });
    await bare.ready();

    try {
      const response = await getSettings({ instance: bare, token: TOKEN });

      expect(response.statusCode).toBe(500);
      expect([403, 404]).not.toContain(response.statusCode);
      // The same body the failing read answers with a repository behind it: the
      // missing repository is not a separate wire outcome.
      expect(response.json()).toEqual({
        error: {
          code: "settings_read_failed",
          message: "Unable to load workspace settings.",
        },
      });
      expect(applicationErrorResponseSchema.parse(response.json())).toBeDefined();
      expect(response.body).not.toContain("Invalid enum value");
      for (const leak of [
        PERSONAL_WORKSPACE_ID,
        "workspace_settings",
        "workspace_members",
      ]) {
        expect(response.body).not.toContain(leak);
      }

      // A missing repository is not a reason to fall back: nothing reached the
      // user-scoped client, and no read repository existed to be reached either.
      expect(userFactoryCalls).toHaveLength(0);
      expect(readCalls).toHaveLength(0);
      expect(readRepositoryCalls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });

  it("case 12: a GET without a token is the existing 401 and reaches neither repository", async () => {
    // The read repository must not be consulted before the caller is known: an
    // anonymous request may not be turned into a workspace read.
    const response = await getSettings({ token: null });

    expect(response.statusCode).toBe(401);
    expect(unauthenticatedErrorResponseSchema.parse(response.json())).toBeDefined();
    expect(readRepositoryCalls).toHaveLength(0);
    expect(userFactoryCalls).toHaveLength(0);
    expect(readCalls).toHaveLength(0);
  });

  it("case 13: the read-failure contract the SERVICE owns is `settings_read_failed` / 500 / the untouched message", async () => {
    // Case 10 measures the wire, case 13 measures the contract behind it — the
    // half of workorder 21L's requirement that is reachable today. A missing
    // repository and a repository that threw must be indistinguishable, and both
    // must stay exactly what the removed PostgREST read produced.
    const failures: Array<unknown | undefined> = [
      undefined,
      new WorkspaceSettingsReadError(
        READ_DEFAULT_MODEL,
        new Error("connect ECONNREFUSED db.internal:5432"),
      ),
      new Error("something the read repository never throws"),
    ];

    for (const failure of failures) {
      readError = failure;
      const service = createSettingsService({
        defaultModel: DEFAULT_AGENT_MODEL,
        ...(failure === undefined ? {} : { workspaceSettingsReadRepository }),
      });

      const error = await service
        .getWorkspaceSettings(USER, PERSONAL_WORKSPACE_ID)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(SettingsServiceError);
      expect((error as SettingsServiceError).code).toBe("settings_read_failed");
      expect((error as SettingsServiceError).message).toBe(
        "Unable to load workspace settings.",
      );
      expect((error as SettingsServiceError).statusCode).toBe(500);
    }
  });
});

/**
 * Every code `SettingsServiceError` can carry must be one the wire schema accepts.
 *
 * `applicationErrorResponseSchema.parse()` runs INSIDE the route's error path
 * (`http/settings.ts` `sendSettingsError`). An unlisted code therefore makes the
 * parse throw while already handling a failure, and the client receives Fastify's
 * generic 500 plus the raw zod dump instead of the intended reply — the real cause
 * replaced by noise. That is exactly what `settings_read_failed` did until
 * workorder 21L-fixup added it to `applicationErrorCodeSchema`
 * (`packages/shared/src/http.ts`), which is why case 10 and case 11 can assert the
 * body on the wire now.
 *
 * Kept as a literal list rather than derived from the type, because a type cannot
 * be enumerated at runtime — and a check that silently covers nothing is worse
 * than no check. The exhaustiveness assertion below is what keeps the list equal
 * to the union the constructor accepts.
 */
const SETTINGS_SERVICE_CODES = [
  "settings_not_found",
  "settings_read_failed",
  "settings_update_failed",
] as const;

describe("SettingsServiceError wire contract", () => {
  it.each(SETTINGS_SERVICE_CODES)(
    "%s is accepted by applicationErrorCodeSchema",
    (code) => {
      expect(() => applicationErrorCodeSchema.parse(code)).not.toThrow();
    },
  );

  it("the list above still covers the constructor's accepted codes", () => {
    // Exhaustiveness, stated the way that actually holds: `SettingsServiceError["code"]`
    // is the whole union the constructor takes, so it only stays assignable to the
    // literal union of the list above while the two are equal. A member added to the
    // class without a line here stops this file compiling — which is the point, since
    // a code the wire enum does not list is a code the client never receives.
    // (`settings_not_found` has no throw site in the server today: the only two
    // `new SettingsServiceError(...)` calls pass the two codes around it. It is
    // listed because it IS part of the union, and the union is what reaches the route.)
    const carried: SettingsServiceError["code"] = "settings_read_failed";
    const covered: (typeof SETTINGS_SERVICE_CODES)[number] = carried;

    const error = new SettingsServiceError(
      covered,
      "Unable to load workspace settings.",
      500,
    );

    expect(error.code).toBe("settings_read_failed");
    expect(error.statusCode).toBe(500);
  });
});
