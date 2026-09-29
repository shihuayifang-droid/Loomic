// Benchmark chat models for use as the Loomic agent model.
//
// Two passes, because mixing them made a single slow case poison the whole run:
//   PASS 1  tools + speed   (no image)  -- decides the shortlist
//   PASS 2  image input                 -- only for models that passed pass 1
//
// Pass 2 sends a real HTTP image URL, not a data URI. A 1x1 data URI made
// claude-opus-5 hang for 25s here even though the same model reads an image URL
// in ~5s, so a data-URI probe would have reported "no vision" for a model that
// clearly has it. runtime.ts now sends URLs anyway, so this matches production.
//
// Results append as each model finishes: buffering the run hides progress and
// loses everything when one model hangs.
//
// ASCII only: this file gets edited by shell one-liners on a GBK console.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\bench.txt";
const REQUEST_TIMEOUT_MS = 30_000;

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
const ASK_VISION = "Name the main subject of this image in one English word. Word only.";

const CANDIDATES = [
  "claude-opus-5", // current baseline
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gpt-5.4",
  "gpt-5.5",
  "grok-4-1-fast-non-reasoning",
  "qwen3.5-flash",
  "glm-5.2",
  "doubao-seed-2-1-turbo",
  "kimi-k3",
  "MiniMax-M2.7",
  "deepseek-v4-flash",
];

/** Newest public object in project-assets, as a URL any gateway can fetch. */
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err.name === "TimeoutError" ? "TIMEOUT" : err.message };
  }
  if (!res.ok) {
    const body = await res.text();
    return { status: res.status, error: body.slice(0, 150).replace(/\s+/g, " ") };
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

const pad = (s, n) => String(s).padEnd(n);
const BASE = env.OPENAI_API_BASE;
const KEY = env.OPENAI_API_KEY;

emit(`system prompt chars=${SYSTEM.length}`);
emit("\n=== PASS 1: function calling + speed (no image) ===");
emit(`${pad("model", 28)} ${pad("toolcall", 9)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);

const shortlist = [];
for (const model of CANDIDATES) {
  const r = await call(
    BASE,
    KEY,
    model,
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: ASK_TOOL },
    ],
    true,
  );
  if (r.status === 200 && !r.error) {
    emit(
      `${pad(model, 28)} ${pad(r.sawToolCall ? "YES" : "NO", 9)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`,
    );
    if (r.sawToolCall) shortlist.push({ model, ttft: r.ttft, total: r.total });
  } else {
    emit(
      `${pad(model, 28)} ${pad("-", 9)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`,
    );
  }
}

const imgUrl = await findPublicImageUrl();
emit(`\n=== PASS 2: image input (real URL) ===`);
if (!imgUrl) {
  emit("no public image object found, skipping");
} else {
  emit(`${pad("model", 28)} ${pad("image", 6)} ${pad("TTFT", 7)} ${pad("total", 7)} note`);
  for (const { model } of shortlist) {
    const r = await call(
      BASE,
      KEY,
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
    if (r.status === 200 && !r.error) {
      emit(`${pad(model, 28)} ${pad("YES", 6)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`);
    } else {
      emit(`${pad(model, 28)} ${pad("NO", 6)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`);
    }
  }
}

if (env.DEEPSEEK_API_KEY) {
  emit("\n=== deepseek direct ===");
  for (const model of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const r = await call(
      env.DEEPSEEK_API_BASE || "https://api.deepseek.com/v1",
      env.DEEPSEEK_API_KEY,
      model,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: ASK_TOOL },
      ],
      true,
    );
    emit(
      r.status === 200 && !r.error
        ? `${pad(model, 28)} ${pad(r.sawToolCall ? "YES" : "NO", 9)} ${pad(r.ttft ?? "-", 7)} ${pad(r.total, 7)}`
        : `${pad(model, 28)} ${pad("-", 9)} ${pad("-", 7)} ${pad("-", 7)} ${r.error ?? r.status}`,
    );
  }
} else {
  emit("\n=== deepseek direct: SKIPPED (DEEPSEEK_API_KEY empty in .env.local) ===");
}

emit("\nDONE");
