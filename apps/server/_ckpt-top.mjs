// Read-only: per-thread checkpoint blob totals, newest threads first.
// Used to confirm that a thread created after the URL-instead-of-base64 change
// no longer accumulates megabytes per turn.
import pg from "pg";
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const line = envText.split(/\r?\n/).find((l) => l.startsWith("SUPABASE_DB_URL="));
const connectionString = line.slice("SUPABASE_DB_URL=".length).trim();

const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 15000 });
try {
  const rows = await pool.query(
    `select b.thread_id,
            count(*) as blob_rows,
            sum(coalesce(octet_length(b.blob), 0))::bigint as bytes,
            max(c.checkpoint_id) as newest_checkpoint
       from langgraph.checkpoint_blobs b
       left join langgraph.checkpoints c on c.thread_id = b.thread_id
      group by b.thread_id
      order by newest_checkpoint desc nulls last`,
  );
  for (const r of rows.rows) {
    console.log(
      `${r.thread_id}  rows=${r.blob_rows}  ${(Number(r.bytes) / 1048576).toFixed(3)} MB`,
    );
  }

  const msgs = await pool.query(
    `select thread_id,
            max(coalesce(octet_length(blob), 0))::bigint as largest_messages_blob
       from langgraph.checkpoint_blobs
      where channel = 'messages'
      group by thread_id
      order by largest_messages_blob desc`,
  );
  console.log("\nLARGEST 'messages' BLOB PER THREAD:");
  for (const r of msgs.rows) {
    console.log(
      `  ${r.thread_id}  ${(Number(r.largest_messages_blob) / 1024).toFixed(1)} KB`,
    );
  }
} catch (err) {
  console.log("ERR", err.message);
} finally {
  await pool.end();
}
