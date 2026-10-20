// GENERATED as a starting point by apps/server/_gen-catalog.ts, then maintained by hand.
//
// Single source of truth for model business metadata: which plan may use a model.
// Lives in shared because both the server (tier guard) and the web app need it;
// providers stay in apps/server and own the technical side (how to call the API,
// capabilities, limits).
//
// Prices are NOT here. A price exists only in the `pricing_rules` table (BL-14
// 第 1 条) and is asked for at charge time by the price quoter.
//
// WHY THIS EXISTS
// A model id used to be registered in up to three unrelated places -- the
// provider's own `models` array, MODEL_MIN_TIER, and the cost tables -- with no
// constraint between them and a silent fallback on every lookup. Missing from the
// tier table meant "pro", invisible to free/starter users. An audit found 17 such
// gaps, including `kwjm/gpt-image-2`, the only image model actually in use.
//
// Entries marked NEEDS-REVIEW had no configured tier and carry the old implicit
// default written out explicitly so behaviour is unchanged. They are the tier
// decisions that were never really made and still need a real answer.
import { z } from "zod";

import type { SubscriptionPlan } from "./credits.js";

export interface ImageCatalogEntry {
  /** Provider that serves this model, for cross-checking against the registry. */
  provider: string;
  minTier: SubscriptionPlan;
}

export interface VideoCatalogEntry {
  provider: string;
  minTier: SubscriptionPlan;
}

export const IMAGE_MODEL_CATALOG = {
  "black-forest-labs/flux-kontext-max": {
    provider: "replicate",
    minTier: "pro",
  },
  "black-forest-labs/flux-kontext-pro": {
    provider: "replicate",
    minTier: "starter",
  },
  "bytedance/seedream-4": {
    provider: "replicate",
    minTier: "starter",
  },
  "bytedance/seedream-4.5": {
    provider: "replicate",
    minTier: "starter",
  },
  "bytedance/seedream-5-lite": {
    provider: "replicate",
    minTier: "starter",
  },
  "google-official/gemini-2.5-flash-image": {
    provider: "google",
    minTier: "free",
  },
  "google-official/gemini-3-pro-image-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-official/gemini-3.1-flash-image-preview": {
    provider: "google",
    minTier: "free",
  },
  "google-vertex/gemini-2.5-flash-image": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/gemini-3-pro-image-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/gemini-3.1-flash-image-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google-vertex",
    minTier: "pro",
  },
  "google/imagen-4": {
    provider: "replicate",
    minTier: "starter",
  },
  "google/nano-banana": {
    provider: "replicate",
    minTier: "free",
  },
  "google/nano-banana-2": {
    provider: "replicate",
    minTier: "starter",
  },
  "google/nano-banana-pro": {
    provider: "replicate",
    minTier: "starter",
  },
  "kwjm/gpt-image-1.5": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "openai",
    minTier: "pro",
  },
  "kwjm/gpt-image-2": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "openai",
    minTier: "pro",
  },
  "kwjm/gpt-image-2-inpaint": {
    // Same wire model as kwjm/gpt-image-2, separate internal id because the
    // OPERATION differs (see ImageOperation in apps/server/src/generation/types.ts).
    // Declaring it separately is what lets tier and limits be set per operation.
    // NEEDS-REVIEW: tier copied from the generate variant, never actually decided.
    provider: "openai",
    minTier: "pro",
  },
  "openai/gpt-image-1.5": {
    provider: "replicate",
    minTier: "starter",
  },
  "recraft-ai/recraft-v3": {
    provider: "replicate",
    minTier: "starter",
  },
} as const satisfies Record<string, ImageCatalogEntry>;

export const VIDEO_MODEL_CATALOG = {
  "bytedance/seedance-1.5-pro": {
    provider: "replicate",
    minTier: "pro",
  },
  "google-official/veo-2.0-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-official/veo-3.0-fast-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-official/veo-3.0-generate-001": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-official/veo-3.1-fast-generate-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-official/veo-3.1-generate-preview": {
    provider: "google",
    minTier: "pro",
  },
  "google-official/veo-3.1-lite-generate-preview": {
    // NEEDS-REVIEW: tier was never configured; the value below is the old implicit default.
    provider: "google",
    minTier: "pro",
  },
  "google-vertex/veo-2.0-generate-001": {
    provider: "google-vertex",
    minTier: "starter",
  },
  "google-vertex/veo-3.0-fast-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/veo-3.0-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/veo-3.1-fast-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/veo-3.1-generate-001": {
    provider: "google-vertex",
    minTier: "pro",
  },
  "google-vertex/veo-3.1-lite-generate-001": {
    provider: "google-vertex",
    minTier: "starter",
  },
  "google/veo-3": {
    provider: "replicate",
    minTier: "pro",
  },
  "google/veo-3.1": {
    provider: "replicate",
    minTier: "pro",
  },
  "google/veo-3.1-fast": {
    provider: "replicate",
    minTier: "pro",
  },
  "kwaivgi/kling-o1": {
    provider: "replicate",
    minTier: "pro",
  },
  "kwaivgi/kling-v2.6": {
    provider: "replicate",
    minTier: "starter",
  },
  "kwaivgi/kling-v3-omni-video": {
    provider: "replicate",
    minTier: "pro",
  },
  "kwaivgi/kling-v3-video": {
    provider: "replicate",
    minTier: "pro",
  },
  "metaso/minimax-h3": {
    provider: "metaso",
    minTier: "starter",
  },
  "minimax/hailuo-2.3": {
    provider: "replicate",
    minTier: "starter",
  },
  "openai/sora-2": {
    provider: "replicate",
    minTier: "pro",
  },
  "openai/sora-2-pro": {
    provider: "replicate",
    minTier: "ultra",
  },
  "wan-video/wan-2.6": {
    provider: "replicate",
    minTier: "starter",
  },
} as const satisfies Record<string, VideoCatalogEntry>;

/** Ids of every catalogued image model. Providers must declare one of these. */
export type CataloguedImageModelId = keyof typeof IMAGE_MODEL_CATALOG;
/** Ids of every catalogued video model. */
export type CataloguedVideoModelId = keyof typeof VIDEO_MODEL_CATALOG;

/**
 * MD-04: the modality is its own field, never parsed out of an id or a tool
 * name. `3d` is kept (D-6: not built, value reserved); `audio` is reserved
 * (MD-12). Adding a modality adds a value here, not a column.
 */
export const modelModalitySchema = z.enum(["image", "video", "3d", "audio"]);
export type ModelModality = z.infer<typeof modelModalitySchema>;

/** Which catalogue a model belongs to decides its modality — not its name. */
export function modalityOfCatalogModel(id: string): ModelModality | null {
  if (Object.prototype.hasOwnProperty.call(IMAGE_MODEL_CATALOG, id)) return "image";
  if (Object.prototype.hasOwnProperty.call(VIDEO_MODEL_CATALOG, id)) return "video";
  return null;
}

/**
 * MD-01: the one visibility configuration every model surface filters by. An id
 * absent here is listed and visible everywhere; an entry overrides only the
 * fields it names. `listed: false` takes a model off every surface at once.
 */
export interface ModelVisibility {
  listed: boolean;
  agent_callable: boolean;
  generator_visible: boolean;
  in_preference: boolean;
}

export type ModelSurface = "agent" | "generator" | "preference";

const DEFAULT_MODEL_VISIBILITY: ModelVisibility = {
  listed: true,
  agent_callable: true,
  generator_visible: true,
  in_preference: true,
};

/** Overrides by model id. Empty today: no model is restricted yet. */
export const MODEL_VISIBILITY_OVERRIDES: Readonly<Record<string, Partial<ModelVisibility>>> = {};

export function modelVisibility(
  id: string,
  overrides: Readonly<Record<string, Partial<ModelVisibility>>> = MODEL_VISIBILITY_OVERRIDES,
): ModelVisibility {
  return { ...DEFAULT_MODEL_VISIBILITY, ...(overrides[id] ?? {}) };
}

export function isModelVisibleFor(
  id: string,
  surface: ModelSurface,
  overrides: Readonly<Record<string, Partial<ModelVisibility>>> = MODEL_VISIBILITY_OVERRIDES,
): boolean {
  const v = modelVisibility(id, overrides);
  if (!v.listed) return false;
  if (surface === "agent") return v.agent_callable;
  if (surface === "generator") return v.generator_visible;
  return v.in_preference;
}
