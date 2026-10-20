import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  JobServiceError,
  type JobService,
} from "../features/jobs/job-service.js";
import {
  CANCEL_REFUND_DESCRIPTION,
  createRefundJob,
} from "../features/jobs/refund-job.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

/**
 * GN-32 / workorder 36E-v2 — a job cancelled BEFORE it started is refunded.
 *
 * What is pinned here is the ROUTE's half: after `cancelJob` answers, a job whose
 * `started_at` is null is handed to the refund hook, and a job that already
 * started is not. There is deliberately no database: the `jobService` double
 * decides what the cancel matched, exactly as the repository would, and the
 * `refundCanceledJob` spy counts the money decisions.
 *
 * Case 5 pins the other half — the refund itself carries a description of its
 * own, distinguishable from the failed-job line. The "does it move the right
 * amount to the right workspace" rules are `refund-job.test.ts`'s and are not
 * repeated here.
 *
 * Nothing in this file asserts on SQL: the cancel statement and the
 * `markSucceeded` guard are owned by their existing cases.
 */

const TOKEN = "cancel-refund-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "cancel-refund@hahart.test",
  id: "00000000-0000-0000-0000-0000000000c1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c2";
// A real uuid: the response body is parsed against `jobResponseSchema`, whose
// `id` is `z.string().uuid()`, so a short placeholder would make the 200 path
// fail on the response rather than on the rule under test.
const JOB_ID = "00000000-0000-0000-0000-0000000000c3";

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation",
    job_type: "image_generation",
    status: "canceled",
    payload: { prompt: "a red panda in a raincoat" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: USER.id,
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:01.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: "2026-10-21T00:00:01.000Z",
    ...overrides,
  };
}

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

function makeJobService(cancelJob: (user: unknown, jobId: string) => Promise<BackgroundJob>) {
  return {
    cancelJob,
    createJob: vi.fn(),
    setCreditsInfo: vi.fn(),
    findRecentJobByClientRequestId: vi.fn(),
    getJob: vi.fn(),
    getJobAdmin: vi.fn(),
    listJobs: vi.fn(),
  } as unknown as JobService;
}

let apps: FastifyInstance[] = [];

async function buildApp(options: {
  cancelJob: (user: unknown, jobId: string) => Promise<BackgroundJob>;
  refundCanceledJob?: (jobId: string) => Promise<void>;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await registerJobRoutes(app, {
    auth,
    jobService: makeJobService(options.cancelJob),
    viewerService,
    ...(options.refundCanceledJob
      ? { refundCanceledJob: options.refundCanceledJob }
      : {}),
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

function cancel(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: `/api/jobs/${JOB_ID}/cancel`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("POST /api/jobs/:jobId/cancel — GN-32 refund of a job that never started", () => {
  it("GN-32: cancelling a job that never started refunds it", async () => {
    const refundCanceledJob = vi.fn(async (_jobId: string) => {});
    // `started_at: null` is what the cancel statement returned for a queued row:
    // the job never began executing, so the money comes back.
    const app = await buildApp({
      cancelJob: async () => makeJob({ started_at: null }),
      refundCanceledJob,
    });

    const response = await cancel(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().job.id).toBe(JOB_ID);
    expect(refundCanceledJob).toHaveBeenCalledTimes(1);
    expect(refundCanceledJob).toHaveBeenCalledWith(JOB_ID);
  });

  it("GN-32: cancelling a job that already started does not refund", async () => {
    const refundCanceledJob = vi.fn(async (_jobId: string) => {});
    // A running row carries `started_at`; only `markRunning` writes it, so its
    // presence is "execution began" and there is nothing to give back.
    const app = await buildApp({
      cancelJob: async () =>
        makeJob({ started_at: "2026-10-21T00:00:00.000Z" }),
      refundCanceledJob,
    });

    const response = await cancel(app);

    expect(response.statusCode).toBe(200);
    expect(refundCanceledJob).toHaveBeenCalledTimes(0);
  });

  it("GN-32: without a refund hook the cancel still answers", async () => {
    // A deployment without credits passes no hook; the cancel must keep working
    // and must not need one.
    const app = await buildApp({
      cancelJob: async () => makeJob({ started_at: null }),
    });

    const response = await cancel(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().job.id).toBe(JOB_ID);
  });

  it("GN-32: a cancel that matched nothing does not refund", async () => {
    const refundCanceledJob = vi.fn(async (_jobId: string) => {});
    // No row matched (unknown id, somebody else's job, or a status that may not
    // be cancelled): `cancelJob` raises its 404 and no refund may follow.
    const app = await buildApp({
      cancelJob: async () => {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      },
      refundCanceledJob,
    });

    const response = await cancel(app);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("job_not_found");
    expect(refundCanceledJob).toHaveBeenCalledTimes(0);
  });
});

describe("createRefundJob with the cancel description", () => {
  it("GN-32: the cancel refund carries its own description", async () => {
    const refundCredits = vi.fn(async (..._args: unknown[]) => "tx-cancel-1");
    const refundJob = createRefundJob({
      readRefundBasis: async () => ({
        creditsCost: 9,
        workspaceId: WORKSPACE_ID,
        createdBy: USER.id,
      }),
      creditService: { refundCredits } as unknown as Pick<
        CreditService,
        "refundCredits"
      >,
      description: CANCEL_REFUND_DESCRIPTION,
      log: () => {},
      logError: () => {},
    });

    await refundJob(JOB_ID, "[test]");

    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledWith(
      WORKSPACE_ID,
      USER.id,
      9,
      JOB_ID,
      "Auto-refund: job canceled before start",
    );
  });
});
