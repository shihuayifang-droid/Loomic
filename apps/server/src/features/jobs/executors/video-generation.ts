import { registerExecutor, type ExecutorContext } from "../job-executor.js";
import { loadExecutorJob } from "./load-executor-job.js";
import { signProjectAssetUrl } from "../../storage/project-asset-urls.js";
import { JOB_TYPE_REGISTRY } from "../job-registry.js";
import { generateVideo } from "../../../generation/video-generation.js";
import { resolveVideoProviderName } from "../../../generation/providers/registry.js";

registerExecutor("video_generation", async (jobId, _rawPayload, ctx: ExecutorContext) => {
  const t0 = Date.now();

  const admin = ctx.getAdminClient();
  const jobRow = await loadExecutorJob(ctx, jobId);

  // Build log tag with traceability context: jobId + sessionId (if available)
  const sessionShort = (jobRow.session_id as string)?.slice(0, 8) ?? "no-session";
  const tag = `[video-job:${jobId.slice(0, 8)} session:${sessionShort}]`;
  const lap = (label: string) => console.log(`${tag} ${label} +${Date.now() - t0}ms`);
  lap("db_fetch");

  const payload = (jobRow.payload ?? {}) as {
    prompt: string;
    model?: string;
    duration?: number;
    resolution?: string;
    aspect_ratio?: string;
    input_images?: string[];
    input_video?: string;
    enable_audio?: boolean;
  };

  if (!payload.prompt) throw new Error(`Job ${jobId} has no prompt in payload`);

  const createdBy: string | null = jobRow.created_by ?? null;
  const workspaceId: string = jobRow.workspace_id ?? jobId;

  // OWNERSHIP vs BILLING — same split as the image executor: the job's workspace
  // is the personal billing workspace (Q1), the project lives in the team
  // workspace, and record_project_asset derives the latter from the canvas.
  const canvasId: string | null = (jobRow.canvas_id as string | null) ?? null;
  const projectId: string | null = (jobRow.project_id as string | null) ?? null;

  if (!createdBy) {
    throw new Error(
      `Job ${jobId} has no created_by — refusing to generate an unattributable asset`,
    );
  }

  const model = payload.model ?? "wan-video/wan-2.6";
  const providerName = resolveVideoProviderName(model);

  // VT and heartbeat interval both derived from JOB_TYPE_REGISTRY — see the
  // longer note in the image executor. Was a hard-coded 300 plus 120_000 here.
  const VT_SECONDS = JOB_TYPE_REGISTRY.video_generation.visibilityTimeoutSeconds;
  const heartbeatTimer = setInterval(() => {
    ctx.renewVt(VT_SECONDS);
  }, (VT_SECONDS / 2) * 1000);

  try {
    lap("replicate_call_start");
    const generated = await generateVideo(providerName, {
      prompt: payload.prompt,
      model,
      ...(payload.duration != null ? { duration: payload.duration } : {}),
      ...(payload.resolution ? { resolution: payload.resolution as "480p" | "720p" | "1080p" } : {}),
      ...(payload.aspect_ratio ? { aspectRatio: payload.aspect_ratio } : {}),
      ...(payload.input_images?.length ? { inputImages: payload.input_images } : {}),
      ...(payload.input_video ? { inputVideo: payload.input_video } : {}),
      ...(payload.enable_audio != null ? { enableAudio: payload.enable_audio } : {}),
    });
    lap("replicate_call_done");

    // Vertex AI returns inline base64 data URIs; Developer API returns HTTP URLs.
    let buffer: Buffer;
    if (generated.url.startsWith("data:")) {
      const commaIdx = generated.url.indexOf(",");
      if (commaIdx === -1) throw new Error("Invalid data URI: no comma separator");
      buffer = Buffer.from(generated.url.slice(commaIdx + 1), "base64");
    } else {
      const response = await fetch(generated.url);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    }
    lap("video_download_done");

    const ext = generated.mimeType === "video/webm" ? "webm" : "mp4";
    const timestamp = Date.now();
    const objectPath = `${workspaceId}/generated/${timestamp}-${jobId}.${ext}`;

    const { error: uploadError } = await admin.storage
      .from("project-assets")
      .upload(objectPath, buffer, {
        contentType: generated.mimeType ?? "video/mp4",
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }
    lap("storage_upload_done");

    // See the image executor: ownership goes through record_project_asset, and a
    // failure here must fail the job rather than leave an unowned object.
    const { data: assetData, error: assetError } = await admin.rpc("record_project_asset", {
      p_bucket: "project-assets",
      p_object_path: objectPath,
      p_created_by: createdBy,
      p_fallback_workspace_id: workspaceId,
      p_project_id: projectId,
      p_canvas_id: canvasId,
      p_mime_type: generated.mimeType ?? "video/mp4",
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
            operation: "video_generation",
            modelId: model,
            prompt: payload.prompt,
            creditsCharged: null,
            actionId: null,
            sourceJobId: jobId,
            parentArtifactId: null,
          },
        });
      } catch {
        console.warn(`[asset-provenance] job ${jobId}: provenance was not recorded`);
      }
    }

    const signedUrl = await signProjectAssetUrl(admin, objectPath);

    lap("total");
    return {
      asset_id: assetId,
      signed_url: signedUrl,
      object_path: objectPath,
      width: generated.width,
      height: generated.height,
      duration_seconds: generated.durationSeconds,
      mime_type: generated.mimeType ?? "video/mp4",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`Video generation failed for model ${model}: ${detail}`);
    // Preserve the original error code so the worker can distinguish
    // non-retryable errors (e.g. invalid_input) from transient failures.
    (wrapped as Error & { code?: string }).code =
      (err as { code?: string })?.code ?? "executor_error";
    throw wrapped;
  } finally {
    clearInterval(heartbeatTimer);
  }
});
