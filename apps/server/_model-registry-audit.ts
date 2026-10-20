// Cross-check the models providers actually expose against the tier table in
// packages/shared. Replaces the regex-over-source version, which produced false
// negatives: providers declare ids inconsistently --
//
//   openai-image.ts    id: "kwjm/gpt-image-2"      <- literal, matched
//   metaso-video.ts    id: METASO_VIDEO_MODEL_ID   <- constant, missed
//   google-video.ts    built from a helper          <- missed
//
// so ten entries looked like orphans when they were not. Reading `.models` off
// each provider instance is format-independent and is the same data the app sees.
//
// Providers are constructed with placeholder credentials because
// registerAllProviders only registers those whose key is present, and this env
// only has the kwjm key -- a live registration would show one provider out of
// nine. Placeholders are safe: keys are only used when generate() is called.
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

type Kind = "image" | "video";
const found: { kind: Kind; provider: string; id: string }[] = [];
const constructionFailures: string[] = [];

function collect(kind: Kind, label: string, build: () => { name: string; models: readonly { id: string }[] }) {
  try {
    const p = build();
    for (const m of p.models) found.push({ kind, provider: p.name, id: m.id });
  } catch (err) {
    constructionFailures.push(
      `${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const KEY = "placeholder-not-used-for-listing";
collect("image", "GoogleImageProvider", () => new GoogleImageProvider(KEY));
collect("image", "GoogleVertexImageProvider", () => new GoogleVertexImageProvider({ project: "p", location: "global" }));
collect("image", "OpenAIImageProvider", () => new OpenAIImageProvider(KEY));
collect("image", "ReplicateImageProvider", () => new ReplicateImageProvider(KEY));
collect("image", "VolcesImageProvider", () => new VolcesImageProvider(KEY));
collect("video", "GoogleVideoProvider", () => new GoogleVideoProvider(KEY));
collect("video", "GoogleVertexVideoProvider", () => new GoogleVertexVideoProvider({ project: "p", location: "us-central1" }));
collect("video", "MetasoVideoProvider", () => new MetasoVideoProvider(KEY));
collect("video", "ReplicateVideoProvider", () => new ReplicateVideoProvider(KEY));

if (constructionFailures.length) {
  console.log("provider construction failures (their models are NOT audited):");
  for (const f of constructionFailures) console.log(`  ${f}`);
  console.log("");
}

const imageIds = found.filter((f) => f.kind === "image");
const videoIds = found.filter((f) => f.kind === "video");
console.log(`providers expose: ${imageIds.length} image, ${videoIds.length} video`);
console.log(`tables: MODEL_MIN_TIER=${Object.keys(MODEL_MIN_TIER).length}`);

let gaps = 0;
function report(
  title: string,
  rows: typeof found,
  table: Record<string, unknown>,
  consequence: string,
) {
  const missing = rows.filter((r) => !(r.id in table));
  console.log(`\n${title}: ${missing.length} missing`);
  if (missing.length) console.log(`  -> ${consequence}`);
  for (const r of missing.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`    ${r.id}   [${r.provider}]`);
  }
  gaps += missing.length;
}

report(
  "image models absent from MODEL_MIN_TIER",
  imageIds,
  MODEL_MIN_TIER,
  'defaults to "pro": free/starter users see it but cannot use it',
);
report(
  "video models absent from MODEL_MIN_TIER",
  videoIds,
  MODEL_MIN_TIER,
  'defaults to "pro"',
);

const exposed = new Set(found.map((f) => f.id));
const orphans = (table: Record<string, unknown>) =>
  Object.keys(table).filter((id) => !exposed.has(id)).sort();

console.log("\n--- table entries no provider exposes (dead / renamed / key-gated) ---");
for (const [label, table] of [["MODEL_MIN_TIER", MODEL_MIN_TIER]] as const) {
  const o = orphans(table as Record<string, unknown>);
  console.log(`${label}: ${o.length}`);
  for (const id of o) console.log(`    ${id}`);
}

console.log(`\nTOTAL FORWARD GAPS: ${gaps}`);
console.log("AUDIT_END");
