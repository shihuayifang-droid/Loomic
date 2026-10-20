// Generate the initial packages/shared/src/model-catalog.ts.
//
// 44 entries is too many to transcribe by hand without introducing exactly the
// kind of drift this change is meant to remove, so the current values are read
// out of the live registry and emitted as code.
//
// Behaviour must not change: where a model has no configured tier today, the
// implicit fallback is written out explicitly and tagged NEEDS-REVIEW. Those tags
// are the list of tier decisions that were never actually made -- notably
// kwjm/gpt-image-2, the only image model currently in use.
//
// This generator deliberately emits NO prices: a price exists only in the
// `pricing_rules` table (workorder 31C / BL-14).
import { writeFileSync } from "node:fs";

import { MODEL_MIN_TIER } from "@loomic/shared";

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

const q = (s: string) => JSON.stringify(s);
const reviewNotes: string[] = [];

// ── image entries ──
const imageEntries = imageModels
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((m) => {
    const tierKnown = m.id in MODEL_MIN_TIER;
    const tier = MODEL_MIN_TIER[m.id] ?? "pro";
    const flags: string[] = [];
    if (!tierKnown) flags.push("tier");
    if (flags.length) reviewNotes.push(`${m.id} (${flags.join(" + ")})`);
    const note = flags.length
      ? `\n    // NEEDS-REVIEW: ${flags.join(" and ")} was never configured; the value below is the old implicit default.`
      : "";
    return `  ${q(m.id)}: {${note}
    provider: ${q(m.provider)},
    minTier: ${q(tier)},
  },`;
  })
  .join("\n");

// ── video entries ──
const videoEntries = videoModels
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((m) => {
    const tierKnown = m.id in MODEL_MIN_TIER;
    const tier = MODEL_MIN_TIER[m.id] ?? "pro";
    const flags: string[] = [];
    if (!tierKnown) flags.push("tier");
    if (flags.length) reviewNotes.push(`${m.id} (${flags.join(" + ")})`);
    const note = flags.length
      ? `\n    // NEEDS-REVIEW: ${flags.join(" and ")} was never configured; the value below is the old implicit default.`
      : "";
    return `  ${q(m.id)}: {${note}
    provider: ${q(m.provider)},
    minTier: ${q(tier)},
  },`;
  })
  .join("\n");

const out = `// GENERATED as a starting point by apps/server/_gen-catalog.ts, then maintained by hand.
//
// Single source of truth for model business metadata: which plan may use a model.
// Lives in shared because both the server (tier guard) and the web app need it;
// providers stay in apps/server and own the technical side (how to call the API,
// capabilities, limits).
//
// Prices are NOT here. A price exists only in the \`pricing_rules\` table (BL-14
// 第 1 条) and is asked for at charge time by the price quoter.
//
// WHY THIS EXISTS
// A model id used to be registered in up to three unrelated places -- the
// provider's own \`models\` array, MODEL_MIN_TIER, and the cost tables -- with no
// constraint between them and a silent fallback on every lookup. Missing from the
// tier table meant "pro", invisible to free/starter users. An audit found 17 such
// gaps, including \`kwjm/gpt-image-2\`, the only image model actually in use.
//
// Entries marked NEEDS-REVIEW had no configured tier and carry the old implicit
// default written out explicitly so behaviour is unchanged. They are the tier
// decisions that were never really made and still need a real answer.
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
