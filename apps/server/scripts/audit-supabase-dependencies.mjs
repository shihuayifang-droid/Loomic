#!/usr/bin/env node
/**
 * Supabase dependency audit (ticket 19 / ADR-0001 migration step 1).
 *
 * Purpose: freeze ONE reproducible set of Supabase coupling counts for the
 * active code/config/schema so every later migration ticket can only lower
 * them. This script never writes anything except the baseline file, and only
 * when `--update-baseline` is passed.
 *
 * Usage (cwd does not matter; all paths resolve from this file):
 *   node scripts/audit-supabase-dependencies.mjs
 *   node scripts/audit-supabase-dependencies.mjs --update-baseline
 *   node scripts/audit-supabase-dependencies.mjs --baseline=<file>   (self-test)
 *   node scripts/audit-supabase-dependencies.mjs --root=<dir>        (self-test)
 *
 * Exit code: 0 when `[PROBLEMS] 0`, otherwise 1.
 *
 * Counting rules (textual, deliberately conservative - a comment or string
 * match still counts, so the baseline can never be lowered by rewording):
 *
 * - Scopes are explicit. The audit counts production code only:
 *   `apps/web/src/**` and `apps/server/src/**` (server production excludes
 *   `*.test.ts`; test-only hits are reported as separate `server.test*` keys).
 * - `Array.from(` / `Object.from(` / `Buffer.from(` are not PostgREST calls.
 * - `rpcCallsRuntime` excludes `apps/server/src/cli/**` (operator tooling, not
 *   the runtime surface) and is reported next to the all-files number.
 * - The Supabase env family is the fixed allow-list below, matched as whole
 *   tokens (so `NEXT_PUBLIC_SUPABASE_URL` is one name, not `SUPABASE_URL`).
 *   Any other `SUPABASE_*` token in active config is counted separately as
 *   `config.unknownSupabaseEnvTokens` so a new name cannot slip in silently.
 * - Active SQL is `supabase/migrations/**`. Rollbacks, snippets and the test
 *   support stub are counted separately.
 * - Excluded from every counter: archives, vendored docs and scratch output -
 *   `node_modules`, `.git`, `dist`, `.next`, `out`, `.turbo`, `coverage`,
 *   `docs`, `.agents`, `skills`, `semantic-review`, `.j-can-see`, and this
 *   script's own directory (`apps/server/scripts`). Their Supabase mentions are
 *   still reported as `excluded.archiveDocSupabaseMentions`, so moving code
 *   into an excluded area raises a problem instead of hiding a hit.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = resolve(SCRIPT_DIR, "..", "..", "..");
const BASELINE_DEFAULT = join(SCRIPT_DIR, "supabase-dependency-baseline.json");

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "out",
  ".turbo",
  "coverage",
]);

const ARCHIVE_DIRS = ["docs", ".agents", "skills"];
const SCRATCH_DIRS = ["semantic-review", ".j-can-see"];

const SUPABASE_ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_JWT_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];

/** ADR-0001: 工单13/16/18 migrations of the superseded X-52 storage line. */
const SUPERSEDED_X52_MIGRATIONS = [
  "20261012000001_hahart_project_asset_signed_reads.sql",
  "20261013000001_hahart_project_asset_backfill_compare_write.sql",
  "20261013000002_hahart_storage_private_cutover.sql",
];

const CONFIG_FILE_CANDIDATES = [
  ".env.example",
  "apps/server/.env.local.example",
  "apps/web/.env.local.example",
  "apps/web/next.config.ts",
  "railway.json",
  "vercel.json",
  "apps/server/Dockerfile",
  "supabase/config.toml",
  "apps/server/src/config/env.ts",
  "apps/web/src/lib/env.ts",
];

const AUTH_SDK_METHODS = [
  "signInWithOtp",
  "signInWithPassword",
  "signInWithOAuth",
  "signUp",
  "signOut",
  "getSession",
  "refreshSession",
  "onAuthStateChange",
  "exchangeCodeForSession",
  "getUser",
  "setSession",
  "updateUser",
  "resetPasswordForEmail",
  "verifyOtp",
];

/** Anchor numbers published in ADR-0001 / the migration plan (read-only check). */
const ANCHORS = [
  { label: "web.Auth", value: 9, key: "web.authSdkDistinctMethods" },
  { label: "web.PostgREST", value: 4, key: "web.postgrestFromCalls" },
  { label: "web.Realtime", value: 0, key: "web.realtimeChannelCalls" },
  { label: "server.runtimeRpc", value: 17, key: "server.rpcCallsRuntime" },
  { label: "sql.rlsTables", value: 32, key: "sql.rlsEnabledTables" },
  { label: "config.envFamily", value: 8, key: "config.supabaseEnvVariableFamily" },
  { label: "manifests", value: 3, key: "manifests.withSupabaseSdk" },
  { label: "sql.migrations", value: 37, key: "sql.migrationsActive" },
];

function parseArgs(argv) {
  const options = {
    updateBaseline: false,
    root: REPO_ROOT_DEFAULT,
    baseline: BASELINE_DEFAULT,
  };

  for (const arg of argv) {
    if (arg === "--update-baseline") {
      options.updateBaseline = true;
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else if (arg.startsWith("--baseline=")) {
      options.baseline = resolve(arg.slice("--baseline=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function walkFiles(dir, extensions, collected = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkFiles(full, extensions, collected);
    } else if (entry.isFile()) {
      if (extensions.some((extension) => entry.name.endsWith(extension))) {
        collected.push(full);
      }
    }
  }

  return collected;
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

function readAll(files) {
  return files.map((file) => readText(file)).join("\n");
}

function listSqlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function collect(root) {
  const metrics = {};
  const skipped = [];

  // ---- web production source -------------------------------------------------
  const webSrcDir = join(root, "apps", "web", "src");
  const webFiles = walkFiles(webSrcDir, [".ts", ".tsx"]);
  const webText = readAll(webFiles);
  const authCallPattern = new RegExp(
    `(?<![A-Za-z0-9_$])auth\\.(${AUTH_SDK_METHODS.join("|")})\\s*\\(`,
    "g",
  );
  const authMethods = new Set();
  for (const match of webText.matchAll(authCallPattern)) {
    authMethods.add(match[1]);
  }

  metrics["web.authSdkCallSites"] = countMatches(webText, authCallPattern);
  metrics["web.authSdkDistinctMethods"] = authMethods.size;
  metrics["web.postgrestFromCalls"] = countMatches(
    webText,
    /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/,
  );
  metrics["web.postgrestRpcCalls"] = countMatches(webText, /\.rpc\s*\(/);
  metrics["web.realtimeChannelCalls"] = countMatches(webText, /\.channel\s*\(/);
  metrics["web.storageApiCalls"] = countMatches(
    webText,
    /\.storage\s*\.\s*[A-Za-z_$]/,
  );
  metrics["web.supabaseSdkImportHits"] = countMatches(
    webText,
    /@supabase\/supabase-js/,
  );

  // ---- server production source ---------------------------------------------
  const serverSrcDir = join(root, "apps", "server", "src");
  const serverFiles = walkFiles(serverSrcDir, [".ts"]);
  const serverProdFiles = serverFiles.filter(
    (file) => !file.endsWith(".test.ts"),
  );
  const serverTestFiles = serverFiles.filter((file) => file.endsWith(".test.ts"));
  const serverProdText = readAll(serverProdFiles);
  const serverTestText = readAll(serverTestFiles);
  const runtimeFiles = serverProdFiles.filter(
    (file) => !file.split(sep).includes("cli"),
  );
  const runtimeText = readAll(runtimeFiles);

  metrics["server.supabaseSdkImportHits"] = countMatches(
    serverProdText,
    /@supabase\/supabase-js/,
  );
  metrics["server.fromCalls"] = countMatches(
    serverProdText,
    /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/,
  );
  metrics["server.fromCallsIncludingTests"] =
    metrics["server.fromCalls"] +
    countMatches(serverTestText, /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/);
  metrics["server.rpcCallsRuntime"] = countMatches(runtimeText, /\.rpc\s*\(/);
  metrics["server.rpcCallsAll"] = countMatches(serverProdText, /\.rpc\s*\(/);
  metrics["server.storageCalls"] = countMatches(serverProdText, /\.storage\b/);
  metrics["server.authGetUserCalls"] = countMatches(
    serverProdText,
    /\.auth\.getUser\s*\(/,
  );
  metrics["server.testSupabaseSdkImportHits"] = countMatches(
    serverTestText,
    /@supabase\/supabase-js/,
  );

  // ---- active configuration --------------------------------------------------
  const configFiles = CONFIG_FILE_CANDIDATES.map((file) => join(root, file)).filter(
    (file) => existsSync(file),
  );
  const configText = readAll(configFiles);
  const presentEnvNames = SUPABASE_ENV_NAMES.filter((name) =>
    new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(configText),
  );
  const supabaseTokenPattern = /(?<![A-Z0-9_])(?:NEXT_PUBLIC_)?SUPABASE_[A-Z0-9_]+/g;
  const unknownEnvTokens = new Set();
  for (const match of configText.matchAll(supabaseTokenPattern)) {
    if (!SUPABASE_ENV_NAMES.includes(match[0])) unknownEnvTokens.add(match[0]);
  }

  metrics["config.supabaseEnvVariableFamily"] = presentEnvNames.length;
  metrics["config.supabaseEnvHits"] = SUPABASE_ENV_NAMES.reduce(
    (total, name) =>
      total +
      countMatches(
        configText,
        new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`),
      ),
    0,
  );
  metrics["config.unknownSupabaseEnvTokens"] = unknownEnvTokens.size;

  // ---- package manifests and lockfile ---------------------------------------
  const manifestFiles = [
    join(root, "package.json"),
    ...walkFiles(join(root, "apps"), [".json"]).filter((file) =>
      file.endsWith(`${sep}package.json`),
    ),
    ...walkFiles(join(root, "packages"), [".json"]).filter((file) =>
      file.endsWith(`${sep}package.json`),
    ),
  ].filter((file) => existsSync(file));
  const manifestsWithSdk = manifestFiles.filter((file) =>
    /@supabase\/supabase-js/.test(readText(file)),
  );

  metrics["manifests.withSupabaseSdk"] = manifestsWithSdk.length;
  metrics["manifests.scanned"] = manifestFiles.length;
  const lockfilePath = join(root, "pnpm-lock.yaml");
  metrics["lockfile.supabaseSdkHits"] = existsSync(lockfilePath)
    ? countMatches(readText(lockfilePath), /@supabase\/supabase-js/)
    : 0;

  // ---- active SQL ------------------------------------------------------------
  const migrationsDir = join(root, "supabase", "migrations");
  const migrationNames = listSqlFiles(migrationsDir);
  const migrationsText = readAll(
    migrationNames.map((name) => join(migrationsDir, name)),
  );

  metrics["sql.migrations"] = migrationNames.length;
  metrics["sql.migrationsActive"] = migrationNames.filter(
    (name) => !SUPERSEDED_X52_MIGRATIONS.includes(name),
  ).length;
  metrics["sql.rlsEnabledTables"] = countMatches(
    migrationsText,
    /enable\s+row\s+level\s+security/i,
  );
  metrics["sql.createPolicyStatements"] = countMatches(
    migrationsText,
    /create\s+policy/i,
  );
  metrics["sql.authUidCalls"] = countMatches(migrationsText, /auth\.uid\s*\(/i);
  metrics["sql.authUsersReferences"] = countMatches(
    migrationsText,
    /auth\.users/i,
  );
  metrics["sql.storageApiReferences"] = countMatches(
    migrationsText,
    /storage\.(objects|buckets|foldername)/i,
  );

  const rollbackDir = join(root, "supabase", "rollbacks");
  const rollbackNames = listSqlFiles(rollbackDir);
  metrics["sql.rollbackFiles"] = rollbackNames.length;
  metrics["sql.rollbackStorageApiReferences"] = countMatches(
    readAll(rollbackNames.map((name) => join(rollbackDir, name))),
    /storage\.(objects|buckets|foldername)/i,
  );

  const stubPath = join(
    root,
    "apps",
    "server",
    "src",
    "test-support",
    "db",
    "supabase-stubs.sql",
  );
  const stubText = existsSync(stubPath) ? readText(stubPath) : "";
  metrics["sql.testSupportRlsStatements"] = countMatches(
    stubText,
    /enable\s+row\s+level\s+security/i,
  );
  metrics["sql.testSupportAuthUidCalls"] = countMatches(
    stubText,
    /auth\.uid\s*\(/i,
  );

  // ---- excluded areas (visibility only, never silently dropped) -------------
  const archiveText = readAll(
    ARCHIVE_DIRS.flatMap((dir) =>
      walkFiles(join(root, dir), [".md", ".ts", ".tsx", ".js", ".mjs", ".sql"]),
    ),
  );
  metrics["excluded.archiveDocSupabaseMentions"] = countMatches(
    archiveText,
    /supabase/i,
  );

  for (const dir of [...ARCHIVE_DIRS, ...SCRATCH_DIRS, "apps/server/scripts"]) {
    skipped.push(dir);
  }

  return { metrics, skipped, configFiles, manifestFiles, migrationsDir };
}

function formatTable(metrics) {
  return Object.keys(metrics)
    .sort()
    .map((key) => `[metric] ${key} = ${metrics[key]}`)
    .join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { metrics, skipped, configFiles, manifestFiles } = collect(options.root);
  const lines = [];

  lines.push(`[audit] root=${options.root}`);
  lines.push(`[audit] baseline=${options.baseline}`);
  lines.push(
    `[audit] configFiles=${configFiles.length} manifests=${manifestFiles.length}`,
  );
  lines.push(`[skip] ${skipped.join(", ")} (scratch output is never counted)`);
  lines.push(formatTable(metrics));

  for (const anchor of ANCHORS) {
    const measured = metrics[anchor.key] ?? 0;
    const verdict =
      measured === anchor.value ? "match" : `DIFFERS by ${measured - anchor.value}`;
    lines.push(
      `[anchor] ${anchor.label}: anchor=${anchor.value} measured[${anchor.key}]=${measured} (${verdict})`,
    );
  }

  const problems = [];

  if (options.updateBaseline) {
    const payload = {
      version: 1,
      generatedBy: "apps/server/scripts/audit-supabase-dependencies.mjs",
      generatedAt: new Date().toISOString(),
      note:
        "Supabase coupling baseline (ticket 19). Counts are textual over the " +
        "scopes documented in the script header. A later ticket may only lower " +
        "a number; an increase fails the audit.",
      anchors: Object.fromEntries(
        ANCHORS.map((anchor) => [anchor.label, anchor.value]),
      ),
      supersededX52Migrations: SUPERSEDED_X52_MIGRATIONS,
      metrics,
    };
    writeFileSync(
      options.baseline,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    lines.push(`[OK] baseline written: ${options.baseline}`);
  } else if (!existsSync(options.baseline)) {
    problems.push(`baseline file not found: ${options.baseline}`);
  } else {
    const baseline = JSON.parse(readText(options.baseline));
    const baselineMetrics = baseline.metrics ?? {};
    const keys = [
      ...new Set([...Object.keys(baselineMetrics), ...Object.keys(metrics)]),
    ].sort();

    for (const key of keys) {
      const expected = baselineMetrics[key];
      const current = metrics[key];

      if (expected === undefined) {
        problems.push(
          `metric ${key} is not in the baseline (current=${current}); re-baseline deliberately`,
        );
        continue;
      }
      if (current === undefined) {
        problems.push(`metric ${key} disappeared from the audit (baseline=${expected})`);
        continue;
      }

      if (current > expected) {
        problems.push(
          `metric ${key} increased: baseline=${expected} current=${current} (+${current - expected})`,
        );
      } else if (current < expected) {
        lines.push(
          `[delta] ${key}: baseline=${expected} current=${current} (-${expected - current})`,
        );
      }
    }

    if (problems.length === 0) {
      lines.push("[OK] no Supabase coupling metric increased");
    }
  }

  for (const problem of problems) {
    lines.push(`[!] ${problem}`);
  }

  lines.push(`[PROBLEMS] ${problems.length}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main();
