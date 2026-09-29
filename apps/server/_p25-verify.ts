/**
 * P2.5 verification: does the recovery layer find exactly the images that are
 * missing from a canvas, and nothing else?
 *
 * Calls the REAL canvas-recovery module against the REAL database. No provider
 * calls, no credits.
 *
 * Two halves:
 *   A. Read-only, against the canvas that actually lost images. Documents the
 *      loss and proves the survivor is NOT offered for recovery.
 *   B. A scratch canvas with synthetic succeeded jobs, so each discrimination
 *      rule can be checked in isolation — including the cases that must report
 *      NOTHING. Without those, "everything is recoverable" would pass too.
 *
 * Run: npx tsx _p25-verify.ts
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import {
  listRecoverableArtifacts,
  recoverArtifacts,
} from "./src/features/canvas/canvas-recovery.js";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env: Record<string, string> = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const problems: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) problems.push(label);
};

const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
}) as any;

const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await db.connect();

// ---------------------------------------------------------------------------
// A. The canvas that really lost images (read-only)
// ---------------------------------------------------------------------------
const REAL_CANVAS = "57143771-08d2-4e60-8d50-98fdeeb273e5";
console.log(`A. real canvas ${REAL_CANVAS} (read-only)`);

// Assertions here are INVARIANTS, not counts. This canvas had two images missing
// when P2.5 was built; restoring them was the point, so any assertion on "how
// many are missing" would have to be edited every time the canvas is used — and
// an assertion you edit to make it pass is not an assertion. The discrimination
// (does it find the missing ones, does it ignore the present ones) is covered in
// part B, where the fixture is built and torn down here.
const realJobs = await db.query(
  `select id from public.background_jobs
    where canvas_id = $1 and status = 'succeeded' and job_type = 'image_generation'
    order by created_at`,
  [REAL_CANVAS],
);
const realFound = await listRecoverableArtifacts(supabase, REAL_CANVAS);
const realIds = realFound.map((a) => a.jobId);
const succeededIds = new Set(realJobs.rows.map((r) => r.id));

console.log(
  `  (${realFound.length} recoverable of ${realJobs.rows.length} succeeded right now)`,
);
check(
  "only ever offers jobs that actually succeeded on this canvas",
  realIds.every((id) => succeededIds.has(id)),
);
check(
  "never offers the same stored file twice",
  new Set(realFound.map((a) => a.objectPath)).size === realFound.length,
);
check(
  "every artifact carries the fields needed to rebuild the element",
  realFound.every(
    (a) => a.objectPath && a.width > 0 && a.height > 0 && a.mimeType && a.createdAt,
  ),
);
check(
  "every artifact carries a preview so the user can look before restoring",
  realFound.every((a) => !!a.previewUrl),
);
for (const a of realFound) {
  console.log(
    `       -> ${a.jobId.slice(0, 8)} ${a.width}x${a.height} ` +
      `prompt=${a.prompt ? JSON.stringify(a.prompt.slice(0, 40)) : "-"}`,
  );
}

// ---------------------------------------------------------------------------
// B. Scratch canvas: one rule per case, created and removed here
// ---------------------------------------------------------------------------
console.log(`\nB. scratch canvas (synthetic jobs)`);

// Borrow real ids so foreign keys are satisfied. project_id comes from canvases
// (NOT NULL there) rather than background_jobs, where it is often null.
const seed = await db.query(
  `select c.project_id, j.workspace_id, j.created_by
     from public.canvases c
     join public.background_jobs j on j.canvas_id = c.id
    where j.workspace_id is not null and j.created_by is not null
    limit 1`,
);
if (!seed.rows.length) {
  console.log("no canvas/job pair to borrow ids from; cannot build the scratch case");
  await db.end();
  process.exit(1);
}
const { project_id, workspace_id, created_by } = seed.rows[0];

const PATHS = {
  a: `${workspace_id}/generated/p25-verify-a.png`,
  b: `${workspace_id}/generated/p25-verify-b.png`,
  c: `${workspace_id}/generated/p25-verify-c.png`,
  wrongBucket: `${workspace_id}/generated/p25-verify-wrong-bucket.png`,
};

const marker = (path: string) => `oss://project-assets/${path}`;
const imageElement = (id: string, fileId: string, isDeleted = false) => ({
  id,
  type: "image",
  fileId,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...(isDeleted ? { isDeleted: true } : {}),
});
const fileRecord = (fileId: string, path: string) => ({
  id: fileId,
  dataURL: marker(path),
  mimeType: "image/png",
  created: Date.now(),
});

let canvasId = "";
// Fixed key set, so reads below are plain strings rather than possibly-undefined
// index lookups.
const jobIds = {} as Record<keyof typeof PATHS, string>;

async function setContent(content: unknown) {
  await db.query("update public.canvases set content = $1::jsonb where id = $2", [
    JSON.stringify(content),
    canvasId,
  ]);
}

try {
  const createdCanvas = await db.query(
    `insert into public.canvases (project_id, name, content, created_by)
     values ($1, $2, '{"elements":[],"appState":{},"files":{}}'::jsonb, $3)
     returning id`,
    [project_id, "_p25-verify scratch", created_by],
  );
  canvasId = createdCanvas.rows[0].id;

  const publicUrl = (bucket: string, path: string) =>
    `https://example.test/storage/v1/object/public/${bucket}/${path}`;

  for (const [key, path] of Object.entries(PATHS)) {
    const bucket = key === "wrongBucket" ? "some-other-bucket" : "project-assets";
    const row = await db.query(
      `insert into public.background_jobs
         (workspace_id, project_id, canvas_id, queue_name, job_type, status,
          payload, result, created_by, started_at, completed_at)
       values ($1,$2,$3,'default','image_generation','succeeded',$4::jsonb,$5::jsonb,$6, now(), now())
       returning id`,
      [
        workspace_id,
        project_id,
        canvasId,
        JSON.stringify({ prompt: `p25 verify ${key}` }),
        JSON.stringify({
          object_path: path,
          width: 1024,
          height: 1024,
          mime_type: "image/png",
          signed_url: publicUrl(bucket, path),
        }),
        created_by,
      ],
    );
    jobIds[key as keyof typeof PATHS] = row.rows[0].id;
  }

  // B1 — empty canvas: everything usable is missing.
  await setContent({ elements: [], appState: {}, files: {} });
  let found = await listRecoverableArtifacts(supabase, canvasId);
  check(
    "empty canvas offers every usable artifact",
    found.length === 3,
    `${found.length} (expected 3 of 4 jobs; the 4th is in another bucket)`,
  );
  check(
    "the artifact stored outside the canvas bucket is refused, not restored broken",
    !found.some((a) => a.jobId === jobIds.wrongBucket),
  );

  // B2 — CONTROL GROUP: all three referenced. Must report nothing. This is what
  // fails if the check degenerates into "list all succeeded jobs".
  await setContent({
    elements: [
      imageElement("el-a", "f-a"),
      imageElement("el-b", "f-b"),
      imageElement("el-c", "f-c"),
    ],
    appState: {},
    files: {
      "f-a": fileRecord("f-a", PATHS.a),
      "f-b": fileRecord("f-b", PATHS.b),
      "f-c": fileRecord("f-c", PATHS.c),
    },
  });
  found = await listRecoverableArtifacts(supabase, canvasId);
  check(
    "CONTROL: nothing is offered when the canvas already shows everything",
    found.length === 0,
    `${found.length}`,
  );

  // B3 — one element removed entirely: exactly that one comes back.
  await setContent({
    elements: [imageElement("el-a", "f-a"), imageElement("el-c", "f-c")],
    appState: {},
    files: {
      "f-a": fileRecord("f-a", PATHS.a),
      "f-c": fileRecord("f-c", PATHS.c),
    },
  });
  found = await listRecoverableArtifacts(supabase, canvasId);
  check(
    "offers exactly the artifact whose element vanished",
    found.length === 1 && found[0]?.jobId === jobIds.b,
    `${found.length} found`,
  );

  // B4 — soft-deleted element: the user deleted this on purpose. Excalidraw keeps
  // it with isDeleted, so it must NOT be offered back.
  await setContent({
    elements: [
      imageElement("el-a", "f-a"),
      imageElement("el-b", "f-b", true),
      imageElement("el-c", "f-c"),
    ],
    appState: {},
    files: {
      "f-a": fileRecord("f-a", PATHS.a),
      "f-b": fileRecord("f-b", PATHS.b),
      "f-c": fileRecord("f-c", PATHS.c),
    },
  });
  found = await listRecoverableArtifacts(supabase, canvasId);
  check(
    "a deliberately deleted image is NOT nagged about",
    found.length === 0,
    `${found.length}`,
  );

  // B5 — orphan file entry, no element: invisible on the canvas, so recoverable.
  await setContent({
    elements: [imageElement("el-a", "f-a"), imageElement("el-c", "f-c")],
    appState: {},
    files: {
      "f-a": fileRecord("f-a", PATHS.a),
      "f-b": fileRecord("f-b", PATHS.b), // file kept, nothing displays it
      "f-c": fileRecord("f-c", PATHS.c),
    },
  });
  found = await listRecoverableArtifacts(supabase, canvasId);
  check(
    "a file with no element referencing it counts as missing",
    found.length === 1 && found[0]?.jobId === jobIds.b,
    `${found.length} found`,
  );

  // B6 — actually restore it, then ask again: the offer must be gone.
  const before = await db.query("select version from public.canvases where id=$1", [canvasId]);
  const restored = await recoverArtifacts(supabase, canvasId, [jobIds.b]);
  check("restore reports one image recovered", restored.recovered === 1, `${restored.recovered}`);
  check("restore reports the new version", typeof restored.version === "number");
  check(
    "restore advanced the canvas version (went through optimistic concurrency)",
    (restored.version ?? 0) > (before.rows[0]?.version ?? 0),
    `${before.rows[0]?.version} -> ${restored.version}`,
  );

  const afterContent = await db.query("select content from public.canvases where id=$1", [canvasId]);
  const els = (afterContent.rows[0].content.elements ?? []) as Record<string, unknown>[];
  const fls = (afterContent.rows[0].content.files ?? {}) as Record<string, any>;
  const restoredEl = els.find(
    (e) => typeof e.fileId === "string" && fls[e.fileId]?.dataURL === marker(PATHS.b),
  );
  check("the restored element is on the canvas and points at the original file", !!restoredEl);
  check(
    "the restored element is not soft-deleted",
    !!restoredEl && restoredEl.isDeleted !== true,
  );

  found = await listRecoverableArtifacts(supabase, canvasId);
  check("nothing is offered any more once restored", found.length === 0, `${found.length}`);

  // B7 — click restore twice: no duplicate element.
  const second = await recoverArtifacts(supabase, canvasId, [jobIds.b]);
  check("a second restore recovers nothing", second.recovered === 0, `${second.recovered}`);
  check(
    "a second restore reports the id as skipped rather than failing",
    second.skipped.includes(jobIds.b),
  );
  const afterTwice = await db.query("select content from public.canvases where id=$1", [canvasId]);
  const elsTwice = (afterTwice.rows[0].content.elements ?? []) as Record<string, unknown>[];
  const flsTwice = (afterTwice.rows[0].content.files ?? {}) as Record<string, any>;
  const copies = elsTwice.filter(
    (e) => typeof e.fileId === "string" && flsTwice[e.fileId]?.dataURL === marker(PATHS.b),
  ).length;
  check("the image exists exactly once on the canvas", copies === 1, `${copies} copies`);
} finally {
  if (canvasId) {
    await db.query("delete from public.background_jobs where canvas_id = $1", [canvasId]);
    await db.query("delete from public.canvases where id = $1", [canvasId]);
    console.log(`\n  (scratch canvas ${canvasId.slice(0, 8)} removed)`);
  }
  await db.end();
}

console.log(`\nTOTAL FAILURES: ${problems.length}`);
if (problems.length) process.exitCode = 1;
