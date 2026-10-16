import { describe, expect, it, vi } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { JobAttemptRepository } from "../../db/job-attempt-repository.js";
import type {
  JobAdminReadRepository,
  JobAdminReadRow,
} from "../../db/job-admin-read-repository.js";
import type { JobBillingGateRepository } from "../../db/job-billing-gate-repository.js";
import type { JobCreditsLinkRepository } from "../../db/job-credits-link-repository.js";
import {
  CreditServiceError,
  type CreditService,
} from "../credits/credit-service.js";
import type { TierGuard } from "../credits/tier-guard.js";
import { withBilling, type BillingRejection } from "../credits/with-billing.js";
import { JobServiceError, createJobService, type JobService } from "./job-service.js";
import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import { processJobMessage } from "./process-job-message.js";

/** Which client produced an operation: the caller's (RLS) or the admin one. */
type ClientKind = "user" | "admin";

type Op = (
  | { kind: "update"; patch: Record<string, unknown> }
  | { kind: "insert"; table: string; row: Record<string, unknown> }
  | { kind: "delete" }
  | { kind: "select"; columns: string | undefined }
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "order" }
  | { kind: "limit" }
  | { kind: "maybeSingle"; table: string }
  | { kind: "single"; table: string }
) & { via: ClientKind };

type HarnessConfig = {
  /** Rows the guarded update reports as changed. */
  updatedRows?: number;
  updateError?: { message: string } | null;
  /**
   * Per-call outcomes for successive AWAITED update chains (the worker's
   * transitions, `setCreditsInfo`), consumed in order. `reject` models a
   * transport failure, which is a different thing from an `error` reported in
   * the resolved answer.
   */
  updateOutcomes?: Array<{ rows?: number; reject?: Error }>;
  /** Row returned by `.maybeSingle()` on `background_jobs` (cancelJob). */
  jobRow?: Record<string, unknown> | null;
  /** Error reported by `.maybeSingle()` on `background_jobs`. */
  jobRowError?: { message: string } | null;
  rpc?: { data: unknown; error: { message: string } | null };
  /** Row returned by `.maybeSingle()` on `canvases` / `projects` (createJob). */
  canvasRow?: Record<string, unknown> | null;
  projectRow?: Record<string, unknown> | null;
  canvasError?: { code?: string; message: string } | null;
  projectError?: { code?: string; message: string } | null;
  /** Row the job insert reports back. */
  insertedJob?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
  /** The enqueue throws (the compensation path of createJob). */
  sendError?: Error;
  /** Rows the compensation DELETE reports, and its resolved error. */
  deleteRows?: number;
  deleteError?: { message: string } | null;
  /**
   * ADR-0001 / workorder 21F: what the attempt counter repository answers.
   * `null` is the "no such job row" answer; omit for a plain `1/3` row.
   */
  attemptRow?: { attemptCount: number; maxAttempts: number } | null;
  /** The repository throws this instead of answering. */
  attemptError?: Error;
  /** Build the service with NO attempt repository at all (fail-closed path). */
  withoutAttemptRepository?: boolean;
  /**
   * ADR-0001 / workorder 21H2: what the credits-link repository answers.
   *
   * `linked` / `claimed` / `marked` are the resolved booleans (the predicate
   * matched nothing ⇒ `false`); the `*Error` fields are the rejected-promise
   * channel. Both are failures the service must handle, and they are different
   * answers on purpose: the old PostgREST update had no way to express either.
   */
  creditsLink?: {
    linked?: boolean;
    claimed?: boolean;
    marked?: boolean;
    linkError?: Error;
    claimError?: Error;
    markError?: Error;
  };
  /** Build the service with NO credits-link repository at all (fail-closed). */
  withoutCreditsLinkRepository?: boolean;
  /**
   * ADR-0001 / workorder 21I: what the admin read repository answers for
   * `getJobAdmin`. `null` (or omitting it) is the "no such job" answer;
   * `adminJobError` is the rejected-promise channel. Both are answers the
   * service must handle — the old admin PostgREST read expressed them as
   * `data: null` and `error`.
   */
  adminJobRow?: Record<string, unknown> | null;
  adminJobError?: Error;
  /** Build the service with NO admin read repository at all (fail-closed). */
  withoutJobAdminReadRepository?: boolean;
};

/**
 * ADR-0001 / workorder 21I: a row shaped the way `JobAdminReadRepository`
 * answers it — all 22 columns, keyed by column name, every timestamp already
 * normalised to an ISO string — so a case hands `getJobAdmin` exactly what the
 * migrated read produces instead of a PostgREST-shaped partial row.
 */
function adminJobFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    project_id: "project-1",
    canvas_id: "canvas-1",
    session_id: "session-1",
    thread_id: "thread-1",
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "queued",
    payload: { prompt: "a cat" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: "user-1",
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function makeHarness(config: HarnessConfig = {}) {
  const ops: Op[] = [];
  const rpcCalls: Array<{ name: string; params: unknown }> = [];
  const attemptCalls: Array<{ jobId: string }> = [];
  const clientTokens: string[] = [];
  /** Every PGMQ call the service made: send, deleteMsg, archive. */
  const messageLifecycle: string[] = [];
  /**
   * The service's own statements in the order they were issued, so "authorize,
   * then insert, then enqueue" is measured rather than asserted in prose.
   */
  const trace: string[] = [];
  /**
   * A one-table stand-in for `background_jobs`, so a compensation delete that
   * was refused leaves a row behind that a case can point at.
   */
  const jobRows = new Map<string, Record<string, unknown>>();

  function makeClient(via: ClientKind) {
    function makeBuilder(table: string) {
      let chain: "update" | "insert" | "delete" | "select" = "select";
      let targetId: unknown;

      const builder = {
        update: (patch: Record<string, unknown>) => {
          chain = "update";
          ops.push({ kind: "update", patch, via });
          trace.push(`update:${table}`);
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          chain = "insert";
          ops.push({ kind: "insert", table, row, via });
          trace.push(`insert:${table}`);
          return builder;
        },
        delete: () => {
          chain = "delete";
          ops.push({ kind: "delete", via });
          trace.push(`delete:${table}`);
          return builder;
        },
        select: (columns?: string) => {
          ops.push({ kind: "select", columns, via });
          return builder;
        },
        eq: (column: string, value: unknown) => {
          if (column === "id") targetId = value;
          ops.push({ kind: "eq", column, value, via });
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          ops.push({ kind: "in", column, values, via });
          return builder;
        },
        order: () => {
          ops.push({ kind: "order", via });
          return builder;
        },
        limit: () => {
          ops.push({ kind: "limit", via });
          return builder;
        },
        maybeSingle: async () => {
          ops.push({ kind: "maybeSingle", table, via });
          trace.push(`read:${table}`);
          if (table === "canvases") {
            return { data: config.canvasRow ?? null, error: config.canvasError ?? null };
          }
          if (table === "projects") {
            return { data: config.projectRow ?? null, error: config.projectError ?? null };
          }
          return { data: config.jobRow ?? null, error: config.jobRowError ?? null };
        },
        single: async () => {
          ops.push({ kind: "single", table, via });
          const row = config.insertedJob ?? null;
          if (table === "background_jobs" && row && row.id !== undefined) {
            jobRows.set(String(row.id), row);
          }
          return { data: row, error: config.insertError ?? null };
        },
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => {
          if (chain === "delete") {
            const error = config.deleteError ?? null;
            const rows = error === null ? (config.deleteRows ?? 1) : 0;
            if (rows > 0 && table === "background_jobs") jobRows.delete(String(targetId));
            return Promise.resolve({
              data: Array.from({ length: rows }, () => ({ id: targetId })),
              error,
            }).then(resolve, reject);
          }

          const outcome = config.updateOutcomes?.shift();
          if (outcome?.reject) {
            return Promise.reject(outcome.reject).then(resolve, reject);
          }

          const rows = outcome?.rows ?? config.updatedRows ?? 0;
          return Promise.resolve({
            data: Array.from({ length: rows }, () => ({ id: "job-1" })),
            error: config.updateError ?? null,
          }).then(resolve, reject);
        },
      };

      return builder;
    }

    return {
      from: (table: string) => makeBuilder(table),
      rpc: async (name: string, params: unknown) => {
        rpcCalls.push({ name, params });
        return config.rpc ?? { data: null, error: null };
      },
    };
  }

  const userClient = makeClient("user");
  const adminClient = makeClient("admin");

  const sentMessages: Array<{ queue: string; message: unknown }> = [];

  // ADR-0001 / workorder 21F: the atomic attempt counter. The harness records
  // the exact argument object the service passed down, so "the count is read
  // from the repository" and "the argument carries nothing else" are observable
  // rather than asserted in prose.
  const jobAttemptRepository: JobAttemptRepository = {
    async incrementAttempt(input) {
      attemptCalls.push(input);
      if (config.attemptError) throw config.attemptError;
      return config.attemptRow === undefined
        ? { attemptCount: 1, maxAttempts: 3 }
        : config.attemptRow;
    },
  };

  // ADR-0001 / workorder 21H2: the credits link and the two compensation steps.
  // The harness records every call (operation + the exact argument object the
  // service passed down), so "the charge is recorded through the repository" and
  // "the compensation runs in this order" are observable rather than asserted in
  // prose — and `patches()` staying empty is what proves nothing reaches
  // PostgREST any more.
  const creditsLinkCalls: Array<{
    operation: string;
    input: Record<string, unknown>;
  }> = [];

  const jobCreditsLinkRepository: JobCreditsLinkRepository = {
    async linkCredits(input) {
      creditsLinkCalls.push({ operation: "linkCredits", input: { ...input } });
      // The link write is the same row write the PostgREST update used to be, so
      // it keeps the same trace marker: the H14 ordering pin stays byte-identical
      // across the migration instead of being quietly rewritten.
      trace.push("update:background_jobs");
      if (config.creditsLink?.linkError) throw config.creditsLink.linkError;
      return config.creditsLink?.linked ?? true;
    },
    async claimUnlinkedCharge(input) {
      creditsLinkCalls.push({
        operation: "claimUnlinkedCharge",
        input: { ...input },
      });
      trace.push("credits-link:claim");
      if (config.creditsLink?.claimError) throw config.creditsLink.claimError;
      return config.creditsLink?.claimed ?? true;
    },
    async markChargeRefunded(input) {
      creditsLinkCalls.push({
        operation: "markChargeRefunded",
        input: { ...input },
      });
      trace.push("credits-link:mark");
      if (config.creditsLink?.markError) throw config.creditsLink.markError;
      return config.creditsLink?.marked ?? true;
    },
  };

  // ADR-0001 / workorder 21I: the admin single-row read of `getJobAdmin`. The
  // harness records the exact argument object the service passed down, so "the
  // read goes through the repository, carrying the job id and nothing else" is
  // observable — and an `ops` list free of any admin read is what proves nothing
  // reaches PostgREST any more.
  const jobAdminReadCalls: Array<{ jobId: string }> = [];

  const jobAdminReadRepository: JobAdminReadRepository = {
    async readJob(input) {
      jobAdminReadCalls.push({ ...input });
      if (config.adminJobError) throw config.adminJobError;
      return (config.adminJobRow ?? null) as JobAdminReadRow | null;
    },
  };

  const service: JobService = createJobService({
    createUserClient: (accessToken: string) => {
      clientTokens.push(accessToken);
      return userClient as unknown as UserSupabaseClient;
    },
    getAdminClient: () => adminClient as unknown as AdminSupabaseClient,
    pgmq: {
      send: async (queue: string, message: unknown) => {
        sentMessages.push({ queue, message });
        messageLifecycle.push(`send:${queue}`);
        trace.push(`send:${queue}`);
        if (config.sendError) throw config.sendError;
        return 1;
      },
      deleteMsg: async (queue: string, msgId: number) => {
        messageLifecycle.push(`deleteMsg:${queue}:${msgId}`);
        return true;
      },
      archive: async (queue: string, msgId: number) => {
        messageLifecycle.push(`archive:${queue}:${msgId}`);
        return true;
      },
    } as unknown as PgmqClient,
    ...(config.withoutAttemptRepository ? {} : { jobAttemptRepository }),
    ...(config.withoutCreditsLinkRepository
      ? {}
      : { jobCreditsLinkRepository }),
    ...(config.withoutJobAdminReadRepository
      ? {}
      : { jobAdminReadRepository }),
  });

  const inOp = () => ops.find((op): op is Extract<Op, { kind: "in" }> => op.kind === "in");
  const updateOp = () =>
    ops.find((op): op is Extract<Op, { kind: "update" }> => op.kind === "update");
  const insertOp = () =>
    ops.find((op): op is Extract<Op, { kind: "insert" }> => op.kind === "insert");
  /** Every status/credits patch the service wrote, in order. */
  const patches = () =>
    ops
      .filter((op): op is Extract<Op, { kind: "update" }> => op.kind === "update")
      .map((op) => op.patch);
  const deletes = () => ops.filter((op) => op.kind === "delete");

  return {
    service,
    ops,
    rpcCalls,
    attemptCalls,
    sentMessages,
    messageLifecycle,
    clientTokens,
    trace,
    jobRows,
    creditsLinkCalls,
    jobAdminReadCalls,
    /** The credits-link operations in the order the service issued them. */
    creditsLinkOperations: () =>
      creditsLinkCalls.map((call) => call.operation),
    inOp,
    updateOp,
    insertOp,
    patches,
    deletes,
  };
}

describe("job service state guards", () => {
  it("case 1: markRunning only accepts queued/retrying and reports whether it changed a row", async () => {
    const changed = makeHarness({ updatedRows: 1 });
    expect(await changed.service.markRunning("job-1")).toBe(true);
    expect(changed.inOp()?.column).toBe("status");
    expect(changed.inOp()?.values).toEqual(["queued", "retrying"]);
    expect(changed.updateOp()?.patch.status).toBe("running");

    const missed = makeHarness({ updatedRows: 0 });
    expect(await missed.service.markRunning("job-1")).toBe(false);
  });

  it("case 2: markRetrying writes retrying and never failed_at", async () => {
    const harness = makeHarness({ updatedRows: 1 });

    expect(await harness.service.markRetrying("job-1", "executor_error", "boom")).toBe(true);

    expect(harness.inOp()?.values).toEqual(["running"]);
    const patch = harness.updateOp()?.patch ?? {};
    expect(patch.status).toBe("retrying");
    expect(patch.error_code).toBe("executor_error");
    expect(patch.error_message).toBe("boom");
    expect("failed_at" in patch).toBe(false);
  });

  it("case 3: markSucceeded only accepts running", async () => {
    const harness = makeHarness({ updatedRows: 0 });

    expect(await harness.service.markSucceeded("job-1", { url: "x" })).toBe(false);
    expect(harness.inOp()?.values).toEqual(["running"]);
    expect(harness.updateOp()?.patch.status).toBe("succeeded");
  });

  it("case 4: markFailed accepts every non-terminal state and stamps failed_at", async () => {
    const harness = makeHarness({ updatedRows: 1 });

    expect(await harness.service.markFailed("job-1", "safety_filter", "blocked")).toBe(true);

    expect(harness.inOp()?.values).toEqual(["queued", "running", "retrying"]);
    const patch = harness.updateOp()?.patch ?? {};
    expect(patch.status).toBe("failed");
    expect(typeof patch.failed_at).toBe("string");
  });

  it("case 5: a database error from any mark* is thrown, not swallowed", async () => {
    const harness = makeHarness({ updatedRows: 0, updateError: { message: "connection reset" } });

    await expect(harness.service.markRunning("job-1")).rejects.toThrow(/connection reset/);
    await expect(
      harness.service.markRetrying("job-1", "e", "m"),
    ).rejects.toThrow(/connection reset/);
    await expect(harness.service.markSucceeded("job-1", {})).rejects.toThrow(/connection reset/);
    await expect(harness.service.markFailed("job-1", "e", "m")).rejects.toThrow(
      /connection reset/,
    );
  });

  it("case 6: a failing attempt write throws job_query_failed instead of inventing a count", async () => {
    // The driver's own text names a host and a credential: it must not travel
    // with the service error.
    const harness = makeHarness({
      attemptError: new Error(
        "connection reset: postgres://loomic:secret@10.210.134.37:5432/loomic",
      ),
    });

    const error = await harness.service
      .incrementAttempt("job-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toContain("increment_job_attempt failed for job-1");
    expect(error?.message).not.toMatch(/postgres:\/\/|secret|10\.210\.134\.37/);
    // And the count really was asked for: the refusal is not a short circuit.
    expect(harness.attemptCalls).toEqual([{ jobId: "job-1" }]);
    // No PostgREST fallback behind the repository.
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case 7: a missing job row is null, not an error", async () => {
    const harness = makeHarness({ attemptRow: null });

    expect(await harness.service.incrementAttempt("job-1")).toBeNull();
    expect(harness.attemptCalls).toEqual([{ jobId: "job-1" }]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case 7b: a counted job returns the repository's row in the wire shape", async () => {
    const harness = makeHarness({ attemptRow: { attemptCount: 2, maxAttempts: 3 } });

    expect(await harness.service.incrementAttempt("job-1")).toEqual({
      attempt_count: 2,
      max_attempts: 3,
    });
    // Exactly one argument, and it is the job id: no token, no workspace, no
    // generic patch a caller could widen the write with.
    expect(harness.attemptCalls).toEqual([{ jobId: "job-1" }]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case 7c: no attempt repository at all fails closed, never back to the RPC", async () => {
    const harness = makeHarness({ withoutAttemptRepository: true });

    const error = await harness.service
      .incrementAttempt("job-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    // Nothing was asked of the repository (there is none) and nothing at all of
    // the admin client: a missing dependency cannot resurrect the old call.
    expect(harness.attemptCalls).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case 7d: the credits link goes through the repository, and a refusing write is a fixed 500", async () => {
    // Workorder 21H2. Two things the old admin update could not do: report that
    // the row was not written, and report that the write itself broke.
    const refused = makeHarness({ creditsLink: { linked: false } });

    const refusedError = await refused.service
      .setCreditsInfo("job-1", 10, "tx-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(refusedError).toBeInstanceOf(JobServiceError);
    expect(refusedError?.code).toBe("job_query_failed");
    expect(refusedError?.statusCode).toBe(500);
    expect(refusedError?.message).toBe(
      "The job credits for job-1 were not recorded: the job is no longer billable.",
    );
    // Exactly one argument object, and it carries nothing else: no token, no
    // workspace, no generic patch a caller could widen the write with.
    expect(refused.creditsLinkCalls).toEqual([
      {
        operation: "linkCredits",
        input: { jobId: "job-1", creditsCost: 10, transactionId: "tx-1" },
      },
    ]);
    // No PostgREST fallback: the migration is not a second chance for the old
    // unchecked update.
    expect(refused.patches()).toEqual([]);
    expect(refused.rpcCalls).toEqual([]);
  });

  it("case 7e: a breaking credits link is a fixed 500 whose message carries no driver text", async () => {
    const harness = makeHarness({
      creditsLink: {
        linkError: new Error(
          "permission denied for table background_jobs: postgres://loomic:secret@10.210.134.37:5432/loomic",
        ),
      },
    });

    const error = await harness.service
      .setCreditsInfo("job-1", 10, "tx-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to record the job credits for job-1.");
    // The two failure modes are DIFFERENT fixed messages, and neither one is a
    // channel for the driver's text.
    expect(error?.message).not.toBe(
      "The job credits for job-1 were not recorded: the job is no longer billable.",
    );
    expect(error?.message).not.toMatch(
      /permission denied|background_jobs|postgres:\/\/|secret|10\.210\.134\.37/,
    );
    expect(harness.patches()).toEqual([]);
  });

  it("case 7f: claimUnlinkedCharge and markChargeRefunded pass the answer through, and fail closed", async () => {
    // `true` / `false` are the repository's own answers and must reach the
    // caller unchanged: the compensation decides whether to refund on exactly
    // this value, so inventing one would refund without ownership.
    const changed = makeHarness({});
    expect(await changed.service.claimUnlinkedCharge("job-1")).toBe(true);
    expect(await changed.service.markChargeRefunded("job-1")).toBe(true);
    expect(changed.creditsLinkCalls).toEqual([
      { operation: "claimUnlinkedCharge", input: { jobId: "job-1" } },
      { operation: "markChargeRefunded", input: { jobId: "job-1" } },
    ]);
    expect(changed.patches()).toEqual([]);

    const refused = makeHarness({
      creditsLink: { claimed: false, marked: false },
    });
    expect(await refused.service.claimUnlinkedCharge("job-1")).toBe(false);
    expect(await refused.service.markChargeRefunded("job-1")).toBe(false);

    for (const [call, scenario, message] of [
      [
        (harness: ReturnType<typeof makeHarness>) =>
          harness.service.claimUnlinkedCharge("job-1"),
        { claimError: new Error("connection reset") },
        "Failed to claim the unlinked charge of job-1.",
      ],
      [
        (harness: ReturnType<typeof makeHarness>) =>
          harness.service.markChargeRefunded("job-1"),
        { markError: new Error("connection reset") },
        "Failed to mark the charge of job-1 as refunded.",
      ],
    ] as const) {
      const broken = makeHarness({ creditsLink: scenario });
      const error = await call(broken)
        .then(() => null)
        .catch((thrown: unknown) => thrown as JobServiceError);

      expect(error).toBeInstanceOf(JobServiceError);
      expect(error?.code).toBe("job_query_failed");
      expect(error?.statusCode).toBe(500);
      expect(error?.message).toBe(message);
      expect(error?.message).not.toMatch(/connection reset/);
    }

    // And with no repository at all, both fail closed the same way: a missing
    // dependency may never look like a refusal.
    const absent = makeHarness({ withoutCreditsLinkRepository: true });
    for (const call of [
      absent.service.setCreditsInfo("job-1", 10, "tx-1"),
      absent.service.claimUnlinkedCharge("job-1"),
      absent.service.markChargeRefunded("job-1"),
    ]) {
      const error = await call
        .then(() => null)
        .catch((thrown: unknown) => thrown as JobServiceError);

      expect(error).toBeInstanceOf(JobServiceError);
      expect(error?.code).toBe("job_query_failed");
      expect(error?.statusCode).toBe(500);
    }
    expect(absent.creditsLinkCalls).toEqual([]);
    expect(absent.patches()).toEqual([]);
    expect(absent.rpcCalls).toEqual([]);
  });

  it("case 8: a legacy dead_letter row is read as failed", async () => {
    // Workorder 21I moved this read to `JobAdminReadRepository`, so the row now
    // arrives from the repository double instead of the admin client's
    // `.maybeSingle()`. The assertion is unchanged on purpose: the migration is
    // not allowed to move what callers see.
    const harness = makeHarness({
      adminJobRow: adminJobFixture({ status: "dead_letter" }),
    });

    const job = await harness.service.getJobAdmin("job-1");

    expect(job.status).toBe("failed");
    // Exactly one read, through the repository, carrying the job id and nothing
    // else — and nothing at all through the admin client.
    expect(harness.jobAdminReadCalls).toEqual([{ jobId: "job-1" }]);
    expect(harness.ops.filter((op) => op.via === "admin")).toEqual([]);
  });

  it("case 9: listJobs by failed also matches legacy dead_letter rows", async () => {
    const harness = makeHarness();

    await harness.service.listJobs(
      { accessToken: "t", email: "a@t", id: "user-1", userMetadata: {} },
      { status: "failed" },
    );

    expect(harness.inOp()?.column).toBe("status");
    expect(harness.inOp()?.values).toEqual(["failed", "dead_letter"]);
  });

  it("case 9b: listJobs by any other status still uses eq", async () => {
    const harness = makeHarness();

    await harness.service.listJobs(
      { accessToken: "t", email: "a@t", id: "user-1", userMetadata: {} },
      { status: "retrying" },
    );

    expect(harness.inOp()).toBeUndefined();
    expect(
      harness.ops.some((op) => op.kind === "eq" && op.column === "status" && op.value === "retrying"),
    ).toBe(true);
  });
});

// ADR-0001 / workorder 21I: the admin single-row read of `getJobAdmin` moved from
// the admin PostgREST client to `JobAdminReadRepository`. What these cases pin is
// that the MOVE changed no answer: the same row comes back through `mapJobRow`,
// the same `job_not_found` 404 and the same `job_query_failed` 500 come out of
// the other two outcomes, and with no repository wired the method fails closed
// instead of reaching for the client it used to read through.
describe("getJobAdmin: the read goes through the repository, and nothing else (工单21I)", () => {
  it("case 10: the repository's row is mapped and returned unchanged", async () => {
    const harness = makeHarness({
      adminJobRow: adminJobFixture({
        project_id: null,
        canvas_id: "canvas-1",
        session_id: null,
        thread_id: null,
        status: "running",
        payload: { prompt: "a cat", steps: [1, 2, { depth: "deep" }] },
        result: { url: "oss://bucket/key.png" },
        error_code: null,
        error_message: null,
        attempt_count: 2,
        max_attempts: 3,
        started_at: "2026-09-30T00:01:00.000Z",
      }),
    });

    const job = await harness.service.getJobAdmin("job-1");

    expect(job).toEqual({
      id: "job-1",
      workspace_id: "ws-1",
      project_id: null,
      canvas_id: "canvas-1",
      session_id: null,
      thread_id: null,
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "running",
      payload: { prompt: "a cat", steps: [1, 2, { depth: "deep" }] },
      result: { url: "oss://bucket/key.png" },
      error_code: null,
      error_message: null,
      attempt_count: 2,
      max_attempts: 3,
      created_by: "user-1",
      created_at: "2026-09-30T00:00:00.000Z",
      updated_at: "2026-09-30T00:00:00.000Z",
      started_at: "2026-09-30T00:01:00.000Z",
      completed_at: null,
      failed_at: null,
      canceled_at: null,
    });

    expect(harness.jobAdminReadCalls).toEqual([{ jobId: "job-1" }]);
    // No access token was needed for an admin read: no user client was built.
    expect(harness.clientTokens).toEqual([]);
    expect(harness.ops.filter((op) => op.via === "admin")).toEqual([]);
  });

  it("case 11: no such job is the existing 404", async () => {
    const harness = makeHarness({ adminJobRow: null });

    const error = await harness.service
      .getJobAdmin("job-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_not_found");
    expect(error?.statusCode).toBe(404);
    expect(error?.message).toBe("Job not found.");
    expect(harness.jobAdminReadCalls).toEqual([{ jobId: "job-1" }]);
  });

  it("case 12: a failing repository is the existing 500, never a 404", async () => {
    const harness = makeHarness({
      adminJobError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 " +
          "select ... from public.background_jobs",
      ),
    });

    const error = await harness.service
      .getJobAdmin("job-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to query job.");
    // The driver's own text is not concatenated: it can name the statement, the
    // host or a credential. The repository carries it as `cause`.
    expect(error?.message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37|public\.|background_jobs/,
    );
  });

  it("case 13: with no repository wired the read fails closed, and the admin client is never used", async () => {
    // The double would answer with a row if it were consulted, so the 500 below
    // can only come from the missing dependency — not from a missing job.
    const harness = makeHarness({
      withoutJobAdminReadRepository: true,
      adminJobRow: adminJobFixture(),
      jobRow: adminJobFixture(),
    });

    const error = await harness.service
      .getJobAdmin("job-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to query job.");

    // Fail-closed means nothing happened: no repository call, and — the point of
    // the migration — no admin PostgREST read either.
    expect(harness.jobAdminReadCalls).toEqual([]);
    expect(harness.ops).toEqual([]);
  });

  it("case 14: the job id is passed verbatim, and it is the only argument", async () => {
    const harness = makeHarness({ adminJobRow: adminJobFixture() });

    await harness.service.getJobAdmin("job-with-odd-id-42");

    // One call, one field: there is no token, no workspace and no filter a
    // caller could widen the read with.
    expect(harness.jobAdminReadCalls).toEqual([
      { jobId: "job-with-odd-id-42" },
    ]);
    expect(Object.keys(harness.jobAdminReadCalls[0] ?? {})).toEqual(["jobId"]);
  });

  it("case 15: every status is passed through, and only dead_letter is rewritten", async () => {
    const statuses = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "canceled",
      "retrying",
    ];

    for (const status of statuses) {
      const harness = makeHarness({ adminJobRow: adminJobFixture({ status }) });

      const job = await harness.service.getJobAdmin("job-1");

      expect([status, job.status]).toEqual([status, status]);
    }

    // The legacy terminal value is the ONE translation, and it lives in
    // `mapJobRow` — not in the repository, which reports the raw column.
    const legacy = makeHarness({
      adminJobRow: adminJobFixture({ status: "dead_letter" }),
    });
    expect((await legacy.service.getJobAdmin("job-1")).status).toBe("failed");
  });
});

// X-52 prep (T2): a job's PROJECT is derived from its canvas, not taken from the
// caller. The worker records asset ownership from that project, so a job carrying
// a project the canvas does not belong to (or none at all) produces media that a
// private bucket cannot authorise for the project that asked for it.
describe("createJob resolves the project from the canvas", () => {
  const USER = { accessToken: "t", email: "a@t", id: "user-1", userMetadata: {} };
  const jobRow = { id: "job-9", status: "queued", job_type: "image_generation" };

  it("case 1: the canvas's project is written even when the caller omitted it", async () => {
    const harness = makeHarness({
      canvasRow: { project_id: "project-from-canvas" },
      insertedJob: jobRow,
    });

    await harness.service.createJob(USER, {
      workspaceId: "ws-personal",
      canvasId: "canvas-1",
      jobType: "image_generation",
      payload: { prompt: "x" },
    });

    expect(harness.insertOp()?.row.project_id).toBe("project-from-canvas");
    expect(harness.insertOp()?.row.canvas_id).toBe("canvas-1");
  });

  it("case 2: a forged project that contradicts the canvas is refused, nothing is enqueued", async () => {
    const harness = makeHarness({
      canvasRow: { project_id: "project-real" },
      insertedJob: jobRow,
    });

    const error = await harness.service
      .createJob(USER, {
        workspaceId: "ws-personal",
        projectId: "project-forged",
        canvasId: "canvas-1",
        jobType: "image_generation",
        payload: { prompt: "x" },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as { statusCode?: number; message?: string });

    expect(error?.statusCode).toBe(400);
    expect(error?.message).toContain("do not match");
    expect(harness.insertOp()).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(0);
  });

  it("case 3: an unreadable canvas is refused rather than guessed", async () => {
    // RLS answers with no row for a canvas the caller cannot see.
    const harness = makeHarness({ canvasRow: null, insertedJob: jobRow });

    const error = await harness.service
      .createJob(USER, {
        workspaceId: "ws-personal",
        canvasId: "canvas-of-someone-else",
        jobType: "image_generation",
        payload: { prompt: "x" },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as { statusCode?: number });

    expect(error?.statusCode).toBe(403);
    expect(harness.insertOp()).toBeUndefined();
  });

  it("case 4: a job with no canvas still works, with a null project", async () => {
    const harness = makeHarness({ insertedJob: jobRow });

    await harness.service.createJob(USER, {
      workspaceId: "ws-personal",
      jobType: "image_generation",
      payload: { prompt: "x" },
    });

    expect(harness.insertOp()?.row.project_id).toBeNull();
    expect(harness.sentMessages).toHaveLength(1);
  });

  it("case 5: a project-only job is verified against the caller's own client", async () => {
    const harness = makeHarness({
      projectRow: { id: "project-1" },
      insertedJob: jobRow,
    });

    await harness.service.createJob(USER, {
      workspaceId: "ws-team",
      projectId: "project-1",
      jobType: "image_generation",
      payload: { prompt: "x" },
    });

    expect(harness.ops.some((op) => op.kind === "maybeSingle" && op.table === "projects")).toBe(
      true,
    );
    expect(harness.insertOp()?.row.project_id).toBe("project-1");
  });

  it("case 6: an unreadable project is refused", async () => {
    const harness = makeHarness({ projectRow: null, insertedJob: jobRow });

    const error = await harness.service
      .createJob(USER, {
        workspaceId: "ws-team",
        projectId: "project-of-someone-else",
        jobType: "image_generation",
        payload: { prompt: "x" },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as { statusCode?: number });

    expect(error?.statusCode).toBe(403);
    expect(harness.insertOp()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADR-0001 / workorder 21F: the two attempt thresholds and the increment
// failure path, driven through the REAL JobService — and therefore through the
// attempt repository — instead of a hand-written stand-in for it.
//
// `process-job-message.test.ts` keeps its mock-level cases (it is untouched by
// this ticket); what is added here is the wiring half: the count the retry
// decision is made from really comes from the repository, so a broken counter
// cannot quietly look like a healthy one.
// ---------------------------------------------------------------------------

const PROCESS_JOB_ID = "job-21f";

type ProcessScenario = {
  attemptRow?: { attemptCount: number; maxAttempts: number } | null;
  attemptError?: Error;
  executorThrows?: { code?: string; message: string };
  hasExecutor?: boolean;
  /** Per-call outcomes for the guarded status writes of the real JobService. */
  updateOutcomes?: Array<{ rows?: number; reject?: Error }>;
};

function makeProcessHarness(scenario: ProcessScenario = {}) {
  const jobHarness = makeHarness({
    updatedRows: 1,
    ...(scenario.attemptRow === undefined ? {} : { attemptRow: scenario.attemptRow }),
    ...(scenario.attemptError === undefined
      ? {}
      : { attemptError: scenario.attemptError }),
    ...(scenario.updateOutcomes === undefined
      ? {}
      : { updateOutcomes: [...scenario.updateOutcomes] }),
  });

  const calls: string[] = [];
  const logs: string[] = [];
  /** Visibility renewals the billing gate asked for (workorder 21H1). */
  const renewals: number[] = [];
  let refunds = 0;

  const executor: JobExecutor = async () => {
    calls.push("executor");
    if (scenario.executorThrows) {
      throw Object.assign(new Error(scenario.executorThrows.message), {
        ...(scenario.executorThrows.code ? { code: scenario.executorThrows.code } : {}),
      });
    }
    return { ok: true };
  };

  const deps = {
    jobService: jobHarness.service,
    // Workorder 21H1: the billing gate is a required dependency of
    // `processJobMessage` now. This harness drives the REAL JobService, and the
    // cases below measure the attempt thresholds and the single-ownership
    // boundaries — none of which the gate changes — so the stand-in answers the
    // pass-through row (a confirmed, zero-cost job) every time. The gate's own
    // matrix is pinned in `process-job-message.test.ts`.
    billingGate: {
      async readBillingGate() {
        return { status: "queued", creditsCost: 0, overdue: false };
      },
      async failUnbilledIfOverdue() {
        return false;
      },
    } as unknown as JobBillingGateRepository,
    pgmq: {
      async archive() {
        calls.push("archive");
      },
      async deleteMsg() {
        calls.push("deleteMsg");
      },
    } as never,
    getExecutor: () => (scenario.hasExecutor === false ? undefined : executor),
    refundJob: async () => {
      calls.push("refundJob");
      refunds += 1;
    },
    log: (message: string) => {
      logs.push(message);
    },
  };

  const args = {
    queue: "image_generation",
    queueJobType: "image_generation" as const,
    msg: {
      msg_id: 7,
      message: { job_id: PROCESS_JOB_ID, job_type: "image_generation" },
    } as never,
    // Workorder 21H1: the billing gate's deferring arm renews the message's
    // visibility timeout. `renewVt`'s contract is that it never throws, and this
    // harness's gate always passes, so the spy below is a guard against a future
    // case failing with "undefined is not a function" instead of on its merits.
    ctx: {
      renewVt: (vtSeconds: number) => {
        renewals.push(vtSeconds);
      },
    } as unknown as ExecutorContext,
  };

  /** Every guarded status write the real JobService performed, in order. */
  const patches = () =>
    jobHarness.ops
      .filter((op): op is Extract<Op, { kind: "update" }> => op.kind === "update")
      .map((op) => op.patch);

  return {
    run: () => processJobMessage(deps, args),
    calls,
    logs,
    patches,
    refunds: () => refunds,
    attemptCalls: jobHarness.attemptCalls,
    rpcCalls: jobHarness.rpcCalls,
  };
}

describe("processJobMessage with the real JobService: the 21F attempt thresholds", () => {
  it("case 1: a failing increment touches nothing — no execute, no archive, no refund, no status write", async () => {
    const harness = makeProcessHarness({
      attemptError: new Error("job attempt write failed (incrementAttempt)"),
    });

    await harness.run();

    // Nothing at all: no status transition, no executor, no archive, no delete,
    // no refund. The message stays invisible and comes back when its visibility
    // timeout expires — that is the whole point of not touching it.
    expect(harness.calls).toEqual([]);
    expect(harness.patches()).toEqual([]);
    expect(harness.refunds()).toBe(0);
    expect(harness.logs.join(" ")).toContain("incrementAttempt failed");
    // And the count really was asked of the repository, not of anything else.
    expect(harness.attemptCalls).toEqual([{ jobId: PROCESS_JOB_ID }]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case 2: the check right after an increment is `>` — a spent budget still runs", async () => {
    const harness = makeProcessHarness({
      attemptRow: { attemptCount: 3, maxAttempts: 3 },
    });

    await harness.run();

    // The count was JUST incremented, so 3/3 is the last attempt and it must
    // run. `>=` here would fail every job on its final attempt.
    expect(harness.calls).toEqual(["executor", "deleteMsg"]);
    expect(harness.patches().map((patch) => patch.status)).toEqual([
      "running",
      "succeeded",
    ]);
    expect(harness.refunds()).toBe(0);
  });

  it("case 3: one past the budget fails before executing, then refunds once and archives", async () => {
    const harness = makeProcessHarness({
      attemptRow: { attemptCount: 4, maxAttempts: 3 },
    });

    await harness.run();

    expect(harness.calls).toEqual(["refundJob", "archive"]);
    expect(harness.calls).not.toContain("executor");
    expect(harness.patches().map((patch) => patch.status)).toEqual(["failed"]);
    expect(harness.patches()[0]?.error_code).toBe("max_attempts_exceeded");
    expect(String(harness.patches()[0]?.error_message)).toContain("4/3");
    expect(harness.refunds()).toBe(1);
  });

  it("case 4: the check after an execution failure is `>=` — the last attempt fails terminally", async () => {
    const harness = makeProcessHarness({
      attemptRow: { attemptCount: 3, maxAttempts: 3 },
      executorThrows: { message: "provider still down" },
    });

    await harness.run();

    // Unlike case 2, this decision is made AFTER the failure: there is no
    // attempt left to spend, so it is terminal — failed, refunded once, archived.
    expect(harness.patches().map((patch) => patch.status)).toEqual([
      "running",
      "failed",
    ]);
    expect(harness.patches()[1]?.error_code).toBe("executor_error");
    expect(harness.calls).toEqual(["executor", "refundJob", "archive"]);
    expect(harness.calls).not.toContain("deleteMsg");
    expect(harness.refunds()).toBe(1);
  });

  it("case 5: one attempt short of the budget is retried, never failed and never archived", async () => {
    const harness = makeProcessHarness({
      attemptRow: { attemptCount: 2, maxAttempts: 3 },
      executorThrows: { message: "provider hiccup" },
    });

    await harness.run();

    // A retryable failure writes `retrying`, never `failed`: writing `failed`
    // would tell the user the generation is over while the worker is still going
    // to retry it. The message is deliberately NOT archived.
    expect(harness.patches().map((patch) => patch.status)).toEqual([
      "running",
      "retrying",
    ]);
    expect(harness.patches()[1]?.error_code).toBe("executor_error");
    expect(harness.calls).toEqual(["executor"]);
    expect(harness.calls).not.toContain("archive");
    expect(harness.refunds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 工单21H0 — the background job WRITE PROTOCOL baseline.
//
// These cases pin what createJob / cancelJob DO today and in what order:
// authorize -> insert -> enqueue, with a compensation delete when the enqueue
// fails; the money's place in that sequence; and the guarded cancel. They are
// baselines, NOT fixes — where the current behaviour is a risk (a refused
// compensation is silent, a credits-info failure cancels a paid job and refunds
// nothing) the case pins THAT, so a later workorder has to change this file on
// purpose instead of drifting past it.
//
// `case H<n>` numbering keeps them apart from the earlier blocks in this file.
// ---------------------------------------------------------------------------

const WRITE_USER = {
  accessToken: "token-21h0",
  email: "job-write@hahart.test",
  id: "user-21h0",
  userMetadata: {},
};

const WRITE_JOB_ROW: Record<string, unknown> = {
  id: "job-21h0",
  workspace_id: "ws-1",
  project_id: "project-1",
  canvas_id: "canvas-1",
  session_id: null,
  thread_id: null,
  queue_name: "image_generation_jobs",
  job_type: "image_generation",
  status: "queued",
  payload: {},
  result: null,
  error_code: null,
  error_message: null,
  attempt_count: 0,
  max_attempts: 3,
  created_by: "user-21h0",
  created_at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  failed_at: null,
  canceled_at: null,
};

describe("createJob: authorize, then insert, then enqueue (工单21H0)", () => {
  it("case H1: the three steps happen in that order, and the enqueue is last", async () => {
    const harness = makeHarness({
      canvasRow: { project_id: "project-1" },
      insertedJob: WRITE_JOB_ROW,
    });

    await harness.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      canvasId: "canvas-1",
      jobType: "image_generation",
      payload: { prompt: "a red fox" },
    });

    // The authorization READ is what makes the INSERT legal, so it cannot move
    // after it; and nothing is enqueued before the row exists.
    expect(harness.trace).toEqual([
      "read:canvases",
      "insert:background_jobs",
      "send:image_generation_jobs",
    ]);
  });

  it("case H2: a failed authorization read is a 500, with no insert and no enqueue", async () => {
    for (const failing of ["canvas", "project"] as const) {
      const harness = makeHarness({
        insertedJob: WRITE_JOB_ROW,
        ...(failing === "canvas"
          ? { canvasError: { message: "permission denied for table canvases" } }
          : { projectError: { message: "permission denied for table projects" } }),
      });

      const error = await harness.service
        .createJob(WRITE_USER, {
          workspaceId: "ws-1",
          ...(failing === "canvas"
            ? { canvasId: "canvas-1" }
            : { projectId: "project-1" }),
          jobType: "image_generation",
          payload: { prompt: "x" },
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown as JobServiceError);

      expect(error).toBeInstanceOf(JobServiceError);
      expect(error?.code).toBe("job_create_failed");
      expect(error?.statusCode).toBe(500);
      // A read failure is NOT the same answer as "you may not use this canvas":
      // it is reported as a server fault, with the database text left out.
      expect(error?.message).toBe(
        failing === "canvas"
          ? "Failed to verify the job canvas."
          : "Failed to verify the job project.",
      );
      expect(harness.insertOp()).toBeUndefined();
      expect(harness.deletes()).toHaveLength(0);
      expect(harness.sentMessages).toHaveLength(0);
    }
  });

  it("case H3: every step runs through the CALLER's client, with the caller's token", async () => {
    const harness = makeHarness({
      canvasRow: { project_id: "project-1" },
      insertedJob: WRITE_JOB_ROW,
    });

    await harness.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      canvasId: "canvas-1",
      jobType: "image_generation",
      payload: { prompt: "x" },
    });

    expect(harness.ops.length).toBeGreaterThan(0);
    expect(harness.ops.every((op) => op.via === "user")).toBe(true);
    // The client is built from the caller's access token, so RLS decides what
    // the authorization read can see. The admin client is not used here at all.
    expect(harness.clientTokens).toEqual(["token-21h0"]);

    // cancelJob is the caller's client too...
    const cancelHarness = makeHarness({ jobRow: WRITE_JOB_ROW });
    await cancelHarness.service.cancelJob(WRITE_USER, "job-21h0");
    expect(cancelHarness.ops.every((op) => op.via === "user")).toBe(true);
    expect(cancelHarness.clientTokens).toEqual(["token-21h0"]);

    // ...while the worker's guarded transitions are the admin client's.
    const adminHarness = makeHarness({ updatedRows: 1 });
    await adminHarness.service.markRunning("job-21h0");
    expect(adminHarness.ops.every((op) => op.via === "admin")).toBe(true);
    expect(adminHarness.clientTokens).toEqual([]);
  });

  it("case H4: an insert that fails - or answers no row - is a 500 and nothing is enqueued", async () => {
    for (const inserted of [
      makeHarness({
        insertError: { message: "duplicate key value violates unique constraint" },
      }),
      makeHarness({ insertedJob: null }),
    ]) {
      const error = await inserted.service
        .createJob(WRITE_USER, {
          workspaceId: "ws-1",
          jobType: "image_generation",
          payload: { prompt: "x" },
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown as JobServiceError);

      expect(error).toBeInstanceOf(JobServiceError);
      expect(error?.code).toBe("job_create_failed");
      expect(error?.statusCode).toBe(500);
      expect(error?.message).toBe("Failed to create job record.");

      // Nothing to enqueue, and nothing to compensate: the row never existed.
      expect(inserted.sentMessages).toHaveLength(0);
      expect(inserted.deletes()).toHaveLength(0);
      expect(inserted.jobRows.size).toBe(0);
    }
  });

  it("case H5: the inserted row is shaped here - including the queue, which comes from the job type", async () => {
    const image = makeHarness({
      canvasRow: { project_id: "project-from-canvas" },
      insertedJob: WRITE_JOB_ROW,
    });
    await image.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      canvasId: "canvas-1",
      sessionId: "session-1",
      threadId: "thread-1",
      jobType: "image_generation",
      payload: { prompt: "a red fox" },
    });

    // The exact key set, so a field added or dropped by a later workorder is a
    // visible change: status/attempt_count/max_attempts are left to the server
    // defaults and are deliberately NOT in this object.
    expect(image.insertOp()?.row).toEqual({
      workspace_id: "ws-1",
      project_id: "project-from-canvas",
      canvas_id: "canvas-1",
      session_id: "session-1",
      thread_id: "thread-1",
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      payload: { prompt: "a red fox" },
      created_by: "user-21h0",
    });

    const video = makeHarness({ insertedJob: WRITE_JOB_ROW });
    await video.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      jobType: "video_generation",
      payload: { prompt: "a slow pan" },
    });

    expect(video.insertOp()?.row).toEqual({
      workspace_id: "ws-1",
      project_id: null,
      canvas_id: null,
      session_id: null,
      thread_id: null,
      queue_name: "video_generation_jobs",
      job_type: "video_generation",
      payload: { prompt: "a slow pan" },
      created_by: "user-21h0",
    });
  });

  it("case H6: the queue message carries ids only - no payload, no project, no token", async () => {
    const harness = makeHarness({
      canvasRow: { project_id: "project-1" },
      insertedJob: WRITE_JOB_ROW,
    });
    await harness.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      canvasId: "canvas-1",
      sessionId: "session-1",
      jobType: "image_generation",
      payload: { prompt: "a secret prompt the queue must not repeat" },
    });

    expect(harness.sentMessages).toEqual([
      {
        queue: "image_generation_jobs",
        message: {
          job_id: "job-21h0",
          job_type: "image_generation",
          workspace_id: "ws-1",
          canvas_id: "canvas-1",
          session_id: "session-1",
        },
      },
    ]);
    const message = harness.sentMessages[0]?.message as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual([
      "canvas_id",
      "job_id",
      "job_type",
      "session_id",
      "workspace_id",
    ]);

    // A job with no canvas and no session omits those two keys entirely (they
    // are spread in conditionally), rather than sending nulls.
    const projectOnly = makeHarness({
      projectRow: { id: "project-9" },
      insertedJob: WRITE_JOB_ROW,
    });
    await projectOnly.service.createJob(WRITE_USER, {
      workspaceId: "ws-1",
      projectId: "project-9",
      threadId: "thread-1",
      jobType: "image_generation",
      payload: {},
    });

    expect(projectOnly.sentMessages).toEqual([
      {
        queue: "image_generation_jobs",
        message: {
          job_id: "job-21h0",
          job_type: "image_generation",
          workspace_id: "ws-1",
        },
      },
    ]);
  });

  it("case H7: a failed enqueue compensates by deleting the row and reports job_create_failed", async () => {
    const logged: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });

    try {
      const harness = makeHarness({
        insertedJob: WRITE_JOB_ROW,
        sendError: new Error("pgmq is down"),
      });

      const error = await harness.service
        .createJob(WRITE_USER, {
          workspaceId: "ws-1",
          jobType: "image_generation",
          payload: { prompt: "x" },
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown as JobServiceError);

      expect(error).toBeInstanceOf(JobServiceError);
      expect(error?.code).toBe("job_create_failed");
      expect(error?.statusCode).toBe(500);
      expect(error?.message).toBe("Failed to enqueue job.");

      // One attempt, no retry.
      expect(harness.sentMessages).toHaveLength(1);
      // The compensation: exactly one DELETE, on this table, by this job id,
      // through the caller's client (so RLS decides whether it can land).
      expect(harness.deletes()).toHaveLength(1);
      expect(harness.deletes()[0]?.via).toBe("user");
      expect(
        harness.ops.some(
          (op) => op.kind === "eq" && op.column === "id" && op.value === "job-21h0",
        ),
      ).toBe(true);
      expect(harness.jobRows.has("job-21h0")).toBe(false);
      // The only trace of the enqueue failure is a console.error naming it.
      expect(logged).toHaveLength(1);
      expect(String(logged[0]?.[0])).toContain("[job-service] pgmq.send failed:");
    } finally {
      spy.mockRestore();
    }
  });

  it("case H8: a REFUSED compensation is silent - the orphan row stays and the caller only hears about the enqueue", async () => {
    // Zero rows: RLS filtered the delete out (the row is not the caller's), or
    // it was already gone. The service never reads that answer.
    const zeroRows = makeHarness({
      insertedJob: WRITE_JOB_ROW,
      sendError: new Error("pgmq is down"),
      deleteRows: 0,
    });
    const zeroRowsError = await zeroRows.service
      .createJob(WRITE_USER, {
        workspaceId: "ws-1",
        jobType: "image_generation",
        payload: { prompt: "x" },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(zeroRowsError?.message).toBe("Failed to enqueue job.");
    expect(zeroRows.deletes()).toHaveLength(1);
    // CURRENT BEHAVIOUR, PINNED AS A RISK: the job row that could not be removed
    // survives, and nothing in the response or the log says so.
    expect(zeroRows.jobRows.has("job-21h0")).toBe(true);

    // The same holds when the delete itself reports a database error: it is not
    // checked, not retried and not logged.
    const deleteFailed = makeHarness({
      insertedJob: WRITE_JOB_ROW,
      sendError: new Error("pgmq is down"),
      deleteError: { message: "permission denied for table background_jobs" },
    });
    const deleteFailedError = await deleteFailed.service
      .createJob(WRITE_USER, {
        workspaceId: "ws-1",
        jobType: "image_generation",
        payload: { prompt: "x" },
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(deleteFailedError?.message).toBe("Failed to enqueue job.");
    expect(deleteFailed.deletes()).toHaveLength(1);
    expect(deleteFailed.jobRows.has("job-21h0")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withBilling driven through the REAL JobService: with-billing.test.ts pins the
// money rules against a stub job service, and these cases pin the same run
// against the statements createJob/cancelJob actually issue.
// ---------------------------------------------------------------------------

type BillingScenario = {
  balance?: number;
  cost?: number;
  deductError?: Error;
  deductTxId?: string;
  /**
   * Workorder 21H2: what the credits-link repository answers to
   * `setCreditsInfo`. `linked: false` is the migrated form of the old resolved
   * "the write did not land" answer; `linkError` is the rejected-promise form.
   */
  creditsLink?: HarnessConfig["creditsLink"];
  /** `false` models a cancel whose guard matched no row (404, swallowed). */
  cancelSeesRow?: boolean;
};

function makeBillingHarness(scenario: BillingScenario = {}) {
  const harness = makeHarness({
    insertedJob: WRITE_JOB_ROW,
    canvasRow: { project_id: "project-1" },
    jobRow: scenario.cancelSeesRow === false ? null : WRITE_JOB_ROW,
    ...(scenario.creditsLink === undefined
      ? {}
      : { creditsLink: scenario.creditsLink }),
  });

  // Billing markers go into the SAME trace as the service's own statements, so
  // "the balance was checked before the job existed" is one ordered list.
  const mark = (entry: string): void => {
    harness.trace.push(entry);
  };

  const creditService = {
    async getBalance() {
      mark("billing:getBalance");
      return {
        balance: scenario.balance ?? 1000,
        plan: "pro" as const,
        dailyClaimed: false,
      };
    },
    async getSubscription() {
      mark("billing:getSubscription");
      return {
        plan: "pro" as const,
        billingPeriod: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        canceledAt: null,
      };
    },
    async deductCredits(
      _workspaceId: string,
      _userId: string,
      amount: number,
      jobId?: string,
    ) {
      mark(`billing:deductCredits:${amount}:${jobId ?? "none"}`);
      if (scenario.deductError) throw scenario.deductError;
      return scenario.deductTxId ?? "tx-21h0";
    },
    async refundCredits(_workspaceId: string, _userId: string, amount: number) {
      mark(`billing:refundCredits:${amount}`);
      return "tx-refund";
    },
    async claimDailyCredits() {
      return { success: false };
    },
    async getTransactions() {
      return [];
    },
    async updatePlan() {
      mark("billing:updatePlan");
    },
  } as unknown as CreditService;

  const tierGuard = {
    checkModelAccess(plan: string, modelId: string) {
      mark(`billing:checkModelAccess:${plan}:${modelId}`);
    },
    checkResolution(_plan: string, quality: string) {
      mark(`billing:checkResolution:${quality}`);
    },
    checkVideoResolution() {},
    async checkConcurrency(workspaceId: string) {
      mark(`billing:checkConcurrency:${workspaceId}`);
    },
    calculateCreditCost() {
      mark(`billing:calculateCreditCost:${scenario.cost ?? 10}`);
      return scenario.cost ?? 10;
    },
  } as unknown as TierGuard;

  const bill = (options: { onRejected?: (rejection: BillingRejection) => void } = {}) =>
    withBilling(
      { creditService, tierGuard, jobService: harness.service },
      {
        user: WRITE_USER,
        workspaceId: "ws-1",
        modelId: "model-21h0",
        guard: { jobType: "image_generation", quality: "hd" },
        description: "Image generation: model-21h0",
        job: { payload: { prompt: "a red fox" }, refs: { canvasId: "canvas-1" } },
        ...(options.onRejected ? { onRejected: options.onRejected } : {}),
      },
      async (outcome) => {
        harness.trace.push("run:body");
        return { jobId: outcome.job?.id ?? null, creditsCost: outcome.creditsCost };
      },
    );

  return { harness, bill };
}

describe("withBilling through the real JobService: where the money sits in the write (工单21H0)", () => {
  it("case H9: a balance below the price is refused BEFORE any job row or queue message exists", async () => {
    const { harness, bill } = makeBillingHarness({ balance: 3, cost: 10 });
    const rejections: BillingRejection[] = [];

    const error = await bill({ onRejected: (r) => rejections.push(r) })
      .then(() => null)
      .catch((thrown: unknown) => thrown as CreditServiceError);

    expect(error).toBeInstanceOf(CreditServiceError);
    expect(error?.code).toBe("insufficient_credits");
    expect(error?.statusCode).toBe(402);
    expect(rejections).toEqual([
      {
        kind: "insufficient_credits",
        currentBalance: 3,
        requiredAmount: 10,
        plan: "pro",
        dailyClaimed: false,
      },
    ]);

    // The whole run stopped at the pre-check: no canvas read, no insert, no
    // enqueue, no charge, no cancel. This is why the job is not created first
    // and cancelled afterwards any more.
    expect(harness.trace).toEqual([
      "billing:getSubscription",
      "billing:checkModelAccess:pro:model-21h0",
      "billing:checkResolution:hd",
      "billing:checkConcurrency:ws-1",
      "billing:calculateCreditCost:10",
      "billing:getBalance",
    ]);
    expect(harness.insertOp()).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.patches()).toEqual([]);
  });

  it("case H10: a failed charge cancels the job it just created, and the charge error survives", async () => {
    const { harness, bill } = makeBillingHarness({
      deductError: new CreditServiceError("credit_deduct_failed", "deduct exploded", 500),
    });

    const error = await bill()
      .then(() => null)
      .catch((thrown: unknown) => thrown as CreditServiceError);

    expect(error?.message).toBe("deduct exploded");

    // The job existed and was enqueued BEFORE the charge was attempted: the
    // charge carries its id, which is why the id has to exist first.
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.trace).toContain("billing:deductCredits:10:job-21h0");
    expect(harness.trace.indexOf("send:image_generation_jobs")).toBeLessThan(
      harness.trace.indexOf("billing:deductCredits:10:job-21h0"),
    );

    // The reaction to a failed charge is the guarded cancel, and nothing else:
    // no PGMQ lifecycle, no compensation delete, no refund.
    expect(harness.patches()).toEqual([
      { status: "canceled", canceled_at: expect.any(String) },
    ]);
    expect(harness.inOp()?.values).toEqual(["queued", "running"]);
    expect(harness.deletes()).toHaveLength(0);
    expect(harness.messageLifecycle).toEqual(["send:image_generation_jobs"]);
    expect(harness.trace).not.toContain("billing:refundCredits:10");
    // The row is NOT deleted: the cancelled job is the record of the attempt.
    expect(harness.jobRows.has("job-21h0")).toBe(true);
    // And the credits bookkeeping was never reached: the cancel's update is the
    // only row write in the whole run.
    expect(harness.trace.filter((entry) => entry === "update:background_jobs")).toHaveLength(1);
  });

  it("case H11: when the charge fails AND the cancel is refused, the cancel failure is swallowed", async () => {
    const { harness, bill } = makeBillingHarness({
      deductError: new CreditServiceError("credit_deduct_failed", "deduct exploded", 500),
      cancelSeesRow: false,
    });

    const error = await bill()
      .then(() => null)
      .catch((thrown: unknown) => thrown as CreditServiceError);

    // The caller learns about the charge, never about the cancel: the promise
    // rejection of the cancel is caught with an empty handler.
    expect(error?.message).toBe("deduct exploded");

    // The cancel WAS attempted - the guarded update was built and sent - and it
    // is the guard that matched nothing, so the job stays `queued` and the
    // worker will still pick it up after a charge that failed.
    expect(harness.patches()).toEqual([
      { status: "canceled", canceled_at: expect.any(String) },
    ]);
    expect(harness.jobRows.has("job-21h0")).toBe(true);
    expect(harness.trace).not.toContain("billing:refundCredits:10");
  });

  it("case H12 (FLIPPED 21H2): a credits-info write that did not land is no longer dropped — it fails the request", async () => {
    // OLD ASSERTION (21H0): the write's resolved answer was ignored, the charge
    // went through, the body ran, and the job kept a NULL
    // `credits_transaction_id` with nobody refunding it.
    //
    // NEW ASSERTION (21H2): the link write's result is checked. `linked: false`
    // is the predicate answering "this row is not billable any more" — the same
    // class of answer the old resolved `{ error: "permission denied ..." }` was,
    // in the shape the `pg` repository reports it. It now becomes the service's
    // fixed `job_query_failed` 500, the body does NOT run, and the charge is
    // compensated (claim -> refund -> mark) because the money was already taken.
    const { harness, bill } = makeBillingHarness({
      creditsLink: { linked: false },
    });

    const error = await bill()
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_query_failed");
    expect(error?.statusCode).toBe(500);
    // Fixed text: it names the job, never the driver's message or any SQL.
    expect(error?.message).toBe(
      "The job credits for job-21h0 were not recorded: the job is no longer billable.",
    );
    expect(error?.message).not.toMatch(
      /permission denied|background_jobs|public\.|postgres:\/\//i,
    );

    // The charge DID happen, and the link was attempted exactly once through the
    // repository — the PostgREST update is gone, so no admin patch carries the
    // credit columns any more.
    expect(harness.trace).toContain("billing:deductCredits:10:job-21h0");
    expect(harness.creditsLinkOperations()).toEqual([
      "linkCredits",
      "claimUnlinkedCharge",
      "markChargeRefunded",
    ]);
    expect(harness.creditsLinkCalls[0]?.input).toEqual({
      jobId: "job-21h0",
      creditsCost: 10,
      transactionId: "tx-21h0",
    });
    expect(harness.patches()).toEqual([]);

    // Nobody executes a job nobody can bill, and the money goes back exactly
    // once, in the order the ownership rule requires.
    expect(harness.trace).not.toContain("run:body");
    expect(harness.trace).toContain("billing:refundCredits:10");
    expect(
      harness.trace.indexOf("credits-link:claim"),
    ).toBeLessThan(harness.trace.indexOf("billing:refundCredits:10"));
    expect(
      harness.trace.indexOf("billing:refundCredits:10"),
    ).toBeLessThan(harness.trace.indexOf("credits-link:mark"));
    // No cancel: the claim already moved the job. A cancel would have added a
    // second guarded `update:background_jobs` (and a patch), so counting the row
    // writes is what states the flip rather than describing it.
    expect(
      harness.trace.filter((entry) => entry === "update:background_jobs"),
    ).toHaveLength(1);
    expect(harness.jobRows.has("job-21h0")).toBe(true);
  });

  it("case H13 (FLIPPED 21H2): a credits-info write that THROWS claims, refunds and marks instead of cancelling", async () => {
    // OLD ASSERTION (21H0): the money was taken, the write threw, and the only
    // reaction was to cancel the job — nobody refunded.
    //
    // NEW ASSERTION (21H2): the same rejection is answered by the compensation.
    // Cancel is gone from this path on purpose: the claim moves a
    // queued/retrying job to `failed`, so cancelling would either be a no-op or
    // race that write.
    const transport = new Error("fetch failed: connection reset by peer");
    const { harness, bill } = makeBillingHarness({
      creditsLink: { linkError: transport },
    });

    const error = await bill()
      .then(() => null)
      .catch((thrown: unknown) => thrown as Error);

    // The caller still sees the write failure the request actually hit: the
    // compensation neither replaces it nor hides it.
    expect(error).toBeInstanceOf(JobServiceError);
    expect((error as JobServiceError).code).toBe("job_query_failed");
    expect((error as JobServiceError).message).toBe(
      "Failed to record the job credits for job-21h0.",
    );

    expect(harness.trace).toContain("billing:deductCredits:10:job-21h0");
    expect(harness.creditsLinkOperations()).toEqual([
      "linkCredits",
      "claimUnlinkedCharge",
      "markChargeRefunded",
    ]);
    expect(harness.trace).toContain("billing:refundCredits:10");

    // THE FLIP, stated as the assertion the old pin made: there is no cancel any
    // more, and the credit columns are not written by a PostgREST update. The
    // link is the only row write — a cancel would have added a second
    // `update:background_jobs` through the guarded status update.
    expect(harness.patches()).toEqual([]);
    expect(harness.patches()).not.toContainEqual({
      status: "canceled",
      canceled_at: expect.any(String),
    });
    expect(
      harness.trace.filter((entry) => entry === "update:background_jobs"),
    ).toHaveLength(1);
    expect(harness.trace).not.toContain("run:body");
    expect(harness.jobRows.has("job-21h0")).toBe(true);
  });

  it("case H14: the full order - guards, balance, job, enqueue, charge, credits info, body", async () => {
    const { harness, bill } = makeBillingHarness({});

    const result = await bill();

    expect(result).toEqual({ jobId: "job-21h0", creditsCost: 10 });
    expect(harness.trace).toEqual([
      "billing:getSubscription",
      "billing:checkModelAccess:pro:model-21h0",
      "billing:checkResolution:hd",
      "billing:checkConcurrency:ws-1",
      "billing:calculateCreditCost:10",
      "billing:getBalance",
      "read:canvases",
      "insert:background_jobs",
      "send:image_generation_jobs",
      "billing:deductCredits:10:job-21h0",
      "update:background_jobs",
      "run:body",
    ]);
  });
});

describe("cancelJob: the guarded update and what it deliberately does not do (工单21H0)", () => {
  it("case H15: cancel writes two columns for queued/running only, and touches neither PGMQ nor credits", async () => {
    const harness = makeHarness({
      jobRow: { ...WRITE_JOB_ROW, status: "canceled", canceled_at: "2026-10-16T00:00:00.000Z" },
    });

    const job = await harness.service.cancelJob(WRITE_USER, "job-21h0");

    expect(job.status).toBe("canceled");
    // Exactly two keys, and `canceled_at` is a timestamp this process produced.
    expect(harness.updateOp()?.patch).toEqual({
      status: "canceled",
      canceled_at: expect.any(String),
    });
    // The guard list is exactly queued/running: `retrying` is NOT cancelable,
    // and neither is a terminal state. Everything else answers 404.
    expect(harness.inOp()?.column).toBe("status");
    expect(harness.inOp()?.values).toEqual(["queued", "running"]);
    // maybeSingle, so a guard that matched nothing is "no job", not a 500.
    expect(
      harness.ops.some((op) => op.kind === "maybeSingle" && op.table === "background_jobs"),
    ).toBe(true);

    // Cancelling does not consume the queue message, does not delete the row and
    // does not move any money: the worker's own guard handles the message.
    expect(harness.messageLifecycle).toEqual([]);
    expect(harness.deletes()).toHaveLength(0);
    expect(harness.patches()).toHaveLength(1);
    expect(harness.rpcCalls).toEqual([]);
  });

  it("case H16: a job the guard does not match is a 404 with the fixed message", async () => {
    // The harness answers "no row" exactly as PostgreSQL does for a status
    // outside queued/running - the PGlite baseline measures that per status.
    const harness = makeHarness({ jobRow: null });

    const error = await harness.service
      .cancelJob(WRITE_USER, "job-21h0")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_not_found");
    expect(error?.statusCode).toBe(404);
    expect(error?.message).toBe("Job not found or already completed.");
    // The same guard was applied; the refusal is the row count, not an error.
    expect(harness.inOp()?.values).toEqual(["queued", "running"]);
    expect(harness.messageLifecycle).toEqual([]);
  });

  it("case H17: a cancel that cannot reach the database is a 500 job_cancel_failed", async () => {
    const harness = makeHarness({ jobRowError: { message: "connection reset" } });

    const error = await harness.service
      .cancelJob(WRITE_USER, "job-21h0")
      .then(() => null)
      .catch((thrown: unknown) => thrown as JobServiceError);

    expect(error).toBeInstanceOf(JobServiceError);
    expect(error?.code).toBe("job_cancel_failed");
    expect(error?.statusCode).toBe(500);
    expect(error?.message).toBe("Failed to cancel job.");
  });
});

describe("processJobMessage with the real JobService: single-ownership boundaries (工单21H0)", () => {
  it("case H18: a missing row, and a job that can no longer start, are archived without executing or refunding", async () => {
    // The job row is gone: nothing to execute, nothing to refund, nothing to
    // write - only the message is retired.
    const gone = makeProcessHarness({ attemptRow: null });
    await gone.run();

    expect(gone.calls).toEqual(["archive"]);
    expect(gone.patches()).toEqual([]);
    expect(gone.refunds()).toBe(0);

    // Cancelled meanwhile: markRunning changed no row, so the message is
    // archived and the job keeps the status somebody else gave it.
    const noLongerStartable = makeProcessHarness({ updateOutcomes: [{ rows: 0 }] });
    await noLongerStartable.run();

    expect(noLongerStartable.calls).toEqual(["archive"]);
    expect(noLongerStartable.calls).not.toContain("executor");
    expect(noLongerStartable.patches().map((patch) => patch.status)).toEqual([
      "running",
    ]);
    expect(noLongerStartable.refunds()).toBe(0);
  });

  it("case H19: a status write that changed no row never refunds and never re-marks", async () => {
    // markFailed changed nothing: another writer already moved the job out of a
    // markable state, so refunding here would pay the same charge twice.
    const lostRace = makeProcessHarness({
      attemptRow: { attemptCount: 3, maxAttempts: 3 },
      executorThrows: { message: "provider down" },
      updateOutcomes: [{ rows: 1 }, { rows: 0 }],
    });
    await lostRace.run();

    expect(lostRace.patches().map((patch) => patch.status)).toEqual([
      "running",
      "failed",
    ]);
    expect(lostRace.calls).toEqual(["executor", "archive"]);
    expect(lostRace.refunds()).toBe(0);

    // Cancelled while the executor was running: the message is DELETED (not
    // archived), the cancelled status is left alone, and no refund is issued.
    const cancelledWhileRunning = makeProcessHarness({
      updateOutcomes: [{ rows: 1 }, { rows: 0 }],
    });
    await cancelledWhileRunning.run();

    expect(cancelledWhileRunning.patches().map((patch) => patch.status)).toEqual([
      "running",
      "succeeded",
    ]);
    expect(cancelledWhileRunning.calls).toEqual(["executor", "deleteMsg"]);
    expect(cancelledWhileRunning.calls).not.toContain("archive");
    expect(cancelledWhileRunning.refunds()).toBe(0);
  });

  it("case H20: a non-retryable code fails terminally on the FIRST attempt, refunding once and archiving", async () => {
    const harness = makeProcessHarness({
      attemptRow: { attemptCount: 1, maxAttempts: 3 },
      executorThrows: { code: "safety_filter", message: "blocked by policy" },
    });

    await harness.run();

    // A code that can only fail the same way does not get a second attempt:
    // failed with the executor's own code, one refund, one archive, no delete.
    expect(harness.patches().map((patch) => patch.status)).toEqual([
      "running",
      "failed",
    ]);
    expect(harness.patches()[1]?.error_code).toBe("safety_filter");
    expect(String(harness.patches()[1]?.error_message)).toContain("blocked by policy");
    expect(harness.patches()[1]?.failed_at).toEqual(expect.any(String));
    expect(harness.calls).toEqual(["executor", "refundJob", "archive"]);
    expect(harness.calls).not.toContain("deleteMsg");
    expect(harness.refunds()).toBe(1);
  });
});
