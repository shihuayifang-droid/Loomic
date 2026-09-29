// Do background_jobs / asset_objects actually record generated artifacts?
//
// This decides whether "recover a generation independently of the canvas
// document" is a new feature (needs new tables) or just reading data the system
// already writes but never reads back. Very different amounts of work.
import { readFileSync } from "node:fs";

const CANVAS_ID = "57143771-08d2-4e60-8d50-98fdeeb273e5";
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

async function q(path, label) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await r.text();
    if (!r.ok) {
      console.log(`\n### ${label}: HTTP ${r.status} ${body.slice(0, 200)}`);
      return null;
    }
    const rows = JSON.parse(body);
    console.log(`\n### ${label}: ${rows.length} row(s)`);
    return rows;
  } catch (err) {
    console.log(`\n### ${label}: ${err.name} ${err.message}`);
    return null;
  }
}

const jobs = await q(
  `background_jobs?select=id,job_type,status,canvas_id,result,payload,created_at,credits_cost&order=created_at.desc&limit=8`,
  "background_jobs (latest 8, any canvas)",
);
for (const j of jobs ?? []) {
  const res = JSON.stringify(j.result ?? null);
  const pay = JSON.stringify(j.payload ?? null);
  console.log(`  ${j.created_at}  ${j.job_type}  ${j.status}  cost=${j.credits_cost}`);
  console.log(`    canvas_id=${j.canvas_id ? String(j.canvas_id).slice(0, 8) : "-"}`);
  console.log(`    payload = ${pay.length > 260 ? pay.slice(0, 260) + "...[trunc]" : pay}`);
  console.log(`    result  = ${res.length > 400 ? res.slice(0, 400) + "...[trunc]" : res}`);
}

const jobsForCanvas = await q(
  `background_jobs?canvas_id=eq.${CANVAS_ID}&select=id,job_type,status,created_at&order=created_at.desc&limit=20`,
  `background_jobs for the test canvas`,
);
for (const j of jobsForCanvas ?? []) {
  console.log(`  ${j.created_at}  ${j.job_type}  ${j.status}`);
}

const assets = await q(
  `asset_objects?select=id,bucket,object_path,mime_type,byte_size,project_id,created_at&order=created_at.desc&limit=10`,
  "asset_objects (latest 10)",
);
for (const a of assets ?? []) {
  console.log(
    `  ${a.created_at}  ${a.bucket}  ${a.byte_size}B  ${a.mime_type}  ${String(a.object_path).slice(0, 70)}`,
  );
}

console.log("\nTRUTH_END");
