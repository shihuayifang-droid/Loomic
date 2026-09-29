// Applies migration 20260404000000_canvas_optimistic_version.sql.
//
// Only an ADD COLUMN IF NOT EXISTS with a default, so it is idempotent and
// backward compatible: code that does not select `version` keeps working.
// Rollback is `ALTER TABLE public.canvases DROP COLUMN version;`.
import { readFileSync } from "node:fs";
import pg from "pg";

const envText = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) env[line.slice(0, i)] = line.slice(i + 1).trim();
}

const url = env.SUPABASE_DB_URL;
if (!url) {
  console.log("SUPABASE_DB_URL missing from .env.local");
  process.exit(1);
}

const sql = readFileSync(
  new URL(
    "../../supabase/migrations/20260404000000_canvas_optimistic_version.sql",
    import.meta.url,
  ),
  "utf8",
);

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  console.log("connected");

  const before = await client.query(
    `select column_name, data_type, column_default, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = 'canvases'
      order by ordinal_position`,
  );
  console.log("columns BEFORE:", before.rows.map((r) => r.column_name).join(", "));

  await client.query(sql);
  console.log("migration executed");

  const after = await client.query(
    `select column_name, data_type, column_default, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = 'canvases' and column_name = 'version'`,
  );
  console.log("version column AFTER:", JSON.stringify(after.rows));

  // Every existing row must have a concrete 0, not NULL, or the first
  // conditional update would match nothing and every save would 409.
  const nulls = await client.query(
    "select count(*)::int as n from public.canvases where version is null",
  );
  console.log(`rows with NULL version: ${nulls.rows[0].n}  (must be 0)`);

  const sample = await client.query(
    "select id, version from public.canvases order by updated_at desc limit 5",
  );
  console.log("sample:", JSON.stringify(sample.rows));
} catch (err) {
  console.log(`FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
