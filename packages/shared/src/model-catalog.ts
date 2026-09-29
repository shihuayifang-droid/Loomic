// GENERATED as a starting point by apps/server/_gen-catalog.ts, then maintained by hand.
//
// Single source of truth for model business metadata: which plan may use a model
// and what it costs. Lives in shared because both the server (tier guard, billing)
// and the web app need it; providers stay in apps/server and own the technical
// side (how to call the API, capabilities, limits).
//
// WHY THIS EXISTS
// A model id used to be registered in up to three unrelated places -- the
// provider's own `models` array, MODEL_MIN_TIER, and IMAGE_/VIDEO_MODEL_COSTS --
// with no constraint between them and a silent fallback on every lookup. Missing
// from the tier table meant "pro" (invisible to free/starter users); missing from
// a cost table meant an invented price. An audit found 17 such gaps, including
// `kwjm/gpt-image-2`, the only image model actually in use, which was billing at
// the made-up default of hd=10.
//
// Entries marked NEEDS-REVIEW carry those old implicit defaults, written out
// explicitly so behaviour is unchanged. They are the pricing/tier decisions that
// were never really made and still need a real answer.
import type { SubscriptionPlan } from "./credits.js";
import type { ImageModelCost, VideoModelCost } from "./credits.js";

export interface ImageCatalogEntry {
  /** Provider that serves this model, for cross-checking against the registry. */
  provider: string;
  minTier: SubscriptionPlan;
  cost: ImageModelCost;
}

export interface VideoCatalogEntry {
  provider: string;
  minTier: SubscriptionPlan;
  cost: VideoModelCost;
}

export const IMAGE_MODEL_CATALOG = {
  "black-forest-labs/flux-kontext-max": {
    provider: "replicate",
    minTier: "pro",
    cost: { standard: 12, hd: 18, ultra: 30 },
  },
  "black-forest-labs/flux-kontext-pro": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 8, hd: 12, ultra: 20 },
  },
  "bytedance/seedream-4": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 2, hd: 4, ultra: 8 },
  },
  "bytedance/seedream-4.5": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 3, hd: 5, ultra: 8 },
  },
  "bytedance/seedream-5-lite": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 3, hd: 6, ultra: 10 },
  },
  "google-official/gemini-2.5-flash-image": {
    provider: "google",
    minTier: "free",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google-official/gemini-3-pro-image-preview": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google-official/gemini-3.1-flash-image-preview": {
    provider: "google",
    minTier: "free",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google-vertex/gemini-2.5-flash-image": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google-vertex/gemini-3-pro-image-preview": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google-vertex/gemini-3.1-flash-image-preview": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google/imagen-4": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google/nano-banana": {
    provider: "replicate",
    minTier: "free",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "google/nano-banana-2": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 4, hd: 8, ultra: 12 },
  },
  "google/nano-banana-pro": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 6, hd: 10, ultra: 18 },
  },
  "kwjm/gpt-image-1.5": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "openai",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "kwjm/gpt-image-2": {
    // NEEDS-REVIEW: tier and cost was never configured; the value below is the old implicit default.
    provider: "openai",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "kwjm/gpt-image-2-inpaint": {
    // Same wire model as kwjm/gpt-image-2, separate internal id because the
    // OPERATION differs (see ImageOperation in apps/server/src/generation/types.ts).
    // Declaring it separately is what lets tier, price and limits be set per
    // operation — an edit is not necessarily worth the same as a generation.
    // NEEDS-REVIEW: price copied from the generate variant, never actually decided.
    provider: "openai",
    minTier: "pro",
    cost: { standard: 5, hd: 10, ultra: 20 },
  },
  "openai/gpt-image-1.5": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 4, hd: 8, ultra: 16 },
  },
  "recraft-ai/recraft-v3": {
    provider: "replicate",
    minTier: "starter",
    cost: { standard: 5, hd: 10, ultra: 18 },
  },
} as const satisfies Record<string, ImageCatalogEntry>;

export const VIDEO_MODEL_CATALOG = {
  "bytedance/seedance-1.5-pro": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":25,"includedSeconds":5,"perAdditionalSecond":5,"resolutionMultipliers":{}},
  },
  "google-official/veo-2.0-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":20,"includedSeconds":5,"perAdditionalSecond":3,"resolutionMultipliers":{}},
  },
  "google-official/veo-3.0-fast-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":50,"includedSeconds":5,"perAdditionalSecond":8,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-official/veo-3.0-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":70,"includedSeconds":5,"perAdditionalSecond":12,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-official/veo-3.1-fast-generate-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":60,"includedSeconds":5,"perAdditionalSecond":10,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-official/veo-3.1-generate-preview": {
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":80,"includedSeconds":5,"perAdditionalSecond":15,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-official/veo-3.1-lite-generate-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":30,"includedSeconds":5,"perAdditionalSecond":5,"resolutionMultipliers":{"1080p":2}},
  },
  "google-vertex/veo-2.0-generate-001": {
    provider: "google-vertex",
    minTier: "starter",
    cost: {"calculation":"base_plus_duration","base":20,"includedSeconds":5,"perAdditionalSecond":3,"resolutionMultipliers":{}},
  },
  "google-vertex/veo-3.0-fast-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":50,"includedSeconds":5,"perAdditionalSecond":8,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-vertex/veo-3.0-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":70,"includedSeconds":5,"perAdditionalSecond":12,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-vertex/veo-3.1-fast-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":60,"includedSeconds":5,"perAdditionalSecond":10,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-vertex/veo-3.1-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":80,"includedSeconds":5,"perAdditionalSecond":15,"resolutionMultipliers":{"1080p":2,"4k":4}},
  },
  "google-vertex/veo-3.1-lite-generate-001": {
    provider: "google-vertex",
    minTier: "starter",
    cost: {"calculation":"base_plus_duration","base":30,"includedSeconds":5,"perAdditionalSecond":5,"resolutionMultipliers":{"1080p":2}},
  },
  "google/veo-3": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":100,"includedSeconds":5,"perAdditionalSecond":0,"resolutionMultipliers":{}},
  },
  "google/veo-3.1": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":100,"includedSeconds":5,"perAdditionalSecond":0,"resolutionMultipliers":{}},
  },
  "google/veo-3.1-fast": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":40,"includedSeconds":5,"perAdditionalSecond":0,"resolutionMultipliers":{}},
  },
  "kwaivgi/kling-o1": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":30,"includedSeconds":5,"perAdditionalSecond":6,"resolutionMultipliers":{}},
  },
  "kwaivgi/kling-v2.6": {
    provider: "replicate",
    minTier: "starter",
    cost: {"calculation":"base_plus_duration","base":25,"includedSeconds":5,"perAdditionalSecond":5,"resolutionMultipliers":{}},
  },
  "kwaivgi/kling-v3-omni-video": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":40,"includedSeconds":5,"perAdditionalSecond":8,"resolutionMultipliers":{}},
  },
  "kwaivgi/kling-v3-video": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":50,"includedSeconds":5,"perAdditionalSecond":10,"resolutionMultipliers":{}},
  },
  "metaso/minimax-h3": {
    provider: "metaso",
    minTier: "starter",
    cost: {"calculation":"per_second","rates":{"720p":10.2,"1080p":17}},
  },
  "minimax/hailuo-2.3": {
    provider: "replicate",
    minTier: "starter",
    cost: {"calculation":"base_plus_duration","base":20,"includedSeconds":5,"perAdditionalSecond":4,"resolutionMultipliers":{}},
  },
  "openai/sora-2": {
    provider: "replicate",
    minTier: "pro",
    cost: {"calculation":"base_plus_duration","base":40,"includedSeconds":5,"perAdditionalSecond":0,"resolutionMultipliers":{}},
  },
  "openai/sora-2-pro": {
    provider: "replicate",
    minTier: "ultra",
    cost: {"calculation":"base_plus_duration","base":120,"includedSeconds":5,"perAdditionalSecond":0,"resolutionMultipliers":{}},
  },
  "wan-video/wan-2.6": {
    provider: "replicate",
    minTier: "starter",
    cost: {"calculation":"base_plus_duration","base":25,"includedSeconds":5,"perAdditionalSecond":5,"resolutionMultipliers":{}},
  },
} as const satisfies Record<string, VideoCatalogEntry>;

/** Ids of every catalogued image model. Providers must declare one of these. */
export type CataloguedImageModelId = keyof typeof IMAGE_MODEL_CATALOG;
/** Ids of every catalogued video model. */
export type CataloguedVideoModelId = keyof typeof VIDEO_MODEL_CATALOG;
