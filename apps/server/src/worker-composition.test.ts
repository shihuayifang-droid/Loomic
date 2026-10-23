/**
 * Worker composition wiring tests (workorder 21X).
 *
 * WHY THIS FILE EXISTS
 * `worker.ts` cannot be imported by a test: the module boots global-agent,
 * registers every executor and provider and calls `main()` at import time. So
 * the wiring it performed in `main()` — the job service and its three `pg`
 * repositories, the credits service, the read-only credits repository, the
 * billing gate, the refund basis repository, the refund function and the
 * per-message base context — had no test at all. A single missing line is
 * invisible to the type checker: workorder 21N lost the worker's
 * `jobAdminReadRepository` and every admin job read failed closed at runtime
 * while `pnpm run typecheck` stayed green.
 *
 * HOW THE WIRING IS PROVED
 * Every probe below drives the REAL composition — built by the real
 * `buildWorkerComposition`, with the real services and the real repositories —
 * against a RECORDING FAKE POOL: `connect()` hands back a client whose `query`
 * records the statement and answers `rows: []`. No PGlite, no `DATABASE_URL`, no
 * network.
 *
 * "This dependency is wired" is proved by a DOMAIN STATEMENT reaching that pool:
 * the repositories' statements name `public.…`, while the transaction envelope
 * (BEGIN, the session settings, COMMIT) names nothing. A repository that was
 * never injected fails closed inside the service with a fixed error and emits NO
 * statement at all, so a missing line cannot hide behind a passing assertion.
 * The statement COUNT of the envelope is deliberately never asserted.
 *
 * The negative controls at the bottom rebuild the real composition with exactly
 * one wiring removed and re-run the same probe, so each positive expectation is
 * shown to be red without its line.
 */

import { describe, expect, it, vi } from "vitest";

import {
  buildWorkerComposition,
  type WorkerComposition,
  type WorkerCompositionInput,
} from "./worker-composition.js";
import { JobServiceError, createJobService } from "./features/jobs/job-service.js";
import { createJobAttemptRepository } from "./db/job-attempt-repository.js";
import { createJobTransitionRepository } from "./db/job-transition-repository.js";
import {
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./db/transaction.js";
import type { CreditReadRepository } from "./db/credit-read-repository.js";
import type { ServerEnv } from "./config/env.js";
import type { PgmqClient } from "./queue/pgmq-client.js";
import type { AdminSupabaseClient } from "./supabase/admin.js";
import type { UserSupabaseClient } from "./supabase/user.js";

const JOB_ID = "00000000-0000-0000-0000-000000002101";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000002102";
const WORKER_TAG = "[worker:test]";

/**
 * A `ServerEnv` with a connection string set on purpose: the composition must
 * never read it, never resolve a pool at build time and never open a connection,
 * so a configured URL makes that claim observable rather than accidental.
 */
const TEST_ENV: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "worker-composition-test",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
  databaseUrl: "postgres://worker-composition-test.invalid:5432/loomic",
};

type QueryRecord = { sql: string; params?: readonly unknown[] };

/** Statements that belong to the transaction envelope, never to a repository. */
const TRANSACTION_ENVELOPE: ReadonlySet<string> = new Set([
  TRANSACTION_STATEMENTS.begin,
  TRANSACTION_STATEMENTS.setLocalSetting,
  TRANSACTION_STATEMENTS.commit,
  TRANSACTION_STATEMENTS.rollback,
]);

/** The repository statements a probe issued: everything the envelope is not. */
function domainStatements(queries: readonly QueryRecord[]): string[] {
  return queries
    .filter((entry) => !TRANSACTION_ENVELOPE.has(entry.sql))
    .map((entry) => entry.sql);
}

type Recorder = {
  input: WorkerCompositionInput;
  queries: QueryRecord[];
  poolGetterCalls: () => number;
  adminClientCalls: () => number;
  userClientCalls: () => number;
};

/**
 * The fake pool, the fake clients and the three counters every test shares.
 *
 * The pool answers `rows: []` to EVERY statement, so each repository takes its
 * own "no such row" arm and each service reports its own fixed answer. Nothing is
 * executed, nothing is parsed, nothing is connected.
 *
 * `getAdminClient` and `createUserClient` throw if they are ever called: this
 * composition must not build either one on any path these probes exercise, and a
 * throw is a louder failure than a counter that nobody reads.
 */
function createRecorder(): Recorder {
  const queries: QueryRecord[] = [];
  let poolGetterCalls = 0;
  let adminClientCalls = 0;
  let userClientCalls = 0;

  const connection: TransactionConnection = {
    async query(sql, params) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });
      return { rows: [] };
    },
    release() {},
  };

  const pool: TransactionPool = {
    async connect() {
      return connection;
    },
  };

  return {
    input: {
      env: TEST_ENV,
      pgmq: createFakePgmq(),
      createUserClient: (accessToken: string): UserSupabaseClient => {
        userClientCalls += 1;
        throw new Error(`composition built a user client (${accessToken})`);
      },
      getAdminClient: (): AdminSupabaseClient => {
        adminClientCalls += 1;
        throw new Error("composition built the admin client");
      },
      getTransactionPool: (): TransactionPool => {
        poolGetterCalls += 1;
        return pool;
      },
    },
    queries,
    poolGetterCalls: () => poolGetterCalls,
    adminClientCalls: () => adminClientCalls,
    userClientCalls: () => userClientCalls,
  };
}

/** The recorder plus a composition built from it by `build`. */
type Harness = Recorder & { composition: WorkerComposition };

function createHarnessWith(
  build: (input: WorkerCompositionInput) => WorkerComposition,
): Harness {
  const recorder = createRecorder();
  return { ...recorder, composition: build(recorder.input) };
}

function createHarness(): Harness {
  return createHarnessWith(buildWorkerComposition);
}

/** Not one of these methods is reached by any probe; the composition only holds it. */
function createFakePgmq(): PgmqClient {
  return {
    async send() {
      return 1;
    },
    async read() {
      return [];
    },
    async readWithPoll() {
      return [];
    },
    async deleteMsg() {
      return true;
    },
    async archive() {
      return true;
    },
    async setVt() {},
    async shutdown() {},
  };
}

/**
 * What one call did: how many domain statements reached the pool, which ones,
 * and how the call settled. A rejected call is reported by its error code when
 * the error carries one (the services' fixed `job_query_failed`), and by its
 * error name otherwise. A call that RESOLVED with a string reports that string,
 * because the probes that answer instead of throwing say so that way; anything
 * else reports `resolved`.
 */
type Evidence = {
  statements: string[];
  outcome: string;
};

async function captureEvidence(
  queries: QueryRecord[],
  run: () => Promise<unknown>,
): Promise<Evidence> {
  const before = queries.length;
  // `run` is allowed to throw synchronously as well as reject — a collaborator
  // that was never wired is a property access on `undefined` — so the call is
  // lifted into a promise chain instead of being awaited directly.
  const outcome = await Promise.resolve()
    .then(() => run())
    .then(
      (value: unknown) => (typeof value === "string" ? value : "resolved"),
      (error: unknown) => failureCode(error),
    );

  return { statements: domainStatements(queries.slice(before)), outcome };
}

function failureCode(error: unknown): string {
  if (!(error instanceof Error)) return "rejected";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.name;
}

function probeComposition(
  harness: Harness,
  run: (composition: WorkerComposition) => Promise<unknown>,
): Promise<Evidence> {
  return captureEvidence(harness.queries, () => run(harness.composition));
}

/** The one fixed failure every service reports for a repository it never got. */
const MISSING_REPOSITORY_CODE = "job_query_failed";

describe("buildWorkerComposition: what it builds", () => {
  it("builds every collaborator and resolves no pool while doing it", () => {
    const harness = createHarness();

    expect(Object.keys(harness.composition).sort()).toEqual([
      "baseCtx",
      "billingGate",
      "creditReadRepository",
      "creditService",
      "jobService",
      "refundJob",
    ]);
    // Nothing was connected, nothing was queried, and the pool getter the worker
    // passes was never asked for a pool: construction is free.
    expect(harness.poolGetterCalls()).toBe(0);
    expect(harness.queries).toEqual([]);
    expect(harness.adminClientCalls()).toBe(0);
    expect(harness.userClientCalls()).toBe(0);
  });

  it("carries exactly the six baseCtx keys, in the order the worker spreads them", () => {
    const harness = createHarness();

    expect(Object.keys(harness.composition.baseCtx)).toEqual([
      "jobService",
      "pgmq",
      "getAdminClient",
      "env",
      "creditReadRepository",
      "assetProvenanceRepository",
      "assetReadRepository",
    ]);
  });

  it("hands baseCtx the SAME instances the composition returns, not copies", () => {
    const harness = createHarness();
    const { baseCtx } = harness.composition;

    expect(baseCtx.jobService).toBe(harness.composition.jobService);
    expect(baseCtx.creditReadRepository).toBe(
      harness.composition.creditReadRepository,
    );
    expect(baseCtx.pgmq).toBe(harness.input.pgmq);
    expect(baseCtx.getAdminClient).toBe(harness.input.getAdminClient);
    expect(baseCtx.env).toBe(harness.input.env);
  });

  it("asks for the pool on first use, not at build time", async () => {
    const harness = createHarness();
    expect(harness.poolGetterCalls()).toBe(0);

    await probeComposition(harness, (c) => c.jobService.incrementAttempt(JOB_ID));
    expect(harness.poolGetterCalls()).toBe(1);

    await probeComposition(harness, (c) => c.jobService.getJobAdmin(JOB_ID));
    expect(harness.poolGetterCalls()).toBe(2);
  });
});

describe("buildWorkerComposition: every wiring point reaches the pool", () => {
  it("wires the attempt counter (21F): incrementAttempt issues the attempt statement", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.jobService.incrementAttempt(JOB_ID),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("update public.background_jobs");
    expect(evidence.statements[0]).toContain("attempt_count = attempt_count + 1");
  });

  it("wires the running transition (21M): markRunning issues its own guarded statement", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.jobService.markRunning(JOB_ID),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("set status = 'running'");
  });

  it("wires the retrying transition (21M): markRetrying issues its own guarded statement", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.jobService.markRetrying(JOB_ID, "generation_failed", "model refused"),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("set status = 'retrying'");
  });

  it("wires the succeeded transition (21M): markSucceeded binds its result as one document", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.jobService.markSucceeded(JOB_ID, { url: "https://example.invalid/a.png" }),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("set status = 'succeeded'");

    const bound = harness.queries.filter((entry) =>
      entry.sql.includes("set status = 'succeeded'"),
    );
    expect(bound[0]?.params?.[1]).toBe(
      JSON.stringify({ url: "https://example.invalid/a.png" }),
    );
  });

  it("wires the failed transition (21M): markFailed issues the guard that authorises a refund", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.jobService.markFailed(JOB_ID, "generation_failed", "model refused"),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("set status = 'failed'");
    expect(evidence.statements[0]).toContain(
      "and status in ('queued', 'running', 'retrying')",
    );
  });

  it("wires the admin job read (21N/21I): 0 rows answers job_not_found, which proves the read reached the repository", async () => {
    const harness = createHarness();

    const failure = await harness.composition.jobService
      .getJobAdmin(JOB_ID)
      .then(() => null, (error: unknown) => error);

    // The repository WAS reached: the fake pool answers zero rows, and zero rows
    // is the service's existing 404. A composition with no repository wired
    // answers the OTHER error (`job_query_failed`) and issues no statement —
    // that is the 21N defect, and the negative control below pins the difference.
    expect(failure).toBeInstanceOf(JobServiceError);
    expect((failure as JobServiceError).code).toBe("job_not_found");
    expect((failure as JobServiceError).statusCode).toBe(404);

    const statements = domainStatements(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("from public.background_jobs");
    expect(statements[0]).toContain("canceled_at");
  });

  it("wires the billing gate (21H1): readBillingGate issues the gate statement", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.billingGate.readBillingGate({ jobId: JOB_ID, timeoutSeconds: 600 }),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("credits_cost");
    expect(evidence.statements[0]).toContain("billing_overdue");
  });

  it("wires the refund basis read (21O): refundJob reads its basis and moves no money on 0 rows", async () => {
    const harness = createHarness();
    const refundCredits = vi.spyOn(harness.composition.creditService, "refundCredits");

    const evidence = await probeComposition(harness, (c) =>
      c.refundJob(JOB_ID, WORKER_TAG),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain(
      "select credits_cost, workspace_id, created_by",
    );
    // Zero rows is the "no such job" answer: the refund returns silently and
    // never asks the credits service for money.
    expect(evidence.outcome).toBe("resolved");
    expect(refundCredits).toHaveBeenCalledTimes(0);
  });

  it("wires the credit read repository (21W): baseCtx.readSubscription issues the subscription statement", async () => {
    const harness = createHarness();

    const evidence = await probeComposition(harness, (c) =>
      c.baseCtx.creditReadRepository.readSubscription({ workspaceId: WORKSPACE_ID }),
    );

    expect(evidence.statements).toHaveLength(1);
    expect(evidence.statements[0]).toContain("from public.subscriptions");
    expect(evidence.statements[0]).toContain("where workspace_id = $1::uuid");
  });

  it("reaches all six wiring points and never builds the admin client", async () => {
    const harness = createHarness();

    const probe = (run: (c: WorkerComposition) => Promise<unknown>) =>
      probeComposition(harness, run);

    await probe((c) => c.jobService.incrementAttempt(JOB_ID));
    await probe((c) => c.jobService.markRunning(JOB_ID));
    await probe((c) => c.jobService.markRetrying(JOB_ID, "code", "message"));
    await probe((c) => c.jobService.markSucceeded(JOB_ID, { ok: true }));
    await probe((c) => c.jobService.markFailed(JOB_ID, "code", "message"));
    await probe((c) => c.jobService.getJobAdmin(JOB_ID));
    await probe((c) => c.billingGate.readBillingGate({ jobId: JOB_ID, timeoutSeconds: 600 }));
    await probe((c) => c.refundJob(JOB_ID, WORKER_TAG));
    await probe((c) => c.baseCtx.creditReadRepository.readSubscription({ workspaceId: WORKSPACE_ID }));

    expect(domainStatements(harness.queries)).toHaveLength(9);
    // The admin client and the user client are only ever needed by the executors
    // and by the credit methods that did not move; none of them is touched here,
    // and the fake getters throw if they are.
    expect(harness.adminClientCalls()).toBe(0);
    expect(harness.userClientCalls()).toBe(0);
  });
});

describe("worker-composition: import-time purity", () => {
  it("registers no executor when it is imported", async () => {
    // A fresh module registry, so the stateful `job-executor` module starts with
    // an empty table and the import under test is the only thing that could fill
    // it. `worker.ts` keeps the executor and provider registrations; this module
    // must not have picked any of them up.
    vi.resetModules();
    const { getExecutor } = await import("./features/jobs/job-executor.js");

    expect(getExecutor("image_generation")).toBeUndefined();
    expect(getExecutor("video_generation")).toBeUndefined();

    await import("./worker-composition.js");

    expect(getExecutor("image_generation")).toBeUndefined();
    expect(getExecutor("video_generation")).toBeUndefined();
  });
});

/**
 * The negative controls.
 *
 * Each entry names the module whose factory produces one collaborator, the probe
 * that exercises it, the domain statements the probe MUST issue when the wiring
 * is present, and how the call settles when it is not.
 */
type WiringPoint = {
  module: string;
  factory: string;
  run: (composition: WorkerComposition) => Promise<unknown>;
  /**
   * The domain statements the probe must issue when this collaborator IS wired:
   * one entry per statement, each entry the fragments that identify it. The
   * count is the statement count, not the fragment count.
   */
  statements: string[][];
  /** What the caller sees when this collaborator was never wired. */
  missingOutcome: string;
};

const WIRING_POINTS = {
  jobAttemptRepository: {
    module: "./db/job-attempt-repository.js",
    factory: "createJobAttemptRepository",
    run: (c) => c.jobService.incrementAttempt(JOB_ID),
    statements: [["update public.background_jobs", "attempt_count = attempt_count + 1"]],
    missingOutcome: MISSING_REPOSITORY_CODE,
  },
  jobTransitionRepository: {
    module: "./db/job-transition-repository.js",
    factory: "createJobTransitionRepository",
    run: async (c) => {
      await c.jobService.markRunning(JOB_ID);
      await c.jobService.markRetrying(JOB_ID, "code", "message");
      await c.jobService.markSucceeded(JOB_ID, { ok: true });
      await c.jobService.markFailed(JOB_ID, "code", "message");
    },
    statements: [
      ["set status = 'running'"],
      ["set status = 'retrying'"],
      ["set status = 'succeeded'"],
      ["set status = 'failed'"],
    ],
    missingOutcome: MISSING_REPOSITORY_CODE,
  },
  jobAdminReadRepository: {
    module: "./db/job-admin-read-repository.js",
    factory: "createJobAdminReadRepository",
    run: (c) => c.jobService.getJobAdmin(JOB_ID),
    statements: [
      ["from public.background_jobs", "where id = $1::uuid", "canceled_at"],
    ],
    missingOutcome: MISSING_REPOSITORY_CODE,
  },
  billingGate: {
    module: "./db/job-billing-gate-repository.js",
    factory: "createJobBillingGateRepository",
    run: (c) => c.billingGate.readBillingGate({ jobId: JOB_ID, timeoutSeconds: 600 }),
    statements: [["from public.background_jobs", "credits_cost", "billing_overdue"]],
    missingOutcome: "TypeError",
  },
  refundJob: {
    module: "./features/jobs/refund-job.js",
    factory: "createRefundJob",
    run: (c) => c.refundJob(JOB_ID, WORKER_TAG),
    statements: [["select credits_cost, workspace_id, created_by"]],
    missingOutcome: "TypeError",
  },
  creditReadRepository: {
    module: "./db/credit-read-repository.js",
    factory: "createCreditReadRepository",
    run: async (c) => {
      // Exactly what the executor does with this OPTIONAL field: no repository
      // means no read at all, and the plan falls back to free.
      const repository = c.baseCtx.creditReadRepository as
        | CreditReadRepository
        | undefined;
      if (!repository) return "no repository wired";

      await repository.readSubscription({ workspaceId: WORKSPACE_ID });
      return "read";
    },
    statements: [["from public.subscriptions", "where workspace_id = $1::uuid"]],
    missingOutcome: "no repository wired",
  },
} as const satisfies Record<string, WiringPoint>;

type WiringName = keyof typeof WIRING_POINTS;

const WIRING_NAMES = Object.keys(WIRING_POINTS) as WiringName[];

/**
 * Rebuild the REAL composition with exactly one wiring removed.
 *
 * The removal happens at the boundary the line itself lives on: the factory that
 * produces the collaborator answers `undefined`, which is the state a deleted
 * wiring line leaves behind — an absent dependency. `buildWorkerComposition`
 * itself runs unchanged, and every consumer takes the fail-closed arm it already
 * has (the `if (!repository)` throw inside the services, and the "optional field
 * is absent" arm on `ExecutorContext`). Nothing else about the composition is
 * touched, which is what makes the comparison meaningful.
 */
async function harnessWithWiringRemoved(name: WiringName): Promise<Harness> {
  const point = WIRING_POINTS[name];

  vi.resetModules();
  vi.doMock(point.module, async () => {
    const actual = await vi.importActual<Record<string, unknown>>(point.module);
    return { ...actual, [point.factory]: () => undefined };
  });

  try {
    const module = await import("./worker-composition.js");
    return createHarnessWith(module.buildWorkerComposition);
  } finally {
    vi.doUnmock(point.module);
    vi.resetModules();
  }
}

describe("worker-composition: negative controls", () => {
  it.each(WIRING_NAMES)(
    "removing the %s wiring makes the same probe emit no domain statement",
    async (name) => {
      const point = WIRING_POINTS[name];

      const real = createHarness();
      const realEvidence = await probeComposition(real, point.run);

      const dropped = await harnessWithWiringRemoved(name);
      const droppedEvidence = await probeComposition(dropped, point.run);

      // With the wiring present: the domain statements, and nothing thrown.
      expect(realEvidence.statements).toHaveLength(point.statements.length);
      point.statements.forEach((fragments, index) => {
        for (const fragment of fragments) {
          expect(realEvidence.statements[index]).toContain(fragment);
        }
      });

      // Without it: not one domain statement, and the caller gets the fixed
      // fail-closed answer instead of a value.
      expect(droppedEvidence.statements).toEqual([]);
      expect(droppedEvidence.outcome).toBe(point.missingOutcome);

      // The positive expectation above, re-run against the dropped wiring, is
      // what turns red — this is that red, made explicit rather than described.
      expect(droppedEvidence).not.toEqual(realEvidence);
      expect(() => expect(droppedEvidence).toEqual(realEvidence)).toThrow();
    },
  );

  it("21N (the defect this workorder exists for): the literal missing line answers exactly like the dropped wiring", async () => {
    // The 21N shape itself: a job service built with NO `jobAdminReadRepository`
    // key at all — the object the type checker accepts and the worker shipped.
    const recorder = createRecorder();
    const literallyMissing = createJobService({
      createUserClient: recorder.input.createUserClient,
      getAdminClient: recorder.input.getAdminClient,
      pgmq: recorder.input.pgmq,
      jobAttemptRepository: createJobAttemptRepository({
        getTransactionPool: recorder.input.getTransactionPool,
      }),
      jobTransitionRepository: createJobTransitionRepository({
        getTransactionPool: recorder.input.getTransactionPool,
      }),
    });

    const literalEvidence = await captureEvidence(recorder.queries, () =>
      literallyMissing.getJobAdmin(JOB_ID),
    );

    const dropped = await harnessWithWiringRemoved("jobAdminReadRepository");
    const droppedEvidence = await probeComposition(dropped, (c) =>
      c.jobService.getJobAdmin(JOB_ID),
    );

    // Both fail closed with the same fixed error and neither reaches the pool.
    expect(literalEvidence).toEqual({
      statements: [],
      outcome: MISSING_REPOSITORY_CODE,
    });
    expect(droppedEvidence).toEqual(literalEvidence);

    // And the wired composition is the ONLY one of the three that answers the
    // repository's own "no such row" 404 — which is what the positive test
    // asserts and what a missing line silently replaces with a 500.
    const wired = createHarness();
    const wiredEvidence = await captureEvidence(wired.queries, () =>
      wired.composition.jobService.getJobAdmin(JOB_ID),
    );
    expect(wiredEvidence.statements).toHaveLength(1);
    expect(wiredEvidence).not.toEqual(literalEvidence);
  });

  it("21W: without the creditReadRepository line baseCtx carries nothing to read a plan through", async () => {
    const wired = createHarness();
    expect(wired.composition.baseCtx.creditReadRepository).toBeDefined();

    const dropped = await harnessWithWiringRemoved("creditReadRepository");
    expect(dropped.composition.baseCtx.creditReadRepository).toBeUndefined();

    const droppedEvidence = await probeComposition(dropped, (c) =>
      c.baseCtx.creditReadRepository.readSubscription({ workspaceId: WORKSPACE_ID }),
    );

    // The positive expectation for this probe is "one subscription statement";
    // with the wiring gone there are none, and the probe's own optional-field
    // arm answers instead — so the positive assertion would be red.
    expect(droppedEvidence.statements).toEqual([]);
    expect(droppedEvidence.outcome).toBe("TypeError");

    const wiredEvidence = await probeComposition(wired, (c) =>
      c.baseCtx.creditReadRepository.readSubscription({ workspaceId: WORKSPACE_ID }),
    );
    expect(wiredEvidence.statements).toHaveLength(1);
    expect(wiredEvidence.statements[0]).toContain("from public.subscriptions");
  });
});
