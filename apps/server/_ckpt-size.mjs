// Read-only: what does ONE turn have to read and write?
// LangGraph reloads the latest checkpoint's channel blobs on every turn and
// writes a new version, so the per-version size — not the table total — is the
// number that sets per-turn latency.
import pg from "pg";
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const line = envText.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
const connectionString = line.slice("SUPABASE_DB_URL=".length).trim();

const THREAD = process.argv[2] ?? "thread_28385d86-2233-43bd-ae32-ab496680b4cb";

const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 15000 });
try {
  const perVersion = await pool.query(
    `select version,
            count(*) as channels,
            sum(coalesce(octet_length(blob), 0))::bigint as bytes
       from langgraph.checkpoint_blobs
      where thread_id = $1
      group by version
      order by version desc
      limit 6`,
    [THREAD],
  );
  console.log(`THREAD ${THREAD}`);
  console.log("\nLATEST CHECKPOINT VERSIONS (newest first):");
  for (const r of perVersion.rows) {
    console.log(
      `  version=${r.version}  channels=${r.channels}  ${(Number(r.bytes) / 1048576).toFixed(2)} MB`,
    );
  }

  const byChannel = await pool.query(
    `select channel,
            count(*) as versions,
            max(coalesce(octet_length(blob), 0))::bigint as max_bytes,
            sum(coalesce(octet_length(blob), 0))::bigint as total_bytes
       from langgraph.checkpoint_blobs
      where thread_id = $1
      group by channel
      order by total_bytes desc
      limit 10`,
    [THREAD],
  );
  console.log("\nBY CHANNEL:");
  for (const r of byChannel.rows) {
    console.log(
      `  ${r.channel}  versions=${r.versions}  largest=${(Number(r.max_bytes) / 1048576).toFixed(2)} MB  total=${(Number(r.total_bytes) / 1048576).toFixed(2)} MB`,
    );
  }

  // How much of the newest "messages" blob is base64 image payload?
  const newest = await pool.query(
    `select octet_length(blob) as bytes, blob
       from langgraph.checkpoint_blobs
      where thread_id = $1 and channel = 'messages'
      order by version desc
      limit 1`,
    [THREAD],
  );
  if (newest.rows.length > 0) {
    const buf = newest.rows[0].blob;
    const text = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
    let b64Bytes = 0;
    let b64Count = 0;
    const re = /data:image\/[a-zA-Z+]+;base64,/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      b64Count += 1;
      // measure until the next quote
      const end = text.indexOf('"', m.index);
      b64Bytes += (end === -1 ? text.length : end) - m.index;
    }
    console.log(
      `\nNEWEST messages BLOB: ${(Number(newest.rows[0].bytes) / 1048576).toFixed(2)} MB` +
        `  inline images=${b64Count}  their bytes=${(b64Bytes / 1048576).toFixed(2)} MB`,
    );
  }
} catch (err) {
  console.log("ERR", err.message);
} finally {
  await pool.end();
}
