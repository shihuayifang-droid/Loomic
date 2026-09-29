// Generate the initial packages/shared/src/model-catalog.ts.
//
// 44 entries is too many to transcribe by hand without introducing exactly the
// kind of drift this change is meant to remove, so the current values are read
// out of the live registry plus the three existing tables and emitted as code.
//
// Behaviour must not change: where a model is missing from a table today, the
// implicit fallback is written out explicitly and tagged NEEDS-REVIEW. Those tags
// are the list of pricing/tier decisions that were never actually made -- notably
// kwjm/gpt-image-2, the only image model currently in use, which has been billing
// at the invented default of hd=10.
import { writeFileSync } from "node:fs";

import {
  IMAGE_MODEL_COSTS,
  MODEL_MIN_TIER,
  VIDEO_MODEL_COSTS,
} from "@loomic/shared";

import { GoogleImageProvider } from "./src/generation/providers/google-image.js";
import { GoogleVertexImageProvider } from "./src/generation/providers/google-vertex-image.js";
import { GoogleVertexVideoProvider } from "./src/generation/providers/google-vertex-video.js";
import { GoogleVideoProvider } from "./src/generation/providers/google-video.js";
import { MetasoVideoProvider } from "./src/generation/providers/metaso-video.js";
import { OpenAIImageProvider } from "./src/generation/providers/openai-image.js";
import { ReplicateImageProvider } from "./src/generation/providers/replicate-image.js";
import { ReplicateVideoProvider } from "./src/generation/providers/replicate-video.js";
import { VolcesImageProvider } from "./src/generation/providers/volces-image.js";
import type { ModelInfo, VideoModelInfo } from "./src/generation/types.js";

const KEY = "placeholder";
const imageModels: (ModelInfo & { provider: string })[] = [];
const videoModels: (VideoModelInfo & { provider: string })[] = [];

function addImage(build: () => { name: string; models: readonly ModelInfo[] }) {
  const p = build();
  for (const m of p.models) imageModels.push({ ...m, provider: p.name });
}
function addVideo(build: () => { name: string; models: readonly VideoModelInfo[] }) {
  const p = build();
  for (const m of p.models) videoModels.push({ ...m, provider: p.name });
}

addImage(() => new GoogleImageProvider(KEY));
addImage(() => new GoogleVertexImageProvider({ project: "p", location: "global" }));
addImage(() => new OpenAIImageProvider(KEY));
addImage(() => new ReplicateImageProvider(KEY));
addImage(() => new VolcesImageProvider(KEY));
addVideo(() => new GoogleVideoProvider(KEY));
addVideo(() => new GoogleVertexVideoProvider({ project: "p", location: "us-central1" }));
addVideo(() => new MetasoVideoProvider(KEY));
addVideo(() => new ReplicateVideoProvider(KEY));

const DEFAULT_IMAGE_COST = { standard: 5, hd: 10, ultra: 20 };
const DEFAULT_VIDEO_COST = {
  calculation: "base_plus_duration",
  base: 80,
  includedSeconds: 0,
  perAdditionalSecond: 0,
  resolutionMultipliers: {},
};

const q = (s: string) => JSON.stringify(s);
const reviewNotes: string[] = [];

// ── image entries ──
const imageEntries = imageModels
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((m) => {
    const tierKnown = m.id in MODEL_MIN_TIER;
    const costKnown = m.id in IMAGE_MODEL_COSTS;
    const tier = MODEL_MIN_TIER[m.id] ?? "pro";
    const cost = IMAGE_MODEL_COSTS[m.id] ?? DEFAULT_IMAGE_COST;
    const flags: string[] = [];
    if (!tierKnown) flags.push("tier");
    if (!costKnown) flags.push("cost");
    if (flags.length) reviewNotes.push(`${m.id} (${flags.join(" + ")})`);
    const note = flags.length
      ? `\n    // NEEDS-REVIEW: ${flags.join(" and ")} was never configured; the value below is the old implicit default.`
      : "";
    return `  ${q(m.id)}: {${note}
    provider: ${q(m.provider)},
    minTier: ${q(tier)},
    cost: { standard: ${cost.standard}, hd: ${cost.hd}, ultra: ${cost.ultra} },
  },`;
  })
  .join("\n");

// ── video entries ──
const videoEntries = videoModels
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((m) => {
    const tierKnown = m.id in MODEL_MIN_TIER;
    const costKnown = m.id in VIDEO_MODEL_COSTS;
    const tier = MODEL_MIN_TIER[m.id] ?? "pro";
    const cost = VIDEO_MODEL_COSTS[m.id] ?? DEFAULT_VIDEO_COST;
    const flags: string[] = [];
    if (!tierKnown) flags.push("tier");
    if (!costKnown) flags.push("cost");
    if (flags.length) reviewNotes.push(`${m.id} (${flags.join(" + ")})`);
    const note = flags.length
      ? `\n    // NEEDS-REVIEW: ${flags.join(" and ")} was never configured; the value below is the old implicit default.`
      : "";
    return `  ${q(m.id)}: {${note}
    provider: ${q(m.provider)},
    minTier: ${q(tier)},
    cost: ${JSON.stringify(cost)},
  },`;
  })
  .join("\n");

const out = `// GENERATED as a starting point by apps/server/_gen-catalog.ts, then maintained by hand.
//
// Single source of truth for model business metadata: which plan may use a model
// and what it costs. Lives in shared because both the server (tier guard, billing)
// and the web app need it; providers stay in apps/server and own the technical
// side (how to call the API, capabilities, limits).
//
// WHY THIS EXISTS
// A model id used to be registered in up to three unrelated places -- the
// provider's own \`models\` array, MODEL_MIN_TIER, and IMAGE_/VIDEO_MODEL_COSTS --
// with no constraint between them and a silent fallback on every lookup. Missing
// from the tier table meant "pro" (invisible to free/starter users); missing from
// a cost table meant an invented price. An audit found 17 such gaps, including
// \`kwjm/gpt-image-2\`, the only image model actually in use, which was billing at
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
${imageEntries}
} as const satisfies Record<string, ImageCatalogEntry>;

export const VIDEO_MODEL_CATALOG = {
${videoEntries}
} as const satisfies Record<string, VideoCatalogEntry>;

/** Ids of every catalogued image model. Providers must declare one of these. */
export type CataloguedImageModelId = keyof typeof IMAGE_MODEL_CATALOG;
/** Ids of every catalogued video model. */
export type CataloguedVideoModelId = keyof typeof VIDEO_MODEL_CATALOG;
`;

const target =
  "D:\\\\cherry stuido\\\\Loomic\\\\packages\\\\shared\\\\src\\\\model-catalog.ts";
writeFileSync(target.replace(/\\\\/g, "\\"), out, "utf8");

console.log(`image entries: ${imageModels.length}`);
console.log(`video entries: ${videoModels.length}`);
console.log(`\nNEEDS-REVIEW (${reviewNotes.length}):`);
for (const n of reviewNotes.sort()) console.log(`  ${n}`);
console.log("\nwrote packages/shared/src/model-catalog.ts");
console.log("GEN_END");
