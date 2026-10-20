import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_IMAGE_MODEL_ID, type BackgroundJob } from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { JobService } from "../features/jobs/job-service.js";
// `vi.mock` below is hoisted above every import, so this binding is already the
// replacement when the module graph loads.
import { watchJob } from "../features/jobs/job-watcher.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { imageJobBillingRequest, registerGenerateRoutes } from "./generate.js";

/**
 * GN-37 — the asynchronous image route (`POST /api/agent/generate-image-job`).
 *
 * What these cases pin is the ROUTE's half of the contract, and only that: the
 * submit answers 202 with the id of a job that was created exactly once, the
 * job carries the prompt / model / ratio AND the billed quality, the watcher is
 * started for that job, and a deployment without a job service says 503 instead
 * of pretending to accept work.
 *
 * Billing is OFF here (no `creditService` / `tierGuard`, so no `priceQuoter`
 * either): that is the branch where the route's own wiring is what is under
 * test, and it keeps the doubles down to the two services named below. The
 * quality that reaches the executor is asserted through `createJob`'s payload —
 * there is no database and no worker in this file, so "what the job says" is
 * the only observable of it that exists.
 *
 * `watchJob` is replaced: in production it is a detached poll loop that would
 * outlive the test process.
 */

vi.mock("../features/jobs/job-watcher.js");

const TOKEN = "image-job-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "image-job-route@hahart.test",
  id: "00000000-0000-0000-0000-0000000000c1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c2";

const IMAGE_JOB: BackgroundJob = {
  id: "job-1",
  workspace_id: WORKSPACE_ID,
  project_id: null,
  canvas_id: null,
  session_id: null,
  thread_id: null,
  queue_name: "image_generation",
  job_type: "image_generation",
  status: "queued",
  payload: { prompt: "猫" },
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
};

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

const uploadService = {} as unknown as UploadService;

const createJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);
const setCreditsInfo = vi.fn(async (..._args: unknown[]) => {});
const cancelJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);

const jobService = {
  createJob,
  setCreditsInfo,
  cancelJob,
  findRecentJobByClientRequestId: vi.fn(async () => null),
  getJob: vi.fn(),
  getJobAdmin: vi.fn(),
  listJobs: vi.fn(),
} as unknown as JobService;

let app: FastifyInstance;

beforeEach(async () => {
  // The doubles are module scope, so case 2 would otherwise count case 1's job.
  vi.clearAllMocks();
  createJob.mockResolvedValue(IMAGE_JOB);

  app = Fastify();
  await registerGenerateRoutes(app, {
    auth,
    jobService,
    viewerService,
    uploadService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function submitImageJob(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/agent/generate-image-job",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body,
  });
}

describe("POST /api/agent/generate-image-job", () => {
  it("GN-37: the image generator gets a job id back with 202", async () => {
    const response = await submitImageJob({ prompt: "猫" });

    expect(response.statusCode).toBe(202);
    expect(response.json().jobId).toBe("job-1");
    // One submission is one row: the id the client got back is the id created.
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("GN-37: the job carries the prompt, model, ratio and the billed quality", async () => {
    const response = await submitImageJob({
      prompt: "猫",
      quality: "ultra",
      aspectRatio: "16:9",
    });

    expect(response.statusCode).toBe(202);
    expect(createJob).toHaveBeenCalledTimes(1);

    const created = createJob.mock.calls[0]?.[1] as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(created?.payload).toEqual({
      prompt: "猫",
      model: DEFAULT_IMAGE_MODEL_ID,
      aspect_ratio: "16:9",
      quality: "ultra",
    });
  });

  it("GN-37: imageJobBillingRequest bills and records the same quality", () => {
    const chosen = imageJobBillingRequest(USER, WORKSPACE_ID, {
      prompt: "猫",
      quality: "ultra",
    });
    expect(chosen.guard.jobType).toBe("image_generation");
    // The guard is a union with the video branch; narrow on the discriminant
    // before reading the field that only the image branch carries.
    const chosenGuard = chosen.guard;
    if (chosenGuard.jobType !== "image_generation") {
      throw new Error("expected an image generation guard");
    }
    expect(chosenGuard.quality).toBe("ultra");
    expect(chosen.job?.payload.quality).toBe("ultra");
    // The tier guard and the executor must never disagree about what was billed.
    expect(chosenGuard.quality).toBe(chosen.job?.payload.quality);

    // No quality asked for: both halves fall back to the same "hd", not to two
    // defaults that merely happen to match today.
    const dflt = imageJobBillingRequest(USER, WORKSPACE_ID, { prompt: "猫" });
    const dfltGuard = dflt.guard;
    if (dfltGuard.jobType !== "image_generation") {
      throw new Error("expected an image generation guard");
    }
    expect(dfltGuard.quality).toBe("hd");
    expect(dflt.job?.payload.quality).toBe("hd");
    expect(dfltGuard.quality).toBe(dflt.job?.payload.quality);
  });

  it("GN-37: progress is watched for the new job", async () => {
    const response = await submitImageJob({ prompt: "猫" });
    expect(response.statusCode).toBe(202);

    const watched = vi.mocked(watchJob).mock.calls;
    expect(watched).toHaveLength(1);
    const first = watched[0];
    expect(first?.[0]).toMatchObject({ jobService });
    expect(first?.[1]).toMatchObject({
      jobId: "job-1",
      jobType: "image_generation",
    });
  });

  it("GN-37: without a job service the route answers 503", async () => {
    const bare = Fastify();
    await registerGenerateRoutes(bare, {
      auth,
      viewerService,
      uploadService,
    });
    await bare.ready();

    try {
      const response = await bare.inject({
        method: "POST",
        url: "/api/agent/generate-image-job",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { prompt: "猫" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("service_unavailable");
      expect(createJob).toHaveBeenCalledTimes(0);
    } finally {
      await bare.close();
    }
  });
});
