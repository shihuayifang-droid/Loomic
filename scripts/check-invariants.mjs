#!/usr/bin/env node
/**
 * Single entry point for the zero-cost invariant checks (QA-03).
 *
 * WHY THIS EXISTS
 *   The zero-cost checks were scattered over `apps/server/_*` and `scripts/`,
 *   so "did anything break?" meant remembering ten file names. This script is
 *   the one command CI and humans run:
 *
 *     node scripts/check-invariants.mjs
 *     pnpm run check:invariants
 *     node scripts/check-invariants.mjs --only <name>     (debug one check)
 *     node scripts/check-invariants.mjs --allow-skips     (warn instead of fail)
 *
 * ADDING A CHECK (required, not optional)
 *   Every newly generated tool / feature MUST add one entry to CHECKS below,
 *   in the same change that introduces it. A check that is not listed here is
 *   invisible to CI, and an invisible red check is the same as no check.
 *
 * WHAT "ZERO COST" MEANS
 *   No network, no provider credits, no database, no secrets. Each entry was
 *   inspected before being listed. Checks that need any external resource are
 *   NOT silently omitted -- they are named in the "NOT INCLUDED" block below
 *   with the reason, so the gap is visible instead of hidden.
 *
 * NOT INCLUDED (needs an external resource / not portable -- do not add these
 * to CHECKS without first making them hermetic):
 *   apps/server/_p02-verify.mjs        HTTP password grant against the real
 *                                      Supabase project (fetch + SUPABASE_ANON_KEY)
 *   apps/server/_p1e-e2e.ts            calls the real image provider; spends
 *                                      money (OPENAI_API_KEY) by design
 *   apps/server/_p2-verify.mjs         pg connection to the real database
 *                                      (SUPABASE_DB_URL); writes scratch rows
 *   apps/server/_p25-verify.ts         real database + Supabase service role key
 *   apps/server/_schema-survey.mjs     REST calls to the live Supabase project
 *                                      (SUPABASE_SERVICE_ROLE_KEY)
 *   apps/server/_errcode-audit.mjs     zero-cost text audit, but it hardcodes
 *                                      absolute paths into D:\cherry stuido\Loomic
 *                                      (the main worktree), so it cannot run in a
 *                                      clean checkout / on CI
 *   scripts/validate-foundation-app.mjs  a typecheck/build gate that writes
 *                                      files, not an invariant check
 *
 * SKIP SEMANTICS ("missing env var must fail")
 *   A check may declare `requiresEnv`. The variables are resolved the same way
 *   the checks themselves resolve them: repo-root `.env.local` first, then
 *   process.env (process.env wins). If anything is missing the check is
 *   reported as SKIP(...) and COUNTED AS A FAILURE, because a gate that cannot
 *   run is not a green gate. `--allow-skips` downgrades that to a warning.
 *
 * Output is plain ASCII with no colours and no progress bar, so it is readable
 * in a CI log.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const DEFAULT_TIMEOUT_MS = 180_000;
const TAIL_LINES = 10;

/**
 * The explicit list. Keep it ordered cheapest-first so a typo fails fast.
 *   name        stable id used by --only and by CI logs
 *   cmd/args    executed directly (no shell), so paths with spaces are safe
 *   cwd         resolved against the repo root
 *   requiresEnv variable names the check cannot work without
 */
const CHECKS = [
  {
    name: "audit-supabase-dependencies",
    cmd: process.execPath,
    args: ["apps/server/scripts/audit-supabase-dependencies.mjs"],
  },
  {
    name: "focus-generating-slots",
    cmd: process.execPath,
    args: ["scripts/check-focus-generating-slots.mjs"],
  },
  {
    name: "merge-files-for-save",
    cmd: process.execPath,
    args: ["scripts/check-merge-files-for-save.mjs"],
  },
  {
    name: "p01-verify",
    cmd: process.execPath,
    args: ["--import", "tsx", "_p01-verify.ts"],
    cwd: "apps/server",
    requiresEnv: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"],
  },
  {
    name: "p1d-verify",
    cmd: process.execPath,
    args: ["--import", "tsx", "_p1d-verify.ts"],
    cwd: "apps/server",
    requiresEnv: ["SUPABASE_DB_URL"],
  },
  {
    name: "p0-verify",
    cmd: process.execPath,
    args: ["--import", "tsx", "_p0-verify.ts"],
    cwd: "apps/server",
  },
  {
    name: "job-registry-parity",
    cmd: process.execPath,
    args: ["--import", "tsx", "_job-registry-parity.ts"],
    cwd: "apps/server",
  },
  {
    name: "image-limits-audit",
    cmd: process.execPath,
    args: ["--import", "tsx", "_image-limits-audit.ts"],
    cwd: "apps/server",
  },
  {
    name: "model-registry-audit",
    cmd: process.execPath,
    args: ["--import", "tsx", "_model-registry-audit.ts"],
    cwd: "apps/server",
  },
];

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const FILE_ENV = readEnvFile(resolve(ROOT, ".env.local"));
const ENV = { ...FILE_ENV, ...process.env };

function parseArgv(argv) {
  const opts = { only: null, allowSkips: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-skips") {
      opts.allowSkips = true;
    } else if (arg === "--only") {
      opts.only = argv[++i] ?? null;
    } else if (arg.startsWith("--only=")) {
      opts.only = arg.slice("--only=".length);
    } else {
      opts.unknownArg = arg;
    }
  }
  return opts;
}

function tailLines(text, count) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-count);
}

function indent(text, pad) {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : pad + line))
    .join("\n");
}

function makeLine(nameWidth) {
  return (index, total, name, status) => {
    const dots = ".".repeat(Math.max(3, nameWidth - name.length));
    return `[${index}/${total}] ${name} ${dots} ${status}`;
  };
}

function runCheck(check) {
  const started = Date.now();
  const result = spawnSync(check.cmd, check.args, {
    cwd: resolve(ROOT, check.cwd ?? "."),
    env: ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const timedOut = result.error?.code === "ETIMEDOUT";
  const spawnError = result.error && !timedOut ? result.error : null;
  const status = timedOut || spawnError ? null : result.status;
  return { seconds, output, timedOut, spawnError, status };
}

const opts = parseArgv(process.argv.slice(2));

if (opts.unknownArg) {
  console.error(`[ERROR] unknown argument: ${opts.unknownArg}`);
  console.error(`[ERROR] known arguments: --only <name>, --allow-skips`);
  process.exit(2);
}

let selected = CHECKS;
if (opts.only) {
  selected = CHECKS.filter((check) => check.name === opts.only);
  if (selected.length === 0) {
    console.error(`[ERROR] unknown check: ${opts.only}`);
    console.error(`[ERROR] known checks: ${CHECKS.map((c) => c.name).join(", ")}`);
    process.exit(2);
  }
}

const nameWidth = Math.max(...selected.map((c) => c.name.length)) + 3;
const line = makeLine(nameWidth);
const total = selected.length;

let failures = 0;
let skipped = 0;

for (let i = 0; i < selected.length; i++) {
  const check = selected[i];
  const index = i + 1;

  const requiredEnv = check.requiresEnv ?? [];
  const missing = requiredEnv.filter((name) => !ENV[name]);

  if (missing.length > 0) {
    skipped++;
    const counted = opts.allowSkips ? "SKIP" : "FAIL";
    if (!opts.allowSkips) failures++;
    console.log(line(index, total, check.name, `${counted} (missing env)`));
    console.log(`    SKIP(${check.name}): missing ${missing.join(",")}`);
    continue;
  }

  const outcome = runCheck(check);

  if (outcome.timedOut) {
    failures++;
    console.log(line(index, total, check.name, `FAIL (timeout ${
      (check.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s)`));
    const tail = tailLines(outcome.output, TAIL_LINES);
    if (tail.length > 0) {
      console.log(indent(tail.join("\n"), "    "));
    }
    continue;
  }

  if (outcome.spawnError) {
    failures++;
    console.log(line(index, total, check.name, "FAIL (could not start)"));
    console.log(indent(String(outcome.spawnError.message ?? outcome.spawnError), "    "));
    continue;
  }

  if (outcome.status === 0) {
    console.log(line(index, total, check.name, `OK (exit 0, ${outcome.seconds}s)`));
    continue;
  }

  failures++;
  console.log(
    line(index, total, check.name, `FAIL (exit ${outcome.status}, ${outcome.seconds}s)`),
  );
  const tail = tailLines(outcome.output, TAIL_LINES);
  if (tail.length > 0) {
    console.log(indent(tail.join("\n"), "    "));
  }
}

console.log(`TOTAL FAILURES: ${failures}`);
console.log(`TOTAL CHECKS: ${total} (skipped: ${skipped})`);
process.exit(failures > 0 ? 1 : 0);
