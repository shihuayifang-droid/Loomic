// @credits-system — Job creation routes with credit balance checks and tier enforcement
import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  BackgroundJobStatus,
  BackgroundJobType,
  VideoResolution,
} from "@loomic/shared";
import {
  DEFAULT_IMAGE_MODEL_ID,
  applicationErrorResponseSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  jobListResponseSchema,
  jobResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import {
  JobServiceError,
  type JobService,
} from "../features/jobs/job-service.js";
import {
  CreditServiceError,
  type CreditService,
} from "../features/credits/credit-service.js";
import {
  TierGuardError,
  type TierGuard,
} from "../features/credits/tier-guard.js";
import { withBilling } from "../features/credits/with-billing.js";
import type { CreditLedgerWriteRepository } from "../db/credit-ledger-write-repository.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { sendValidationError } from "./validation-error.js";

export async function registerJobRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService: JobService;
    tierGuard?: TierGuard;
    /**
     * Workorder 31B: the price comes from the price table, and a PENDING price
     * leaves a 0-amount ledger row. Passed straight through to `withBilling`,
     * which refuses to run with billing on and no quoter.
     */
    priceQuoter?: PriceQuoter;
    creditLedgerWriteRepository?: CreditLedgerWriteRepository;
    viewerService: ViewerService;
  },
) {
  // POST /api/jobs/image-generation — create image generation job
  app.post("/api/jobs/image-generation", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const payload = createImageJobRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);

      const model = payload.model ?? DEFAULT_IMAGE_MODEL_ID;

      const { job } = await withBilling(
        options,
        {
          user,
          workspaceId: viewer.workspace.id,
          modelId: model,
          entryPoint: "canvas_generator",
          // This request has no `quality` field, so bill at the plan maximum —
          // what this route already did via getPlanConfig(sub.plan).
          guard: { jobType: "image_generation", quality: "plan_max" },
          description: `Image generation: ${model}`,
          job: {
            payload: {
              prompt: payload.prompt,
              ...(payload.model !== undefined ? { model: payload.model } : {}),
              ...(payload.aspect_ratio !== undefined
                ? { aspect_ratio: payload.aspect_ratio }
                : {}),
            },
            refs: {
              ...(payload.project_id !== undefined
                ? { projectId: payload.project_id }
                : {}),
              ...(payload.canvas_id !== undefined
                ? { canvasId: payload.canvas_id }
                : {}),
              ...(payload.session_id !== undefined
                ? { sessionId: payload.session_id }
                : {}),
              ...(payload.thread_id !== undefined
                ? { threadId: payload.thread_id }
                : {}),
            },
          },
        },
        // Nothing to do here: the worker picks the job up off the queue. The
        // response just hands the job back to the caller to poll.
        async (outcome) => outcome,
      );

      return reply.code(201).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }
      return sendJobError(error, reply, "job_create_failed");
    }
  });

  // POST /api/jobs/video-generation — create video generation job
  app.post("/api/jobs/video-generation", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const payload = createVideoJobRequestSchema.parse(request.body);
      const viewer = await options.viewerService.ensureViewer(user);

      const model = payload.model ?? "wan-video/wan-2.6";

      const { job } = await withBilling(
        options,
        {
          user,
          workspaceId: viewer.workspace.id,
          modelId: model,
          entryPoint: "canvas_generator",
          guard: {
            jobType: "video_generation",
            // BEHAVIOUR FIX: this route used to pass only `duration` into the
            // cost calculation while writing `resolution` into the job payload,
            // so a 1080p request was billed at the base rate and the
            // resolutionMultipliers entry (1080p: 2 for the Veo models) never
            // applied. The other two video paths always passed both. Now it also
            // goes through checkVideoResolution, which this route skipped.
            ...(payload.duration != null ? { duration: payload.duration } : {}),
            ...(payload.resolution != null
              ? { resolution: payload.resolution as VideoResolution }
              : {}),
          },
          description: `Video generation: ${model}`,
          job: {
            payload: {
              prompt: payload.prompt,
              ...(payload.model !== undefined ? { model: payload.model } : {}),
              ...(payload.duration !== undefined ? { duration: payload.duration } : {}),
              ...(payload.resolution !== undefined ? { resolution: payload.resolution } : {}),
              ...(payload.aspect_ratio !== undefined ? { aspect_ratio: payload.aspect_ratio } : {}),
              ...(payload.input_images !== undefined ? { input_images: payload.input_images } : {}),
              ...(payload.input_video !== undefined ? { input_video: payload.input_video } : {}),
              ...(payload.enable_audio !== undefined ? { enable_audio: payload.enable_audio } : {}),
            },
            refs: {
              ...(payload.project_id !== undefined
                ? { projectId: payload.project_id }
                : {}),
              ...(payload.canvas_id !== undefined
                ? { canvasId: payload.canvas_id }
                : {}),
              ...(payload.session_id !== undefined
                ? { sessionId: payload.session_id }
                : {}),
              ...(payload.thread_id !== undefined
                ? { threadId: payload.thread_id }
                : {}),
            },
          },
        },
        async (outcome) => outcome,
      );

      return reply.code(201).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      if (isZodError(error)) {
        return sendValidationError(reply, error.issues);
      }
      return sendJobError(error, reply, "job_create_failed");
    }
  });

  // GET /api/jobs/:jobId — get job status
  app.get("/api/jobs/:jobId", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      const job = await options.jobService.getJob(user, jobId);

      return reply.code(200).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      return sendJobError(error, reply, "job_query_failed");
    }
  });

  // GET /api/jobs — list jobs
  app.get("/api/jobs", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const query = request.query as { status?: string; job_type?: string };
      const filters: { status?: BackgroundJobStatus; jobType?: BackgroundJobType } = {};
      if (query.status) filters.status = query.status as BackgroundJobStatus;
      if (query.job_type) filters.jobType = query.job_type as BackgroundJobType;
      const jobs = await options.jobService.listJobs(user, filters);

      return reply.code(200).send(jobListResponseSchema.parse({ jobs }));
    } catch (error) {
      return sendJobError(error, reply, "job_query_failed");
    }
  });

  // POST /api/jobs/:jobId/cancel — cancel job
  app.post("/api/jobs/:jobId/cancel", async (request, reply) => {
    try {
      const user = await options.auth.authenticate(request);
      if (!user) return sendUnauthenticated(reply);

      const { jobId } = request.params as { jobId: string };
      const job = await options.jobService.cancelJob(user, jobId);

      return reply.code(200).send(jobResponseSchema.parse({ job }));
    } catch (error) {
      return sendJobError(error, reply, "job_cancel_failed");
    }
  });
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

type JobErrorFallbackCode =
  | "job_not_found"
  | "job_create_failed"
  | "job_query_failed"
  | "job_cancel_failed";

function sendJobError(
  error: unknown,
  reply: FastifyReply,
  fallbackCode: JobErrorFallbackCode,
) {
  if (error instanceof JobServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof TierGuardError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  if (error instanceof CreditServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: fallbackCode,
        message: "An unexpected error occurred.",
      },
    }),
  );
}

function isZodError(
  error: unknown,
): error is { issues: unknown[]; name: string } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    "issues" in error &&
    Array.isArray(error.issues)
  );
}
