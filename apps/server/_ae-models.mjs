// List the Aether gateway's model ids. Separate from the benchmark on purpose:
// the benchmark caps how many models it will hit, and that cap has to be chosen
// after seeing how long the list actually is.
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\aemodels.txt";
const lines = [];
const emit = (s) => {
  console.log(s);
  lines.push(s);
};

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const BASE = env.AETHER_API_BASE || "http://10.210.134.15:18085/v1";
const KEY = env.AETHER_API_KEY || "";
emit(`base=${BASE}`);
emit(`key_len=${KEY.length}  key_prefix=${KEY.slice(0, 6)}`);

if (!KEY) {
  emit("AETHER_API_KEY still empty.");
  writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf8");
  process.exit(0);
}

try {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await r.text();
  emit(`GET /models -> HTTP ${r.status} in ${Date.now() - t0}ms, ${raw.length} bytes`);
  if (!r.ok) {
    emit(`body: ${raw.slice(0, 600)}`);
  } else {
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      emit(`not JSON. first 600 bytes: ${raw.slice(0, 600)}`);
      writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf8");
      process.exit(0);
    }
    const data = j.data ?? [];
    emit(`count=${data.length}`);
    for (const m of data) emit(`  ${m.id}`);
    if (data.length === 0) emit(`raw: ${raw.slice(0, 600)}`);
  }
} catch (err) {
  emit(`failed: ${err.name} ${err.message}`);
}

writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf8");
