// Survey the schema over REST (the pg pooler is unreliable behind the proxy).
//
// Goal: find out what is, and is not, a source of truth for a generated artifact.
// If the only record of a generated image lives inside canvases.content, then the
// artifact's existence depends on a canvas document write succeeding -- which is
// the architectural problem, not a missing feature.
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}
const headers = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};

// PostgREST exposes the schema at the root as an OpenAPI document.
const r = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
  headers,
  signal: AbortSignal.timeout(20_000),
});
if (!r.ok) {
  console.log(`schema fetch HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(0);
}
const spec = await r.json();
const tables = Object.keys(spec.definitions ?? {}).sort();
console.log(`tables (${tables.length}):`);
for (const t of tables) {
  const cols = Object.keys(spec.definitions[t].properties ?? {});
  console.log(`  ${t}`);
  console.log(`      ${cols.join(", ")}`);
}
console.log("SURVEY_END");
