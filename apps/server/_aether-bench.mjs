// Benchmark the internal Aether gateway (10.210.134.15:18085) against kwjm.
//
// Deliberately keeps SYSTEM / TOOLS / ASK_* byte-identical to _deepseek-bench.mjs
// so the numbers drop straight into the same comparison table.
//
// Two things this does that a naive script would not:
//  1. Lists the real model ids first. Aether's ids are unknown, and guessing
//     names burns a 30s timeout per miss.
//  2. Re-measures kwjm in the SAME run. Comparing today's Aether number against
//     yesterday's kwjm number would fold in whatever the network was doing then.
//
// Prompt strings contain Chinese on purpose (that is the real workload). Edit
// this file with a real editor, never with Set-Content on a GBK console.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\aebench.txt";
const TIMEOUT_MS = 40_000;
const MAX_MODELS = 16; // guard: a LAN gateway can expose dozens

function emit(line) {
  console.log(line);
  appendFileSync(OUT, line + "\r\n", "utf8");
}
writeFileSync(OUT, "", "utf8");

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const AE_BASE = env.AETHER_API_BASE || "http://10.210.134.15:18085/v1";
const AE_KEY = env.AETHER_API_KEY;
const KW_BASE = env.OPENAI_API_BASE;
const KW_KEY = env.OPENAI_API_KEY;

if (!AE_KEY) {
  emit("AETHER_API_KEY is empty in .env.local -- fill it in, then re-run.");
  process.exit(0);
}
emit(`aether base=${AE_BASE}  key_len=${AE_KEY.length}`);
emit(`kwjm   base=${KW_BASE}  key_len=${KW_KEY ? KW_KEY.length : 0}`);

const promptSrc = readFileSync(
  new URL("./src/agent/prompts/loomic-main.ts", import.meta.url),
  "utf8",
);
const SYSTEM = promptSrc.slice(promptSrc.indexOf("`") + 1, promptSrc.lastIndexOf("`"));
emit(`system prompt chars=${SYSTEM.length}`);

const TOOLS = [
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate an image and place it on the canvas. Use for any visual output request.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image prompt in English" },
          title: { type: "string", description: "Short Chinese label" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_canvas",
      description: "Read precise properties of canvas elements.",
      parameters: { type: "object", properties: { elementId: { type: "string" } } },
    },
  },
];

const ASK_TOOL = "生成一个苹果。必须调用 generate_image 工具，不要只用文字回答。";

async function call(base, key, model, messages, useTools) {
  const t0 = Date.now();
  let ttft = null;
  let sawToolCall = false;
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        stream: true,
        messages,
        ...(useTools ? { tools: TOOLS } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err.name === "TimeoutError" ? "TIMEOUT" : err.message };
  }
  if (!res.ok) {
    const body = await res.text();
    return { status: res.status, error: body.slice(0, 170).replace(/\s+/g, " ") };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (ttft === null && (text.includes('"content"') || text.includes('"tool_calls"'))) {
        ttft = Date.now() - t0;
      }
      if (text.includes('"tool_calls"')) sawToolCall = true;
    }
  } catch {
    return { status: 200, ttft, total: Date.now() - t0, sawToolCall, error: "stream cut" };
  }
  return { status: 200, ttft, total: Date.now() - t0, sawToolCall };
}

// --- PASS 0: what does this key actually expose? ---
let ids = [];
try {
  const r = await fetch(`${AE_BASE}/models`, {
    headers: { Authorization: `Bearer ${AE_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await r.text();
  if (!r.ok) {
    emit(`\nmodel list -> HTTP ${r.status}: ${raw.slice(0, 300).replace(/\s+/g, " ")}`);
  } else {
    const j = JSON.parse(raw);
    ids = (j.data ?? []).map((m) => m.id);
    emit(`\nmodels reported (${ids.length}):`);
    for (const id of ids) emit(`  ${id}`);
    if (ids.length === 0) emit(`  raw: ${raw.slice(0, 300)}`);
  }
} catch (err) {
  emit(`\nmodel list failed: ${err.message}`);
}

if (ids.length === 0) {
  emit("\nNo model ids -> cannot benchmark. Check the key or ask for the model list.");
  process.exit(0);
}

const targets = ids.slice(0, MAX_MODELS);
if (ids.length > MAX_MODELS) {
  emit(`\n(capped at first ${MAX_MODELS} of ${ids.length})`);
}

const pad = (s, n) => String(s).padEnd(n);
const msgs = [
  { role: "system", content: SYSTEM },
  { role: "user", content: ASK_TOOL },
];

emit("\n=== AETHER: function calling + speed ===");
emit(`${pad("model", 38)} ${pad("toolcall", 9)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);
const results = [];
for (const model of targets) {
  const r = await call(AE_BASE, AE_KEY, model, msgs, true);
  if (r.status === 200 && !r.error) {
    emit(
      `${pad(model, 38)} ${pad(r.sawToolCall ? "YES" : "NO", 9)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`,
    );
    results.push({ model, ...r });
  } else {
    emit(`${pad(model, 38)} ${pad("-", 9)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`);
  }
}

// --- kwjm control, measured right now, same prompt ---
emit("\n=== KWJM control (same run, same prompt) ===");
if (!KW_KEY || !KW_BASE) {
  emit("no OPENAI_API_BASE/KEY -- skipping control");
} else {
  emit(`${pad("model", 38)} ${pad("toolcall", 9)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);
  for (const model of ["claude-opus-5", "glm-5.2"]) {
    const r = await call(KW_BASE, KW_KEY, model, msgs, true);
    emit(
      r.status === 200 && !r.error
        ? `${pad(model, 38)} ${pad(r.sawToolCall ? "YES" : "NO", 9)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`
        : `${pad(model, 38)} ${pad("-", 9)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`,
    );
  }
}

const usable = results.filter((r) => r.sawToolCall).sort((a, b) => a.total - b.total);
emit("\n=== Ranked (Aether, tool-calling only) ===");
for (const r of usable) emit(`  ${pad(r.model, 38)} TTFT ${pad(r.ttft, 7)} total ${r.total}`);
if (usable.length === 0) emit("  none of the Aether models emitted a tool call");

emit("\nDONE");
