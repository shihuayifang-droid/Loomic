import type { GeneratorParams } from "@loomic/shared";
import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageModelInfo,
  ImageQualityTier,
  ImageProvider,
} from "../types.js";
import { aspectRatioToDimensions, GenerationError } from "../utils.js";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

/** Flux Kontext publishes one parameter group: the aspect ratio (user ruling 2026-10-23). */
const FLUX_KONTEXT_PARAMS: GeneratorParams = {
  maxCount: 10,
  params: [
    {
      type: "discrete",
      id: "aspectRatio",
      label: "比例",
      default: "1:1",
      options: ["1:1", "16:9", "9:16", "4:3", "3:4"].map((v) => ({ value: v, label: v })),
    },
  ],
};

/**
 * Image input parameter mapping per model.
 *
 * Replicate models use different parameter names for image input:
 * - `input_image`  (single URL string)  → Flux Kontext family
 * - `input_images` (array of URL strings) → OpenAI GPT Image
 * - `image_input`  (array of URL strings) → Google Nano Banana, ByteDance Seedream (default)
 */
/**
 * This set is about the WIRE FORMAT (`input_image` takes one URL string, not an
 * array), which is why it is not derived from `limits`. But the two must agree:
 * a model listed here can only ever send one reference, so its declared
 * `maxInputImages` must be 1 — otherwise the tool advertises a capacity that
 * this method silently truncates. `_image-limits-audit.ts` checks that.
 *
 * flux-1.1-pro and flux-pro are not in REPLICATE_IMAGE_MODELS; they are kept
 * here so the mapping stays correct if they are ever declared.
 */
const SINGLE_IMAGE_INPUT_MODELS = new Set([
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
  "black-forest-labs/flux-1.1-pro",
  "black-forest-labs/flux-pro",
]);

const INPUT_IMAGES_MODELS = new Set([
  "openai/gpt-image-1.5",
  "openai/gpt-image-1",
]);

/**
 * Recraft uses `size` (e.g. "1024x1024") instead of `aspect_ratio`.
 */
const RECRAFT_MODELS = new Set(["recraft-ai/recraft-v3"]);

const ICON_GOOGLE = "https://tjzk.replicate.delivery/models_organizations_avatar/27e1e3fe-f766-4748-83b3-777bc282d8dd/1342004.png";
const ICON_OPENAI = "https://github.com/openai.png";
const ICON_BFL = "https://tjzk.replicate.delivery/models_organizations_avatar/01ed70be-0d47-4a4a-85fb-32c02cdd4ab5/bfl.png";
const ICON_BYTEDANCE = "https://github.com/bytedance.png";
const ICON_RECRAFT = "https://github.com/recraft-ai.png";

/**
 * Reference-image counts below come from what the code already encoded:
 * the "up to 14" figures were in these descriptions, `1` came from
 * SINGLE_IMAGE_INPUT_MODELS, and `0` from the former TEXT_ONLY_MODELS set.
 * "multiple" had no number anywhere, so it is recorded as "unbounded" instead of
 * being guessed at.
 */
// ── Quality → model-specific resolution translation ──────────────────────
//
// MD-03: declared ABOVE the model list because each entry derives its
// `qualityTiers` from this table; a later declaration would be in the temporal
// dead zone while the list initialises. Moved verbatim — the values are unchanged.

type QualityMap = Record<string, Record<string, { param: string; value: string }>>;

/**
 * Maps (model prefix → quality level → { paramName, paramValue }).
 * Lookup order: exact model ID → prefix before "/" → fallback.
 */
const QUALITY_MAP: QualityMap = {
  // Google Nano Banana Pro / 2: uses `resolution`
  "google/nano-banana-pro": {
    standard: { param: "resolution", value: "1K" },
    hd:       { param: "resolution", value: "2K" },
    ultra:    { param: "resolution", value: "4K" },
  },
  "google/nano-banana-2": {
    standard: { param: "resolution", value: "1K" },
    hd:       { param: "resolution", value: "2K" },
    ultra:    { param: "resolution", value: "4K" },
  },
  // Google Imagen 4: uses `image_size`
  "google/imagen-4": {
    standard: { param: "image_size", value: "1K" },
    hd:       { param: "image_size", value: "2K" },
    ultra:    { param: "image_size", value: "2K" }, // max 2K, cap silently
  },
  // ByteDance Seedream 5 Lite: uses `size`, max 3K
  "bytedance/seedream-5-lite": {
    standard: { param: "size", value: "2K" },
    hd:       { param: "size", value: "2K" },
    ultra:    { param: "size", value: "3K" },
  },
  // ByteDance Seedream 4.5: uses `size`, max 4K
  "bytedance/seedream-4.5": {
    standard: { param: "size", value: "2K" },
    hd:       { param: "size", value: "2K" },
    ultra:    { param: "size", value: "4K" },
  },
  // ByteDance Seedream 4: uses `size`, max 4K
  "bytedance/seedream-4": {
    standard: { param: "size", value: "1K" },
    hd:       { param: "size", value: "2K" },
    ultra:    { param: "size", value: "4K" },
  },
};

/**
 * MD-03: the tiers a Replicate model really honours, derived from `QUALITY_MAP`
 * — the very table `applyQuality` sends from. A model with no entry there is sent
 * no resolution parameter at all, so it declares no tiers and the UI shows no
 * quality selector. Returns a spreadable fragment so entries stay literal.
 */
function tiersFromQualityMap(
  modelId: string,
): { qualityTiers?: readonly ImageQualityTier[] } {
  const modelMap = QUALITY_MAP[modelId];
  if (!modelMap) return {};
  const tiers = (["standard", "hd", "ultra"] as const).map((quality) => ({
    quality,
    output: modelMap[quality]!.value as ImageQualityTier["output"],
  }));
  return tiers ? { qualityTiers: tiers } : {};
}

const REPLICATE_IMAGE_MODELS: readonly ImageModelInfo[] = [
  // Google
  {
    id: "google/nano-banana-pro",
    ...tiersFromQualityMap("google/nano-banana-pro"),
    displayName: "Nano Banana Pro",
    description: "Google's SOTA image generation & editing model. Up to 4K resolution. Best for multi-reference editing.",
    iconUrl: ICON_GOOGLE,
    operation: "generate",
    limits: { maxInputImages: 14, supportsOutputFormat: true },
  },
  {
    id: "google/nano-banana-2",
    ...tiersFromQualityMap("google/nano-banana-2"),
    displayName: "Nano Banana 2",
    description: "Fast image generation with conversational editing and character consistency. Good for multi-image fusion.",
    iconUrl: ICON_GOOGLE,
    operation: "generate",
    limits: { maxInputImages: 14, supportsOutputFormat: true },
  },
  {
    id: "google/nano-banana",
    displayName: "Nano Banana",
    description: "Google's image editing model in Gemini 2.5. Best for editing & transformation tasks.",
    iconUrl: ICON_GOOGLE,
    operation: "generate",
    limits: { maxInputImages: 14, supportsOutputFormat: true },
  },
  {
    id: "google/imagen-4",
    ...tiersFromQualityMap("google/imagen-4"),
    displayName: "Imagen 4",
    description: "Google's Imagen 4 flagship text-to-image model. Best pure text-to-image quality.",
    iconUrl: ICON_GOOGLE,
    operation: "generate",
    limits: { maxInputImages: 0, supportsOutputFormat: true },
  },
  // OpenAI
  {
    id: "openai/gpt-image-1.5",
    displayName: "GPT Image 1.5",
    description: "OpenAI's latest image model with better instruction following. Supports background transparency.",
    iconUrl: ICON_OPENAI,
    operation: "generate",
    limits: {
      maxInputImages: "unbounded",
      allowedAspectRatios: ["1:1", "3:2", "2:3"],
      supportsOutputFormat: true,
    },
  },
  // Black Forest Labs
  {
    id: "black-forest-labs/flux-kontext-max",
    displayName: "Flux Kontext Max",
    description: "Premium text-based image editing with maximum performance and improved typography. Best for single-image editing.",
    iconUrl: ICON_BFL,
    operation: "generate",
    limits: { maxInputImages: 1, supportsOutputFormat: true },
    params: FLUX_KONTEXT_PARAMS,
  },
  {
    id: "black-forest-labs/flux-kontext-pro",
    displayName: "Flux Kontext Pro",
    description: "SOTA text-based image editing with excellent prompt following and consistent results. Best for single-image editing.",
    iconUrl: ICON_BFL,
    operation: "generate",
    limits: { maxInputImages: 1, supportsOutputFormat: true },
    params: FLUX_KONTEXT_PARAMS,
  },
  // ByteDance
  {
    id: "bytedance/seedream-5-lite",
    ...tiersFromQualityMap("bytedance/seedream-5-lite"),
    displayName: "Seedream 5.0 Lite",
    description: "Image generation with built-in reasoning and example-based editing. Up to 3K resolution.",
    iconUrl: ICON_BYTEDANCE,
    operation: "generate",
    limits: { maxInputImages: "unbounded", supportsOutputFormat: true },
  },
  {
    id: "bytedance/seedream-4.5",
    ...tiersFromQualityMap("bytedance/seedream-4.5"),
    displayName: "Seedream 4.5",
    description: "Upgraded ByteDance model with stronger spatial understanding. Up to 4K resolution.",
    iconUrl: ICON_BYTEDANCE,
    operation: "generate",
    limits: { maxInputImages: "unbounded", supportsOutputFormat: false },
  },
  {
    id: "bytedance/seedream-4",
    ...tiersFromQualityMap("bytedance/seedream-4"),
    displayName: "Seedream 4",
    description: "Unified text-to-image generation and precise editing. Up to 4K resolution.",
    iconUrl: ICON_BYTEDANCE,
    operation: "generate",
    limits: { maxInputImages: "unbounded", supportsOutputFormat: false },
  },
  // Recraft
  {
    id: "recraft-ai/recraft-v3",
    displayName: "Recraft V3",
    description: "SOTA text-to-image with long text rendering and wide style variety. #1 by Artificial Analysis benchmark.",
    iconUrl: ICON_RECRAFT,
    operation: "generate",
    limits: { maxInputImages: 0, supportsOutputFormat: false },
  },
];

/** Model id → its declared limits, for the parameter-building helpers below. */
const LIMITS_BY_ID = new Map(
  REPLICATE_IMAGE_MODELS.map((m) => [m.id as string, m.limits] as const),
);

/** GPT Image 1.5 quality mapping (native `quality` param) */
const GPT_IMAGE_QUALITY: Record<string, string> = {
  standard: "medium",
  hd: "high",
  ultra: "high",
};

function applyQuality(
  input: Record<string, unknown>,
  model: string,
  quality: string | undefined,
): void {
  if (!quality) return;

  // GPT Image has native `quality` param
  if (INPUT_IMAGES_MODELS.has(model)) {
    input.quality = GPT_IMAGE_QUALITY[quality] ?? "auto";
    return;
  }

  // Lookup quality translation for this model
  const modelMap = QUALITY_MAP[model];
  if (modelMap) {
    const entry = modelMap[quality];
    if (entry) {
      input[entry.param] = entry.value;
    }
  }
  // Models not in QUALITY_MAP (Flux, Nano Banana, Recraft): no resolution param, skip
}

// ── Aspect ratio normalization ────────────────────────────────────────────

function parseRatio(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  return (w && h) ? w / h : 1;
}

/**
 * If the model doesn't support the requested ratio, find the nearest one.
 * e.g. "16:9" (1.78) → "3:2" (1.5) for GPT Image.
 */
function normalizeAspectRatio(model: string, ratio: string): string {
  const supported = LIMITS_BY_ID.get(model)?.allowedAspectRatios;
  if (!supported || supported.includes(ratio)) return ratio;

  const target = parseRatio(ratio);
  let best = supported[0]!;
  let bestDiff = Math.abs(parseRatio(best) - target);

  for (const candidate of supported) {
    const diff = Math.abs(parseRatio(candidate) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

// ── Output format translation ────────────────────────────────────────────

function applyOutputFormat(
  input: Record<string, unknown>,
  model: string,
  format: string | undefined,
): void {
  if (!format) return;
  // Unknown ids keep the old permissive behaviour: forward the parameter and let
  // Replicate reject it, rather than silently dropping it.
  if (LIMITS_BY_ID.get(model)?.supportsOutputFormat === false) return;
  input.output_format = format;
}

// ── Provider implementation ──────────────────────────────────────────────

export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate";
  readonly models = REPLICATE_IMAGE_MODELS;
  private apiToken: string;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const rawRatio = params.aspectRatio ?? "1:1";
    const aspectRatio = normalizeAspectRatio(params.model, rawRatio);
    const { width, height } = aspectRatioToDimensions(aspectRatio);

    const input: Record<string, unknown> = {
      prompt: params.prompt,
    };

    // Aspect ratio / size — Recraft uses pixel `size`, others use `aspect_ratio`
    if (RECRAFT_MODELS.has(params.model)) {
      input.size = `${width}x${height}`;
    } else {
      input.aspect_ratio = aspectRatio;
    }

    // Image input — parameter name varies by model. Text-only models (declared
    // maxInputImages: 0) get references dropped instead of a hard error, which is
    // the behaviour the former TEXT_ONLY_MODELS set had.
    const isTextOnly = LIMITS_BY_ID.get(params.model)?.maxInputImages === 0;
    if (params.inputImages?.length && !isTextOnly) {
      if (SINGLE_IMAGE_INPUT_MODELS.has(params.model)) {
        input.input_image = params.inputImages[0];
      } else if (INPUT_IMAGES_MODELS.has(params.model)) {
        input.input_images = params.inputImages;
      } else {
        input.image_input = params.inputImages;
      }
    }

    // Semantic params → model-specific translation
    applyQuality(input, params.model, params.quality);
    applyOutputFormat(input, params.model, params.outputFormat);

    const response = await fetch(
      `${REPLICATE_API_BASE}/models/${params.model}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(120_000), // 120s — guard against Replicate hanging
      },
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new GenerationError(
        "replicate",
        "api_error",
        `Replicate API error ${response.status}: ${(errorBody as { detail?: string })?.detail ?? "Unknown error"}`,
      );
    }

    const data = (await response.json()) as {
      output: string[] | string;
      status: string;
    };
    const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;

    if (!outputUrl) {
      throw new GenerationError(
        "replicate",
        "no_output",
        "Replicate returned no output URL",
      );
    }

    const mimeType = params.outputFormat === "jpg" ? "image/jpeg"
      : params.outputFormat === "webp" ? "image/webp"
      : "image/png";

    return { url: outputUrl, mimeType, width, height };
  }
}
