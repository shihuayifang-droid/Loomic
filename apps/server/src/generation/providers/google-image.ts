import { GoogleGenAI } from "@google/genai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageModelInfo,
  ImageQualityTier,
  ImageProvider,
} from "../types.js";
import { aspectRatioToDimensions, fetchAsBase64, GenerationError } from "../utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const PROVIDER_NAME = "google";

const ICON_GOOGLE =
  "https://tjzk.replicate.delivery/models_organizations_avatar/27e1e3fe-f766-4748-83b3-777bc282d8dd/1342004.png";

/**
 * Maps our internal model IDs (with `google-official/` prefix) to the
 * actual Gemini API model name. The prefix avoids collision with
 * Replicate-hosted `google/*` models.
 */
const MODEL_MAP: Record<string, string> = {
  "google-official/gemini-2.5-flash-image": "gemini-2.5-flash-image",
  "google-official/gemini-3.1-flash-image-preview":
    "gemini-3.1-flash-image-preview",
  "google-official/gemini-3-pro-image-preview":
    "gemini-3-pro-image-preview",
};

/**
 * Shared by every Gemini image model: text-to-image plus editing via reference
 * images, 14 of them, any aspect ratio the tool exposes, and no output-format
 * parameter (the API always returns PNG via inlineData — see `generate`).
 */
const GEMINI_IMAGE_DEFAULTS = {
  operation: "generate",
  limits: {
    maxInputImages: 14,
    supportsOutputFormat: false,
  },
} as const;

/** Semantic quality → Gemini imageSize param. */
const QUALITY_TO_IMAGE_SIZE: Record<string, string> = {
  standard: "1K",
  hd: "2K",
  ultra: "4K",
};

/**
 * MD-03: every Gemini image model is sent `imageSize` (see `generate`), so all
 * of them declare the same three tiers. Derived from the map above so a label
 * cannot drift from the value that is actually sent.
 */
function geminiQualityTiers(): { qualityTiers: readonly ImageQualityTier[] } {
  return {
    qualityTiers: (["standard", "hd", "ultra"] as const).map((quality) => ({
      quality,
      output: QUALITY_TO_IMAGE_SIZE[quality] as ImageQualityTier["output"],
    })),
  };
}

const GOOGLE_IMAGE_MODELS: readonly ImageModelInfo[] = [
  {
    id: "google-official/gemini-3-pro-image-preview",
    displayName: "Nano Banana Pro",
    description:
      "Google Gemini 3 Pro image generation & editing preview. Up to 4K resolution. Best quality with advanced reasoning.",
    iconUrl: ICON_GOOGLE,
    ...GEMINI_IMAGE_DEFAULTS,
    ...geminiQualityTiers(),
  },
  {
    id: "google-official/gemini-3.1-flash-image-preview",
    displayName: "Nano Banana 2",
    description:
      "Google Gemini 3.1 image generation & editing preview. Faster generation, newest capabilities.",
    iconUrl: ICON_GOOGLE,
    ...GEMINI_IMAGE_DEFAULTS,
    ...geminiQualityTiers(),
  },
  {
    id: "google-official/gemini-2.5-flash-image",
    displayName: "Nano Banana",
    description:
      "Google Gemini native image generation & editing via direct API. Stable. Best balance of speed and quality.",
    iconUrl: ICON_GOOGLE,
    ...GEMINI_IMAGE_DEFAULTS,
    ...geminiQualityTiers(),
  },
];

/** Gemini finish reasons that indicate content policy / safety blocks. */
const SAFETY_FINISH_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

// ── Provider ─────────────────────────────────────────────────────────────

export class GoogleImageProvider implements ImageProvider {
  readonly name = PROVIDER_NAME;
  readonly models = GOOGLE_IMAGE_MODELS;

  private client: GoogleGenAI;

  /**
   * @param apiKey  Gemini API key, or the gateway key when `baseUrl` is set.
   * @param baseUrl Optional Gemini-compatible gateway host WITHOUT the version
   *   segment (e.g. "https://kwjm.com"); the SDK appends `/v1beta/models/...`.
   *
   * When routing through a gateway we must also send `Authorization: Bearer`.
   * The SDK only sends `x-goog-api-key`, which gateways like kwjm reject with
   * 401. We add the header ONLY in gateway mode so the official endpoint keeps
   * using the SDK's own auth untouched.
   */
  constructor(apiKey: string, baseUrl?: string) {
    this.client = new GoogleGenAI({
      apiKey,
      ...(baseUrl
        ? {
            httpOptions: {
              baseUrl,
              headers: { Authorization: `Bearer ${apiKey}` },
            },
          }
        : {}),
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const apiModel = MODEL_MAP[params.model];
    if (!apiModel) {
      throw new GenerationError(
        PROVIDER_NAME,
        "model_not_found",
        `Unknown Google image model: ${params.model}`,
      );
    }

    const aspectRatio = params.aspectRatio ?? "1:1";
    const imageSize = QUALITY_TO_IMAGE_SIZE[params.quality ?? "hd"] ?? "2K";
    // Note: outputFormat is ignored — Gemini API does not support output format
    // selection; it always returns PNG via inlineData.

    // Build content parts: text prompt + optional input images.
    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [{ text: params.prompt }];

    if (params.inputImages?.length) {
      const fetched = await Promise.all(
        params.inputImages.map((url) => fetchAsBase64(PROVIDER_NAME, url)),
      );
      for (const img of fetched) {
        parts.push({
          inlineData: { mimeType: img.mimeType, data: img.data },
        });
      }
    }

    let response;
    try {
      response = await this.client.models.generateContent({
        model: apiModel,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio,
            imageSize,
          },
        },
      });
    } catch (err) {
      throw new GenerationError(
        PROVIDER_NAME,
        "api_error",
        `Gemini API error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check for safety blocks.
    const candidate = response.candidates?.[0];
    if (
      candidate?.finishReason &&
      SAFETY_FINISH_REASONS.has(candidate.finishReason)
    ) {
      throw new GenerationError(
        PROVIDER_NAME,
        "safety_filter",
        `Image generation blocked by safety filter (reason: ${candidate.finishReason})`,
      );
    }

    if (response.promptFeedback?.blockReason) {
      throw new GenerationError(
        PROVIDER_NAME,
        "safety_filter",
        `Prompt blocked by safety filter (reason: ${response.promptFeedback.blockReason})`,
      );
    }

    // Extract base64 image from response parts.
    const imagePart = candidate?.content?.parts?.find(
      (p) => p.inlineData?.data,
    );
    const inlineData = imagePart?.inlineData;

    if (!inlineData?.data) {
      throw new GenerationError(
        PROVIDER_NAME,
        "no_output",
        "Gemini returned no image data in response",
      );
    }

    const mimeType = inlineData.mimeType ?? "image/png";
    const dataUri = `data:${mimeType};base64,${inlineData.data}`;
    const { width, height } = aspectRatioToDimensions(aspectRatio);

    return { url: dataUri, mimeType, width, height };
  }
}
