// P0-1 invariants: for every image the pipeline claims to have produced, is the
// whole chain actually intact?
//
//   background_jobs.result.object_path
//     -> content.files[fileId].dataURL == "oss://<bucket>/<path>"
//       -> some non-deleted element references that fileId
//         -> the object really exists in Storage
//
// WHY THESE AND NOT "did the image appear"
//   A run can look successful in the browser and still be broken at rest: the
//   element can exist with no file record (broken tile after reload), the file
//   record can exist with no element (invisible but paid for), or the marker can
//   point at an object that was never uploaded. Each of those has happened here.
//   So this asserts the JOINS, not the happy path.
//
// Deliberately NOT asserted: how many images there are. That number changes every
// time anyone uses the canvas, and an assertion you have to edit to keep green is
// not an assertion.
//
// Run:
//   node --env-file=../../.env.local --import tsx _p01-verify.ts [canvasId]
import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const CANVAS_ID = process.argv[2] ?? "57143771-08d2-4e60-8d50-98fdeeb273e5";

// Reads .env.local directly rather than relying on `node --env-file`, matching the
// other retained scripts. Run under plain `npx tsx` and it silently found no env,
// printed nothing, and looked like a pass — a verification script that can no-op
// quietly is worse than none.
function loadEnv(): Record<string, string> {
  const text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}
const env = { ...loadEnv(), ...process.env } as Record<string, string>;

const url = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = env.SUPABASE_DB_URL;
if (!url || !serviceKey || !dbUrl) {
  console.log("SCRIPT ERROR: supabase env missing (SUPABASE_URL/SERVICE_ROLE_KEY/DB_URL)");
  console.log("TOTAL FAILURES: -1");
  process.exit(1);
}

const failures: string[] = [];
const fail = (s: string) => {
  failures.push(s);
  console.log(`  FAIL ${s}`);
};
const ok = (s: string) => console.log(`  ok   ${s}`);

const pool = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 20_000 });
const storage = createClient(url, serviceKey).storage;

try {
  const canvas = await pool.query(
    "select content, version from canvases where id = $1",
    [CANVAS_ID],
  );
  if (canvas.rows.length === 0) throw new Error(`canvas ${CANVAS_ID} not found`);
  const content = canvas.rows[0].content ?? {};
  const elements: any[] = Array.isArray(content.elements) ? content.elements : [];
  const files: Record<string, any> = content.files ?? {};
  const live = elements.filter((e) => e.isDeleted !== true);
  console.log(
    `canvas ${CANVAS_ID} version=${canvas.rows[0].version} ` +
      `elements=${elements.length} live=${live.length} files=${Object.keys(files).length}`,
  );

  // --- A. element <-> file, both directions ------------------------------------
  console.log("\nA. element/file join");
  const referenced = new Set(live.map((e) => e.fileId).filter(Boolean));
  for (const e of live) {
    if (e.type !== "image") continue;
    if (!e.fileId) {
      fail(`image element ${e.id} has no fileId — renders as a broken tile`);
      continue;
    }
    if (!files[e.fileId]) {
      fail(`element ${e.id} references missing file ${e.fileId}`);
    }
  }
  const orphans = Object.keys(files).filter((f) => !referenced.has(f));
  if (orphans.length > 0) {
    // Not fatal by itself, but it is exactly the shape of a paid-for image the
    // user cannot see, so it must be reported rather than tolerated silently.
    fail(`${orphans.length} file record(s) unreferenced by any live element: ${orphans.join(", ")}`);
  } else {
    ok(`every file record is referenced; every image element resolves (${live.length} live)`);
  }

  // --- B. marker format + storage object really exists -------------------------
  console.log("\nB. oss:// marker resolves to a real object");
  for (const [fid, f] of Object.entries(files)) {
    const dataURL = typeof f?.dataURL === "string" ? f.dataURL : "";
    if (!dataURL.startsWith("oss://")) {
      // Inline base64 is legal but means extractFilesToStorage did not run, which
      // is how canvases used to grow to multi-MB and time out on save.
      fail(`file ${fid} is not an oss:// marker (${dataURL.slice(0, 30)}...)`);
      continue;
    }
    const ref = dataURL.slice("oss://".length);
    const slash = ref.indexOf("/");
    if (slash <= 0) {
      fail(`file ${fid} marker has no bucket/path split: ${dataURL.slice(0, 40)}`);
      continue;
    }
    const bucket = ref.slice(0, slash);
    const path = ref.slice(slash + 1);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { data, error } = await storage.from(bucket).list(dir, { search: name });
    if (error) {
      fail(`file ${fid} storage list failed for ${bucket}/${path}: ${error.message}`);
    } else if (!data?.some((o) => o.name === name)) {
      fail(`file ${fid} marker points at a MISSING object: ${bucket}/${path}`);
    } else {
      ok(`${fid} -> ${bucket}/${path}`);
    }
  }

  // --- C. every succeeded image job landed on the canvas ----------------------
  // This is the direction that catches "we charged the user and lost the result".
  console.log("\nC. succeeded image jobs are all present on the canvas");
  const jobs = await pool.query(
    `select id, result, created_at
       from background_jobs
      where job_type = 'image_generation'
        and status = 'succeeded'
        and canvas_id = $1
      order by created_at desc
      limit 25`,
    [CANVAS_ID],
  );
  const markers = new Set(
    Object.values(files)
      .map((f: any) => (typeof f?.dataURL === "string" ? f.dataURL : ""))
      .filter((u) => u.startsWith("oss://")),
  );
  let checked = 0;
  for (const row of jobs.rows) {
    const objectPath = row.result?.object_path;
    if (!objectPath) continue; // nothing to join on; not this script's business
    checked++;
    const hit = [...markers].some((m) => m.endsWith(objectPath));
    if (hit) ok(`job ${String(row.id).slice(0, 8)} -> on canvas`);
    else
      fail(
        `job ${String(row.id).slice(0, 8)} succeeded (${objectPath}) but NOTHING on ` +
          `the canvas points at it — recoverable via /recoverable`,
      );
  }
  if (checked === 0) console.log("  (no succeeded jobs with object_path for this canvas)");

  console.log(`\nTOTAL FAILURES: ${failures.length}`);
} catch (err) {
  console.log(`SCRIPT ERROR: ${(err as Error).message}`);
  console.log("TOTAL FAILURES: -1");
} finally {
  await pool.end();
}
