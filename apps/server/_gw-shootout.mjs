// Three-gateway shootout with repeated sampling.
//
// Why this exists: the single-sample run measured kwjm's claude-opus-5 at
// 3577ms total, while an earlier run of the same model on the same gateway
// measured 6475ms. That spread is larger than the gaps between models, so a
// one-shot ranking is not trustworthy. This runs N rounds and reports the
// median, plus min/max so the spread is visible rather than hidden.
//
// Interleaves providers within each round instead of finishing one provider
// before starting the next -- otherwise a slow patch of network time lands
// entirely on whichever provider happened to be tested during it.
//
// Prompt strings are byte-identical to _aether-bench.mjs / _deepseek-bench.mjs.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\shootout.txt";
const TIMEOUT_MS = 40_000;
const ROUNDS = 3;

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

const GW = {
  aether: { base: env.AETHER_API_BASE, key: env.AETHER_API_KEY },
  kwjm: { base: env.OPENAI_API_BASE, key: env.OPENAI_API_KEY },
  deepseek: { base: env.DEEPSEEK_API_BASE, key: env.DEEPSEEK_API_KEY },
};

// gateway + model pairs. claude-opus-5 appears on two gateways on purpose:
// it is the only way to separate "this gateway is slow" from "this model is slow".
const ALL_TARGETS = [
  ["aether", "claude-haiku-4.5"],
  ["aether", "claude-opus-4.8"],
  ["aether", "claude-sonnet-5"],
  ["aether", "gpt-5.6-sol"],
  ["aether", "gpt-5.6-terra"],
  ["aether", "gpt-5.6-luna"],
  ["aether", "claude-opus-5"],
  ["kwjm", "claude-opus-5"],
  ["kwjm", "glm-5.2"],
  ["deepseek", "deepseek-chat"],
];

// Optional argv filter, so a subset can be topped up without re-running the
// whole matrix: `node _gw-shootout.mjs claude-opus-4.8 claude-sonnet-5`
const filters = process.argv.slice(2);
const TARGETS =
  filters.length === 0
    ? ALL_TARGETS
    : ALL_TARGETS.filter(([, m]) => filters.some((f) => m === f));
if (TARGETS.length === 0) {
  emit(`no target matched ${JSON.stringify(filters)}`);
  process.exit(0);
}

const promptSrc = readFileSync(
  new URL("./src/agent/prompts/loomic-main.ts", import.meta.url),
  "utf8",
);
const SYSTEM = promptSrc.slice(promptSrc.indexOf("`") + 1, promptSrc.lastIndexOf("`"));

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
const msgs = [
  { role: "system", content: SYSTEM },
  { role: "user", content: ASK_TOOL },
];

async function call(gw, model) {
  const cfg = GW[gw];
  if (!cfg || !cfg.base || !cfg.key) return { error: "no config" };
  const t0 = Date.now();
  let ttft = null;
  let sawToolCall = false;
  let res;
  try {
    res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 200, stream: true, messages: msgs, tools: TOOLS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err.name === "TimeoutError" ? "TIMEOUT" : err.message };
  }
  if (!res.ok) {
    const body = await res.text();
    return { error: `HTTP ${res.status} ${body.slice(0, 90).replace(/\s+/g, " ")}` };
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
    return { error: "stream cut", ttft, total: Date.now() - t0 };
  }
  return { ttft, total: Date.now() - t0, sawToolCall };
}

const samples = new Map(); // "gw|model" -> [{ttft,total,sawToolCall}]
for (const [gw, model] of TARGETS) samples.set(`${gw}|${model}`, []);

for (let round = 1; round <= ROUNDS; round++) {
  emit(`--- round ${round}/${ROUNDS} ---`);
  for (const [gw, model] of TARGETS) {
    const r = await call(gw, model);
    const key = `${gw}|${model}`;
    if (r.error && r.total === undefined) {
      emit(`  ${gw}/${model}: ERR ${r.error}`);
    } else {
      samples.get(key).push(r);
      emit(`  ${gw}/${model}: ttft=${r.ttft ?? "-"} total=${r.total} tool=${r.sawToolCall ? "Y" : "N"}`);
    }
  }
}

const median = (arr) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pad = (s, n) => String(s).padEnd(n);

const rows = [];
for (const [key, arr] of samples) {
  if (arr.length === 0) continue;
  const [gw, model] = key.split("|");
  const totals = arr.map((r) => r.total);
  const ttfts = arr.map((r) => r.ttft).filter((v) => v !== null);
  rows.push({
    gw,
    model,
    n: arr.length,
    medTotal: median(totals),
    medTtft: median(ttfts),
    minTotal: Math.min(...totals),
    maxTotal: Math.max(...totals),
    allTool: arr.every((r) => r.sawToolCall),
  });
}
rows.sort((a, b) => a.medTotal - b.medTotal);

emit(`\n=== RANKED by median total over ${ROUNDS} rounds (fastest first) ===`);
emit(
  `${pad("#", 3)} ${pad("gateway", 9)} ${pad("model", 20)} ${pad("med TTFT", 9)} ${pad("med total", 10)} ${pad("spread", 15)} tool`,
);
rows.forEach((r, i) => {
  emit(
    `${pad(i + 1, 3)} ${pad(r.gw, 9)} ${pad(r.model, 20)} ${pad(r.medTtft ?? "-", 9)} ${pad(r.medTotal, 10)} ${pad(`${r.minTotal}-${r.maxTotal}`, 15)} ${r.allTool ? "YES" : "NO!"}`,
  );
});

// same model, two gateways -> isolates gateway overhead from model speed
const a = rows.find((r) => r.gw === "aether" && r.model === "claude-opus-5");
const k = rows.find((r) => r.gw === "kwjm" && r.model === "claude-opus-5");
if (a && k) {
  emit(`\n=== claude-opus-5, same model on both gateways ===`);
  emit(`  aether: TTFT ${a.medTtft}  total ${a.medTotal}  (${a.minTotal}-${a.maxTotal})`);
  emit(`  kwjm  : TTFT ${k.medTtft}  total ${k.medTotal}  (${k.minTotal}-${k.maxTotal})`);
  emit(
    `  delta : TTFT ${a.medTtft - k.medTtft >= 0 ? "+" : ""}${a.medTtft - k.medTtft}ms  total ${a.medTotal - k.medTotal >= 0 ? "+" : ""}${a.medTotal - k.medTotal}ms  (positive = aether slower)`,
  );
}

emit("\nDONE");
