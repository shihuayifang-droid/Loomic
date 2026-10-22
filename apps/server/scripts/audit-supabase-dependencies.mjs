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
 * match still counts, so the baseline can never be lowered by rewording; the
 * four RPC counters are the one deliberate exception, see "RPC recognition"):
 *
 * - Scopes are explicit. The audit counts production code only:
 *   `apps/web/src/**` and `apps/server/src/**` (server production excludes
 *   `*.test.ts`; test-only hits are reported as separate `server.test*` keys).
 * - `Array.from(` / `Object.from(` / `Buffer.from(` are not PostgREST calls.
 * - `untypedFrom(client, table)` recognition (ticket 21AD / T-46). Two files,
 *   `http/skills.ts` and `http/skills-marketplace.ts`, reach PostgREST tables
 *   through that local wrapper, whose body is `(client as any).from(table)`:
 *   the call site names the wrapper, not a client, so the `.from(` rule above
 *   cannot see it. A call site of that wrapper counts as one
 *   `server.fromCalls` from this ticket on (65 -> 84 for the 19 call sites) as
 *   an OBSERVATION fix, not as a new dependency. The wrapper is deliberately
 *   NOT generalised into "any helper that returns a `.from(` receiver": exactly
 *   one such wrapper is known, and a rule that guesses would count innocent
 *   identifiers. A future wrapper of this shape has to extend this rule by
 *   hand, together with its call sites - see `UNTYPED_FROM_CALL_PATTERN`.
 *   Like the `.from(` rule, it reads raw text, so a mention inside a comment is
 *   counted too (T-45 stays open on purpose).
 * - `rpcCallsRuntime` excludes `apps/server/src/cli/**` (operator tooling, not
 *   the runtime surface) and is reported next to the all-files number.
 * - RPC recognition (ticket 21-preflight B / T-35). An RPC call site is
 *   counted in BOTH source forms this repository actually uses: the chained
 *   `client.rpc("name", ...)` and the parenthesised TypeScript type assertion
 *   `(client.rpc as any)("name", ...)`. Only the second form used to be
 *   missed, which hid `grant_plan_credits` in
 *   `features/credits/credit-service.ts` - an RPC call that already existed at
 *   runtime before this ticket. The runtime baseline therefore moved 17 -> 18
 *   as an OBSERVATION fix (a counting gap closed), never because a new
 *   dependency was allowed in. Unlike every other counter, the RPC counters
 *   read code with comments, string/template contents and regex literals
 *   blanked out, so prose that merely mentions `.rpc(` cannot raise them.
 *   `web.postgrestRpcCalls`, `server.rpcCallsRuntime`, `server.rpcCallsAll`
 *   and `tooling.rpcCalls` all use that rule through `countRpcCalls`.
 * - The Supabase env family is the fixed allow-list below, matched as whole
 *   tokens (so `NEXT_PUBLIC_SUPABASE_URL` is one name, not `SUPABASE_URL`).
 *   Any other `SUPABASE_*` token in active config is counted separately as
 *   `config.unknownSupabaseEnvTokens` so a new name cannot slip in silently.
 * - Active SQL is `supabase/migrations/**`. Rollbacks, snippets and the test
 *   support stub are counted separately.
 * - Active tooling is `apps/server/scripts/**` (minus the two files named
 *   below) and the repository-root `scripts/**`: JS/TS files that run in this
 *   repository but are not production source. They get their own `tooling.*`
 *   metrics, so a Supabase call in a script cannot hide behind an exclusion.
 * - Excluded from every counter: archives, vendored docs and scratch output -
 *   `node_modules`, `.git`, `dist`, `.next`, `out`, `.turbo`, `coverage`,
 *   `docs`, `.agents`, `skills`, `semantic-review`, `.j-can-see`. Inside the
 *   tooling scope exactly two files are excluded, both by identity: this script
 *   itself and the baseline file in use (counting the baseline would make the
 *   audit depend on its own output). Every exclusion is printed as a
 *   `[tooling] excluded=` line. Archive Supabase mentions are still reported as
 *   `excluded.archiveDocSupabaseMentions`, so moving code into an excluded
 *   archive area raises a problem instead of hiding a hit.
 *
 * Coverage and trend are two separate verdicts:
 *
 * - Coverage (fail-closed): the required scope - root manifest, `apps/web/src`,
 *   `apps/server/src`, `apps/server/package.json`, `supabase/migrations` - must
 *   exist, be readable and be non-empty. A tree the audit could not scan is a
 *   `[PROBLEMS]` failure, never a "supabase is gone" success, and it also
 *   refuses `--update-baseline`.
 * - Trend (baseline): only coupling metrics are compared, and only a RISE is a
 *   problem. A lower number is the goal, so a shrinking count is reported as a
 *   `[delta]` line and never as an error.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_SELF = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_SELF);
const REPO_ROOT_DEFAULT = resolve(SCRIPT_DIR, "..", "..", "..");
const BASELINE_DEFAULT = join(SCRIPT_DIR, "supabase-dependency-baseline.json");

/** POSIX-shaped relative path, so exclusion matching is separator independent. */
function normalizeRelPath(value) {
  return value.split(sep).join("/");
}

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

/** Active tooling: run in this repo, but not production source. */
const TOOLING_DIRS = ["scripts", "apps/server/scripts"];
const TOOLING_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * The only two tooling files that are never counted: the auditor itself and
 * the baseline. Matching happens both by absolute path and by position
 * relative to the default repository root, so a mirror root that carries a
 * copy of either file still behaves like the real root.
 */
const TOOLING_EXCLUDED_RELATIVE_PATHS = [
  normalizeRelPath(relative(REPO_ROOT_DEFAULT, SCRIPT_SELF)),
  normalizeRelPath(relative(REPO_ROOT_DEFAULT, BASELINE_DEFAULT)),
];

/**
 * Required scope for the coverage gate. This is deliberately about
 * "did I actually scan the repository", not about Supabase counts: an absent
 * or empty scope must fail closed instead of reporting a clean zero.
 */
const REQUIRED_SCOPE = [
  { label: "rootManifest", path: "package.json", kind: "file" },
  {
    label: "webSource",
    path: "apps/web/src",
    kind: "dir",
    extensions: [".ts", ".tsx"],
  },
  {
    label: "serverSource",
    path: "apps/server/src",
    kind: "dir",
    extensions: [".ts"],
  },
  { label: "serverManifest", path: "apps/server/package.json", kind: "file" },
  {
    label: "activeMigrations",
    path: "supabase/migrations",
    kind: "dir",
    extensions: [".sql"],
  },
];

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
  // 37M: +3 (team_credit_pools, member_team_usage, user_credit_wallets); 37W: +2 (credit_cap_templates, member_cap_settings); 39J: +1 (refund_compensations); 39N: +1 (member_generation_pauses)
  { label: "sql.rlsTables", value: 39, key: "sql.rlsEnabledTables" },
  { label: "config.envFamily", value: 8, key: "config.supabaseEnvVariableFamily" },
  { label: "manifests", value: 3, key: "manifests.withSupabaseSdk" },
  // 31A: +1 migration (pricing_rules); 33D: +1 (deduct_credits SQLSTATE); 33F: +1 (asset provenance); 33X: +1 (asset display name); 34T: +1 (job client_request_id); 36C: +1 (asset source_job fk); 36D: +1 (refund once per job); 37N: +1 (deduct_from_pools); 37O: +2 (credit cycle types, cycle grants); 37S: +1 (refund_to_pools); 37U: +1 (admin credit adjust); 37W: +1 (member cap settings); 38N: +1 (set_team_pool_limit); 39E: +1 (create_charged_job); 39J: +1 (refund_compensations); 39N: +1 (member pause and credit audit)
  { label: "sql.migrations", value: 55, key: "sql.migrationsActive" },
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

/** Quote characters that open a string or template literal. */
const QUOTE_CHARS = new Set(['"', "'", "`"]);

/**
 * A `/` only starts a regex literal where an expression is expected - never
 * after an identifier, a number or a closing bracket (there it is division).
 */
const REGEX_LEAD_CHARS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "~", "^", "<", ">", "\n",
]);

/** Keywords an expression may follow, so a `/` after them opens a regex. */
const REGEX_LEAD_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await",
]);

function regexCanStartAt(text, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  if (cursor < 0) return true;

  const char = text[cursor];
  if (REGEX_LEAD_CHARS.has(char)) return true;
  if (!/[A-Za-z0-9_$]/.test(char)) return false;

  let start = cursor;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start])) start -= 1;
  return REGEX_LEAD_KEYWORDS.has(text.slice(start + 1, cursor + 1));
}

/**
 * Index of the `}` closing the `${` whose brace sits at `openIndex`, or -1 when
 * the template expression is unterminated.
 */
function matchTemplateBrace(text, openIndex) {
  const length = text.length;
  let depth = 0;
  let index = openIndex;

  while (index < length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (QUOTE_CHARS.has(char)) {
      index = findLiteralEnd(text, index, []);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      index = newline === -1 ? length : newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? length : close + 2;
      continue;
    }
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      continue;
    }
    index += 1;
  }

  return -1;
}

/**
 * Index just past the quoted literal starting at `start`. `${ ... }` holes are
 * collected so a backtick inside them is not read as the end of the literal.
 */
function findLiteralEnd(text, start, holes) {
  const quote = text[start];
  const length = text.length;
  let index = start + 1;

  while (index < length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote === "`" && char === "$" && text[index + 1] === "{") {
      const close = matchTemplateBrace(text, index + 1);
      if (close === -1) return length;
      holes.push([index + 2, close]);
      index = close + 1;
      continue;
    }
    index += 1;
  }

  return length;
}

/**
 * Same-length copy of `text` in which everything that is not executable code -
 * line/block comments, string and template contents, regex literals - is
 * replaced by spaces. Newlines survive so line structure is unchanged, and
 * `${ ... }` holes stay code (stripped recursively).
 *
 * Only the RPC counters use this: a mention of `.rpc(` in prose is not a call,
 * so it must not raise a coupling metric (ticket 21-preflight B, requirement 3).
 * Known limit: JSX text is not understood, so an apostrophe in `.tsx` markup can
 * read as a string opener. No `.tsx` file here contains an RPC call today, and
 * `web.postgrestRpcCalls` is published, so such a call would be visible.
 */
function stripNonCode(text) {
  const out = text.split("");
  const length = text.length;

  const blank = (from, to) => {
    for (let index = from; index < to && index < length; index += 1) {
      const char = out[index];
      if (char !== "\n" && char !== "\r") out[index] = " ";
    }
  };

  let index = 0;
  while (index < length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "/" && next === "/") {
      const newline = text.indexOf("\n", index + 2);
      const end = newline === -1 ? length : newline;
      blank(index, end);
      index = end;
      continue;
    }

    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }

    if (char === "/" && regexCanStartAt(text, index)) {
      let end = index + 1;
      let inClass = false;
      let closed = false;
      while (end < length) {
        const inner = text[end];
        if (inner === "\\") {
          end += 2;
          continue;
        }
        if (inner === "\n") break;
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          end += 1;
          closed = true;
          break;
        }
        end += 1;
      }
      if (closed) {
        blank(index, end);
        index = end;
        continue;
      }
      index += 1;
      continue;
    }

    if (QUOTE_CHARS.has(char)) {
      const holes = [];
      const end = findLiteralEnd(text, index, holes);
      blank(index, end);
      for (const [from, to] of holes) {
        const inner = stripNonCode(text.slice(from, to));
        for (let offset = 0; offset < inner.length; offset += 1) {
          out[from + offset] = inner[offset];
        }
      }
      index = end;
      continue;
    }

    index += 1;
  }

  return out.join("");
}

/**
 * RPC call sites in both source forms this repository uses: the chained
 * `client.rpc("name", ...)` and the parenthesised type assertion
 * `(client.rpc as any)("name", ...)`. The assertion body is deliberately
 * narrow - no parentheses, braces, semicolons or line breaks - so a mere
 * mention cannot be mistaken for a call.
 */
const RPC_CALL_PATTERN = /\.rpc\s*\(|\.rpc\s+as\s+[^(){};\n]*\)\s*\(/;

/** Counts RPC call sites in code, ignoring comments/strings/regex literals. */
function countRpcCalls(text) {
  return countMatches(stripNonCode(text), RPC_CALL_PATTERN);
}

/**
 * Call sites of the `untypedFrom(client, table)` wrapper of `http/skills.ts` and
 * `http/skills-marketplace.ts` (ticket 21AD / T-46). That wrapper hides a real
 * PostgREST table read behind `(client as any).from(table)`, and its callers
 * name the wrapper instead of the client, so the `.from(` rule counts none of
 * them - the call sites were invisible, not absent.
 *
 * The DEFINITION line (`const untypedFrom = (...)`) does not match: the `=` sits
 * between the name and the parenthesis, so only invocations are counted.
 *
 * Deliberately specific rather than a general "isolate any function that returns
 * a `.from(` receiver": exactly one wrapper of this shape exists, and a guessed
 * pattern would count unrelated identifiers as PostgREST calls. Adding another
 * wrapper of this shape means extending this rule by hand, together with the
 * call sites it has to cover.
 */
const UNTYPED_FROM_CALL_PATTERN = /\buntypedFrom\s*\(/;

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

function collect(root, baselinePath) {
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
  metrics["web.postgrestRpcCalls"] = countRpcCalls(webText);
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
  metrics["server.fromCalls"] =
    countMatches(serverProdText, /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/) +
    countMatches(serverProdText, UNTYPED_FROM_CALL_PATTERN);
  metrics["server.fromCallsIncludingTests"] =
    metrics["server.fromCalls"] +
    countMatches(serverTestText, /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/) +
    countMatches(serverTestText, UNTYPED_FROM_CALL_PATTERN);
  metrics["server.rpcCallsRuntime"] = countRpcCalls(runtimeText);
  metrics["server.rpcCallsAll"] = countRpcCalls(serverProdText);
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

  // ---- active tooling (scripts are NOT invisible) ----------------------------
  const toolingExclusionTargets = [
    { label: "auditor", abs: SCRIPT_SELF },
    { label: "baseline", abs: BASELINE_DEFAULT },
    { label: "baseline in use", abs: baselinePath },
  ];
  const toolingExcludedAbsolute = new Set(
    toolingExclusionTargets.map((entry) => resolve(entry.abs)),
  );
  const toolingExcludedRelative = new Set(TOOLING_EXCLUDED_RELATIVE_PATHS);
  const toolingReport = [];
  const toolingFiles = [];
  const toolingExcludedFound = new Set();

  for (const dir of TOOLING_DIRS) {
    const dirPath = join(root, dir);
    let counted = 0;

    for (const file of walkFiles(dirPath, TOOLING_EXTENSIONS)) {
      const relToRoot = normalizeRelPath(relative(root, file));
      if (
        toolingExcludedAbsolute.has(resolve(file)) ||
        toolingExcludedRelative.has(relToRoot)
      ) {
        toolingExcludedFound.add(relToRoot);
        continue;
      }

      toolingFiles.push(file);
      counted += 1;
    }

    toolingReport.push(
      `[tooling] dir=${normalizeRelPath(dir)} files=${counted} (active JS/TS counted)`,
    );
  }

  for (const entry of toolingExclusionTargets) {
    const relToRoot = normalizeRelPath(relative(root, entry.abs));
    const present =
      existsSync(entry.abs) || (relToRoot && existsSync(join(root, relToRoot)));

    toolingReport.push(
      `[tooling] excluded=${relToRoot} reason=${entry.label} present=${
        present ? "yes" : "no"
      } suppressed=${
        toolingExcludedFound.has(relToRoot) ? "yes" : "no"
      } (never counted)`,
    );
  }

  const toolingText = readAll(toolingFiles);
  const toolingEnvNames = SUPABASE_ENV_NAMES.filter((name) =>
    new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(toolingText),
  );

  metrics["tooling.supabaseMentions"] = countMatches(toolingText, /supabase/i);
  metrics["tooling.supabaseSdkImportHits"] = countMatches(
    toolingText,
    /@supabase\/supabase-js/,
  );
  metrics["tooling.fromCalls"] = countMatches(
    toolingText,
    /(?<!Array)(?<!Object)(?<!Buffer)\.from\s*\(/,
  );
  metrics["tooling.rpcCalls"] = countRpcCalls(toolingText);
  metrics["tooling.storageCalls"] = countMatches(toolingText, /\.storage\b/);
  metrics["tooling.authGetUserCalls"] = countMatches(
    toolingText,
    /\.auth\.getUser\s*\(/,
  );
  metrics["tooling.supabaseEnvVariableFamily"] = toolingEnvNames.length;
  metrics["tooling.supabaseEnvHits"] = SUPABASE_ENV_NAMES.reduce(
    (total, name) =>
      total +
      countMatches(
        toolingText,
        new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`),
      ),
    0,
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

  for (const dir of [...ARCHIVE_DIRS, ...SCRATCH_DIRS]) {
    skipped.push(dir);
  }

  return {
    metrics,
    skipped,
    toolingReport,
    configFiles,
    manifestFiles,
    migrationsDir,
  };
}

/**
 * Coverage gate: prove the audit actually reached the repository it claims to
 * measure. Runs before any baseline comparison, never derived from it.
 */
function checkRequiredScope(root) {
  return REQUIRED_SCOPE.map((entry) => {
    const full = join(root, entry.path);
    const base = {
      label: entry.label,
      kind: entry.kind,
      path: normalizeRelPath(entry.path),
      full,
      files: 0,
    };

    let stats;
    try {
      stats = statSync(full);
    } catch (error) {
      const missing = error && error.code === "ENOENT";
      return { ...base, status: missing ? "missing" : "unreadable" };
    }

    if (entry.kind === "file") {
      if (!stats.isFile()) return { ...base, status: "not-a-file" };
      try {
        readText(full);
      } catch {
        return { ...base, status: "unreadable" };
      }
      return { ...base, files: 1, status: "ok" };
    }

    if (!stats.isDirectory()) return { ...base, status: "not-a-directory" };

    try {
      readdirSync(full);
    } catch {
      return { ...base, status: "unreadable" };
    }

    const files = walkFiles(full, entry.extensions);
    if (files.length === 0) return { ...base, status: "empty" };

    return { ...base, files: files.length, status: "ok" };
  });
}

function formatTable(metrics) {
  return Object.keys(metrics)
    .sort()
    .map((key) => `[metric] ${key} = ${metrics[key]}`)
    .join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const lines = [];
  const problems = [];

  lines.push(`[audit] root=${options.root}`);
  lines.push(`[audit] baseline=${options.baseline}`);

  // ---- coverage gate (fail-closed, independent of the trend) ----------------
  const coverage = checkRequiredScope(options.root);
  for (const entry of coverage) {
    lines.push(
      `[scope] ${entry.label} kind=${entry.kind} files=${entry.files} ` +
        `status=${entry.status} path=${entry.full}`,
    );
  }
  for (const entry of coverage) {
    if (entry.status === "ok") continue;
    problems.push(
      `required scope ${entry.label} (${entry.path}) is ${entry.status}; ` +
        "the audit refuses to certify a repository it could not scan",
    );
  }

  // ---- coupling metrics -----------------------------------------------------
  let collected = null;
  try {
    collected = collect(options.root, options.baseline);
  } catch (error) {
    problems.push(
      `scan failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (collected) {
    const { metrics, skipped, toolingReport, configFiles, manifestFiles } =
      collected;

    lines.push(
      `[audit] configFiles=${configFiles.length} manifests=${manifestFiles.length}`,
    );
    lines.push(
      `[skip] ${skipped.join(", ")} (archive/scratch output is never counted)`,
    );
    lines.push(...toolingReport);
    lines.push(
      "[from] rule: an `untypedFrom(client, table)` call site counts as one " +
        "`server.fromCalls` (and one `server.fromCallsIncludingTests`). " +
        "`http/skills.ts` and `http/skills-marketplace.ts` issue 19 PostgREST " +
        "table calls through that local wrapper, which the `.from(` rule cannot " +
        "see: the call site names the wrapper, not the client. The definition " +
        "line does not match - the `=` sits between the name and the " +
        "parenthesis - so only invocations count. Counting them from ticket 21AD " +
        "on (T-46) moved server.fromCalls 65 -> 84 as an OBSERVATION fix, not as " +
        "a new dependency: no production call, SQL or schema changed. The wrapper " +
        "is deliberately not generalised into 'any helper returning a `.from(` " +
        "receiver' - exactly one such wrapper is known and a guessed pattern " +
        "would count innocent identifiers; a new one must extend this rule by " +
        "hand. Like the `.from(` rule this reads raw text, so a mention inside a " +
        "comment is counted too (T-45, left open on purpose). Workorder 21AE " +
        "moved all nineteen call sites into `db/skill-repository.ts` and deleted " +
        "the two wrapper definitions, so the call count of this rule is 0 from " +
        "21AE on (84 -> 63); the rule is KEPT, not removed, because a future " +
        "wrapper of the same shape still has to be counted by hand.",
    );
    lines.push(
      "[rpc] rule: an RPC call site is counted in both `client.rpc(...)` and " +
        "`(client.rpc as any)(...)` form, with comments/strings/regex literals " +
        "ignored. `grant_plan_credits` (features/credits/credit-service.ts) was " +
        "already a runtime call before ticket 21-preflight B: the type-asserted " +
        "form was a counting gap, so server.rpcCallsRuntime moved 17 -> 18 (and " +
        "server.rpcCallsAll 21 -> 22) as an OBSERVATION fix, not as a new " +
        "dependency. No production RPC call, credits rule or schema changed.",
    );
    lines.push(formatTable(metrics));

    for (const anchor of ANCHORS) {
      const measured = metrics[anchor.key] ?? 0;
      const verdict =
        measured === anchor.value
          ? "match"
          : `DIFFERS by ${measured - anchor.value}`;
      lines.push(
        `[anchor] ${anchor.label}: anchor=${anchor.value} measured[${anchor.key}]=${measured} (${verdict})`,
      );
    }
  }

  // ---- baseline: write or compare -------------------------------------------
  if (options.updateBaseline) {
    if (problems.length > 0 || !collected) {
      lines.push(
        `[!] refusing to write baseline: ${problems.length} problem(s) before ` +
          "any comparison (coverage failures can never be re-baselined away)",
      );
    } else {
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
        metrics: collected.metrics,
      };
      writeFileSync(
        options.baseline,
        `${JSON.stringify(payload, null, 2)}\n`,
        "utf8",
      );
      lines.push(`[OK] baseline written: ${options.baseline}`);
    }
  } else if (!existsSync(options.baseline)) {
    problems.push(`baseline file not found: ${options.baseline}`);
  } else if (collected) {
    const metrics = collected.metrics;
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

try {
  main();
} catch (error) {
  // Fail closed: an audit that could not finish must never look like a pass.
  process.stdout.write(
    `[!] audit failed: ${error instanceof Error ? error.message : String(error)}\n` +
      "[PROBLEMS] 1\n",
  );
  process.exitCode = 1;
}
