// P2 verification: does the lost update actually stop happening?
//
// Reproduces the exact sequence that erased generated images, against the real
// database, with no provider calls and no credits spent:
//
//   1. reader A reads content+version        (the browser opening the canvas)
//   2. writer B appends an element           (the agent finishing a generation)
//   3. A writes its whole array back         (the browser's debounced auto-save)
//
// Before P2, step 3 silently erased B's element. Now it must be rejected.
//
// Runs on a scratch canvas it creates and deletes, so no real project is touched.
import { readFileSync } from "node:fs";
import pg from "pg";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
const problems = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) problems.push(label);
};

/** The conditional update, exactly as writeIfUnchanged issues it. */
async function writeIfUnchanged(canvasId, content, expectedVersion) {
  const r = await client.query(
    `update public.canvases
        set content = $1::jsonb, version = $2
      where id = $3 and version = $4
      returning version`,
    [JSON.stringify(content), expectedVersion + 1, canvasId, expectedVersion],
  );
  return r.rows[0]?.version ?? null;
}

async function read(canvasId) {
  const r = await client.query(
    "select content, version from public.canvases where id = $1",
    [canvasId],
  );
  return r.rows[0];
}

let canvasId;
try {
  await client.connect();

  // Borrow any existing project so FK constraints are satisfied.
  const proj = await client.query("select id from public.projects limit 1");
  if (!proj.rows.length) {
    console.log("no projects in the database; cannot create a scratch canvas");
    process.exit(1);
  }
  const created = await client.query(
    `insert into public.canvases (project_id, name, content)
     values ($1, '_p2-verify scratch', '{"elements":[],"appState":{}}'::jsonb)
     returning id, version`,
    [proj.rows[0].id],
  );
  canvasId = created.rows[0].id;
  console.log(`scratch canvas ${canvasId} version=${created.rows[0].version}\n`);

  console.log("1. new row starts at version 0");
  check("version", created.rows[0].version, 0);

  console.log("\n2. THE ORIGINAL BUG: stale whole-content write must be rejected");
  const a = await read(canvasId); // browser reads
  // agent appends while the browser sits on its snapshot
  const b = await read(canvasId);
  const bWrote = await writeIfUnchanged(
    canvasId,
    { ...b.content, elements: [{ id: "agent-image", type: "image" }] },
    b.version,
  );
  check("agent write bumped version to 1", bWrote, 1);

  // browser now saves ITS array, which never contained agent-image
  const aWrote = await writeIfUnchanged(
    canvasId,
    { ...a.content, elements: [{ id: "user-rect", type: "rectangle" }] },
    a.version,
  );
  check("stale browser write rejected (null = no row matched)", aWrote, null);

  const afterConflict = await read(canvasId);
  check(
    "agent's element still there",
    afterConflict.content.elements.map((e) => e.id),
    ["agent-image"],
  );

  console.log("\n3. after merging, the retry succeeds");
  const merged = {
    ...afterConflict.content,
    elements: [
      ...afterConflict.content.elements,
      { id: "user-rect", type: "rectangle" },
    ],
  };
  const mergedWrote = await writeIfUnchanged(canvasId, merged, afterConflict.version);
  check("merged write accepted", mergedWrote, 2);
  const final = await read(canvasId);
  check(
    "BOTH elements survive",
    final.content.elements.map((e) => e.id).sort(),
    ["agent-image", "user-rect"],
  );

  console.log("\n4. two agent-side writers: the loser retries and both land");
  // mutateCanvasContent's loop, run for real against the database.
  async function mutate(elementId) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const snap = await read(canvasId);
      const next = {
        ...snap.content,
        elements: [...snap.content.elements, { id: elementId, type: "image" }],
      };
      const v = await writeIfUnchanged(canvasId, next, snap.version);
      if (v !== null) return { attempt, version: v };
    }
    return null;
  }
  // Interleave deliberately: both read, then both write.
  const s1 = await read(canvasId);
  const s2 = await read(canvasId);
  const w1 = await writeIfUnchanged(
    canvasId,
    { ...s1.content, elements: [...s1.content.elements, { id: "img-1", type: "image" }] },
    s1.version,
  );
  const w2First = await writeIfUnchanged(
    canvasId,
    { ...s2.content, elements: [...s2.content.elements, { id: "img-2", type: "image" }] },
    s2.version,
  );
  check("first writer wins", w1, 3);
  check("second writer is rejected, not silently applied", w2First, null);
  const retried = await mutate("img-2");
  check("second writer succeeds on retry", retried !== null, true);
  const final2 = await read(canvasId);
  check(
    "all four elements present, nothing lost",
    final2.content.elements.map((e) => e.id).sort(),
    ["agent-image", "img-1", "img-2", "user-rect"],
  );

  console.log("\n5. control: WITHOUT the version check the loss still happens");
  // Proves the test would have caught the old behaviour, i.e. it is not
  // vacuously passing.
  const c = await read(canvasId);
  await client.query(
    "update public.canvases set content = $1::jsonb where id = $2",
    [JSON.stringify({ ...c.content, elements: [{ id: "only-mine" }] }), canvasId],
  );
  const clobbered = await read(canvasId);
  check(
    "unconditional update DOES erase everything (the old bug)",
    clobbered.content.elements.map((e) => e.id),
    ["only-mine"],
  );
} catch (err) {
  console.log(`ERROR: ${err.message}`);
  problems.push(err.message);
} finally {
  if (canvasId) {
    await client
      .query("delete from public.canvases where id = $1", [canvasId])
      .then(() => console.log(`\nscratch canvas ${canvasId} deleted`))
      .catch((e) => console.log(`\nCLEANUP FAILED for ${canvasId}: ${e.message}`));
  }
  await client.end().catch(() => {});
}

console.log(`\nTOTAL FAILURES: ${problems.length}`);
if (problems.length) process.exitCode = 1;
