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

import { generateImage } from "../generation/image-generation.js";
import { resolveImageProviderName } from "../generation/providers/registry.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { CreditServiceError } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { TierGuardError } from "../features/credits/tier-guard.js";
import { withBilling } from "../features/credits/with-billing.js";
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

    const model = payload.model ?? DEFAULT_IMAGE_MODEL_ID;

    try {
      const viewer = await options.viewerService.ensureViewer(user);

      // No `job` in the request: this route generates synchronously and never
      // creates one, so withBilling owns the refund if anything below fails --
      // the provider call, the download, or the Storage upload. The upload case
      // is deliberately covered: the provider has already charged us by then,
      // but the user got no image, so eating their credits too is the wrong
      // trade. Making this route asynchronous so the transaction carries a
      // job_id is tracked as B-3.
      const { signedUrl, assetId, result } = await withBilling(
        options,
        {
          user,
          workspaceId: viewer.workspace.id,
          modelId: model,
          entryPoint: "canvas_generator",
          guard: {
            jobType: "image_generation",
            quality: payload.quality ?? "hd",
          },
          description: `Direct image generation: ${model}`,
        },
        async (outcome) => {
          const providerName = resolveImageProviderName(model, "generate");
          const generated = await generateImage(providerName, {
            prompt: payload.prompt,
            model,
            aspectRatio: payload.aspectRatio ?? "1:1",
            ...(payload.quality ? { quality: payload.quality } : {}),
          });

          const uploaded = await downloadAndUpload(
            generated.url,
            generated.mimeType,
            payload.prompt,
            user,
            options,
            { modelId: model, creditsCharged: outcome.creditsCost },
          );
          return { ...uploaded, result: generated };
        },
      );

      return reply.code(200).send({
        url: signedUrl,
        assetId,
        prompt: payload.prompt,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      // Handle tier/credit errors
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

      const message =
        error instanceof Error ? error.message : "Image generation failed.";

      if (message.includes("No provider registered")) {
        return reply.code(400).send(
          applicationErrorResponseSchema.parse({
            error: {
              code: "provider_not_configured",
              message: "Image generation is not available.",
            },
          }),
        );
      }

      return reply.code(502).send(generationFailedBody(error));
    }
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

async function downloadAndUpload(
  sourceUrl: string,
  mimeType: string,
  prompt: string,
  user: AuthenticatedUser,
  deps: { uploadService: UploadService; viewerService: ViewerService },
  relay: { modelId: string; creditsCharged: number },
): Promise<{ signedUrl: string; assetId: string }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to download generated image: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const ext = mimeType === "image/webp" ? "webp" : "png";
  const slug = prompt.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fileName = `gen-${slug}-${Date.now()}.${ext}`;

  const viewer = await deps.viewerService.ensureViewer(user);

  const result = await deps.uploadService.uploadFile(user, {
    bucket: "project-assets",
    fileName,
    fileBuffer: buffer,
    mimeType,
    workspaceId: viewer.workspace.id,
    // GN-11 / X-P7: this route produced the image, so relaying it into Storage
    // records where it really came from instead of calling it a user upload.
    provenance: generatorRelayProvenance({
      modelId: relay.modelId,
      prompt,
      creditsCharged: relay.creditsCharged,
    }),
  });

  return { signedUrl: result.url, assetId: result.asset.id };
}
