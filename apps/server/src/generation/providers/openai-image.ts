import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageModelInfo,
  ImageQualityTier,
  ImageProvider,
} from "../types.js";
import { fetchAsBase64, GenerationError } from "../utils.js";

// ── LOCAL FORK ───────────────────────────────────────────────────────────
//
// Upstream shipped this provider as a stub: `models = []` (so the model never
// appeared in /api/image-models) plus three bugs that made it unusable against
// a real gpt-image endpoint:
//
//   1. `quality` was never sent, but it is a REQUIRED parameter -> HTTP 400.
//   2. It read `response.data[0].url`, but gpt-image returns `b64_json`, so the
//      URL was always undefined and every call threw "no_output".
//   3. `inputImages` was ignored entirely, i.e. no reference-image support.
//
// It also passed arbitrary WxH computed from the aspect ratio, but the endpoint
// only accepts a fixed set of size strings, which is another guaranteed 400.
//
// This rewrite targets the kwjm (开物基模) gateway. It keeps the provider name
// "openai" because that is the registry key and the wire format is the OpenAI
// images API; only the base URL differs.
//
// Docs consulted:
//   https://kwjm.com/docs/modelhub/openai/gpt-image-2-image-generations.html
//   https://kwjm.com/docs/modelhub/openai/gpt-image-2-image-edit.html

const PROVIDER_NAME = "openai";

const ICON_OPENAI = "https://openai.com/favicon.ico";

/** Internal model ID → gateway model name. Prefixed to avoid colliding with
 * Replicate-hosted `openai/*` models.
 *
 * Note two internal ids map to the SAME gateway model: `-inpaint` is the same
 * `gpt-image-2` driven through /images/edits with a `mask`. They are separate
 * entries because the declared OPERATION differs, which is what lets the registry
 * route by operation and the catalog price them independently. */
const MODEL_MAP: Record<string, string> = {
  "kwjm/gpt-image-2": "gpt-image-2",
  "kwjm/gpt-image-1.5": "gpt-image-1.5",
  "kwjm/gpt-image-2-inpaint": "gpt-image-2",
  // Server-internal model for the no-selection fallback of the quick-edit flow
  // (ED-06). Deliberately NOT listed in OPENAI_IMAGE_MODELS: it must not show up
  // in the public catalog, so it needs no price row either.
  "kwjm/gpt-image-2.5-sunburst": "gpt-image-2.5-sunburst",
};

/**
 * Gateway models that accept an ARBITRARY `WxH` size on the wire. Everything
 * else is limited to the `SIZE_TABLE` strings and rejects anything else with a
 * 400, so `params.size` is ignored for them.
 *
 * Keyed by the UPSTREAM model name (the value in MODEL_MAP), not the internal
 * id, so two internal ids pointing at the same upstream model cannot disagree.
 */
const CUSTOM_SIZE_MODELS = new Set(["gpt-image-2.5-sunburst"]);

/**
 * The gateway sits behind Cloudflare, which answers any request whose
 * User-Agent looks non-browser with `403 error code: 1010` — Node's default
 * `undici` UA is rejected, so both calls below must look like a desktop Chrome.
 */
const GATEWAY_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Both kwjm models take repeated `image[]` fields on /images/edits, so several
 * references go in one request; the gateway docs state no cap, hence
 * "unbounded" rather than an invented number.
 *
 * `supportsOutputFormat: false` describes THIS implementation: the endpoint
 * always returns PNG base64 and `callGenerations`/`callEdits` never send an
 * output-format field. Flip it here if that changes.
 *
 * Aspect ratio is unrestricted because SIZE_TABLE maps any ratio onto one of the
 * accepted size strings via `orientationOf`.
 */
const KWJM_IMAGE_DEFAULTS = {
  operation: "generate",
  limits: {
    maxInputImages: "unbounded",
    supportsOutputFormat: false,
  },
} as const;

type Orientation = "square" | "landscape" | "portrait";

/**
 * The endpoint accepts ONLY these size strings — arbitrary WxH is rejected:
 *   1024x1024  1536x1024  1024x1536
 *   2048x2048  2048x1152
 *   3840x2160  2160x3840
 *
 * Not every (quality, orientation) pair has an exact match, so a few cells fall
 * back to the nearest available size:
 *   - hd/portrait  -> 1024x1536 (no 2K portrait exists)
 *   - ultra/square -> 2048x2048 (no 4K square exists)
 */
const SIZE_TABLE: Record<string, Record<Orientation, string>> = {
  standard: {
    square: "1024x1024",
    landscape: "1536x1024",
    portrait: "1024x1536",
  },
  hd: {
    square: "2048x2048",
    landscape: "2048x1152",
    portrait: "1024x1536",
  },
  ultra: {
    square: "2048x2048",
    landscape: "3840x2160",
    portrait: "2160x3840",
  },
};

/**
 * The 7 sizes the gateway really accepts for GPT Image 2 (user ruling
 * 2026-10-23). The single definition: the catalogue options, the pixel mapping
 * and the billing tier are all derived from it. A size is billed by its LONG
 * edge: <= 1.5K standard, 2K hd, 4K ultra.
 */
export const GPT_IMAGE_2_SIZES = [
  { value: "1:1", label: "1:1", width: 1024, height: 1024, tier: "standard" },
  { value: "3:2", label: "3:2", width: 1536, height: 1024, tier: "standard" },
  { value: "2:3", label: "2:3", width: 1024, height: 1536, tier: "standard" },
  { value: "1:1-2k", label: "1:1 · 2K", width: 2048, height: 2048, tier: "hd" },
  { value: "16:9-2k", label: "16:9 · 2K", width: 2048, height: 1152, tier: "hd" },
  { value: "16:9-4k", label: "16:9 · 4K", width: 3840, height: 2160, tier: "ultra" },
  { value: "9:16-4k", label: "9:16 · 4K", width: 2160, height: 3840, tier: "ultra" },
] as const;

export type GptImage2SizeOption = (typeof GPT_IMAGE_2_SIZES)[number];

/** Look a catalogue size value up; `undefined` when it is not one of the 7. */
export function gptImage2SizeOption(value: string): GptImage2SizeOption | undefined {
  return GPT_IMAGE_2_SIZES.find((option) => option.value === value);
}

/** Every `WxH` string the tier table can emit (the gateway accepts exactly these). */
const TIER_TABLE_PIXELS: ReadonlySet<string> = new Set(
  Object.values(SIZE_TABLE).flatMap((cells) => Object.values(cells)),
);

/**
 * MD-03: what each tier really produces, read off `SIZE_TABLE` itself instead of
 * a second hand-kept list. A tier's `output` is the LONGEST edge of the sizes the
 * table can pick for it — standard 1536 → "1.5K", hd 2048 → "2K",
 * ultra 3840 → "4K" — so the label cannot claim a resolution the endpoint would
 * never return for that tier.
 */
function kwjmQualityTiers(): { qualityTiers: readonly ImageQualityTier[] } {
  // Ascending by edge; the table only yields 1024 / 1536 / 2048 / 3840 today.
  const LABELS: readonly { edge: number; output: ImageQualityTier["output"] }[] = [
    { edge: 1024, output: "1K" },
    { edge: 1536, output: "1.5K" },
    { edge: 2048, output: "2K" },
    { edge: 3072, output: "3K" },
    { edge: 3840, output: "4K" },
  ];
  return {
    qualityTiers: (["standard", "hd", "ultra"] as const).map((quality) => {
      const cells = Object.values(SIZE_TABLE[quality]!);
      const longest = Math.max(
        ...cells.map((size) => Math.max(...size.split("x").map(Number))),
      );
      const match =
        LABELS.find((label) => label.edge >= longest) ??
        LABELS[LABELS.length - 1]!;
      return { quality, output: match.output };
    }),
  };
}

const OPENAI_IMAGE_MODELS: readonly ImageModelInfo[] = [
  {
    id: "kwjm/gpt-image-2",
    displayName: "GPT Image 2",
    description:
      "OpenAI gpt-image-2 via the kwjm gateway. Text-to-image and multi-reference image editing. Up to 4K. Good prompt adherence and text rendering.",
    iconUrl: ICON_OPENAI,
    ...KWJM_IMAGE_DEFAULTS,
    ...kwjmQualityTiers(),
    params: {
      maxCount: 1,
      params: [
        {
          type: "discrete",
          id: "size",
          label: "尺寸",
          default: "1:1",
          options: GPT_IMAGE_2_SIZES.map((s) => ({ value: s.value, label: s.label, tier: s.tier })),
        },
      ],
    },
  },
  {
    id: "kwjm/gpt-image-1.5",
    displayName: "GPT Image 1.5",
    description:
      "Previous-generation OpenAI image model via the kwjm gateway. Cheaper and faster than gpt-image-2, lower fidelity.",
    iconUrl: ICON_OPENAI,
    ...KWJM_IMAGE_DEFAULTS,
    ...kwjmQualityTiers(),
  },
  {
    // P1-e stage 2: the first non-generate operation to be wired end to end.
    //
    // Chosen over upscale because kwjm has NO upscaler and no background-removal
    // model (checked its /v1/models: 121 models, zero matches), while
    // /images/edits does document a `mask` parameter — the standard inpaint
    // interface. It is also the stricter test of the abstraction: it needs a new
    // parameter, not just a different model id.
    id: "kwjm/gpt-image-2-inpaint",
    displayName: "GPT Image 2 (Inpaint)",
    description:
      "Repaints only the masked region of an image, leaving the rest untouched. Needs a source image plus a PNG mask whose transparent area marks what to replace.",
    iconUrl: ICON_OPENAI,
    operation: "inpaint",
    limits: {
      // Exactly one source image: /images/edits pairs a single `image[]` with a
      // single `mask`, and a mask has no meaning against several sources.
      maxInputImages: 1,
      supportsOutputFormat: false,
    },
    ...kwjmQualityTiers(),
  },
];

/** Semantic quality → gateway `quality` enum (low | medium | high | auto). */
const QUALITY_MAP: Record<string, string> = {
  standard: "low",
  hd: "medium",
  ultra: "high",
};

function orientationOf(aspectRatio: string): Orientation {
  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h) return "square";
  const ratio = w / h;
  // Deliberately wide dead-band so 4:3 and 3:4 do not get forced into the
  // extreme 16:9 / 9:16 buckets.
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.87) return "portrait";
  return "square";
}

function resolveSize(aspectRatio: string, quality: string): string {
  const tier = SIZE_TABLE[quality] ?? SIZE_TABLE.hd!;
  return tier[orientationOf(aspectRatio)];
}

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split("x").map(Number);
  return { width: w ?? 1024, height: h ?? 1024 };
}

/**
 * Rounds a requested edge and clamps it into the range the gateway documents as
 * acceptable ([256, 4096]); non-finite input falls back to the low bound rather
 * than producing `NaNxNaN` on the wire.
 */
function clampEdge(value: number): number {
  if (!Number.isFinite(value)) return 256;
  return Math.min(4096, Math.max(256, Math.round(value)));
}

/**
 * Size actually sent to the gateway. Models in CUSTOM_SIZE_MODELS honour an
 * explicit `size` verbatim (clamped); every other model keeps the tier-table
 * behaviour, which is what the endpoint accepts.
 */
function resolveRequestSize(
  params: ImageGenerateParams,
  apiModel: string,
  qualityKey: string,
): string {
  if (params.size && CUSTOM_SIZE_MODELS.has(apiModel)) {
    return `${clampEdge(params.size.width)}x${clampEdge(params.size.height)}`;
  }
  // A size the tier table itself can emit is something the endpoint accepts, so
  // an explicit catalogue size is sent as is; anything else keeps the tier table.
  if (params.size) {
    const requested = `${params.size.width}x${params.size.height}`;
    if (TIER_TABLE_PIXELS.has(requested)) return requested;
  }
  return resolveSize(params.aspectRatio ?? "1:1", qualityKey);
}

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = PROVIDER_NAME;
  readonly models = OPENAI_IMAGE_MODELS;

  private apiKey: string;
  private baseURL: string;

  constructor(apiKey: string, baseURL?: string) {
    this.apiKey = apiKey;
    this.baseURL = (baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const apiModel = MODEL_MAP[params.model];
    if (!apiModel) {
      throw new GenerationError(
        PROVIDER_NAME,
        "model_not_found",
        `Unknown image model: ${params.model}`,
      );
    }

    const declared = OPENAI_IMAGE_MODELS.find((m) => m.id === params.model);
    const operation = declared?.operation ?? "generate";

    // Both directions are hard errors, never silent:
    //   - an inpaint model without a mask would quietly regenerate the whole
    //     image and look like a successful edit
    //   - a mask sent to a generate model would be dropped, same illusion
    if (operation === "inpaint") {
      if (!params.mask) {
        throw new GenerationError(
          PROVIDER_NAME,
          "invalid_input",
          `${params.model} performs inpainting and requires a mask.`,
        );
      }
      if (!params.inputImages?.length) {
        throw new GenerationError(
          PROVIDER_NAME,
          "invalid_input",
          `${params.model} requires the source image to edit.`,
        );
      }
    } else if (params.mask) {
      throw new GenerationError(
        PROVIDER_NAME,
        "invalid_input",
        `${params.model} performs "${operation}" and cannot use a mask. ` +
          `Use an inpaint model instead.`,
      );
    }

    const qualityKey = params.quality ?? "hd";
    const quality = QUALITY_MAP[qualityKey] ?? "medium";
    const size = resolveRequestSize(params, apiModel, qualityKey);

    const hasInputs = !!params.inputImages?.length;
    const response = hasInputs
      ? await this.callEdits(apiModel, params, size, quality)
      : await this.callGenerations(apiModel, params, size, quality);

    return this.toGeneratedImage(response, size);
  }

  /** Text-to-image: JSON body against /images/generations. */
  private async callGenerations(
    apiModel: string,
    params: ImageGenerateParams,
    size: string,
    quality: string,
  ): Promise<Response> {
    return fetch(`${this.baseURL}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": GATEWAY_USER_AGENT,
      },
      body: JSON.stringify({
        model: apiModel,
        prompt: params.prompt,
        size,
        quality,
        n: 1,
      }),
    });
  }

  /**
   * Image editing / reference images: multipart against /images/edits.
   * The field name is `image[]` (repeated) so several references can be sent in
   * one request. Content-Type is intentionally NOT set — fetch must generate the
   * multipart boundary itself.
   */
  private async callEdits(
    apiModel: string,
    params: ImageGenerateParams,
    size: string,
    quality: string,
  ): Promise<Response> {
    const form = new FormData();
    form.append("model", apiModel);
    form.append("prompt", params.prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("n", "1");

    const fetched = await Promise.all(
      params.inputImages!.map((url) => fetchAsBase64(PROVIDER_NAME, url)),
    );

    fetched.forEach((img, i) => {
      const bytes = Buffer.from(img.data, "base64");
      const ext = img.mimeType.split("/")[1] ?? "png";
      form.append(
        "image[]",
        new Blob([new Uint8Array(bytes)], { type: img.mimeType }),
        `reference-${i}.${ext}`,
      );
    });

    // Inpainting: the mask goes in the documented `mask` field. Its fully
    // transparent pixels are the region to repaint, so it MUST stay PNG — a JPEG
    // has no alpha channel and the whole image would be treated as editable.
    if (params.mask) {
      const maskImg = await fetchAsBase64(PROVIDER_NAME, params.mask);
      if (!/png/i.test(maskImg.mimeType)) {
        throw new GenerationError(
          PROVIDER_NAME,
          "invalid_input",
          `Mask must be a PNG with an alpha channel, got ${maskImg.mimeType}.`,
        );
      }
      const maskBytes = Buffer.from(maskImg.data, "base64");
      form.append(
        "mask",
        new Blob([new Uint8Array(maskBytes)], { type: maskImg.mimeType }),
        "mask.png",
      );
    }

    return fetch(`${this.baseURL}/images/edits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": GATEWAY_USER_AGENT,
      },
      body: form,
    });
  }

  private async toGeneratedImage(
    response: Response,
    size: string,
  ): Promise<GeneratedImage> {
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | ImagesApiResponse
        | null;
      const detail = body?.error?.message ?? "Unknown error";

      // The gateway documents 400 (not 503) as the content-policy status, so
      // surface that as a safety filter rather than a generic API failure.
      const code =
        response.status === 400 && /polic|safety|content/i.test(detail)
          ? "safety_filter"
          : "api_error";

      throw new GenerationError(
        PROVIDER_NAME,
        code,
        `Image API error ${response.status}: ${detail}`,
      );
    }

    const body = (await response.json()) as ImagesApiResponse;
    const first = body.data?.[0];

    // gpt-image returns base64, not a URL. Keep the URL branch as a fallback so
    // an OpenAI-compatible endpoint that does return URLs still works.
    const url = first?.b64_json
      ? `data:image/png;base64,${first.b64_json}`
      : first?.url;

    if (!url) {
      throw new GenerationError(
        PROVIDER_NAME,
        "no_output",
        "Image API returned neither b64_json nor url",
      );
    }

    const { width, height } = parseSize(size);
    return { url, mimeType: "image/png", width, height };
  }
}
