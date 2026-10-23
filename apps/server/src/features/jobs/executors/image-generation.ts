// Image generation executor (BL-40: generated images are never watermarked)
import { registerExecutor, type ExecutorContext } from "../job-executor.js";
import { loadExecutorJob } from "./load-executor-job.js";
import { storeJobOutput } from "./store-job-output.js";
import { signProjectAssetUrl } from "../../storage/project-asset-urls.js";
import { JOB_TYPE_REGISTRY } from "../job-registry.js";
import { generateImage } from "../../../generation/image-generation.js";
import { resolveImageProviderName } from "../../../generation/providers/registry.js";

import { DEFAULT_IMAGE_MODEL_ID } from "@loomic/shared";
import type { ImageGenerateParams, ImageQuality } from "../../../generation/types.js";

// BL-07: the ledger records what a job was charged for, so the job has to be
// generated at that same tier. These are the three tiers the price table and the
// billing guard know about; anything else is not a tier we can have billed for
// and must not be forwarded to a provider by accident.
const BILLABLE_IMAGE_QUALITIES: readonly string[] = ["standard", "hd", "ultra"];

/**
 * Derive the provider parameters for an image job from its stored payload.
 *
 * Split out of the executor so the mapping can be asserted without a database,
 * a provider or a CDN download. It is a pure function: no I/O, no side effects
 * other than one warning for a value that is not a real tier.
 */
export function imageJobGenerateParams(
  payload: {
    prompt: string;
    model?: string;
    aspect_ratio?: string;
    input_images?: string[];
    quality?: string;
  },
  model: string,
): ImageGenerateParams {
  const params: ImageGenerateParams = { prompt: payload.prompt, model };

  if (payload.aspect_ratio !== undefined) params.aspectRatio = payload.aspect_ratio;
  if (payload.input_images?.length) params.inputImages = payload.input_images;

  // Only a value the billing guard could have charged for is forwarded. An
  // unknown tier leaves `quality` absent so the provider keeps its own default
  // rather than receiving a string it cannot interpret.
  if (payload.quality !== undefined) {
    if (BILLABLE_IMAGE_QUALITIES.includes(payload.quality)) {
      params.quality = payload.quality as ImageQuality;
    } else {
      console.warn(
        `[image-job] ignoring unknown payload quality ${JSON.stringify(payload.quality)}; keeping the provider default`,
      );
    }
  }

  return params;
}

registerExecutor("image_generation", async (jobId, _rawPayload, ctx: ExecutorContext) => {
  const t0 = Date.now();

  // Read the full job row including payload from the database.
  // The PGMQ message only contains { job_id, job_type, workspace_id },
  // so we must fetch prompt/model/aspect_ratio from background_jobs.payload.
  const admin = ctx.getAdminClient();
  const jobRow = await loadExecutorJob(ctx, jobId);

  // Build log tag with traceability context: jobId + sessionId (if available)
  const sessionShort = (jobRow.session_id as string)?.slice(0, 8) ?? "no-session";
  const tag = `[image-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
  const lap = (label: string) => console.log(`${tag} ${label} +${Date.now() - t0}ms`);
  lap("db_fetch");

  const payload = (jobRow.payload ?? {}) as {
    prompt: string;
    model?: string;
    aspect_ratio?: string;
    title?: string;
    input_images?: string[];
    quality?: string;
  };

  if (!payload.prompt) throw new Error(`Job ${jobId} has no prompt in payload`);

  const createdBy: string | null = jobRow.created_by ?? null;
  const workspaceId: string = jobRow.workspace_id ?? jobId;

  // OWNERSHIP vs BILLING. `workspace_id` here is the PERSONAL billing workspace
  // (Q1), while the project a canvas belongs to lives in the team workspace. The
  // asset's ownership is derived from the project/canvas by record_project_asset,
  // so the two must be passed separately and never conflated.
  const canvasId: string | null = (jobRow.canvas_id as string | null) ?? null;
  const projectId: string | null = (jobRow.project_id as string | null) ?? null;

  if (!createdBy) {
    // Fail before generating: an asset nobody created is an asset nobody can be
    // authorised against once the bucket is private (X-52).
    throw new Error(
      `Job ${jobId} has no created_by — refusing to generate an unattributable asset`,
    );
  }

  // Resolve provider dynamically from model ID via registry
  const model = payload.model ?? DEFAULT_IMAGE_MODEL_ID;
  const providerName = resolveImageProviderName(model, "generate");

  // Keep renewing the visibility timeout so the message does not become visible
  // again while we are still working. Both the VT and the heartbeat interval come
  // from JOB_TYPE_REGISTRY: this used to be a hard-coded 120 here plus a
  // hard-coded 60_000, a second copy of the value in worker.ts's VT table. If the
  // registry VT ever dropped below the old fixed interval the heartbeat would
  // silently stop keeping up and the job would run twice.
  const VT_SECONDS = JOB_TYPE_REGISTRY.image_generation.visibilityTimeoutSeconds;
  const heartbeatTimer = setInterval(() => {
    ctx.renewVt(VT_SECONDS);
  }, (VT_SECONDS / 2) * 1000);

  // Log input image format for debugging the data-URI-passthrough pipeline
  if (payload.input_images?.length) {
    const formats = payload.input_images.map((img) =>
      img.startsWith("data:") ? "data-uri" : "url",
    );
    console.log(`${tag} input_images formats: [${formats.join(", ")}] (${formats.length} total)`);
  }

  try {
    // Generate image via the registered provider
    lap(`${providerName}_call_start`);
    let generated;
    try {
      generated = await generateImage(providerName, imageJobGenerateParams(payload, model));
    } catch (genError) {
      const detail = genError instanceof Error ? genError.message : String(genError);
      const wrapped = new Error(`Image generation failed for model ${model}: ${detail}`);
      (wrapped as Error & { code?: string }).code =
        (genError as { code?: string })?.code ?? "executor_error";
      throw wrapped;
    }
    lap(`${providerName}_call_done`);

    // Download the generated image from the provider CDN
    const response = await fetch(generated.url);
    if (!response.ok) {
      throw new Error(`Failed to download generated image from ${model}: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    // BL-40: the downloaded bytes are uploaded as they are. Nothing reads the
    // subscription plan here any more, so no image is ever watermarked.
    const buffer: Buffer = Buffer.from(arrayBuffer);
    lap("image_download_done");

    // Upload to storage and record ownership (shared with the tool executor).
    const timestamp = Date.now();
    const { assetId, objectPath } = await storeJobOutput(admin, {
      objectPath: `${workspaceId}/generated/${timestamp}-${jobId}.png`,
      bytes: buffer,
      mimeType: generated.mimeType ?? "image/png",
      createdBy,
      workspaceId,
      projectId,
      canvasId,
    });

    lap("asset_record_done");

    // GN-11: provenance on the asset row. Best effort — the asset is already
    // recorded and the generation already succeeded, so a failure here is
    // logged and never fails the job (same reasoning as T-15).
    if (ctx.assetProvenanceRepository) {
      try {
        await ctx.assetProvenanceRepository.recordProvenance({
          actorId: createdBy,
          assetId,
          provenance: {
            source: jobRow.session_id ? "agent" : "generator",
            operation: "image_generation",
            modelId: model,
            prompt: payload.prompt,
            creditsCharged: ctx.creditsCharged ?? null,
            actionId: null,
            sourceJobId: jobId,
            parentArtifactId: null,
          },
        });
      } catch {
        console.warn(`[asset-provenance] job ${jobId}: provenance was not recorded`);
      }
    }

    // A short-lived signature, not a permanent public URL (X-52). The worker uses
    // its admin client: it just recorded ownership of this object itself, and the
    // URL is a convenience for the job's consumer — `object_path` and `asset_id`
    // remain the stable identity.
    const signedUrl = await signProjectAssetUrl(admin, objectPath);

    lap("total");
    // GN-02 (5): the result also lists its artifacts. One job produces one
    // artifact for now; the array is what lets GN-41 add more without a new
    // field. The dimensions are the ones the provider reported — a provider that
    // reports none gets NO artifacts key rather than a fabricated 0x0 entry.
    const mimeType = generated.mimeType ?? "image/png";
    const hasDimensions =
      Number.isInteger(generated.width) &&
      generated.width > 0 &&
      Number.isInteger(generated.height) &&
      generated.height > 0;
    return {
      asset_id: assetId,
      signed_url: signedUrl,
      object_path: objectPath,
      width: generated.width,
      height: generated.height,
      mime_type: mimeType,
      ...(hasDimensions
        ? {
            artifacts: [
              {
                artifact_id: assetId,
                index: 0,
                format: mimeType,
                width: generated.width,
                height: generated.height,
              },
            ],
          }
        : {}),
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
});
