import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { applicationErrorResponseSchema } from "@loomic/shared";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";

/**
 * Workorder 31B fixup2 — `model_not_available` on the wire.
 *
 * The pricing table has no usable row for a model, so `withBilling` refuses
 * BEFORE the job exists and before the balance is read, throwing
 * `CreditServiceError("model_not_available", …, 400)`. The route's `catch` then
 * builds the reply through `applicationErrorResponseSchema.parse({ error: {
 * code, message } })` — so as long as the code is missing from
 * `applicationErrorCodeSchema`, that `parse()` throws a ZodError from inside the
 * error path and the client receives a 500 instead of the intended 400. This
 * file pins both halves:
 *
 *   1. the schema accepts the code (the parse that used to throw);
 *   2. `POST /api/jobs/image-generation` answers 400 with that code — and no job
 *      was created, which is the point of refusing here (ruling 6).
 *
 * The harness is the real `buildApp` with the same doubles the other route tests
 * use (`http/tools.test.ts`), plus the two billing dependencies 31B introduced.
 * Nothing here reads PostgREST: `createUserClient` records and throws.
 */

const TOKEN = "model-not-available-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "model-not-available@hahart.test",
  id: "00000000-0000-0000-0000-0000000000c1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c2";
const MODEL_ID = "black-forest-labs/flux-kontext-pro";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

let userFactoryCalls: string[];

function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);
  throw new Error(
    "the model_not_available refusal happens before any PostgREST / Storage call",
  );
}

/**
 * The app-wide member gate (`http/team-gate.ts`) runs before every `/api/` route,
 * so the harness has to satisfy it. It is not what this file is about.
 */
const teamMembershipService = {
  async get() {
    return {
      workspace: {
        id: "33333333-3333-3333-3333-333333333333",
        name: "HaHart 团队",
        type: "team" as const,
        ownerUserId: USER.id,
      },
      role: "member" as const,
    };
  },
  invalidate() {},
} as unknown as TeamMembershipService;

const viewerService = {
  async ensureViewer() {
    return {
      workspace: {
        id: WORKSPACE_ID,
        name: "Personal",
        type: "personal" as const,
        ownerUserId: USER.id,
      },
    };
  },
} as unknown as ViewerService;

/** Billing is on (`creditService` + `tierGuard` present) — that is what quotes. */
const creditService = {
  getSubscription: vi.fn(async () => ({
    plan: "pro" as const,
    billingPeriod: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    canceledAt: null,
  })),
} as unknown as CreditService;

const tierGuard = {
  checkModelAccess: vi.fn(),
  checkResolution: vi.fn(),
  checkVideoResolution: vi.fn(),
  checkConcurrency: vi.fn(async () => {}),
} as unknown as TierGuard;

/** The price table does not know the model: `{ ok: false, code }`. */
const quote = vi.fn(async () => ({
  ok: false as const,
  code: "model_not_available" as const,
}));
const priceQuoter: PriceQuoter = { quote };

const createJob = vi.fn(async () => {
  throw new Error("createJob must not be called for an unavailable model");
});
const jobService = {
  createJob,
  getJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  getJobAdmin: vi.fn(),
} as unknown as JobService;

let app: FastifyInstance;

beforeEach(async () => {
  userFactoryCalls = [];
  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    creditService,
    env: {},
    jobService,
    priceQuoter,
    teamMembershipService,
    tierGuard,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  // The doubles above are module scope, so calls have to be cleared between
  // cases or case 3 counts case 2's quote.
  vi.clearAllMocks();
});

describe("applicationErrorResponseSchema", () => {
  it("case 1: parsing a model_not_available error body does not throw", () => {
    expect(() =>
      applicationErrorResponseSchema.parse({
        error: { code: "model_not_available", message: "x" },
      }),
    ).not.toThrow();

    const parsed = applicationErrorResponseSchema.parse({
      error: { code: "model_not_available", message: "x" },
    });
    expect(parsed.error.code).toBe("model_not_available");
  });
});

describe("POST /api/jobs/image-generation: an unregistered model is a 400", () => {
  it("case 2: 400 with code model_not_available, and no job was created", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { model: MODEL_ID, prompt: "a red panda in a raincoat" },
    });

    expect(response.statusCode).toBe(400);

    // The body IS the application error envelope, not Fastify's zod dump: the
    // assertion below is the one that fails while the enum lacks the code.
    const body = applicationErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("model_not_available");
    expect(body.error.message).toContain(MODEL_ID);

    // Ruling 6: the refusal comes BEFORE the job exists.
    expect(createJob).toHaveBeenCalledTimes(0);
    // Nothing reached PostgREST either — the whole request is decided on the quote.
    expect(userFactoryCalls).toHaveLength(0);
  });

  it("case 3: the quote is what decided it — asked once, for the requested model", async () => {
    await app.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { model: MODEL_ID, prompt: "a red panda in a raincoat" },
    });

    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote.mock.calls[0]?.[0]).toMatchObject({
      modelId: MODEL_ID,
      entryPoint: "canvas_generator",
    });
    expect(tierGuard.checkConcurrency).toHaveBeenCalledTimes(1);
  });
});
