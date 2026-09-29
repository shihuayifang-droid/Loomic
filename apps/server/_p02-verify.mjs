// P0-2 verification: a failure after the deduction must refund.
//
// Trick that makes this cheap and repeatable: pass a model id that is NOT in the
// provider registry. The ordering in the route is
//
//   checkModelAccess -> checkResolution -> checkConcurrency
//   -> calculateCreditCost -> deductCredits -> resolveImageProviderName -> generate
//
// An unregistered id passes the guards (unlisted models default to min tier
// "pro", and to {standard:5, hd:10, ultra:20} for cost), gets charged, and then
// throws "No provider registered" -- landing exactly in the window this fix
// covers. No external provider is called, so nothing is really spent: a correct
// implementation nets zero.
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const SERVER = "http://127.0.0.1:3001";
const EMAIL = "ultra@test.loomic.com";
const PASSWORD = env.LOOMIC_TEST_PASSWORD ?? "opensourceloomic";

// 1. Get a real user token (the browser session is stale; this is independent).
const authRes = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: {
    apikey: env.SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  signal: AbortSignal.timeout(20_000),
});
if (!authRes.ok) {
  console.log(`auth failed HTTP ${authRes.status}: ${(await authRes.text()).slice(0, 200)}`);
  process.exit(1);
}
const { access_token: token } = await authRes.json();
console.log(`got token, len=${token.length}`);

const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function balance() {
  const r = await fetch(`${SERVER}/api/credits`, { headers: authed });
  if (!r.ok) throw new Error(`GET /api/credits -> ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return j.balance ?? j.credits?.balance ?? JSON.stringify(j);
}

const before = await balance();
console.log(`balance before          = ${before}`);

const t0 = Date.now();
const genRes = await fetch(`${SERVER}/api/agent/generate-image`, {
  method: "POST",
  headers: authed,
  body: JSON.stringify({
    prompt: "p0-2 refund verification, should never reach a provider",
    model: "nonexistent-provider/fake-model-p02-verify",
    quality: "hd",
  }),
  signal: AbortSignal.timeout(60_000),
});
const body = await genRes.text();
console.log(`POST generate-image     = HTTP ${genRes.status} in ${Date.now() - t0}ms`);
console.log(`  body: ${body.slice(0, 220)}`);

// Refund is awaited inside the catch before the reply is sent, so the balance is
// already settled by the time we get here. Small delay purely for safety.
await new Promise((r) => setTimeout(r, 800));

const after = await balance();
console.log(`balance after           = ${after}`);

const delta = Number(after) - Number(before);
console.log(`delta                   = ${delta}`);
console.log(
  delta === 0
    ? "\nPASS — credits were deducted and refunded (net zero)"
    : `\nFAIL — user is out ${-delta} credits with nothing delivered`,
);
process.exit(delta === 0 ? 0 : 1);
