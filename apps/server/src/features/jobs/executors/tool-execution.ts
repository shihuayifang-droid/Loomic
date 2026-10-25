// Tool execution executor (GN-24, ED-00j, ED-07).
//
// Fetch the ORIGINAL image of an artifact, hand it to the runner registered for
// the job's tool id, normalise the product to a PNG of exactly the source size,
// store it server-side under the `tool/` domain and record where it came from.
// This module knows no concrete tool: each tool is a runner registered elsewhere.
import sharp from "sharp";

import { registerExecutor, type ExecutorContext } from "../job-executor.js";
import { loadExecutorJob } from "./load-executor-job.js";
import { storeJobOutput } from "./store-job-output.js";
import { signProjectAssetUrl } from "../../storage/project-asset-urls.js";
import { resolveOriginalSource } from "../../tools/original-source.js";
import { getToolRunner, ToolRunError } from "../../tools/tool-runners.js";
import { JOB_TYPE_REGISTRY } from "../job-registry.js";

const TOOL_ID_PATTERN = /^[a-z0-9_]+$/;
const FETCH_TIMEOUT_MS = 60_000;

type ToolExecutionPayload = {
  tool_id?: unknown;
  artifact_id?: unknown;
  model?: unknown;
  params?: unknown;
  file_prefix?: unknown;
};

registerExecutor("tool_execution", async (jobId, _rawPayload, ctx: ExecutorContext) => {
  const jobRow = await loadExecutorJob(ctx, jobId);
  const payload = (jobRow.payload ?? {}) as ToolExecutionPayload;

  const toolId = payload.tool_id;
  if (typeof toolId !== "string" || !TOOL_ID_PATTERN.test(toolId)) {
    throw new ToolRunError("invalid_input", `Job ${jobId} has no valid tool_id in payload`);
  }
  const artifactId = payload.artifact_id;
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new ToolRunError("invalid_input", `Job ${jobId} has no artifact_id in payload`);
  }
  const model = typeof payload.model === "string" ? payload.model : null;
  const params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as Record<string, unknown>)
      : {};
  const filePrefix =
    typeof payload.file_prefix === "string" && TOOL_ID_PATTERN.test(payload.file_prefix)
      ? payload.file_prefix
      : toolId;

  const createdBy: string | null = jobRow.created_by ?? null;
  const workspaceId: string = jobRow.workspace_id ?? jobId;
  const canvasId: string | null = (jobRow.canvas_id as string | null) ?? null;
  const projectId: string | null = (jobRow.project_id as string | null) ?? null;

  if (!createdBy) {
    // Fail before any work: an asset nobody created cannot be authorised later.
    throw new Error(
      `Job ${jobId} has no created_by — refusing to produce an unattributable asset`,
    );
  }

  const runner = getToolRunner(toolId);
  if (!runner) {
    throw new ToolRunError("unknown_tool", `No runner is registered for tool ${toolId}`);
  }
  if (!ctx.assetReadRepository) {
    throw new Error(`Job ${jobId}: the executor context has no assetReadRepository`);
  }

  // T-133 (7th slice): the store the product is uploaded through is a REQUIRED
  // part of the context now. The worker wires it in (1c); a context without one
  // is an assembly mistake, not an upstream failure — so it fails here, before
  // the heartbeat starts, rather than quietly building an adapter of its own.
  const objectStore = ctx.objectStore;
  if (!objectStore) {
    throw new ToolRunError(
      "invalid_input",
      `Job ${jobId}: the executor context has no objectStore — assembly error, ` +
        `not an upstream failure (this executor writes its product only through ` +
        `the store the worker injects)`,
    );
  }

  const VT_SECONDS = JOB_TYPE_REGISTRY.tool_execution.visibilityTimeoutSeconds;
  const heartbeatTimer = setInterval(() => {
    ctx.renewVt(VT_SECONDS);
  }, (VT_SECONDS / 2) * 1000);

  try {
    // ED-00j: the original object, read as the job's owner and signed through
    // the store the worker injected (T-133 slice 9 — the same `objectStore` this
    // executor uploads its product through, resolved and checked above).
    // Throws OriginalSourceError when the artifact is not readable.
    const source = await resolveOriginalSource(
      { assetReadRepository: ctx.assetReadRepository, objectStore },
      { actorId: createdBy, artifactId },
    );

    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ToolRunError(
        "invalid_input",
        `Failed to read the original artifact: ${response.status} ${response.statusText}`,
      );
    }
    const inputBytes = Buffer.from(await response.arrayBuffer());

    const inputMeta = await sharp(inputBytes).metadata();
    const width = inputMeta.width;
    const height = inputMeta.height;
    if (!width || !height) {
      throw new ToolRunError("invalid_input", "The original artifact has no readable size");
    }

    const out = await runner({
      bytes: inputBytes,
      mimeType: source.mimeType ?? "application/octet-stream",
      width,
      height,
      params,
      model,
    });

    // ED-07: always a PNG, always the source size.
    const png = await sharp(out.bytes)
      .resize(width, height, { fit: "fill" })
      .png()
      .toBuffer();
    const outMeta = await sharp(png).metadata();
    if (outMeta.width !== width || outMeta.height !== height) {
      throw new Error(
        `Tool ${toolId} output size ${outMeta.width}x${outMeta.height} does not match the source ${width}x${height}`,
      );
    }

    // T-133 (7th slice): the store was resolved from the context before the try
    // block — this executor no longer builds a backend of its own.
    const { assetId, objectPath } = await storeJobOutput(
      objectStore,
      ctx.assetRecordRepository,
      {
        objectPath: `${workspaceId}/tool/${toolId}/${Date.now()}-${jobId}.png`,
        bytes: png,
        mimeType: "image/png",
        createdBy,
        workspaceId,
        projectId,
        canvasId,
      },
    );

    // GN-24: where the product came from. Best effort, like the image executor.
    if (ctx.assetProvenanceRepository) {
      try {
        await ctx.assetProvenanceRepository.recordProvenance({
          actorId: createdBy,
          assetId,
          provenance: {
            source: `tool:${toolId}`,
            operation: toolId,
            modelId: model,
            prompt: null,
            creditsCharged: ctx.creditsCharged ?? null,
            actionId: null,
            sourceJobId: jobId,
            parentArtifactId: artifactId,
          },
        });
      } catch {
        console.warn(`[asset-provenance] job ${jobId}: provenance was not recorded`);
      }
    }

    const signedUrl = await signProjectAssetUrl(objectStore, objectPath);

    return {
      asset_id: assetId,
      signed_url: signedUrl,
      object_path: objectPath,
      width,
      height,
      mime_type: "image/png",
      file_name: `${filePrefix}_${assetId}.png`,
      tool_id: toolId,
      model,
      artifacts: [{ artifact_id: assetId, index: 0, format: "png", width, height }],
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
});
