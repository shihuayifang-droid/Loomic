import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

/**
 * ED-00m — `client_request_id` on the two job-creation routes.
 *
 * What these cases pin is the ROUTE's half of the contract: the field is accepted
 * by the request schema, it reaches `withBilling` as `job.clientRequestId` (not
 * inside the generation payload, and not as a column on the insert), and a
 * repeat submission is answered with the SAME job and a 201.
 *
 * The deduplication itself lives in `withBilling` (workorder 34U) and is the job
 * service's lookup, so this file's `jobService` double is what makes a "hit" —
 * there is deliberately no database here. `createJob` is counted instead: "one
 * submission is one job" is exactly the `createJob` call count.
 *
 * Billing is OFF in this harness (no `creditService` / `tierGuard`, so no
 * `priceQuoter` either): that is the branch where the route's own wiring is what
 * is under test, and it keeps the doubles down to the two services named below.
 */

const TOKEN = "client-request-id-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "client-request-id@hahart.test",
  id: "00000000-0000-0000-0000-0000000000a1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000a2";

const CLIENT_REQUEST_ID = "req-12345678";

function makeJob(overrides: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation",
    job_type: "image_generation",
    status: "queued",
    payload: { prompt: "a red panda in a raincoat" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: USER.id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

const IMAGE_JOB = makeJob({
  id: "00000000-0000-0000-0000-0000000000b1",
  job_type: "image_generation",
  queue_name: "image_generation",
});

const VIDEO_JOB = makeJob({
  id: "00000000-0000-0000-0000-0000000000b2",
  job_type: "video_generation",
  queue_name: "video_generation",
});

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

const createJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);
const findRecentJobByClientRequestId = vi.fn(
  async (..._args: unknown[]): Promise<BackgroundJob | null> => null,
);
const setCreditsInfo = vi.fn(async (..._args: unknown[]) => {});
const cancelJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);

const jobService = {
  createJob,
  setCreditsInfo,
  cancelJob,
  findRecentJobByClientRequestId,
  getJob: vi.fn(),
  getJobAdmin: vi.fn(),
  listJobs: vi.fn(),
} as unknown as JobService;

let app: FastifyInstance;

beforeEach(async () => {
  // The doubles are module scope, so case 2 would count case 1's createJob.
  vi.clearAllMocks();
  createJob.mockResolvedValue(IMAGE_JOB);
  findRecentJobByClientRequestId.mockResolvedValue(null);

  app = Fastify();
  await registerJobRoutes(app, {
    auth,
    jobService,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function submitImage(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/jobs/image-generation",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body,
  });
}

describe("POST /api/jobs/image-generation with a client_request_id", () => {
  it("ED-00m: the same client_request_id twice yields one job", async () => {
    // First submission: nothing stored under this id yet, so it becomes a job.
    // Second submission of the SAME id: the lookup answers with that job.
    findRecentJobByClientRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(IMAGE_JOB);

    const first = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: CLIENT_REQUEST_ID,
    });
    const second = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: CLIENT_REQUEST_ID,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().job.id).toBe(IMAGE_JOB.id);
    expect(second.json().job.id).toBe(IMAGE_JOB.id);

    // One submission = one job, even though the button was pressed twice.
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ clientRequestId: CLIENT_REQUEST_ID }),
    );
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(2);
    expect(findRecentJobByClientRequestId).toHaveBeenCalledWith(
      USER,
      CLIENT_REQUEST_ID,
    );
  });

  it("ED-00m: without client_request_id every submission is its own job", async () => {
    const first = await submitImage({ prompt: "a red panda in a raincoat" });
    const second = await submitImage({ prompt: "a red panda in a raincoat" });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createJob).toHaveBeenCalledTimes(2);
    // No id, no lookup: the path is exactly what it was before ED-00m.
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(0);
    expect(createJob.mock.calls[0]?.[1]).not.toHaveProperty("clientRequestId");
  });

  it("ED-00m: a client_request_id shorter than 8 characters is a 400", async () => {
    const response = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: "short",
    });

    expect(response.statusCode).toBe(400);
    expect(createJob).toHaveBeenCalledTimes(0);
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(0);
  });
});

describe("POST /api/jobs/video-generation with a client_request_id", () => {
  it("ED-00m: the video route takes the same field", async () => {
    createJob.mockResolvedValue(VIDEO_JOB);

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/video-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        prompt: "a red panda in a raincoat",
        client_request_id: CLIENT_REQUEST_ID,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().job.id).toBe(VIDEO_JOB.id);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        clientRequestId: CLIENT_REQUEST_ID,
        jobType: "video_generation",
      }),
    );
  });
});
