// Confirm the canvas row is intact WITHOUT depending on either
//   (a) the browser's session token -- the session is from yesterday, so a 401
//       there says nothing about the data, or
//   (b) the pg pooler on :5432 -- which is currently failing behind the proxy.
//
// Uses the service key over REST/:443 instead. Retries, because the whole point
// of this investigation is that single attempts through the proxy are unreliable.
import { readFileSync } from "node:fs";

const CANVAS_ID = process.argv[2] ?? "57143771-08d2-4e60-8d50-98fdeeb273e5";
const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const url =
  `${env.SUPABASE_URL}/rest/v1/canvases?id=eq.${CANVAS_ID}&select=id,updated_at,content`;
// New-style sb_secret_ keys need BOTH headers; apikey alone returns 403.
const headers = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
};

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    const t0 = Date.now();
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const ms = Date.now() - t0;
    if (!r.ok) {
      console.log(`attempt ${attempt}: HTTP ${r.status} in ${ms}ms :: ${(await r.text()).slice(0, 200)}`);
    } else {
      const rows = await r.json();
      if (rows.length === 0) {
        console.log(`attempt ${attempt}: OK in ${ms}ms but ROW NOT FOUND`);
        break;
      }
      const row = rows[0];
      const c = row.content ?? {};
      const els = Array.isArray(c.elements) ? c.elements : [];
      const files = c.files && typeof c.files === "object" ? c.files : {};
      console.log(`attempt ${attempt}: OK in ${ms}ms`);
      console.log(`  updated_at ${row.updated_at}`);
      console.log(`  elements   ${els.length}`);
      console.log(`  files      ${Object.keys(files).length}`);
      for (const e of els) {
        console.log(
          `    type=${e.type} id=${String(e.id).slice(0, 20)} fileId=${e.fileId ? String(e.fileId).slice(0, 16) : "-"}`,
        );
      }
      for (const [fid, f] of Object.entries(files)) {
        const u = typeof f?.dataURL === "string" ? f.dataURL : "";
        const kind = u.startsWith("data:")
          ? `INLINE ${u.length}B`
          : u.startsWith("oss://")
            ? "oss:// pointer"
            : u.slice(0, 40);
        console.log(`    file ${fid.slice(0, 16)} ${kind}`);
      }
      const leftovers = els.filter((e) => String(e.id).startsWith("kiro-test"));
      console.log(`  leftover test elements: ${leftovers.length}`);
      break;
    }
  } catch (err) {
    console.log(`attempt ${attempt}: ${err.name} ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
console.log("CHECK_END");
