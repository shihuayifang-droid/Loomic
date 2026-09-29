// What is ACTUALLY stored for this canvas right now?
//
// The save log reported elements=1 / payloadBytes=897 while the user says two
// generated images were on the canvas. Either the client is submitting a
// truncated scene, or the images live somewhere other than `elements`. Read the
// row directly rather than guessing.
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const OUT = "d:\\AnimalMafia_ArtResource\\Kiro-AnimalMafia\\scripts\\temp\\canvasdump.txt";
const CANVAS_ID = process.argv[2] ?? "57143771-08d2-4e60-8d50-98fdeeb273e5";
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

const pool = new pg.Pool({
  connectionString: env.SUPABASE_DB_URL,
  max: 1,
  connectionTimeoutMillis: 20_000,
});

try {
  const cols = await pool.query(
    `select column_name from information_schema.columns
      where table_name = 'canvases' order by ordinal_position`,
  );
  emit(`canvases columns: ${cols.rows.map((c) => c.column_name).join(", ")}`);
  emit("");

  const r = await pool.query(
    `select id, updated_at,
            octet_length(content::text) as content_bytes,
            content
       from canvases where id = $1`,
    [CANVAS_ID],
  );
  if (r.rows.length === 0) {
    emit(`canvas ${CANVAS_ID} NOT FOUND`);
  } else {
    const row = r.rows[0];
    emit(`canvas   ${row.id}`);
    emit(`updated  ${row.updated_at}`);
    emit(`bytes    ${row.content_bytes}`);
    const c = row.content ?? {};
    const els = Array.isArray(c.elements) ? c.elements : [];
    const files = c.files && typeof c.files === "object" ? c.files : {};
    emit(`elements ${els.length}`);
    emit(`files    ${Object.keys(files).length}`);
    emit("");
    emit("--- elements ---");
    for (const e of els) {
      emit(
        `  type=${e.type} id=${String(e.id).slice(0, 12)} ` +
          `fileId=${e.fileId ? String(e.fileId).slice(0, 16) : "-"} ` +
          `x=${Math.round(e.x ?? 0)} y=${Math.round(e.y ?? 0)} ` +
          `w=${Math.round(e.width ?? 0)} h=${Math.round(e.height ?? 0)} ` +
          `deleted=${e.isDeleted === true}`,
      );
    }
    emit("");
    emit("--- files (dataURL vs oss:// pointer) ---");
    for (const [fid, f] of Object.entries(files)) {
      const url = typeof f?.dataURL === "string" ? f.dataURL : "";
      const kind = url.startsWith("data:")
        ? `INLINE base64 ${url.length}B`
        : url.startsWith("oss://")
          ? "oss:// pointer"
          : url.slice(0, 45);
      emit(`  ${fid.slice(0, 16)}  mime=${f?.mimeType ?? "?"}  ${kind}`);
    }
    // orphans in both directions
    const usedIds = new Set(els.map((e) => e.fileId).filter(Boolean));
    const orphanFiles = Object.keys(files).filter((k) => !usedIds.has(k));
    const missingFiles = [...usedIds].filter((k) => !(k in files));
    emit("");
    emit(`orphan files (stored but unreferenced): ${orphanFiles.length}`);
    emit(`missing files (referenced but absent):  ${missingFiles.length}`);
    if (missingFiles.length) emit(`  ${missingFiles.map((s) => s.slice(0, 16)).join(", ")}`);
  }

  // Recent generation artifacts for this canvas, to see what SHOULD be present
  emit("");
  emit("--- recent image jobs for this canvas ---");
  try {
    const j = await pool.query(
      `select id, status, created_at
         from generation_jobs
        where canvas_id = $1
        order by created_at desc limit 10`,
      [CANVAS_ID],
    );
    if (j.rows.length === 0) emit("  (no rows)");
    for (const row of j.rows) {
      emit(`  ${row.created_at.toISOString()}  ${row.status}  ${row.id.slice(0, 8)}`);
    }
  } catch (err) {
    emit(`  query failed: ${err.message}`);
  }
} catch (err) {
  emit(`FAILED: ${err.message}`);
} finally {
  await pool.end();
}

writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf8");
