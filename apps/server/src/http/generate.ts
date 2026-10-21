// @credits-system — Direct generation routes with credit deduction and tier checks
import type { FastifyInstance } from "fastify";

import {
  DEFAULT_IMAGE_MODEL_ID,
  DEFAULT_VIDEO_MODEL_ID,
  applicationErrorResponseSchema,
  generateImageRequestSchema,
  generateVideoRequestSchema,
  unauthenticatedErrorResponseSchema,
  type GenerateImageRequest,
  type GenerateVideoRequest,
  type VideoResolution,
} from "@loomic/shared";

import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import { withBilling, type BillingRequest } from "../features/credits/with-billing.js";
import { generationLedgerDescription } from "../features/credits/ledger-description.js";
import type { CreditLedgerWriteRepository } from "../db/credit-ledger-write-repository.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { JobService } from "../features/jobs/job-service.js";
import { JobServiceError } from "../features/jobs/job-service.js";
import { watchJob } from "../features/jobs/job-watcher.js";
import type { ConnectionManager } from "../ws/connection-manager.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type { AuthenticatedUser, RequestAuthenticator } from "../supabase/user.js";
import { sanitizeErrorForClient } from "../utils/error-sanitizer.js";

// Workorder 31D ruling 1: the two request-body schemas moved to
// `@loomic/shared` (`pricing-quote.ts`) and are imported above. The quote route
// validates the SAME objects, which is what makes "询价的请求体与提交完全同构" a
// fact instead of two copies that happen to look alike today.

/**
 * X-40 §3: the fallback answer of the two generation routes. The raw error is
 * logged server-side by `sanitizeErrorForClient`; the client gets a fixed,
 * category-level sentence instead of upstream/driver text. Code and status are
 * unchanged (`generation_failed`, 502).
 */
export function generationFailedBody(error: unknown) {
  return applicationErrorResponseSchema.parse({
    error: { code: "generation_failed", message: sanitizeErrorForClient(error) },
  });
}

/**
 * GN-11 / X-P7: what a generator relay upload records about the image it is
 * relaying — the real source, the model, the prompt and what it cost.
 */
export function generatorRelayProvenance(input: { modelId: string; prompt: string; creditsCharged: number }) {
  return {
    source: "generator" as const,
    operation: "image_generation",
    modelId: input.modelId,
    prompt: input.prompt,
    creditsCharged: input.creditsCharged,
  };
}

/**
 * GN-37: the billing request of the asynchronous image route, as a pure function.
 *
 * Pulled out of the route so a test can compare the two halves that must agree
 * without standing up a whole request: the tier guard decides what is ALLOWED at
 * this quality, and the job payload decides what the executor RENDERS. Two
 * separate `?? "hd"` expressions would be two copies that happen to look alike
 * today and could drift tomorrow, so the quality is resolved once into a local
 * and both halves read that local (the 35N rule, same as the video route does
 * for its own fields).
 */
export function imageJobBillingRequest(
  user: AuthenticatedUser,
  workspaceId: string,
  payload: GenerateImageRequest,
): BillingRequest {
  const model = payload.model ?? DEFAULT_IMAGE_MODEL_ID;
  const quality = payload.quality ?? "hd";

  return {
    user,
    workspaceId,
    modelId: model,
    entryPoint: "canvas_generator",
    guard: {
      jobType: "image_generation",
      quality,
    },
    description: generationLedgerDescription("image", model),
    job: {
      payload: {
        prompt: payload.prompt,
        model,
        aspect_ratio: payload.aspectRatio ?? "1:1",
        quality,
      },
    },
  };
}

export async function registerGenerateRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService?: CreditService;
    jobService?: JobService;
    tierGuard?: TierGuard;
    /**
     * Workorder 31B: the price comes from the price table, and a PENDING price
     * leaves a 0-amount ledger row. Both are passed straight through to
     * `withBilling`, which refuses to run with billing on and no quoter.
     */
    priceQuoter?: PriceQuoter;
    creditLedgerWriteRepository?: CreditLedgerWriteRepository;
    uploadService: UploadService;
    viewerService: ViewerService;
    /** Needed to push job.progress. Absent = no progress events, jobs still run. */
    connectionManager?: ConnectionManager;
  },
) {
  // ── POST /api/agent/generate-image (RETIRED, GN-37) ─────────
  //
  // The synchronous shape is gone: it held the HTTP request open for the whole
  // generation and billed without a job_id. Every caller moved to
  // POST /api/agent/generate-image-job below, so this path now only answers 410
  // and names its replacement. Authentication still runs first, so an
  // unauthenticated caller gets 401 and learns nothing about the retirement.
  //
  // Nothing is generated and nothing is charged here — deliberately not a call
  // to `withBilling` with an early return, because that would still open a
  // billing round-trip for a request that is guaranteed to fail.
  app.post("/api/agent/generate-image", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    return reply.code(410).send(
      applicationErrorResponseSchema.parse({
        error: {
          code: "service_unavailable",
          message: "该接口已下线，请改用 POST /api/agent/generate-image-job",
        },
      }),
    );
  });

  // ── POST /api/agent/generate-video ──────────────────────────
  app.post("/api/agent/generate-video", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: GenerateVideoRequest;
    try {
      payload = generateVideoRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message: "Video generation is not available (job service not configured).",
          },
        }),
      );
    }

    const model = payload.model ?? DEFAULT_VIDEO_MODEL_ID;

    try {
      const viewer = await options.viewerService.ensureViewer(user);
      const workspaceId = viewer.workspace.id;

      const result = await withBilling(
        options,
        {
          user,
          workspaceId,
          modelId: model,
          entryPoint: "canvas_generator",
          guard: {
            jobType: "video_generation",
            ...(payload.duration != null ? { duration: payload.duration } : {}),
            ...(payload.resolution
              ? { resolution: payload.resolution as VideoResolution }
              : {}),
          },
          description: `Direct video generation: ${model}`,
          job: {
            payload: {
              prompt: payload.prompt,
              model,
              ...(payload.duration != null ? { duration: payload.duration } : {}),
              ...(payload.resolution ? { resolution: payload.resolution } : {}),
              ...(payload.aspectRatio
                ? { aspect_ratio: payload.aspectRatio }
                : {}),
              ...(payload.inputImages?.length
                ? { input_images: payload.inputImages }
                : {}),
            },
          },
        },
        // P1-d: the job is created and charged, then we return. This used to poll
        // here for up to 300s while holding the HTTP request open — video takes
        // 180-600s, so that request was the first thing certain to be killed by
        // any proxy or sleeping laptop in between, leaving the client with nothing
        // even though the job completed fine.
        //
        // The worker (and its dead-letter refund) owns the outcome from here on.
        async ({ job }) => job!,
      );

      // Detached watcher: polls the job and pushes `job.progress` over the WS.
      // Fire-and-forget on purpose — the job's fate does not depend on anyone
      // watching, and a failure to push must not fail this request.
      watchJob(
        {
          jobService: options.jobService,
          ...(options.connectionManager
            ? { connectionManager: options.connectionManager }
            : {}),
        },
        {
          jobId: result.id,
          userId: user.id,
          jobType: "video_generation",
        },
      );

      // 202, not 200: the work is accepted and still running. The client watches
      // for job.progress (or queries GET /api/jobs/:id) instead of waiting here.
      return reply.code(202).send({
        jobId: result.id,
        status: result.status,
        prompt: payload.prompt,
      });
    } catch (error) {
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
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      return reply.code(502).send(generationFailedBody(error));
    }
  });

  // ── POST /api/agent/generate-image-job ──────────────────────
  //
  // GN-37: the image generator's asynchronous shape, written as the twin of
  // POST /api/agent/generate-video above. Same three steps, same order:
  //
  //   job row (charged, carrying this job's id) -> detached watcher -> 202
  //
  // The synchronous /api/agent/generate-image route is deliberately left
  // untouched: the frontend still calls it until it moves over, and retiring it
  // is a separate ticket. That is why this is a NEW path instead of a flag on
  // the old one.
  app.post("/api/agent/generate-image-job", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) {
      return reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
    }

    let payload: GenerateImageRequest;
    try {
      payload = generateImageRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    if (!options.jobService) {
      return reply.code(503).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "service_unavailable",
            message:
              "Image generation is not available (job service not configured).",
          },
        }),
      );
    }

    try {
      const viewer = await options.viewerService.ensureViewer(user);

      const result = await withBilling(
        options,
        imageJobBillingRequest(user, viewer.workspace.id, payload),
        // The worker owns the outcome from here on, including the dead-letter
        // refund. Nothing below this line may hold the request open: the whole
        // point of GN-37 is that the submit answers in about a second.
        async ({ job }) => job!,
      );

      // Detached watcher: polls the job and pushes `job.progress` over the WS.
      // Fire-and-forget on purpose — a failed push must not fail the submit.
      watchJob(
        {
          jobService: options.jobService,
          ...(options.connectionManager
            ? { connectionManager: options.connectionManager }
            : {}),
        },
        {
          jobId: result.id,
          userId: user.id,
          jobType: "image_generation",
        },
      );

      // 202, not 200: accepted and still running. The client follows
      // job.progress (or GET /api/jobs/:id) instead of waiting here.
      return reply.code(202).send({
        jobId: result.id,
        status: result.status,
        prompt: payload.prompt,
      });
    } catch (error) {
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
      if (error instanceof JobServiceError) {
        return reply.code(error.statusCode).send(
          applicationErrorResponseSchema.parse({
            error: { code: error.code, message: error.message },
          }),
        );
      }

      return reply.code(502).send(generationFailedBody(error));
    }
  });
}

// ── Job polling helper ──────────────────────────────────────

type VideoJobResult = {
  signed_url: string;
  asset_id: string;
  width: number;
  height: number;
  duration_seconds: number;
  mime_type: string;
};

// P1-d removed `pollJobUntilDone` from here. It was the loop that held the HTTP
// request open for up to 300s. The equivalent polling now lives in
// features/jobs/job-watcher.ts, detached from any request, and the client learns
// the outcome from `job.progress` (with GET /api/jobs/:id as its safety net).

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Image download + upload helper ──────────────────────────
//
// GN-37 removed `downloadAndUpload` from here together with the synchronous
// route that was its only caller. The generator relay it used to record is now
// done by the image job worker, which still imports `generatorRelayProvenance`
// from this module — that export stays.

