/**
 * P1-c stage 3 audit -- image model `limits` consistency.
 *
 * Providers are constructed directly with placeholder credentials, same as
 * _model-registry-audit.ts: registerAllProviders only registers providers whose
 * key is present, and this env only has the kwjm key, so going through it would
 * audit one provider out of five. Keys are only used inside generate().
 *
 * Checks:
 *   1. Every declared image model has `limits`.
 *   2. Models sent through Replicate's single-URL `input_image` parameter declare
 *      maxInputImages: 1 -- otherwise the tool advertises a capacity the provider
 *      silently truncates to the first image.
 *   3. maxInputImages is a non-negative integer or "unbounded".
 *   4. allowedAspectRatios, when present, is non-empty and well-formed "w:h".
 *
 * Run: npx tsx _image-limits-audit.ts
 */
import { GoogleImageProvider } from "./src/generation/providers/google-image.js";
import { GoogleVertexImageProvider } from "./src/generation/providers/google-vertex-image.js";
import { OpenAIImageProvider } from "./src/generation/providers/openai-image.js";
import { ReplicateImageProvider } from "./src/generation/providers/replicate-image.js";
import { VolcesImageProvider } from "./src/generation/providers/volces-image.js";
import type { ImageModelInfo } from "./src/generation/types.js";

// Kept in sync by hand with SINGLE_IMAGE_INPUT_MODELS in replicate-image.ts.
// That set is a wire-format concern (input_image takes one string, not an array),
// so it is not derived from limits; this audit is what keeps the two from
// drifting apart.
const SINGLE_IMAGE_WIRE_MODELS = [
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
  "black-forest-labs/flux-1.1-pro",
  "black-forest-labs/flux-pro",
];

const KEY = "placeholder-not-used-for-listing";

const providers: Array<{ label: string; build: () => { name: string; models: readonly ImageModelInfo[] } }> = [
  { label: "GoogleImageProvider", build: () => new GoogleImageProvider(KEY) },
  { label: "GoogleVertexImageProvider", build: () => new GoogleVertexImageProvider({ project: "p", location: "global" }) },
  { label: "OpenAIImageProvider", build: () => new OpenAIImageProvider(KEY) },
  { label: "ReplicateImageProvider", build: () => new ReplicateImageProvider(KEY) },
  { label: "VolcesImageProvider", build: () => new VolcesImageProvider(KEY) },
];

const rows: Array<{ provider: string; model: ImageModelInfo }> = [];
const problems: string[] = [];

for (const { label, build } of providers) {
  try {
    const p = build();
    for (const m of p.models) rows.push({ provider: p.name, model: m });
  } catch (err) {
    problems.push(
      `${label} could not be constructed, its models are NOT audited: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

console.log(`image models declared by providers: ${rows.length}`);

// Coverage of the 17-entry Lovart toolbar, minus the client-side-only actions.
const byOperation = new Map<string, number>();
for (const { model } of rows) {
  byOperation.set(model.operation, (byOperation.get(model.operation) ?? 0) + 1);
}
console.log(
  `operations covered: ${[...byOperation.entries()].map(([op, n]) => `${op}=${n}`).join(", ")}`,
);
console.log("");

for (const { provider, model: m } of rows) {
  if (!m.limits) {
    problems.push(`${m.id}: missing limits`);
    continue;
  }
  if (!m.operation) {
    problems.push(`${m.id}: missing operation`);
    continue;
  }

  const max = m.limits.maxInputImages;
  if (max !== "unbounded" && (!Number.isInteger(max) || max < 0)) {
    problems.push(`${m.id}: maxInputImages is ${JSON.stringify(max)}`);
  }

  if (SINGLE_IMAGE_WIRE_MODELS.includes(m.id) && max !== 1) {
    problems.push(
      `${m.id}: uses the single-URL input_image parameter but declares ` +
        `maxInputImages=${JSON.stringify(max)} -- extra references would be dropped silently`,
    );
  }

  const ratios = m.limits.allowedAspectRatios;
  if (ratios) {
    if (!ratios.length) {
      problems.push(`${m.id}: allowedAspectRatios is empty (omit it instead)`);
    }
    for (const r of ratios) {
      if (!/^\d+:\d+$/.test(r)) problems.push(`${m.id}: malformed aspect ratio "${r}"`);
    }
  }

  const ratioNote = ratios ? ` ratios=[${ratios.join(",")}]` : "";
  console.log(
    `  ${m.id.padEnd(46)} [${provider.padEnd(14)}] ${m.operation.padEnd(10)}` +
      ` refs=${String(max).padEnd(10)} outputFormat=${String(m.limits.supportsOutputFormat).padEnd(5)}${ratioNote}`,
  );
}

const unbounded = rows.filter((r) => r.model.limits?.maxInputImages === "unbounded");
console.log("");
console.log(`NEEDS-REVIEW (reference cap never documented): ${unbounded.length}`);
for (const r of unbounded) console.log(`  - ${r.model.id}`);

console.log("");
console.log(`TOTAL PROBLEMS: ${problems.length}`);
for (const p of problems) console.log(`  ! ${p}`);

if (problems.length) process.exitCode = 1;
