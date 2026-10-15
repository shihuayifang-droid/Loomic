import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import type { JobAttemptRepository } from "../../db/job-attempt-repository.js";
import { JobServiceError, createJobService, type JobService } from "./job-service.js";
import type { ExecutorContext, JobExecutor } from "./job-executor.js";
import { processJobMessage } from "./process-job-message.js";

type Op =
  | { kind: "update"; patch: Record<string, unknown> }
  | { kind: "insert"; table: string; row: Record<string, unknown> }
  | { kind: "select"; columns: string | undefined }
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "order" }
  | { kind: "limit" }
  | { kind: "maybeSingle"; table: string }
  | { kind: "single"; table: string };

type HarnessConfig = {
  /** Rows the guarded update reports as changed. */
  updatedRows?: number;
  updateError?: { message: string } | null;
  /** Row returned by `.maybeSingle()` (getJobAdmin). */
  jobRow?: Record<string, unknown> | null;
  rpc?: { data: unknown; error: { message: string } | null };
  /** Row returned by `.maybeSingle()` on `canvases` / `projects` (createJob). */
  canvasRow?: Record<string, unknown> | null;
  projectRow?: Record<string, unknown> | null;
  canvasError?: { code?: string; message: string } | null;
  projectError?: { code?: string; message: string } | null;
  /** Row the job insert reports back. */
  insertedJob?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
  /**
   * ADR-0001 / workorder 21F: what the attempt counter repository answers.
   * `null` is the "no such job row" answer; omit for a plain `1/3` row.
   */
  attemptRow?: { attemptCount: number; maxAttempts: number } | null;
  /** The repository throws this instead of answering. */
  attemptError?: Error;
  /** Build the service with NO attempt repository at all (fail-closed path). */
  withoutAttemptRepository?: boolean;
};

function makeHarness(config: HarnessConfig = {}) {
  const ops: Op[] = [];
  const rpcCalls: Array<{ name: string; params: unknown }> = [];
  const attemptCalls: Array<{ jobId: string }> = [];

  function makeBuilder(table: string) {
    const builder = {
      update: (patch: Record<string, unknown>) => {
        ops.push({ kind: "update", patch });
        return builder;
      },
      insert: (row: Record<string, unknown>) => {
        ops.push({ kind: "insert", table, row });
        return builder;
      },
      select: (columns?: string) => {
        ops.push({ kind: "select", columns });
        return builder;
      },
      eq: (column: string, value: unknown) => {
        ops.push({ kind: "eq", column, value });
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        ops.push({ kind: "in", column, values });
        return builder;
      },
      order: () => {
        ops.push({ kind: "order" });
        return builder;
      },
      limit: () => {
        ops.push({ kind: "limit" });
        return builder;
      },
      maybeSingle: async () => {
        ops.push({ kind: "maybeSingle", table });
        if (table === "canvases") {
          return { data: config.canvasRow ?? null, error: config.canvasError ?? null };
        }
        if (table === "projects") {
          return { data: config.projectRow ?? null, error: config.projectError ?? null };
        }
        return { data: config.jobRow ?? null, error: null };
      },
      single: async () => {
        ops.push({ kind: "single", table });
        return { data: config.insertedJob ?? null, error: config.insertError ?? null };
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: Array.from({ length: config.updatedRows ?? 0 }, () => ({ id: "job-1" })),
          error: config.updateError ?? null,
        }).then(resolve),
    };

    return builder;
  }

  const sentMessages: Array<{ queue: string; message: unknown }> = [];

  const client = {
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string, params: unknown) => {
      rpcCalls.push({ name, params });
      return config.rpc ?? { data: null, error: null };
    },
  };

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

  const service: JobService = createJobService({
    createUserClient: () => client as unknown as UserSupabaseClient,
    getAdminClient: () => client as unknown as AdminSupabaseClient,
    pgmq: {
      send: async (queue: string, message: unknown) => {
        sentMessages.push({ queue, message });
        return 1;
      },
    } as unknown as PgmqClient,
    ...(config.withoutAttemptRepository ? {} : { jobAttemptRepository }),
  });

  const inOp = () => ops.find((op): op is Extract<Op, { kind: "in" }> => op.kind === "in");
  const updateOp = () =>
    ops.find((op): op is Extract<Op, { kind: "update" }> => op.kind === "update");
  const insertOp = () =>
    ops.find((op): op is Extract<Op, { kind: "insert" }> => op.kind === "insert");

  return { service, ops, rpcCalls, attemptCalls, sentMessages, inOp, updateOp, insertOp };
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

  it("case 8: a legacy dead_letter row is read as failed", async () => {
    const harness = makeHarness({
      jobRow: {
        id: "job-1",
        workspace_id: "ws-1",
        status: "dead_letter",
        job_type: "image_generation",
        queue_name: "q",
        payload: {},
        attempt_count: 3,
        max_attempts: 3,
        created_by: "user-1",
        created_at: "2026-09-30T00:00:00.000Z",
        updated_at: "2026-09-30T00:00:00.000Z",
      },
    });

    const job = await harness.service.getJobAdmin("job-1");

    expect(job.status).toBe("failed");
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
};

function makeProcessHarness(scenario: ProcessScenario = {}) {
  const jobHarness = makeHarness({
    updatedRows: 1,
    ...(scenario.attemptRow === undefined ? {} : { attemptRow: scenario.attemptRow }),
    ...(scenario.attemptError === undefined
      ? {}
      : { attemptError: scenario.attemptError }),
  });

  const calls: string[] = [];
  const logs: string[] = [];
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
    ctx: {} as ExecutorContext,
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
