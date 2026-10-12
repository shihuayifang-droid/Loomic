import { describe, expect, it } from "vitest";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import { createJobService, type JobService } from "./job-service.js";

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
};

function makeHarness(config: HarnessConfig = {}) {
  const ops: Op[] = [];
  const rpcCalls: Array<{ name: string; params: unknown }> = [];

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

  const service: JobService = createJobService({
    createUserClient: () => client as unknown as UserSupabaseClient,
    getAdminClient: () => client as unknown as AdminSupabaseClient,
    pgmq: {
      send: async (queue: string, message: unknown) => {
        sentMessages.push({ queue, message });
        return 1;
      },
    } as unknown as PgmqClient,
  });

  const inOp = () => ops.find((op): op is Extract<Op, { kind: "in" }> => op.kind === "in");
  const updateOp = () =>
    ops.find((op): op is Extract<Op, { kind: "update" }> => op.kind === "update");
  const insertOp = () =>
    ops.find((op): op is Extract<Op, { kind: "insert" }> => op.kind === "insert");

  return { service, ops, rpcCalls, sentMessages, inOp, updateOp, insertOp };
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

  it("case 6: a failing attempt RPC throws instead of inventing a count", async () => {
    const harness = makeHarness({ rpc: { data: null, error: { message: "rpc down" } } });

    await expect(harness.service.incrementAttempt("job-1")).rejects.toThrow(/rpc down/);
    expect(harness.rpcCalls).toEqual([
      { name: "increment_job_attempt", params: { p_job_id: "job-1" } },
    ]);
  });

  it("case 7: an attempt RPC with no rows returns null", async () => {
    const harness = makeHarness({ rpc: { data: [], error: null } });

    expect(await harness.service.incrementAttempt("job-1")).toBeNull();
  });

  it("case 7b: an attempt RPC with a row returns the counts", async () => {
    const harness = makeHarness({
      rpc: { data: [{ attempt_count: 2, max_attempts: 3 }], error: null },
    });

    expect(await harness.service.incrementAttempt("job-1")).toEqual({
      attempt_count: 2,
      max_attempts: 3,
    });
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
