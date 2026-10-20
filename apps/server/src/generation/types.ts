import type {
  CataloguedImageModelId,
  CataloguedVideoModelId,
} from "@loomic/shared";

/** Metadata describing a model supported by a provider. */
export interface ModelInfo {
  /** Provider-scoped model ID, e.g. "google/nano-banana-pro" */
  id: string;
  /** Human-readable name shown to users */
  displayName: string;
  /** Short description for LLM model selection */
  description: string;
  /** URL to the model owner's avatar/icon */
  iconUrl?: string;
}

/**
 * What a model does to an image.
 *
 * This is a property of the MODEL, not an argument to the call, because on every
 * provider we use these are separate models: upscaling is `nightmareai/real-esrgan`,
 * background removal is `851-labs/background-remover`. You do not ask flux to
 * upscale; you call a different model. So the registry can route by operation and
 * a tool can offer only the models that actually perform its operation.
 *
 * The list is taken from Lovart's per-image toolbar (17 entries, of which these
 * are the ones that require a provider call — download, move, crop, flip/rotate
 * and toolbar customisation are pure client-side canvas actions). Declaring them
 * all up front is deliberate: it is the enum a new provider must pick from, and
 * it makes "which of the 17 do we still not support" answerable by grep instead
 * of by memory.
 *
 * Only "generate" has an implementation today. See Loomic-改造执行清单 P1-e.
 */
export type ImageOperation =
  /** Text-to-image, and image-to-image when reference images are supplied. */
  | "generate"
  /** Increase resolution without changing content. */
  | "upscale"
  /** Cut the subject out, producing transparency. */
  | "remove_background"
  /** Erase or replace a masked region (Lovart's eraser). */
  | "inpaint"
  /** Extend the image beyond its original bounds (Lovart's "扩展"). */
  | "outpaint"
  /** Split a flat image into separate layers. */
  | "extract_layer"
  /** Re-render the text in an image without touching the rest. */
  | "edit_text"
  /** Re-render the subject from another angle, with rotate/tilt/zoom params. */
  | "angle"
  /** Composite the image onto a product mockup. */
  | "mockup"
  /** Raster to vector. */
  | "vectorize";

/**
 * Semantic quality levels — each provider translates to its own resolution param.
 * - standard: ~1K (fastest, preview quality)
 * - hd:       ~2K (default, production quality)
 * - ultra:    ~4K (highest, print quality — not all models support this)
 */
export type ImageQuality = "standard" | "hd" | "ultra";

/**
 * MD-03: what one quality tier really produces on one model.
 *
 * `output` is the provider's own resolution label — the value actually put on
 * the wire — not a promise the tier's name makes. A model that silently caps
 * `ultra` at 2K declares "2K" here, which is what lets the UI say
 * "超清（实际 2K）" instead of advertising a resolution the API never returns.
 */
export type ImageQualityTier = {
  quality: ImageQuality;
  output: "1K" | "1.5K" | "2K" | "3K" | "4K";
};

export type OutputFormat = "png" | "jpg" | "webp";

export interface ImageGenerateParams {
  prompt: string;
  model: string;
  aspectRatio?: string;
  inputImages?: string[];
  /** Semantic quality level, provider translates to model-specific resolution */
  quality?: ImageQuality;
  /** Output format preference */
  outputFormat?: OutputFormat;
  /**
   * Mask for `operation: "inpaint"` models: a PNG whose FULLY TRANSPARENT pixels
   * mark the region to repaint, same dimensions as the source image.
   *
   * Only inpaint models read this. A provider that receives it for a model whose
   * declared operation is not "inpaint" must fail loudly rather than drop it —
   * silently ignoring a mask would return a plain regeneration that looks like a
   * successful edit.
   */
  mask?: string;
  metadata?: Record<string, unknown>;
}

export interface GeneratedImage {
  url: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * What an image model will and will not accept.
 *
 * These facts used to live in four disconnected places inside
 * `replicate-image.ts` (TEXT_ONLY_MODELS, SINGLE_IMAGE_INPUT_MODELS,
 * MODEL_ASPECT_RATIOS, NO_OUTPUT_FORMAT_MODELS) plus a hand-written English
 * sentence in the `inputImages` tool description — which listed only the
 * Replicate models and was already wrong for the kwjm ones. Declaring them on
 * the model means a new model cannot be added without answering these
 * questions.
 *
 * Deliberately NOT here: how each provider spells the parameter on the wire
 * (`input_image` vs `input_images` vs `image_input`, `resolution` vs `size`).
 * That is implementation detail and stays inside the provider.
 */
export interface ImageModelLimits {
  /**
   * Maximum reference images accepted.
   * - `0` — text-only, reference images are dropped
   * - `"unbounded"` — accepts several, but no documented cap was found
   *
   * `"unbounded"` is not a claim that any count works; it records that the real
   * limit is unverified. Any future runtime validation must handle it explicitly
   * rather than treating a made-up number as fact.
   */
  maxInputImages: number | "unbounded";
  /**
   * Aspect ratios the API accepts, when it only accepts a subset.
   * Omit when every ratio the tool exposes is passed through untouched.
   */
  allowedAspectRatios?: readonly string[];
  /**
   * Whether requesting an output format has any effect.
   * `false` means the provider drops `outputFormat` for this model — either the
   * API has no such parameter, or this implementation does not forward it.
   */
  supportsOutputFormat: boolean;
}

/**
 * A model an image provider exposes.
 *
 * `id` is narrowed to the ids present in shared's IMAGE_MODEL_CATALOG, so a
 * provider physically cannot expose a model that has no plan or price registered.
 * That used to be possible and happened 6 times: the lookup silently fell back to
 * min tier "pro" (invisible to free/starter users) and to an invented price —
 * including for kwjm/gpt-image-2, the only image model actually in use.
 *
 * Adding a model is now: add it to the catalog, then declare it here. Skipping the
 * first step is a compile error instead of a silent mispricing.
 */
export interface ImageModelInfo extends ModelInfo {
  id: CataloguedImageModelId;
  /**
   * Which operation this model performs. Required so that adding an upscaler
   * cannot accidentally show up in the text-to-image model list, and so the
   * routing question "who can upscale?" has an answer in code.
   */
  operation: ImageOperation;
  limits: ImageModelLimits;
  /**
   * MD-03: the quality tiers this model really honours and what each one
   * actually produces. Absent = the model takes no resolution parameter, so no
   * quality selector is shown. Derived from the same map the provider sends.
   */
  qualityTiers?: readonly ImageQualityTier[];
}

export interface ImageProvider {
  readonly name: string;
  readonly models: readonly ImageModelInfo[];
  generate(params: ImageGenerateParams): Promise<GeneratedImage>;
}

export interface VideoGenerateParams {
  prompt: string;
  model: string;
  resolution?: "480p" | "720p" | "1080p";
  duration?: number;
  aspectRatio?: string;
  inputImages?: string[];
  inputVideo?: string;
  /** Enable audio generation (only supported by some providers). */
  enableAudio?: boolean;
}

export interface GeneratedVideo {
  url: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface VideoProvider {
  readonly name: string;
  readonly models: readonly VideoModelInfo[];
  generate(params: VideoGenerateParams): Promise<GeneratedVideo>;
}

export interface VideoPriceRate {
  /** Loomic's resolution value sent through the public generation API. */
  resolution: "720p" | "1080p";
  /** Provider-native label shown to users, for example 768P or 2K. */
  displayResolution: string;
  providerPointsPerSecond: number;
  cnyPerSecond: {
    min: number;
    max: number;
  };
}

export interface VideoPricingInfo {
  currency: "CNY";
  billingUnit: "generated_second";
  providerPointsName: string;
  evidenceDate: string;
  rates: readonly VideoPriceRate[];
}

/**
 * Extended model info with video-specific capabilities metadata.
 *
 * `id` is narrowed against VIDEO_MODEL_CATALOG for the same reason as
 * ImageModelInfo above — 5 video models were missing a tier entry.
 */
export interface VideoModelInfo extends ModelInfo {
  id: CataloguedVideoModelId;
  capabilities: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  /** Verified provider pricing, separate from Loomic's own credit balance. */
  pricing?: VideoPricingInfo;
}
