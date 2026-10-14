import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The dependency audit is a repository-level tool, and its contract IS its exit
 * code: a repository it could not scan must fail closed instead of reporting a
 * clean zero. These tests therefore drive the real script as a child process
 * and read its real stdout — the same thing an operator runs.
 *
 * Every fixture that has to look "coupled" is assembled from fragments
 * (`@supabase` + `/` + `supabase-js`, `.` + `from(`). A literal import line or a
 * literal PostgREST call in this file would itself land in `apps/server/src`
 * and raise the very counters asserted below. The fixture must not move the
 * numbers it measures.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(TEST_DIR, "..", "..");
const REPO_ROOT = resolve(SERVER_ROOT, "..", "..");
const AUDIT_SCRIPT = join(
  SERVER_ROOT,
  "scripts",
  "audit-supabase-dependencies.mjs",
);
const BASELINE = join(
  SERVER_ROOT,
  "scripts",
  "supabase-dependency-baseline.json",
);

/** Directories copied into a mirror root, relative to the repository root. */
const MIRROR_TREES = [
  "apps/web/src",
  "apps/server/src",
  "apps/server/scripts",
  "scripts",
  "supabase/migrations",
];

/** Files copied into a mirror root, relative to the repository root. */
const MIRROR_FILES = ["package.json", "apps/server/package.json"];

const PROBE_RELATIVE_PATH = "apps/server/scripts/probe.mjs";

const SUPABASE_SDK_PACKAGE = ["@supabase", "supabase-js"].join("/");
const FROM_CALL = "." + "from(";

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

type AuditRun = {
  status: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hahart-audit-${label}-`));
  tempRoots.push(root);
  return root;
}

function copyInto(root: string, relativePath: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(REPO_ROOT, relativePath), target, { recursive: true });
}

function buildMirror(
  label: string,
  options: { skipTrees?: readonly string[]; emptyTrees?: readonly string[] } = {},
): string {
  const root = makeTempRoot(label);
  const skipTrees = new Set(options.skipTrees ?? []);

  for (const relativePath of MIRROR_TREES) {
    if (skipTrees.has(relativePath)) continue;
    if (options.emptyTrees?.includes(relativePath)) {
      mkdirSync(join(root, relativePath), { recursive: true });
      continue;
    }
    copyInto(root, relativePath);
  }
  for (const relativePath of MIRROR_FILES) {
    copyInto(root, relativePath);
  }

  return root;
}

/** A script that exercises every `tooling.*` metric the audit publishes. */
function buildProbeSource(): string {
  return [
    `import { createClient } from "${SUPABASE_SDK_PACKAGE}";`,
    "",
    ...SUPABASE_ENV_NAMES.map(
      (name, index) => `const env${index} = process.env.${name};`,
    ),
    "",
    "const client = createClient(env0, env1);",
    `await client${FROM_CALL}"projects").select("*");`,
    `await client.storage${FROM_CALL}"bucket").upload("key", "body");`,
    'await client.rpc("touch_credit_balance");',
    "await client.auth.getUser();",
    "export {};",
    "",
  ].join("\n");
}

function runAudit(args: readonly string[]): AuditRun {
  const result = spawnSync(process.execPath, [AUDIT_SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 120_000,
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function metricValue(stdout: string, key: string): number {
  const match = new RegExp(`^\\[metric\\] ${key} = (\\d+)$`, "m").exec(stdout);
  if (!match?.[1]) throw new Error(`metric ${key} missing from audit output`);

  return Number(match[1]);
}

function problemCount(stdout: string): number {
  const match = /^\[PROBLEMS\] (\d+)$/m.exec(stdout);
  if (!match?.[1]) throw new Error("[PROBLEMS] line missing from audit output");

  return Number(match[1]);
}

function scopeStatus(stdout: string, label: string): string {
  const match = new RegExp(`^\\[scope\\] ${label} .*status=([a-z-]+) `, "m").exec(
    stdout,
  );
  if (!match?.[1]) throw new Error(`scope ${label} missing from audit output`);

  return match[1];
}

describe("audit-supabase-dependencies: coverage fails closed", () => {
  it("reports a problem and exits 1 for an empty root", () => {
    const root = makeTempRoot("empty");

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(run.stdout).not.toContain("[OK] no Supabase coupling metric increased");
    for (const label of [
      "rootManifest",
      "webSource",
      "serverSource",
      "serverManifest",
      "activeMigrations",
    ]) {
      expect(scopeStatus(run.stdout, label)).toBe("missing");
    }
  });

  it("reports a problem and exits 1 when apps/server/src is missing", () => {
    const root = buildMirror("no-server-src", {
      skipTrees: ["apps/server/src"],
    });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "serverSource")).toBe("missing");
    expect(scopeStatus(run.stdout, "webSource")).toBe("ok");
  });

  it("reports a problem and exits 1 when apps/web/src is missing", () => {
    const root = buildMirror("no-web-src", { skipTrees: ["apps/web/src"] });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "webSource")).toBe("missing");
    expect(scopeStatus(run.stdout, "serverSource")).toBe("ok");
  });

  it("reports a problem and exits 1 when a required scope holds zero source files", () => {
    const root = buildMirror("empty-web-src", { emptyTrees: ["apps/web/src"] });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "webSource")).toBe("empty");
  });

  it("refuses to write a baseline while coverage is failing", () => {
    const root = makeTempRoot("no-write");
    const target = join(root, "would-be-baseline.json");

    const run = runAudit([
      `--root=${root}`,
      `--baseline=${target}`,
      "--update-baseline",
    ]);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("refusing to write baseline");
    expect(existsSync(target)).toBe(false);
  });
});

describe("audit-supabase-dependencies: scripts are inside the audit", () => {
  it("catches an injected occurrence under scripts and returns to zero once removed", () => {
    const root = buildMirror("probe");
    const probePath = join(root, PROBE_RELATIVE_PATH);

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);
    expect(problemCount(before.stdout)).toBe(0);

    const baselineSdkImports = metricValue(
      before.stdout,
      "tooling.supabaseSdkImportHits",
    );

    writeFileSync(probePath, buildProbeSource(), "utf8");
    const injected = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(injected.status).toBe(1);
    expect(problemCount(injected.stdout)).toBeGreaterThanOrEqual(1);
    expect(metricValue(injected.stdout, "tooling.supabaseSdkImportHits")).toBe(
      baselineSdkImports + 1,
    );
    for (const key of [
      "tooling.fromCalls",
      "tooling.rpcCalls",
      "tooling.storageCalls",
      "tooling.authGetUserCalls",
      "tooling.supabaseMentions",
    ]) {
      expect(metricValue(injected.stdout, key)).toBeGreaterThan(
        metricValue(before.stdout, key),
      );
    }
    expect(
      metricValue(injected.stdout, "tooling.supabaseEnvVariableFamily"),
    ).toBe(SUPABASE_ENV_NAMES.length);
    expect(injected.stdout).toContain(
      `[!] metric tooling.supabaseSdkImportHits increased`,
    );

    rmSync(probePath);
    const restored = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(restored.status).toBe(0);
    expect(problemCount(restored.stdout)).toBe(0);
    expect(metricValue(restored.stdout, "tooling.supabaseSdkImportHits")).toBe(
      baselineSdkImports,
    );
  });

  it("counts the repository-root scripts and excludes only the auditor and baseline", () => {
    const run = runAudit([`--baseline=${BASELINE}`]);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[tooling] dir=scripts files=");
    expect(run.stdout).toContain("[tooling] dir=apps/server/scripts files=0");
    expect(run.stdout).toContain(
      "excluded=apps/server/scripts/audit-supabase-dependencies.mjs",
    );
    expect(run.stdout).toContain(
      "excluded=apps/server/scripts/supabase-dependency-baseline.json",
    );
    // The Supabase SDK import and the PostgREST calls live in root scripts
    // only, so a non-zero count proves that scope is really scanned.
    expect(metricValue(run.stdout, "tooling.supabaseSdkImportHits")).toBe(1);
    expect(metricValue(run.stdout, "tooling.fromCalls")).toBeGreaterThanOrEqual(
      5,
    );
    expect(metricValue(run.stdout, "tooling.rpcCalls")).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe("audit-supabase-dependencies: real repository root", () => {
  it("passes with zero problems and unchanged server counters", () => {
    const run = runAudit([`--baseline=${BASELINE}`]);

    expect(run.status).toBe(0);
    expect(problemCount(run.stdout)).toBe(0);
    expect(run.stdout).toContain("[OK] no Supabase coupling metric increased");
    for (const label of [
      "rootManifest",
      "webSource",
      "serverSource",
      "serverManifest",
      "activeMigrations",
    ]) {
      expect(scopeStatus(run.stdout, label)).toBe("ok");
    }

    expect(metricValue(run.stdout, "server.fromCalls")).toBe(155);
    // Guard for this file's own fixture discipline: fragment-assembled probe
    // text must not raise the server test counters it is testing.
    expect(metricValue(run.stdout, "server.testSupabaseSdkImportHits")).toBe(1);
    expect(metricValue(run.stdout, "server.fromCallsIncludingTests")).toBe(155);
  });
});
