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

/**
 * Every test in this file copies a mirror of the repository and drives the real
 * audit script as a child process, so its cost tracks the size of the source
 * tree and the load of a full parallel run. This budget widens only the outer
 * Vitest limit; the 120s `spawnSync` ceiling in `runAudit` is unchanged. Thirty
 * seconds is not a performance SLA.
 */
const AUDIT_TEST_TIMEOUT_MS = 30_000;

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

/**
 * A runtime-scope probe: a `.ts` file under `apps/server/src` that is neither a
 * test nor CLI tooling, so it moves `server.rpcCallsRuntime` (and with it
 * `server.rpcCallsAll`) and never a `tooling.*` metric. It only ever exists
 * inside a temp mirror - writing it into the repository would be a real
 * coupling change, which is exactly what this audit is there to prevent.
 */
const RUNTIME_PROBE_RELATIVE_PATH = "apps/server/src/audit-rpc-probe.ts";

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

/**
 * One chained RPC and one parenthesised, TypeScript-asserted RPC. Both are real
 * call syntax, so a runtime counter must see exactly two calls.
 */
function buildRpcFormProbeSource(): string {
  return [
    "declare const admin: any;",
    'await admin.rpc("deduct_credits", { p_workspace_id: "w" });',
    'await (admin.rpc as any)("grant_plan_credits", { p_workspace_id: "w" });',
    "export {};",
    "",
  ].join("\n");
}

/** The type-asserted form on its own, for the rise-and-restore probe. */
function buildTypedRpcProbeSource(): string {
  return [
    "declare const admin: any;",
    'await (admin.rpc as any)("grant_plan_credits", { p_workspace_id: "w" });',
    "export {};",
    "",
  ].join("\n");
}

/**
 * Every way the literal `.rpc(` appears WITHOUT being a call: a line comment, a
 * block comment, string/template/regex literal contents, a property read, a
 * destructured property name, and type assertions that are never invoked. The
 * file ends with exactly one real chained call as the control, so the counter
 * must move by exactly one: anything the four prose categories contributed
 * would push the delta above one, and a detector that stopped working would
 * drop it below one.
 */
function buildRpcProseProbeSource(): string {
  return [
    "declare const admin: any;",
    "",
    '// comment: admin.rpc("grant_plan_credits") is never executed',
    '/* block comment: admin.rpc("grant_plan_credits") is never executed */',
    "",
    "const single = 'admin.rpc(\"grant_plan_credits\")';",
    "const double = \"admin.rpc('grant_plan_credits')\";",
    "const template = `admin.rpc(\"grant_plan_credits\")`;",
    "const pattern = /\\.rpc\\(/;",
    "",
    "const propertyName = admin.rpc;",
    "const { rpc: aliased } = admin;",
    "",
    "const asserted = (admin.rpc as any);",
    "const alsoAsserted = admin.rpc as any;",
    "",
    'await admin.rpc("deduct_credits", { p_workspace_id: "w" });',
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
  }, AUDIT_TEST_TIMEOUT_MS);

  it("reports a problem and exits 1 when apps/server/src is missing", () => {
    const root = buildMirror("no-server-src", {
      skipTrees: ["apps/server/src"],
    });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "serverSource")).toBe("missing");
    expect(scopeStatus(run.stdout, "webSource")).toBe("ok");
  }, AUDIT_TEST_TIMEOUT_MS);

  it("reports a problem and exits 1 when apps/web/src is missing", () => {
    const root = buildMirror("no-web-src", { skipTrees: ["apps/web/src"] });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "webSource")).toBe("missing");
    expect(scopeStatus(run.stdout, "serverSource")).toBe("ok");
  }, AUDIT_TEST_TIMEOUT_MS);

  it("reports a problem and exits 1 when a required scope holds zero source files", () => {
    const root = buildMirror("empty-web-src", { emptyTrees: ["apps/web/src"] });

    const run = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(run.status).toBe(1);
    expect(problemCount(run.stdout)).toBeGreaterThanOrEqual(1);
    expect(scopeStatus(run.stdout, "webSource")).toBe("empty");
  }, AUDIT_TEST_TIMEOUT_MS);

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
  }, AUDIT_TEST_TIMEOUT_MS);
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
  }, AUDIT_TEST_TIMEOUT_MS);

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
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe("audit-supabase-dependencies: typed RPC call forms", () => {
  it("counts the type-asserted RPC form beside the chained form as runtime RPCs", () => {
    const root = buildMirror("rpc-forms");
    const probePath = join(root, RUNTIME_PROBE_RELATIVE_PATH);

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);
    expect(problemCount(before.stdout)).toBe(0);

    writeFileSync(probePath, buildRpcFormProbeSource(), "utf8");
    const after = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    // One chained call plus one type-asserted call: the chained form must still
    // count, and the cast form must count for the first time, so each counter
    // moves by exactly two and the rise is reported as a problem.
    expect(metricValue(after.stdout, "server.rpcCallsRuntime")).toBe(
      metricValue(before.stdout, "server.rpcCallsRuntime") + 2,
    );
    expect(metricValue(after.stdout, "server.rpcCallsAll")).toBe(
      metricValue(before.stdout, "server.rpcCallsAll") + 2,
    );
    expect(after.status).toBe(1);
    expect(after.stdout).toContain("[!] metric server.rpcCallsRuntime increased");
  }, AUDIT_TEST_TIMEOUT_MS);

  it("ignores `.rpc(` in comments, strings, property names and uncalled assertions", () => {
    const root = buildMirror("rpc-prose");
    const probePath = join(root, RUNTIME_PROBE_RELATIVE_PATH);
    const source = buildRpcProseProbeSource();

    // Guard against a vacuous pass: the fixture really does carry the token in
    // every non-call shape it claims to cover.
    expect(source).toContain(".rpc(");

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);

    writeFileSync(probePath, source, "utf8");
    const after = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    // The file holds exactly one real call, so a delta of exactly one proves
    // that comments, strings, regex contents, property names and uncalled
    // assertions all contributed zero.
    expect(metricValue(after.stdout, "server.rpcCallsRuntime")).toBe(
      metricValue(before.stdout, "server.rpcCallsRuntime") + 1,
    );
    expect(metricValue(after.stdout, "server.rpcCallsAll")).toBe(
      metricValue(before.stdout, "server.rpcCallsAll") + 1,
    );
  }, AUDIT_TEST_TIMEOUT_MS);

  it("flags a rise once the type-asserted form crosses the frozen baseline and returns to zero once removed", () => {
    const root = buildMirror("rpc-rise");
    const probePath = join(root, RUNTIME_PROBE_RELATIVE_PATH);

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);
    expect(problemCount(before.stdout)).toBe(0);
    // Workorder 21F moved `increment_job_attempt` into the pure `pg`
    // repository, and workorder 21F-fixup re-baselined the frozen numbers to the
    // measurement that produced (17 runtime / 21 total). A mirror of the
    // repository therefore now sits EXACTLY ON the baseline — which is the lower
    // edge of the boundary: equal is not an increase, and the auditor must not
    // report one.
    expect(metricValue(before.stdout, "server.rpcCallsRuntime")).toBe(17);
    expect(metricValue(before.stdout, "server.rpcCallsAll")).toBe(21);

    // ONE extra type-asserted call is therefore enough to cross the baseline by
    // exactly one, and both counters must be reported as risen. That is the upper
    // edge, and it is the tightest crossing the auditor can be asked to notice: a
    // single-call probe fails if the comparison is off by one in either direction
    // (a `>=` comparison would report the equal case above, and a `<`/off-by-one
    // ceiling would miss this one).
    writeFileSync(probePath, buildTypedRpcProbeSource(), "utf8");
    const injected = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(injected.status).toBe(1);
    expect(problemCount(injected.stdout)).toBeGreaterThanOrEqual(1);
    expect(injected.stdout).toContain("[!] metric server.rpcCallsRuntime increased");
    expect(injected.stdout).toContain("[!] metric server.rpcCallsAll increased");
    expect(metricValue(injected.stdout, "server.rpcCallsRuntime")).toBe(
      metricValue(before.stdout, "server.rpcCallsRuntime") + 1,
    );
    expect(metricValue(injected.stdout, "server.rpcCallsAll")).toBe(22);

    rmSync(probePath);
    const restored = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(restored.status).toBe(0);
    expect(problemCount(restored.stdout)).toBe(0);
    expect(metricValue(restored.stdout, "server.rpcCallsRuntime")).toBe(
      metricValue(before.stdout, "server.rpcCallsRuntime"),
    );
    expect(metricValue(restored.stdout, "server.rpcCallsAll")).toBe(
      metricValue(before.stdout, "server.rpcCallsAll"),
    );
  }, AUDIT_TEST_TIMEOUT_MS);
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

    // Workorder 20D moved the four chat read points (session list, message
    // history, asset identities, thread binding) into the pure `pg` repository,
    // workorder 20E moved the five read-only lookups the Project/Upload WRITE
    // flows perform (archive existence, thumbnail workspace, upload project +
    // row read-back, delete locate) after it, workorder 20F-A moved the three
    // reads behind the team member list (team workspace, members, profiles) into
    // one statement, and workorder 20F-B moved the last runtime PostgREST lookup
    // of `TeamAdminService.addMember` (the profile behind an email) into that
    // repository. Workorder 21B then moved the three writes of
    // `ChatService.createMessage` — the message insert (139→136), the same-id
    // confirmation read and the session touch — into `ChatWriteRepository`,
    // workorder 21C moved the chat SESSION CRUD — the `chat_sessions` insert
    // (136→133), the title update and the delete — into
    // `ChatSessionWriteRepository`, and workorder 21D moved the LAST single-table
    // write, the `profiles` display-name update behind
    // `PATCH /api/viewer/profile` (133→132), into `ProfileWriteRepository`.
    // Workorder 21E1 then moved the single-key `workspace_settings.default_model`
    // upsert behind `PUT /api/workspace/settings` (132→131) into
    // `WorkspaceSettingsWriteRepository`, which also removed the last PostgREST
    // write from `SettingsService` — the READ of the same table is untouched and
    // is still counted here. The Supabase-RPC write of the credits rules and the
    // cache invalidation after it are unchanged.
    expect(metricValue(run.stdout, "server.fromCalls")).toBe(131);
    // Guard for this file's own fixture discipline: fragment-assembled probe
    // text must not raise the server test counters it is testing.
    expect(metricValue(run.stdout, "server.testSupabaseSdkImportHits")).toBe(1);
    expect(metricValue(run.stdout, "server.fromCallsIncludingTests")).toBe(131);

    // Workorder 21-preflight B (T-35): `CreditService.updatePlan` invokes
    // `grant_plan_credits` through a parenthesised type assertion —
    // `(admin.rpc as any)("grant_plan_credits", ...)` in
    // `features/credits/credit-service.ts` — which the pre-ticket auditor never
    // matched. The call itself is untouched and predates this ticket, so the
    // runtime observation moved 17 -> 18 and, with the four CLI call sites
    // unchanged, all 21 -> 22. Everything downstream of the write stays put.
    //
    // Workorder 21F then moved the LAST runtime RPC of the job pipeline —
    // `increment_job_attempt`, called from `features/jobs/job-service.ts` — into
    // `JobAttemptRepository` (pure `pg`), so the runtime observation moves back
    // DOWN 18 -> 17 and, with the four CLI call sites unchanged, all 22 -> 21.
    // This is a real coupling removal rather than a counting change: no RPC call
    // site of any form is left in that file. `fromCalls` and every other counter
    // stay exactly where workorder 21E1 left them.
    expect(metricValue(run.stdout, "server.rpcCallsRuntime")).toBe(17);
    expect(metricValue(run.stdout, "server.rpcCallsAll")).toBe(21);

    // The published anchor is a CONSTANT of the audit script
    // (`ANCHORS.server.runtimeRpc`) mirrored by the baseline's
    // `anchors.server.runtimeRpc`. Workorder 21F-fixup pins BOTH to the
    // observation above (18 -> 17), so the published line must report the frozen
    // anchor agreeing with the live measurement instead of the previous
    // `anchor=18 ... (DIFFERS by -1)`. Matched as a whole line: a stale anchor or
    // a silently moved counter cannot pass by appearing somewhere else in the
    // output.
    //
    // This is the exact reverse of workorder 21C-preflight D, which pinned
    // 17 -> 18 (`8308315`) when the anchor was frozen ABOVE the measurement; the
    // anchor now follows the real coupling down instead of being left behind.
    expect(run.stdout).toMatch(
      /^\[anchor\] server\.runtimeRpc: anchor=17 measured\[server\.rpcCallsRuntime\]=17 \(match\)$/m,
    );

    expect(metricValue(run.stdout, "server.storageCalls")).toBe(23);
    expect(metricValue(run.stdout, "server.authGetUserCalls")).toBe(1);
    expect(metricValue(run.stdout, "server.supabaseSdkImportHits")).toBe(3);
  }, AUDIT_TEST_TIMEOUT_MS);
});
