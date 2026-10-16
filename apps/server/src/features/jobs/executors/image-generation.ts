// @credits-system — Image generation executor: applies watermark for free-tier users
import { registerExecutor, type ExecutorContext } from "../job-executor.js";
import { loadExecutorJob } from "./load-executor-job.js";
import { signProjectAssetUrl } from "../../storage/project-asset-urls.js";
import { JOB_TYPE_REGISTRY } from "../job-registry.js";
import { generateImage } from "../../../generation/image-generation.js";
import { resolveImageProviderName } from "../../../generation/providers/registry.js";
import { applyWatermark } from "../../credits/watermark.js";

import type { SubscriptionPlan } from "@loomic/shared";

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
  const model = payload.model ?? "black-forest-labs/flux-kontext-pro";
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
      generated = await generateImage(providerName, {
        prompt: payload.prompt,
        model,
        ...(payload.aspect_ratio !== undefined ? { aspectRatio: payload.aspect_ratio } : {}),
        ...(payload.input_images?.length ? { inputImages: payload.input_images } : {}),
      });
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
    let buffer: Buffer = Buffer.from(arrayBuffer);
    lap("image_download_done");

    // Apply watermark for free-plan users
    if (workspaceId) {
      try {
        const { data: sub } = await admin
          .from("subscriptions")
          .select("plan")
          .eq("workspace_id", workspaceId)
          .maybeSingle();

        const plan: SubscriptionPlan = (sub?.plan as SubscriptionPlan) ?? "free";
        if (plan === "free") {
          buffer = await applyWatermark(buffer, generated.mimeType ?? "image/png");
          lap("watermark_applied");
        }
      } catch (wmErr) {
        // Non-fatal: log and continue without watermark rather than failing the job
        console.warn(`${tag} Watermark failed, continuing without:`, wmErr);
      }
    }

    // Upload to Supabase Storage under the project-assets bucket
    const timestamp = Date.now();
    const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.png`;

    const { error: uploadError } = await admin.storage
      .from("project-assets")
      .upload(objectPath, buffer, {
        contentType: generated.mimeType ?? "image/png",
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }
    lap("storage_upload_done");

    // Record ownership through the single service_role-only entry point. A
    // direct insert here is what left generated media attached to the billing
    // workspace with project_id null, which a private bucket then cannot
    // authorise. If this fails the job must fail: an uploaded object with no
    // metadata is exactly the "silent success" this ticket exists to remove.
    const { data: assetData, error: assetError } = await admin.rpc("record_project_asset", {
      p_bucket: "project-assets",
      p_object_path: objectPath,
      p_created_by: createdBy,
      p_fallback_workspace_id: workspaceId,
      p_project_id: projectId,
      p_canvas_id: canvasId,
      p_mime_type: generated.mimeType ?? "image/png",
      p_byte_size: buffer.length,
    });

    if (assetError) {
      throw new Error(`Failed to record asset ownership: ${assetError.message}`);
    }

    const assetId = (assetData as { asset_id?: string } | null)?.asset_id;
    if (!assetId) {
      throw new Error("Failed to record asset ownership: no asset id returned");
    }

    lap("asset_record_done");

    // A short-lived signature, not a permanent public URL (X-52). The worker uses
    // its admin client: it just recorded ownership of this object itself, and the
    // URL is a convenience for the job's consumer — `object_path` and `asset_id`
    // remain the stable identity.
    const signedUrl = await signProjectAssetUrl(admin, objectPath);

    lap("total");
    return {
      asset_id: assetId,
      signed_url: signedUrl,
      object_path: objectPath,
      width: generated.width,
      height: generated.height,
      mime_type: generated.mimeType ?? "image/png",
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
});
