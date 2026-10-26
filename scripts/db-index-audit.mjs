#!/usr/bin/env node
/**
 * scripts/db-index-audit.mjs
 *
 * Read-only index audit for the HaHart Postgres database (ticket 45DM / OP-21 ops lane).
 *
 * What it prints, per table:
 *   - the indexes that already exist (pg_indexes: name + definition, so the column list is included)
 *   - the column list (information_schema.columns), used to build the sampled query
 *   - EXPLAIN (FORMAT JSON) of that table's most common query, with "Plan Rows" and whether an
 *     index was used
 *
 * Connection: DATABASE_URL from process.env only. When it is absent the script prints
 * "SKIP no DATABASE_URL" and exits 0, so it is safe to wire into any pipeline step.
 *
 * SQL policy (read-only by construction): the statements issued by this file are
 *   - SELECT against pg_catalog / information_schema (metadata),
 *   - SELECT to_regclass(...) for existence checks,
 *   - EXPLAIN (FORMAT JSON) <select ...> for the sampled queries.
 * Nothing else is issued: the audit cannot mutate data, schema or settings. There is no
 * statement in this file that writes rows, creates/drops objects or changes configuration.
 *
 * Sampled query per table ("most common query"): the list endpoint pattern used by the API,
 * i.e. "rows of one owner/workspace, newest first, page size 20". The filter column is the
 * first of workspace_id / owner_user_id / project_id / user_id / id that the table actually
 * has, the order column is the first of updated_at / created_at / id, and the literal is cast
 * from the column's real data type. This is deliberately derived from introspection instead
 * of hard-coded SQL so a schema rename shows up as a change in output, not as a crash.
 *
 * Table `credits` has no table of that exact name in this schema; credit state lives in the
 * credit_* tables. When a requested table is missing the script says so and falls back to
 * auditing the credit_* tables that actually exist, so the run still produces an audit.
 *
 * Usage:
 *   node scripts/db-index-audit.mjs                  # uses DATABASE_URL from the environment
 *   node --env-file=.env.local scripts/db-index-audit.mjs   # local: load the repo env file
 *
 * Extra env (optional): DB_INDEX_AUDIT_TIMEOUT_MS (default 8000) caps connect + query time.
 * The connection string is never printed.
 */

import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SERVER_PKG_JSON = path.join(REPO_ROOT, "apps", "server", "package.json");

const REQUESTED_TABLES = ["credits", "canvases", "projects"];
const CREDIT_FALLBACK_TABLES = [
  "credit_balances",
  "credit_transactions",
  "user_credit_wallets",
  "daily_credit_claims",
  "team_credit_pools",
];

const FILTER_COLUMN_PREFERENCE = ["workspace_id", "owner_user_id", "project_id", "user_id", "id"];
const ORDER_COLUMN_PREFERENCE = ["updated_at", "created_at", "id"];
const PAGE_SIZE = 20;

const TIMEOUT_MS = Number.parseInt(process.env.DB_INDEX_AUDIT_TIMEOUT_MS ?? "", 10) > 0
  ? Number.parseInt(process.env.DB_INDEX_AUDIT_TIMEOUT_MS, 10)
  : 8000;

function loadPg() {
  const attempts = [SERVER_PKG_JSON, import.meta.url];
  for (const base of attempts) {
    try {
      return createRequire(base)("pg");
    } catch {
      // try the next resolution base
    }
  }
  throw new Error("pg module not found (looked for apps/server/node_modules/pg)");
}

function literalFor(dataType) {
  const t = String(dataType ?? "").toLowerCase();
  if (t === "uuid") return "'00000000-0000-0000-0000-000000000000'::uuid";
  if (t.includes("timestamp") || t === "date") return "(now() - interval '7 days')";
  if (t === "boolean") return "false";
  if (t.includes("int") || t.includes("numeric") || t.includes("double") || t.includes("real") || t.includes("decimal")) {
    return "0";
  }
  return "'audit'";
}

function collectPlanNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.Plans ?? []) collectPlanNodes(child, out);
  return out;
}

function describePlan(explainJson) {
  const root = Array.isArray(explainJson) ? explainJson[0] : explainJson;
  const plan = root?.Plan ?? {};
  const nodes = collectPlanNodes(plan);
  const nodeTypes = nodes.map((n) => String(n["Node Type"] ?? "unknown"));
  const indexNodes = nodes.filter((n) => /Index/.test(String(n["Node Type"] ?? "")));
  const seqNodes = nodes.filter((n) => /Seq Scan/.test(String(n["Node Type"] ?? "")));
  return {
    topNodeType: String(plan["Node Type"] ?? "unknown"),
    planRows: plan["Plan Rows"] ?? null,
    totalCost: plan["Total Cost"] ?? null,
    nodeTypes,
    usesIndex: indexNodes.length > 0,
    indexNodes: indexNodes.map((n) => ({
      nodeType: n["Node Type"],
      indexName: n["Index Name"] ?? null,
      planRows: n["Plan Rows"] ?? null,
    })),
    seqScanTables: seqNodes.map((n) => n["Relation Name"] ?? "unknown"),
  };
}

function buildSampleQuery(table, columns) {
  const byName = new Map(columns.map((c) => [c.columnName, c.dataType]));
  const filterColumn = FILTER_COLUMN_PREFERENCE.find((c) => byName.has(c)) ?? null;
  const orderColumn = ORDER_COLUMN_PREFERENCE.find((c) => byName.has(c)) ?? null;

  let sql = `SELECT * FROM public.${table}`;
  if (filterColumn) {
    sql += ` WHERE ${filterColumn} = ${literalFor(byName.get(filterColumn))}`;
  }
  if (orderColumn) {
    sql += ` ORDER BY ${orderColumn} DESC`;
  }
  sql += ` LIMIT ${PAGE_SIZE}`;

  const rationale = filterColumn
    ? `list rows for one ${filterColumn.replace(/_id$/, "")}${orderColumn ? `, newest ${orderColumn} first` : ""}`
    : `list rows${orderColumn ? `, newest ${orderColumn} first` : ""}`;

  return { sql, filterColumn, orderColumn, rationale };
}

async function listColumns(client, table) {
  const res = await client.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return res.rows.map((r) => ({ columnName: r.column_name, dataType: r.data_type }));
}

async function listIndexes(client, table) {
  const res = await client.query(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY indexname`,
    [table],
  );
  return res.rows.map((r) => ({ name: r.indexname, definition: r.indexdef }));
}

async function tableExists(client, table) {
  const res = await client.query("SELECT to_regclass($1) AS oid", [`public.${table}`]);
  return res.rows[0]?.oid !== null && res.rows[0]?.oid !== undefined;
}

async function existingTablesMatching(client, prefix) {
  const res = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE $1
      ORDER BY table_name`,
    [`${prefix}%`],
  );
  return res.rows.map((r) => r.table_name);
}

async function auditTable(client, table) {
  const columns = await listColumns(client, table);
  const indexes = await listIndexes(client, table);
  const sample = buildSampleQuery(table, columns);

  let plan = null;
  let explainError = null;
  try {
    const res = await client.query(`EXPLAIN (FORMAT JSON) ${sample.sql}`);
    plan = describePlan(res.rows[0]?.["QUERY PLAN"]);
  } catch (err) {
    explainError = err && err.message ? err.message : String(err);
  }

  return {
    table,
    rowCount: null,
    columnCount: columns.length,
    columns: columns.map((c) => `${c.columnName} ${c.dataType}`),
    indexes,
    sampleQuery: sample.sql,
    sampleRationale: sample.rationale,
    plan,
    explainError,
  };
}

function printTableReport(report, requestedAs) {
  const label = requestedAs && requestedAs !== report.table ? `${report.table} (fallback for ${requestedAs})` : report.table;
  console.log("");
  console.log(`## ${label}`);
  console.log(`columns (${report.columnCount}): ${report.columns.join(", ")}`);
  if (report.indexes.length === 0) {
    console.log("indexes: none");
  } else {
    console.log(`indexes (${report.indexes.length}):`);
    for (const idx of report.indexes) {
      console.log(`  - ${idx.name}: ${idx.definition}`);
    }
  }
  console.log(`sample query (${report.sampleRationale}): ${report.sampleQuery}`);
  if (report.explainError) {
    console.log(`EXPLAIN: ERROR ${report.explainError}`);
    return;
  }
  const p = report.plan;
  console.log(
    `EXPLAIN: Plan Rows=${p.planRows} top=${p.topNodeType} uses_index=${p.usesIndex ? "yes" : "no"} ` +
      `nodes=[${p.nodeTypes.join(" > ")}]`,
  );
  if (p.indexNodes.length > 0) {
    const names = p.indexNodes.map((n) => `${n.nodeType}${n.indexName ? `(${n.indexName})` : ""}`);
    console.log(`  index nodes: ${names.join(", ")}`);
  }
  if (p.seqScanTables.length > 0) {
    console.log(`  seq scan relations: ${p.seqScanTables.join(", ")}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP no DATABASE_URL");
    return 0;
  }

  const pg = loadPg();
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  });

  const reports = [];
  try {
    await client.connect();
    console.log("DB-INDEX-AUDIT");
    console.log("DATABASE_URL: set (value not printed)");
    console.log(`requested tables: ${REQUESTED_TABLES.join(", ")}`);

    for (const requested of REQUESTED_TABLES) {
      if (await tableExists(client, requested)) {
        const report = await auditTable(client, requested);
        reports.push({ ...report, requestedAs: requested });
        printTableReport(report, requested);
        continue;
      }

      console.log("");
      console.log(`## ${requested}`);
      console.log(`TABLE ${requested}: NOT FOUND in schema public (to_regclass returned NULL)`);

      if (requested === "credits") {
        const candidates = [];
        for (const name of CREDIT_FALLBACK_TABLES) {
          if (await tableExists(client, name)) candidates.push(name);
        }
        const alsoPresent = (await existingTablesMatching(client, "credit")).filter(
          (name) => !candidates.includes(name),
        );
        for (const extra of alsoPresent) candidates.push(extra);
        console.log(`  credit state actually lives in: ${candidates.join(", ") || "(none found)"}`);
        for (const name of candidates) {
          const report = await auditTable(client, name);
          reports.push({ ...report, requestedAs: requested });
          printTableReport(report, requested);
        }
      }
    }

    console.log("");
    console.log(`SUMMARY_JSON ${JSON.stringify({ tables: reports.map((r) => ({
      table: r.table,
      requestedAs: r.requestedAs,
      indexes: r.indexes.map((i) => i.name),
      sampleQuery: r.sampleQuery,
      planRows: r.plan?.planRows ?? null,
      usesIndex: r.plan?.usesIndex ?? null,
      topNodeType: r.plan?.topNodeType ?? null,
    })) })}`);
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(`AUDIT FAILED: ${message}`);
    return 1;
  } finally {
    try {
      await client.end();
    } catch {
      // ignore shutdown errors
    }
  }
}

process.exitCode = await main();
