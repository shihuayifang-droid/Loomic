// Benchmark DeepSeek's OFFICIAL API (not via kwjm).
//
// The kwjm-routed DeepSeek measured 12.4s, slower than claude-opus-5. The claim
// is that the direct API is much faster, so this compares like for like: same
// system prompt, same tool schemas, same image URL, same TTFT definition.
//
// Also lists the account's real model ids first — guessing names wastes a whole
// run on 404s.
//
// ASCII only: this file gets edited by shell one-liners on a GBK console.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\dsbench.txt";
const TIMEOUT_MS = 30_000;

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

const BASE = env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1";
const KEY = env.DEEPSEEK_API_KEY;
if (!KEY) {
  emit("DEEPSEEK_API_KEY is empty in .env.local — nothing to test.");
  process.exit(0);
}
emit(`base=${BASE}  key_len=${KEY.length}`);

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
const ASK_VISION = "Name the main subject of this image in one English word. Word only.";

async function findPublicImageUrl() {
  const pool = new pg.Pool({
    connectionString: env.SUPABASE_DB_URL,
    max: 1,
    connectionTimeoutMillis: 15_000,
  });
  try {
    const r = await pool.query(
      `select name from storage.objects
        where bucket_id = 'project-assets' and name ~* '\\.(png|jpg|jpeg|webp)$'
        order by created_at desc limit 1`,
    );
    if (r.rows.length === 0) return null;
    const path = r.rows[0].name.split("/").map(encodeURIComponent).join("/");
    return `${env.SUPABASE_URL}/storage/v1/object/public/project-assets/${path}`;
  } finally {
    await pool.end();
  }
}

async function call(model, messages, useTools) {
  const t0 = Date.now();
  let ttft = null;
  let sawToolCall = false;
  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
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
  } catch (err) {
    return { status: 200, ttft, total: Date.now() - t0, sawToolCall, error: "stream cut" };
  }
  return { status: 200, ttft, total: Date.now() - t0, sawToolCall };
}

// --- what models does this key actually have? ---
try {
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  const ids = (j.data ?? []).map((m) => m.id);
  emit(`\nmodels reported by API (${ids.length}): ${ids.join(", ") || JSON.stringify(j).slice(0, 200)}`);
} catch (err) {
  emit(`\nmodel list failed: ${err.message}`);
}

const CANDIDATES = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

const pad = (s, n) => String(s).padEnd(n);

emit("\n=== PASS 1: function calling + speed (no image) ===");
emit(`${pad("model", 30)} ${pad("toolcall", 9)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);
const ok = [];
for (const model of CANDIDATES) {
  const r = await call(
    model,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: ASK_TOOL },
    ],
    true,
  );
  if (r.status === 200 && !r.error) {
    emit(
      `${pad(model, 30)} ${pad(r.sawToolCall ? "YES" : "NO", 9)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`,
    );
    ok.push(model);
  } else {
    emit(`${pad(model, 30)} ${pad("-", 9)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`);
  }
}

const imgUrl = await findPublicImageUrl();
emit("\n=== PASS 2: image input (real URL) ===");
if (!imgUrl) {
  emit("no public image object found, skipping");
} else {
  emit(`${pad("model", 30)} ${pad("image", 6)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);
  for (const model of ok) {
    const r = await call(
      model,
      [
        {
          role: "user",
          content: [
            { type: "text", text: ASK_VISION },
            { type: "image_url", image_url: { url: imgUrl } },
          ],
        },
      ],
      false,
    );
    emit(
      r.status === 200 && !r.error
        ? `${pad(model, 30)} ${pad("YES", 6)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`
        : `${pad(model, 30)} ${pad("NO", 6)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`,
    );
  }
}

emit("\nDONE");
