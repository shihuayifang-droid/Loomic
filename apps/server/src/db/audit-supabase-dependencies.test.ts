import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * Pinned audit numbers come from the baseline JSON, the single place a reducing
 * ticket lowers them. The assertions below still mean "measured = baseline".
 */
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as {
  metrics: Record<string, number>;
};

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

/**
 * The same shape of probe for the `untypedFrom` wrapper rule (workorder 21AD /
 * T-46): production scope, no test suffix, so it moves `server.fromCalls` and
 * `server.fromCallsIncludingTests` together and never a `server.test*` key.
 */
const UNTYPED_FROM_PROBE_RELATIVE_PATH =
  "apps/server/src/audit-untyped-from-probe.ts";

const SUPABASE_SDK_PACKAGE = ["@supabase", "supabase-js"].join("/");
const FROM_CALL = "." + "from(";

/**
 * The `untypedFrom` invocation token, split for exactly the same reason as
 * `FROM_CALL`: this file is itself inside the server test scope, so a literal
 * occurrence here would raise `server.fromCallsIncludingTests` by the number of
 * fixture lines that carry it and would make the real-repository pins below
 * depend on this file's own prose.
 */
const UNTYPED_FROM_CALL = "untypedFrom" + "(";

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

/**
 * The `untypedFrom` wrapper of `http/skills.ts` and `http/skills-marketplace.ts`
 * (workorder 21AD / T-46): the definition, two invocations and one comment
 * mention. The definition contributes one from call - it is the wrapper's own
 * body - so the counter must move by exactly 1 definition + 2 calls + 1 comment
 * = 4, and that sum is what pins both halves of the rule at once.
 */
function buildUntypedFromProbeSource(): string {
  return [
    "declare const client: any;",
    `const untypedFrom = (c, t) => (c as any)${FROM_CALL}t);`,
    `await ${UNTYPED_FROM_CALL}client, "x")`,
    `await ${UNTYPED_FROM_CALL}client, "x")`,
    `// ${UNTYPED_FROM_CALL}client, "y")`,
    "export {};",
    "",
  ].join("\n");
}

/**
 * The same definition with no call site at all. The `=` between the wrapper name
 * and its parenthesis keeps the definition from matching the wrapper rule, so
 * this fixture must move the counter by exactly one - the body's own from call.
 */
function buildUntypedFromDefinitionProbeSource(): string {
  return [
    "declare const client: any;",
    `const untypedFrom = (c, t) => (c as any)${FROM_CALL}t);`,
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
    expect(metricValue(before.stdout, "server.rpcCallsRuntime")).toBe(
      baseline.metrics["server.rpcCallsRuntime"],
    );
    expect(metricValue(before.stdout, "server.rpcCallsAll")).toBe(
      baseline.metrics["server.rpcCallsAll"],
    );

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
    expect(metricValue(injected.stdout, "server.rpcCallsAll")).toBe(
      Number(baseline.metrics["server.rpcCallsAll"]) + 1,
    );

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

describe("audit-supabase-dependencies: untypedFrom wrapper calls", () => {
  it("counts the wrapper definition, its call sites and its comment mentions", () => {
    const root = buildMirror("untyped-from-calls");
    const probePath = join(root, UNTYPED_FROM_PROBE_RELATIVE_PATH);
    const source = buildUntypedFromProbeSource();

    // Guard against a vacuous pass: the fixture really does carry the token in
    // every shape this case claims to cover.
    expect(source).toContain("untypedFrom");

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);
    expect(problemCount(before.stdout)).toBe(0);

    writeFileSync(probePath, source, "utf8");
    const after = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    // One definition (its own from call), two invocations and one comment
    // mention: a delta of exactly four pins BOTH halves of the rule - that a
    // call site is counted, and that a mention inside a comment is counted too,
    // which is the same raw-text treatment the from-call rule already has
    // (T-45 stays open on purpose, it is not fixed here).
    //
    // Since ticket 44A the baseline equals the measurement, so any rise fails the audit, like the RPC probes.
    expect(metricValue(after.stdout, "server.fromCalls")).toBe(
      metricValue(before.stdout, "server.fromCalls") + 4,
    );
    expect(metricValue(after.stdout, "server.fromCallsIncludingTests")).toBe(
      metricValue(before.stdout, "server.fromCallsIncludingTests") + 4,
    );
    expect(after.status).toBe(1);
    expect(problemCount(after.stdout)).toBeGreaterThanOrEqual(1);
    expect(after.stdout).toContain("[!] metric server.fromCalls increased");

    rmSync(probePath);
    const restored = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    expect(metricValue(restored.stdout, "server.fromCalls")).toBe(
      metricValue(before.stdout, "server.fromCalls"),
    );
    expect(
      metricValue(restored.stdout, "server.fromCallsIncludingTests"),
    ).toBe(metricValue(before.stdout, "server.fromCallsIncludingTests"));
    expect(restored.status).toBe(0);
    expect(problemCount(restored.stdout)).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);

  it("counts a wrapper definition with no call site as exactly one", () => {
    const root = buildMirror("untyped-from-definition");
    const probePath = join(root, UNTYPED_FROM_PROBE_RELATIVE_PATH);

    const before = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);
    expect(before.status).toBe(0);
    expect(problemCount(before.stdout)).toBe(0);

    writeFileSync(probePath, buildUntypedFromDefinitionProbeSource(), "utf8");
    const after = runAudit([`--root=${root}`, `--baseline=${BASELINE}`]);

    // Only the body's own from call moves the counter, by exactly one: the `=`
    // between the wrapper name and its parenthesis keeps the definition from
    // being mistaken for an invocation, which is the negative half of the rule
    // (a rule that matched the definition too would count two here).
    expect(metricValue(after.stdout, "server.fromCalls")).toBe(
      metricValue(before.stdout, "server.fromCalls") + 1,
    );
    expect(metricValue(after.stdout, "server.fromCallsIncludingTests")).toBe(
      metricValue(before.stdout, "server.fromCallsIncludingTests") + 1,
    );
    expect(problemCount(after.stdout)).toBeGreaterThanOrEqual(1);
    expect(after.stdout).toContain("[!] metric server.fromCalls increased");
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
    // write from `SettingsService` — the READ of the same table was left behind
    // by that ticket and is still counted here until workorder 21L moves it (see
    // below). The Supabase-RPC write of the credits rules and the cache
    // invalidation after it are unchanged.
    //
    // Workorder 21G then moved the last two server-only `agent_runs` writes — the
    // accepted INSERT and the run metadata UPDATE behind
    // `AgentRunMetadataService` (131→129) — into
    // `AgentRunWriteRepository`, which leaves that service with no PostgREST path
    // at all: it no longer receives an admin client, and a missing repository is a
    // persistence failure rather than a fallback. Both counters move together
    // because both files are production source, and no READ of `agent_runs` ever
    // existed here to be left behind.
    //
    // Workorder 21H2 then moved the admin PostgREST write of
    // `JobService.setCreditsInfo` — the credits link that closes a job — into
    // `JobCreditsLinkRepository` (129→128), so both counters below move down
    // together. The credits RULE invocation further down is a Supabase RPC with
    // its own counter and is untouched.
    //
    // Workorder 21I then moved the admin single-row READ behind
    // `JobService.getJobAdmin` — the job watcher's poll and the agent runtime's
    // re-read of a job it is about to settle — into `JobAdminReadRepository`
    // (128→127), so both counters below move down together again. That is a real
    // coupling removal rather than a counting change: `getJobAdmin` no longer
    // receives an admin client at all, and the repository that replaces it can
    // only reach PostgreSQL. The two new test files of that workorder carry no
    // PostgREST call of their own — their fixtures name no client method — which
    // is why `fromCallsIncludingTests` follows `fromCalls` down instead of
    // parting from it. The RPC counters are untouched: this migration removed no
    // RPC call site.
    //
    // Workorder 21J then moved the LAST PostgREST read of
    // `features/credits/tier-guard.ts` — the plan's active-job count behind
    // `TierGuard.checkConcurrency` — into `JobConcurrencyRepository` (127→126), so
    // both counters below move down together one last time. That is a real
    // coupling removal rather than a counting change: `createTierGuard` no longer
    // receives an admin client at all, and the repository that replaces it can
    // only reach PostgreSQL, where the three slot-holding statuses are written
    // into the statement instead of being bound as a `text[]`. Its three new test
    // files name no client method, so `fromCallsIncludingTests` follows
    // `fromCalls` down again. The RPC counters are untouched: this migration
    // removed no RPC call site.
    //
    // Workorder 21K then moved the last two PostgREST reads of
    // `features/credits/credit-service.ts` — the workspace transaction list and
    // the workspace subscription row — into `CreditReadRepository` (126->124),
    // so both counters below move down together one last time. That is a real
    // coupling removal rather than a counting change: those two methods no
    // longer receive an admin client at all, and the repository that replaces
    // them can only reach PostgreSQL, where the workspace predicate is
    // `$1::uuid` and the transaction limit is bound as `$2::int` instead of
    // being written into the statement. Its three new test files name no client
    // method, so `fromCallsIncludingTests` follows `fromCalls` down again. The
    // RPC counters are untouched: this migration removed no RPC call site — the
    // remaining RPC of that service is the plan grant, whose counter is
    // unchanged.
    //
    // Workorder 21L then moved the LAST PostgREST read of
    // `features/settings/settings-service.ts` — the `workspace_settings` row
    // behind `GET /api/workspace/settings` (which `http/runs.ts` and
    // `ws/handler.ts` also read to pick the model an agent run starts on) — into
    // `WorkspaceSettingsReadRepository` (124->123), so both counters below move
    // down together one last time. That is a real coupling removal rather than a
    // counting change: `createSettingsService` no longer receives a user-scoped
    // client at all, and the repository that replaces it can only reach
    // PostgreSQL, where the membership predicate of the replaced
    // `workspace_settings_select` policy is written into the statement verbatim
    // (any role reads; a non-member gets `null`, which the service turns into its
    // default model rather than a 403). Its three new test files name no client
    // method, so `fromCallsIncludingTests` follows `fromCalls` down again. The
    // RPC counters are untouched: this migration removed no RPC call site.
    //
    // Workorder 21M then moved the LAST PostgREST writes of
    // `features/jobs/job-service.ts` — the four guarded status transitions
    // (`markRunning`/`markRetrying`/`markSucceeded`/`markFailed`, which all went
    // through one caller-parameterised update) — into `JobTransitionRepository`
    // (123->122), so both counters below move down together one last time. That
    // is a real coupling removal rather than a counting change: those four
    // methods no longer receive an admin client at all, and the repository that
    // replaces them can only reach PostgreSQL, where the `from` set and the
    // target status are SQL literals of that one file instead of arguments. Its
    // two new test files name no client method, so `fromCallsIncludingTests`
    // follows `fromCalls` down again. The RPC counters are untouched: this
    // migration removed no RPC call site.
    //
    // Workorder 21N then removed the LAST two admin PostgREST job-row reads —
    // the byte-identical single-row read that `image-generation.ts` and
    // `video-generation.ts` each carried, now the shared `loadExecutorJob` helper
    // calling `JobService.getJobAdmin` (itself already on `pg` since workorder
    // 21I) — so both counters below move down together again (122->120). That is
    // a real coupling removal rather than a counting change: neither executor
    // takes an admin client for that read any more, and the helper names no
    // client method of any form. Its one new test file names no client method
    // either, so `fromCallsIncludingTests` follows `fromCalls` down again. The
    // RPC counters are untouched: this migration removed no RPC call site.
    //
    // Workorder 21O then removed the LAST admin PostgREST read of `worker.ts` —
    // the three-column job row (`credits_cost, workspace_id, created_by`) the
    // worker read before refunding a terminally failed job — so both counters
    // below move down together again (120->119). That is a real coupling removal
    // rather than a counting change: the read now goes through
    // `JobRefundBasisRepository` (pure `pg`), so the worker no longer names a
    // client method for it, and the refund decision itself moved to
    // `features/jobs/refund-job.ts` with the condition, the amount, the
    // description and the never-throwing contract unchanged. Its three new test
    // files name no client method either, so `fromCallsIncludingTests` follows
    // `fromCalls` down again. The RPC counters are untouched: `refund_credits` is
    // still the one RPC of this path and this migration removed no RPC call site.
    //
    // Workorder 21P then removed the LAST three admin PostgREST reads of
    // `features/credits/credit-service.ts` — the parallel `Promise.all` behind
    // `getBalance` (the workspace balance, the workspace subscription and the
    // day's claim row) — so both counters below move down together again
    // (119->116). That is a real coupling removal rather than a counting change:
    // `getBalance` no longer receives an admin client at all, and the ONE
    // statement that replaces the three reads can only reach PostgreSQL, where
    // the workspace predicate is `$1::uuid`, the day is bound as `$2::date` and
    // the claim answer is an `exists` inside the statement instead of a row that
    // may or may not come back. Its three test files name no client method, so
    // `fromCallsIncludingTests` follows `fromCalls` down again. The RPC counters
    // are untouched: this migration removed no RPC call site — the remaining RPC
    // of that service is still the plan grant.
    //
    // Workorder 21Q then removed the LAST two admin PostgREST reads of
    // `features/credits/credit-service.ts` — the plan read that `claimDailyCredits`
    // makes BEFORE granting the day's credits and the balance read it makes AFTER
    // — so both counters below move down together again (116->114). That is a
    // real coupling removal rather than a counting change: the plan now comes
    // from `CreditReadRepository.readSubscription` and the updated balance from
    // its `readBalanceSnapshot`, so neither read names a client method any more
    // and the grant's own RPC is the only thing left reaching that client from
    // this method. Its new cases name no client method either, so
    // `fromCallsIncludingTests` follows `fromCalls` down again. The RPC counters
    // are untouched: this migration removed no RPC call site.
    //
    // Workorder 21R then removed the LAST seven PostgREST reads of the Agent
    // runtime's canvas → project path — `resolveBrandKitId` in
    // `agent/runtime.ts` (three: the joined read and both steps of its fallback),
    // `resolveCanvasProjectId` in the same file (one) and `resolveWorkspaceId` in
    // `agent/workspace-skills.ts` (three: the joined read and both steps of its
    // fallback) — so both counters below move down together again (114->107).
    // All three asked the same question, so they collapse into ONE statement on
    // `CanvasReadRepository.findReadableCanvasProjectLink`, which the run now
    // issues once and answers the brand kit and the workspace skills from. That
    // is a real coupling removal rather than a counting change: none of the three
    // call sites names a client method any more, and the predicate is
    // `private.can_read_project` verbatim — including the fact that it has NO
    // `archived_at` term, so an archived project's canvas keeps resolving.
    // `workspace_skills` / `skill_files` stay on the user client and are counted
    // exactly as before. Its new cases name no client method either, so
    // `fromCallsIncludingTests` follows `fromCalls` down again. The RPC counters
    // are untouched: this migration removed no RPC call site.
    //
    // Workorder 21S then removed the LAST PostgREST read of the Agent runtime's
    // attachment path — `resolveAttachmentContent` in `agent/runtime.ts`, which
    // read the single `asset_objects` row behind each attachment's `assetId`
    // before signing it — so both counters below move down together again
    // (107->106). That is a real coupling removal rather than a counting change:
    // the row now comes from `AssetReadRepository.findReadableAsset`, whose
    // statement carries the run's own actor id and re-applies the asset's
    // two-branch read ACL verbatim, with no archive filter in either, so this
    // path no longer names a client method for the read and the caller's client
    // is kept for the SIGNATURE alone. Its new cases name no client method
    // either, so `fromCallsIncludingTests` follows `fromCalls` down again. The
    // RPC counters are untouched: this migration removed no RPC call site.
    //
    // Workorder 21T then removed the LAST two PostgREST reads of
    // `features/jobs/job-service.ts` — the CALLER's own job row behind
    // `getJob` (`GET /api/jobs/:jobId`) and the CALLER's own job list behind
    // `listJobs` (`GET /api/jobs`) — so both counters below move down together
    // again (106->104). That is a real coupling removal rather than a counting
    // change: neither method takes a user client for a read any more, and the
    // repository that replaces them can only reach PostgreSQL, where the ACL the
    // table's RLS policy applied is written into the statement verbatim as
    // `created_by = $1::uuid`, the filters are bound WITH their enum casts (so an
    // unknown value stays the 500 it was instead of quietly matching nothing),
    // and the order and the 50-row cap are statement text rather than caller
    // arguments. `createUserClient` stays wired for `createJob` and `cancelJob`,
    // which still read and write through it and are counted exactly as before.
    // Its two new test files name no client method either, so
    // `fromCallsIncludingTests` follows `fromCalls` down again. The RPC counters
    // are untouched: this migration removed no RPC call site.
    //
    // Workorder 21U then removed the LAST PostgREST write of
    // `features/jobs/job-service.ts` — the caller's OWN job cancel behind
    // `cancelJob` (`POST /api/jobs/:jobId/cancel`), which is also the reaction
    // `withBilling` runs when a charge fails — so both counters below move down
    // together again (104->103). That is a real coupling removal rather than a
    // counting change: the method no longer builds a user client at all, and the
    // repository that replaces it can only reach PostgreSQL, where the ACL the
    // table's RLS policy applied is written into the statement verbatim as
    // `created_by = $1::uuid`, the cancel guard (`status in ('queued', 'running')`,
    // `retrying` excluded) and the two columns written are statement text rather
    // than caller arguments, and `updated_at` is left to the table's trigger.
    // `createUserClient` stays wired for `createJob`, which still reads and writes
    // through it and is counted exactly as before. Its two new test files name no
    // client method either, so `fromCallsIncludingTests` follows `fromCalls` down
    // again. The RPC counters are untouched: this migration removed no RPC call
    // site.
    // Workorder 21V then removed the LAST two PostgREST reads of
    // `features/jobs/job-service.ts` — the two authorization reads `createJob`
    // performs before it inserts anything: "which project is this canvas's?" (a
    // `canvases` row) and "may this caller use this project?" (a `projects` row,
    // for a submission with no canvas) — so both counters below move down
    // together again (103->101). That is a real coupling removal rather than a
    // counting change: both branches now call the repositories that already
    // answer those two questions, `CanvasReadRepository.findReadableCanvasProjectLink`
    // (workorder 21R) and
    // `ProjectReadRepository.findReadableProjectWorkspaceForMutation` (workorder
    // 20B), whose ACL is `private.can_read_project` verbatim and whose statements
    // deliberately carry NO `archived_at` filter — which is why a generation
    // submitted from an archived project's canvas is still authorized, as the
    // real-SQL ACL cases of that workorder measure. The caller's client stays
    // wired for what did NOT move: the job INSERT and the compensation DELETE of a
    // failed enqueue are counted exactly as before, and a missing repository is
    // the branch's existing 500 rather than a fallback to it. Its new cases name
    // no client method either, so `fromCallsIncludingTests` follows `fromCalls`
    // down again. The RPC counters are untouched: this migration removed no RPC
    // call site.
    //
    // Workorder 21W then removed the LAST PostgREST read of
    // `features/jobs/executors/image-generation.ts` — the workspace subscription
    // row the image executor read to decide whether to watermark a generated
    // image — so both counters below move down together again (101->100). That is
    // a real coupling removal rather than a counting change: the executor asks
    // `ExecutorContext.creditReadRepository` for the plan (workorder 21K's
    // `CreditReadRepository.readSubscription`, built in `worker.ts` beside the
    // other `pg` repositories) instead of naming a client method of its own. The
    // behaviour is unchanged in the direction that matters: no repository, no
    // subscription row and a failed read all still mean the free plan, and a free
    // plan is still watermarked, exactly as the discarded error field produced.
    // Its cases name no client method either, so `fromCallsIncludingTests`
    // follows `fromCalls` down again. The RPC counters are untouched: this
    // migration removed no RPC call site.
    //
    // Workorder 21Y then removed the LAST two PostgREST reads of
    // `features/brand-kit/brand-kit-service.ts` — the caller's own kit rows behind
    // `GET /api/brand-kits`, and the `kit_id`/`asset_type` rows of exactly those
    // kits — so both counters below move down together again (100->98). That is a
    // real coupling removal rather than a counting change: `listKits` now asks
    // `BrandKitReadRepository.listOwnKits` (pure `pg`, built in `app.ts` beside
    // the other repositories) and no longer calls `createUserClient` at all, so
    // no PostgREST read of that method is left. Its ACL is the two RLS policies
    // translated verbatim — `brand_kits` and `brand_kit_assets` are owner-only and
    // keyed on the actor alone, with no workspace, project, role or admin
    // predicate to derive, and the asset statement keeps the policy's `exists`
    // clause — while the published list shape, the `asset_counts` defaults and the
    // 500 message of a failed read are unchanged. `createUserClient` stays wired
    // for the brand-kit write routes, which did not move. Its cases name no client
    // method either, so `fromCallsIncludingTests` follows `fromCalls` down again.
    // The RPC counters are untouched: this migration removed no RPC call site.
    // Workorder 21Z then moved the remaining 22 PostgREST TABLE calls of that same
    // file — the kit insert, the default clear, the kit update and delete, the
    // asset insert, update and delete, the next-sort-order read, the file-path
    // read, the kit-detail read, the kit-detail asset read and the duplicate's
    // batch copy — so both counters below move down together again (98->76). That
    // is a real coupling removal rather than a counting change: every one of them
    // now runs through `BrandKitReadRepository` or the new
    // `BrandKitWriteRepository` (pure `pg`, built in `app.ts` beside the other
    // repositories), with each RLS policy translated verbatim into the statement's
    // OWN predicate — `user_id` for `brand_kits`, the owning-kit `exists` clause
    // for `brand_kit_assets`, and no workspace, project, role or admin clause
    // derived from anything else. The published wire shape, every error code,
    // status and message, and the four places that swallowed a failure on purpose
    // are unchanged; the seven Storage calls of that file did not move (they belong
    // to workorder 22A), which is why `server.storageCalls` and the RPC counters
    // below stay exactly where workorder 21Y left them. The new and modified test
    // files name no client method either, so `fromCallsIncludingTests` follows
    // `fromCalls` down again.
    // Workorder 21AA then moved the five remaining TABLE calls of the two files
    // that write projects and assets — the `projects` archive, the `projects`
    // thumbnail reference, the `projects` name/brand-kit patch, and the two
    // `asset_objects` calls of the asset URL read and the asset row delete — so
    // both counters below move down together again (76->71). That is a real
    // coupling removal rather than a counting change: they now run through the new
    // `ProjectWriteRepository` and `AssetWriteRepository` (pure `pg`, built in
    // `app.ts` beside the other repositories), and the asset URL read reuses
    // `AssetReadRepository.findReadableAsset`, which `deleteAsset` already used.
    // Each RLS policy is translated verbatim into the statement's OWN predicate —
    // `created_by` plus the `private.is_workspace_member` body for `projects_update_owner`,
    // the three conjuncts of `asset_objects_delete_self` (author, membership, and the
    // project's `can_write_project`) for the delete — with no administrator escape and
    // no archive filter, because the policies have neither. The published wire shape,
    // every error code, status and message, and all three "zero rows is still a
    // success" answers are unchanged; Storage (23) and the RPC counters did not move,
    // because this workorder touched neither. The new and modified test files name no
    // client method either, so `fromCallsIncludingTests` follows `fromCalls` down again.
    // Workorder 21AC then moved the six remaining TABLE calls of the Agent side — the
    // `canvases` embedded `projects(workspace_id)` lookup and the `asset_objects` row
    // delete of `features/storage/agent-project-assets.ts`, the `brand_kits` and
    // `brand_kit_assets` reads of `agent/tools/brand-kit.ts`, and the
    // `workspace_skills`-joined-`skills` and `skill_files` reads of
    // `agent/workspace-skills.ts` — so both counters below move down together again
    // (71->65). That is a real coupling removal rather than a counting change: four of
    // the six reuse an existing repository asked with the run's own actor
    // (`CanvasReadRepository.findReadableCanvasProjectLink`,
    // `AssetWriteRepository.deleteOwnAsset`, `BrandKitReadRepository.findOwnKit` and
    // `listOwnKitAssets`), and the two skill reads go through the new
    // `WorkspaceSkillReadRepository` (pure `pg`, built in `app.ts` beside the other
    // repositories). Each RLS policy is translated verbatim into its statement's OWN
    // predicate — `private.can_read_project` for the canvas link (no archive filter,
    // because that predicate has none), the three conjuncts of
    // `asset_objects_delete_self` for the compensation delete, the owner-only
    // `brand_kits_user_policy` for the kit, and `ws_skills_select` +
    // `skills_select_all` + `skill_files_select` for the skills — while every
    // swallowed error (the kit read, the asset read, the skill read, the file read and
    // the compensation's own failure) stays swallowed, exactly as before. Storage (23)
    // and the RPC counters did not move: the brand-kit bucket signing and the
    // `record_project_asset` RPC still run on the clients they always used. The four
    // new test files name no client method either, so `fromCallsIncludingTests`
    // follows `fromCalls` down again.
    // Workorder 21AD then COUNTED 19 table calls that had never been visible: the
    // `untypedFrom` wrapper of `http/skills.ts` (15 call sites) and of
    // `http/skills-marketplace.ts` (4) reaches PostgREST by calling `from(table)`
    // on a `(client as any)` cast, and every caller names the wrapper instead of
    // a client, so the from-call rule counted none of them - the two definition
    // lines were the only part of those two files it saw. The counters below
    // therefore move UP together (65->84). That is an OBSERVATION fix, not a new
    // dependency, exactly like the RPC recognition of workorder 21-preflight B:
    // no production call, SQL or schema changed, and the frozen baseline (163,
    // which already allowed for those calls) is left untouched because the audit
    // only fails on an increase OVER it. The rule is deliberately specific to this
    // one wrapper - "any helper that returns a from-call receiver" would count
    // innocent identifiers - so a future wrapper of this shape has to extend it by
    // hand. It reads raw text like the from-call rule, which is why a mention
    // inside a comment is counted too; T-45 stays open on purpose.
    // Workorder 21AE then moved all nineteen of those call sites out of PostgREST
    // and into `db/skill-repository.ts` (ten fixed statements built in `app.ts`
    // beside the other repositories), and deleted the two `untypedFrom` wrapper
    // definitions with them. So both counters below move DOWN together (84->63):
    // nineteen call sites plus the two definition lines, whose own `from` casts
    // were the only part of those two files the from-call rule could see. That is
    // a real coupling removal rather than a counting change: the two HTTP files
    // no longer name a Supabase client at all, and each RLS policy is translated
    // verbatim into its statement's OWN predicate — `skills_select_all`,
    // `skills_insert_user`, `skills_update_user` and `skills_delete_user` for the
    // registry, `skill_files_select` / `skill_files_insert` for the files,
    // `ws_skills_select` for the workspace list, and BOTH branches of
    // `private.is_workspace_admin_or_owner` (the `workspaces.owner_user_id` one
    // included) for install, toggle and uninstall. The published wire shape, every
    // error code, status and message, all six swallowed failures and the four
    // T-61 bug-level behaviours are unchanged. `server.storageCalls` (23) and the
    // RPC counters below did not move, because this workorder touched neither, and
    // the `[from] rule` itself is KEPT — it reads 0 call sites now, but a future
    // wrapper of the same shape still has to be counted by hand. The new and
    // modified test files name no client method either, so
    // `fromCallsIncludingTests` follows `fromCalls` down again.
    // 43J: the brand kit goes through the ObjectStore adapter; the rest are one-off CLIs.
    expect(metricValue(run.stdout, "server.fromCalls")).toBe(
      baseline.metrics["server.fromCalls"],
    );
    // Guard for this file's own fixture discipline: fragment-assembled probe
    // text must not raise the server test counters it is testing. The wrapper
    // fixtures above are assembled the same way (`UNTYPED_FROM_CALL`), so a
    // literal token there cannot inflate this counter either - the two server
    // counters below still agree exactly.
    // Ticket 45BN (T-133 10b): the storage seam stopped handing out Supabase
    // clients, so this test-scope counter really dropped 1 -> 0. Still pinned
    // with an exact equality, only at the new (lower) value.
    expect(metricValue(run.stdout, "server.testSupabaseSdkImportHits")).toBe(0);
    // 43J: the brand kit goes through the ObjectStore adapter; the rest are one-off CLIs.
    expect(metricValue(run.stdout, "server.fromCallsIncludingTests")).toBe(
      baseline.metrics["server.fromCallsIncludingTests"],
    );

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
    // stay exactly where workorder 21E1 left them — workorder 21G moved only the
    // two PostgREST writes counted above, and touched no RPC call site.
    expect(metricValue(run.stdout, "server.rpcCallsRuntime")).toBe(
      baseline.metrics["server.rpcCallsRuntime"],
    );
    expect(metricValue(run.stdout, "server.rpcCallsAll")).toBe(
      baseline.metrics["server.rpcCallsAll"],
    );

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
    const runtimeRpc = baseline.metrics["server.rpcCallsRuntime"];
    expect(run.stdout).toMatch(
      new RegExp(
        `^\\[anchor\\] server\\.runtimeRpc: anchor=${runtimeRpc} measured\\[server\\.rpcCallsRuntime\\]=${runtimeRpc} \\(match\\)$`,
        "m",
      ),
    );

    // 43J: the brand kit goes through the ObjectStore adapter; the rest are one-off CLIs.
    expect(metricValue(run.stdout, "server.storageCalls")).toBe(
      baseline.metrics["server.storageCalls"],
    );
    expect(metricValue(run.stdout, "server.authGetUserCalls")).toBe(1);
    // Ticket 45BN (T-133 10b): two supabase-js imports disappeared from the
    // server scope (3 -> 2) for the same reason as the test counter above.
    expect(metricValue(run.stdout, "server.supabaseSdkImportHits")).toBe(2);
  }, AUDIT_TEST_TIMEOUT_MS);

  it("baseline fromCalls / rpcCallsRuntime / storageCalls equal the measured values", () => {
    // Values come from supabase-dependency-baseline.json; a reducing ticket lowers them there.
    const run = runAudit([`--baseline=${BASELINE}`]);
    expect(run.status).toBe(0);
    expect(metricValue(run.stdout, "server.fromCalls")).toBe(
      baseline.metrics["server.fromCalls"],
    );
    expect(metricValue(run.stdout, "server.rpcCallsRuntime")).toBe(
      baseline.metrics["server.rpcCallsRuntime"],
    );
    expect(metricValue(run.stdout, "server.storageCalls")).toBe(
      baseline.metrics["server.storageCalls"],
    );
    expect(run.stdout).toMatch(/^\[anchor\] server\.runtimeRpc: .*\(match\)$/m);
  }, AUDIT_TEST_TIMEOUT_MS);
});
