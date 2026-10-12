import { tool } from "langchain";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import type { AgentAssetReference } from "@loomic/shared";

import { generateImage } from "../../generation/image-generation.js";
import {
  getAvailableImageModels,
  resolveImageProviderName,
  type AvailableModel,
} from "../../generation/providers/registry.js";
import type { ImageModelLimits } from "../../generation/types.js";

const DEFAULT_MODEL = "black-forest-labs/flux-kontext-pro";

/** Short human phrase for a model's reference-image capacity. */
function refImageLabel(max: ImageModelLimits["maxInputImages"]): string {
  if (max === 0) return "text-only, no reference images";
  if (max === "unbounded") return "multiple reference images";
  return max === 1 ? "1 reference image only" : `up to ${max} reference images`;
}

/**
 * Groups models by reference-image capacity so the LLM gets the real per-model
 * limits instead of a hand-maintained sentence. The previous hard-coded text
 * ("Google models accept up to 14, Flux models accept 1. Imagen 4 and Recraft V3
 * are text-only.") covered only the Replicate models and never mentioned the
 * kwjm ones that are actually in use.
 */
function describeRefImageLimits(models: AvailableModel[]): string {
  const base =
    "Reference image URLs for editing/transformation. Ignored by text-only models.";
  if (!models.length) return base;

  const groups = new Map<string, string[]>();
  for (const m of models) {
    const label = refImageLabel(m.limits.maxInputImages);
    const ids = groups.get(label);
    if (ids) ids.push(m.id);
    else groups.set(label, [m.id]);
  }

  const detail = [...groups.entries()]
    .map(([label, ids]) => `${label}: ${ids.join(", ")}`)
    .join("; ");
  return `${base} Per-model limits — ${detail}.`;
}

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds.includes(DEFAULT_MODEL)
    ? DEFAULT_MODEL
    : modelIds[0] ?? DEFAULT_MODEL;

  const modelDescription = models.length
    ? `Model to use. Available:\n${models
        .map(
          (m) =>
            `- ${m.id}: ${m.displayName} — ${m.description} (${refImageLabel(m.limits.maxInputImages)})`,
        )
        .join("\n")}`
    : "Model identifier (no providers currently registered)";

  // z.enum needs [string, ...string[]], but we may have 0 models at test time.
  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as (typeof modelIds)[number])
          .describe(modelDescription)
      : z.string().default(DEFAULT_MODEL).describe(modelDescription);

  return z.object({
    title: z
      .string()
      .min(1)
      .describe(
        "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
      ),
    prompt: z.string().min(1).describe("Detailed image generation prompt"),
    model: modelField,
    aspectRatio: z
      .string()
      .optional()
      .default("1:1")
      .describe("Aspect ratio (e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4, 2:3, 3:2). Provider auto-normalizes unsupported ratios to nearest match."),
    quality: z
      .enum(["standard", "hd", "ultra"])
      .optional()
      .default("hd")
      .describe(
        "Image quality/resolution level. standard: ~1K fast preview, hd: ~2K production quality (default), ultra: ~4K print quality (not all models support this, will use max available).",
      ),
    outputFormat: z
      .enum(["png", "jpg", "webp"])
      .optional()
      .describe("Output image format. PNG for transparency, JPG for photos, WebP for web."),
    inputImages: z
      .array(z.string())
      .optional()
      .describe(describeRefImageLimits(models)),
    placementX: z
      .number()
      .optional()
      .describe(
        "Left edge x coordinate on canvas. Use inspect_canvas to determine position.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Top edge y coordinate on canvas. Use inspect_canvas to determine position.",
      ),
    placementWidth: z
      .number()
      .optional()
      .default(512)
      .describe("Display width on canvas"),
    placementHeight: z
      .number()
      .optional()
      .default(512)
      .describe("Display height on canvas"),
  });
}

type ImageGenerateInput = {
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: string;
  outputFormat?: string;
  inputImages?: string[];
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
};

type ImageGenerateResult = {
  summary: string;
  title?: string;
  elementId?: string;
  imageUrl?: string;
  /**
   * X-52: stable identity of the stored image, alongside `imageUrl`. Persisted
   * records (chat blocks, artifacts) key off these; `imageUrl` alone becomes a
   * broken link once the bucket stops serving public objects.
   */
  assetId?: string;
  objectPath?: string;
  bucket?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  jobId?: string;
  jobType?: "image_generation";
  placement?: { x: number; y: number; width: number; height: number };
};

/**
 * Optional function to persist a generated image to Storage.
 *
 * X-52: it returns the STABLE reference (`assetId` + `objectPath` + the mime
 * type and size it actually wrote), not a URL string. `signedUrl` on the same
 * object is this read's projection and expires; the identity does not.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<AgentAssetReference>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
}) => Promise<{
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
}>;

export async function runImageGenerate(
  input: ImageGenerateInput,
  persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
): Promise<ImageGenerateResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(`[generate_image] ${label} +${Date.now() - t0}ms`, extra ? JSON.stringify(extra) : "");
  };

  // Resolve assetId references in inputImages to base64 data URIs
  if (input.inputImages?.length && attachmentMap) {
    input = {
      ...input,
      inputImages: input.inputImages.map((ref) =>
        attachmentMap[ref] ?? ref,
      ),
    };
  }

  // Filter out invalid image references — only keep valid URLs.
  // Agent may pass canvas element IDs or unresolved assetIds that aren't
  // in the attachmentMap. These would cause Replicate 422 errors.
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter((img) =>
      img.startsWith("http://") || img.startsWith("https://") || img.startsWith("data:"),
    );
    if (validImages.length !== input.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: input.inputImages.length,
        after: validImages.length,
        dropped: input.inputImages.filter((img) =>
          !img.startsWith("http://") && !img.startsWith("https://") && !img.startsWith("data:"),
        ),
      });
    }
    input = validImages.length > 0
      ? { ...input, inputImages: validImages }
      : { ...input, inputImages: [] };
  }

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitImageJob({
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        const isTimeout = jobResult.error.includes("timed out");
        return {
          summary: isTimeout
            ? `Image is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user.`
            : `Image generation failed with model ${input.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "image_generation" as const,
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: ImageGenerateResult = {
        summary: `Generated image (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${input.model}`,
        title: input.title,
        ...(jobResult.elementId != null ? { elementId: jobResult.elementId } : {}),
        imageUrl: jobResult.imageUrl ?? "",
        mimeType: jobResult.mimeType ?? "image/png",
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 512,
          height: input.placementHeight ?? 512,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Image generation failed with model ${input.model}: ${message}. Consider trying a different model or simplifying the prompt.`,
        error: message,
      };
    }
  }

  // Direct generation: resolve provider from model ID via registry
  try {
    lap("direct_generate_start", { model: input.model });
    const providerName = resolveImageProviderName(input.model, "generate");
    const result = await generateImage(providerName, {
      prompt: input.prompt,
      model: input.model,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.quality ? { quality: input.quality as any } : {}),
      ...(input.outputFormat ? { outputFormat: input.outputFormat as any } : {}),
      ...(input.inputImages?.length ? { inputImages: input.inputImages } : {}),
    });
    lap("direct_generate_done", { width: result.width, height: result.height });

    // X-52: the persisted identity, when persistence succeeded. `imageUrl` stays
    // for readers that only understand a URL, but the assetId/objectPath pair is
    // what a chat block or artifact records.
    let persisted: AgentAssetReference | undefined;

    let imageUrl = result.url;
    if (persistImage) {
      try {
        persisted = await persistImage(result.url, result.mimeType, input.prompt);
        imageUrl = persisted.signedUrl ?? result.url;
        lap("persist_image_done", { assetId: persisted.assetId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[generate_image] persistImage FAILED: ${reason}`);

        // LOCAL FORK: upstream silently fell back to `result.url` here.
        // That is safe when the provider hands back a real http(s) URL
        // (Replicate does), but catastrophic when it hands back a base64 data
        // URI (Google and gpt-image both do): the image then gets embedded in
        // the canvas document itself. One 1024x1024 PNG measured 7 MB, and
        // because the client re-uploads the whole document on every canvas
        // change, saves started timing out with "Unable to save canvas" and
        // the retry storm exhausted the database connection pool — which in
        // turn made persistImage time out too, a self-reinforcing loop.
        //
        // So: only fall back when the URL is actually a remote reference.
        if (result.url.startsWith("data:")) {
          return {
            summary:
              `Image was generated successfully but could not be saved to storage (${reason}). ` +
              `It was NOT placed on the canvas, because embedding the raw image data would make the canvas unsaveable. ` +
              `Ask the user to retry — this is usually a transient storage timeout.`,
            error: `storage_upload_failed: ${reason}`,
          };
        }
      }
    }

    const directResult: ImageGenerateResult = {
      summary: `Generated image (${result.width}x${result.height}) via ${input.model}`,
      title: input.title,
      imageUrl,
      mimeType: persisted?.mimeType ?? result.mimeType,
      width: result.width,
      height: result.height,
      ...(persisted
        ? {
            assetId: persisted.assetId,
            objectPath: persisted.objectPath,
            bucket: persisted.bucket,
          }
        : {}),
    };
    if (input.placementX != null && input.placementY != null) {
      directResult.placement = {
        x: input.placementX,
        y: input.placementY,
        width: input.placementWidth ?? 512,
        height: input.placementHeight ?? 512,
      };
    }
    return directResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      summary: `Image generation failed: ${message}`,
      error: message,
    };
  }
}

export function createImageGenerateTool(deps: {
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** Override for testing — defaults to querying the provider registry. */
  availableModels?: AvailableModel[];
  /**
   * Acknowledge that this instance will call providers directly, with NO job
   * record, NO credit deduction and NO tier check. Tests only.
   */
  allowUnbilledDirect?: boolean;
} = {}) {
  // LOCAL FORK: same guard as createVideoGenerateTool -- see the longer comment
  // there. runImageGenerate falls through to an unbilled direct provider call
  // when submitImageJob is absent, and the deps chain that carries it
  // (runtime -> deep-agent -> createMainAgentTools -> here) was optional at
  // every hop, so one missing argument anywhere handed out free generations
  // silently.
  if (!deps.submitImageJob && !deps.allowUnbilledDirect) {
    throw new Error(
      "createImageGenerateTool: submitImageJob is required. Without it the tool " +
        "calls the provider directly, bypassing the job queue, credit deduction " +
        "and tier checks. If there is no job channel available, do not register " +
        "this tool at all. Pass allowUnbilledDirect: true only in tests.",
    );
  }

  // Only text-to-image models. Listing an upscaler or background remover here
  // would let the LLM pick a model that ignores the prompt entirely.
  const models = deps.availableModels ?? getAvailableImageModels("generate");

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  return tool(
    async (input: ImageGenerateInput, config) => {
      const attachmentMap =
        (config as any)?.configurable?.user_attachment_map as
          Record<string, string> | undefined;
      return await runImageGenerate(
        input,
        deps.persistImage,
        deps.submitImageJob,
        attachmentMap,
      );
    },
    {
      name: "generate_image",
      description: `Generate an image using AI. Available models: ${modelSummary}. Returns the generated image URL.`,
      schema: buildImageGenerateSchema(models),
    },
  );
}
