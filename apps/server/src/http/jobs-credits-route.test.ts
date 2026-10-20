import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jobCreditsResponseSchema } from "@loomic/shared";

import type { JobCreditsReadRepository } from "../db/job-credits-read-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

/**
 * GN-35 / workorder 36K — `GET /api/jobs/:jobId/credits`.
 *
 * What is pinned here is the ROUTE's half, with a stand-in repository and no
 * database: the 200 carries exactly the four fields of
 * `jobCreditsResponseSchema`; `null` from the repository becomes the same 404
 * the job read answers; and an unauthenticated request never reaches the
 * repository at all.
 *
 * The ownership predicate and the refund sum are the repository's, and they are
 * pinned against real SQL in `test-support/db/job-credits-read-db.test.ts`.
 */

const TOKEN = "job-credits-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "job-credits@hahart.test",
  id: "00000000-0000-0000-0000-0000000000d1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000d2";
// A real uuid: the response body is parsed against a schema whose `job_id` is
// `z.string().uuid()`, so a short placeholder would fail the 200 path on the
// response rather than on the rule under test.
const JOB_ID = "00000000-0000-0000-0000-0000000000d3";
const TRANSACTION_ID = "00000000-0000-0000-0000-0000000000d4";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

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

const jobService = {
  cancelJob: vi.fn(),
  createJob: vi.fn(),
  setCreditsInfo: vi.fn(),
  findRecentJobByClientRequestId: vi.fn(),
  getJob: vi.fn(),
  getJobAdmin: vi.fn(),
  listJobs: vi.fn(),
} as unknown as JobService;

let apps: FastifyInstance[] = [];

async function buildApp(
  repository?: JobCreditsReadRepository,
): Promise<FastifyInstance> {
  const app = Fastify();
  await registerJobRoutes(app, {
    auth,
    jobService,
    viewerService,
    ...(repository ? { jobCreditsReadRepository: repository } : {}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
  vi.clearAllMocks();
});

function readCredits(
  app: FastifyInstance,
  options: { authenticated?: boolean } = {},
) {
  return app.inject({
    method: "GET",
    url: `/api/jobs/${JOB_ID}/credits`,
    ...(options.authenticated === false
      ? {}
      : { headers: { authorization: `Bearer ${TOKEN}` } }),
  });
}

describe("GET /api/jobs/:jobId/credits — GN-35", () => {
  it("GN-35: the owner reads what the job cost and what came back", async () => {
    const readOwnJobCredits = vi.fn(async () => ({
      jobId: JOB_ID,
      creditsCost: 12,
      creditsRefunded: 12,
      creditsTransactionId: TRANSACTION_ID,
    }));
    const app = await buildApp({ readOwnJobCredits });

    const response = await readCredits(app);

    expect(response.statusCode).toBe(200);
    // Parsed with the exported schema, so the body is the contract and not just
    // "the handler happened to send an object".
    const body = jobCreditsResponseSchema.parse(response.json());
    expect(body).toEqual({
      job_id: JOB_ID,
      credits_cost: 12,
      credits_refunded: 12,
      credits_transaction_id: TRANSACTION_ID,
    });
    // The read is asked for the CALLER's job: the actor is the authenticated
    // user, never something from the request.
    expect(readOwnJobCredits).toHaveBeenCalledTimes(1);
    expect(readOwnJobCredits).toHaveBeenCalledWith({
      actorId: USER.id,
      jobId: JOB_ID,
    });
  });

  it("GN-35: a job that is not the caller's is the job read's 404", async () => {
    // The repository answers `null` for BOTH "no such job" and "not yours", so
    // the two are indistinguishable from outside — which is the point.
    const readOwnJobCredits = vi.fn(async () => null);
    const app = await buildApp({ readOwnJobCredits });

    const response = await readCredits(app);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("job_not_found");
    expect(readOwnJobCredits).toHaveBeenCalledTimes(1);
  });

  it("GN-35: without a token the credits are not read at all", async () => {
    const readOwnJobCredits = vi.fn(async () => null);
    const app = await buildApp({ readOwnJobCredits });

    const response = await readCredits(app, { authenticated: false });

    expect(response.statusCode).toBe(401);
    expect(readOwnJobCredits).toHaveBeenCalledTimes(0);
  });
});
