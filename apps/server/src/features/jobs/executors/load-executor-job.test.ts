// Workorder 21N: both generation executors read their job row through ONE helper,
// and that helper reads it through `JobService.getJobAdmin`. Two properties are
// pinned here, and both are the reason the ticket exists:
//
//   * the six fields the executors consume arrive VERBATIM from the service — the
//     helper is a projection, not a second mapper;
//   * EVERY failure of that read comes out as the same bare
//     "Job <id> not found in database" Error the executors threw before, with no
//     `code` and no trace of the original text, so `processJobMessage` keeps
//     recording the retryable `executor_error`.
//
// The fake context is deliberately hostile to the OLD read: its admin client
// throws on first touch, so a test that still reaches for one fails loudly
// instead of quietly passing through a client that is no longer the source.
import { describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import { JobServiceError } from "../job-service.js";
import type { ExecutorContext } from "../job-executor.js";
import { loadExecutorJob } from "./load-executor-job.js";

const JOB_ID = "8f14e45f-ceea-467a-9c1e-1a2b3c4d5e6f";

const ADMIN_CLIENT_MESSAGE =
  "getAdminClient was reached: the job row must come from getJobAdmin";

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: "ws-personal-billing",
    project_id: "project-team-1",
    canvas_id: "canvas-1",
    session_id: "session-1",
    thread_id: "thread-1",
    queue_name: "image_generation",
    job_type: "image_generation",
    status: "running",
    payload: { prompt: "a cat", model: "test/model" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function makeContext(read: (jobId: string) => Promise<BackgroundJob>) {
  const getAdminClient = vi.fn(() => {
    throw new Error(ADMIN_CLIENT_MESSAGE);
  });
  const getJobAdmin = vi.fn(read);
  const ctx = {
    jobService: { getJobAdmin },
    getAdminClient,
  } as unknown as ExecutorContext;

  return { ctx, getAdminClient, getJobAdmin };
}

/** A context whose read always fails with `thrown`, whatever `thrown` is. */
function makeFailingContext(thrown: unknown) {
  return makeContext(async () => {
    throw thrown;
  });
}

/** A context that was never wired to an admin-read repository at all. */
function makeUnwiredContext() {
  const getAdminClient = vi.fn(() => {
    throw new Error(ADMIN_CLIENT_MESSAGE);
  });
  const ctx = { jobService: {}, getAdminClient } as unknown as ExecutorContext;

  return { ctx, getAdminClient };
}

function expectSingleRead(
  spies: ReturnType<typeof makeContext>,
  jobId: string,
): void {
  expect(spies.getAdminClient).toHaveBeenCalledTimes(0);
  expect(spies.getJobAdmin).toHaveBeenCalledTimes(1);
  expect(spies.getJobAdmin).toHaveBeenCalledWith(jobId);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("loadExecutorJob resolved; a rejection was expected");
}

/** The pre-21N failure contract, asserted in full. */
function expectLegacyNotFoundError(error: Error, jobId: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe(`Job ${jobId} not found in database`);
  // The message is the WHOLE message: no original text, no prefix, no suffix.
  expect(error.message).toHaveLength(`Job ${jobId} not found in database`.length);
  // No `code`, so `processJobMessage` classifies it as `executor_error`.
  expect((error as { code?: string }).code).toBeUndefined();
  expect("code" in error).toBe(false);
  // And it is not the service's own error, whose `code` would reclassify the job.
  expect(error).not.toBeInstanceOf(JobServiceError);
}

describe("loadExecutorJob: the six fields come from getJobAdmin verbatim", () => {
  it("1. returns created_by, workspace_id, canvas_id, project_id, session_id and payload as read", async () => {
    const job = makeJob();
    const spies = makeContext(async () => job);

    const row = await loadExecutorJob(spies.ctx, JOB_ID);

    expect(row).toEqual({
      created_by: "user-1",
      workspace_id: "ws-personal-billing",
      canvas_id: "canvas-1",
      project_id: "project-team-1",
      session_id: "session-1",
      payload: { prompt: "a cat", model: "test/model" },
    });
    expectSingleRead(spies, JOB_ID);
  });

  it("2. projects exactly those six keys — no extra field leaks through", async () => {
    const spies = makeContext(async () => makeJob());

    const row = await loadExecutorJob(spies.ctx, JOB_ID);

    expect(Object.keys(row).sort()).toEqual([
      "canvas_id",
      "created_by",
      "payload",
      "project_id",
      "session_id",
      "workspace_id",
    ]);
  });

  it("3. an empty payload is passed through as the very same object", async () => {
    const payload: Record<string, unknown> = {};
    const spies = makeContext(async () => makeJob({ payload }));

    const row = await loadExecutorJob(spies.ctx, JOB_ID);

    expect(row.payload).toEqual({});
    expect(row.payload).toBe(payload);
  });

  it("4. nullable ids stay null instead of turning into undefined or a string", async () => {
    const spies = makeContext(async () =>
      makeJob({ canvas_id: null, project_id: null, session_id: null }),
    );

    const row = await loadExecutorJob(spies.ctx, JOB_ID);

    expect(row.canvas_id).toBeNull();
    expect(row.project_id).toBeNull();
    expect(row.session_id).toBeNull();
    expect(row.workspace_id).toBe("ws-personal-billing");
  });

  it("5. payload contents are not rewritten on the way out", async () => {
    const payload = {
      prompt: "a cat",
      aspect_ratio: "16:9",
      input_images: ["one.png", "two.png"],
      nested: { keep: true },
    };
    const spies = makeContext(async () => makeJob({ payload }));

    const row = await loadExecutorJob(spies.ctx, JOB_ID);

    expect(row.payload).toBe(payload);
    expect(row.payload.input_images).toEqual(["one.png", "two.png"]);
    expect(row.payload.nested).toEqual({ keep: true });
  });

  it("6. a successful read calls getJobAdmin once with the job id and never the admin client", async () => {
    const spies = makeContext(async () => makeJob());

    await loadExecutorJob(spies.ctx, JOB_ID);

    expectSingleRead(spies, JOB_ID);
  });
});

describe("loadExecutorJob: every read failure keeps the pre-21N error", () => {
  it("7. job_not_found becomes the bare not-found Error", async () => {
    const spies = makeFailingContext(
      new JobServiceError("job_not_found", "Job not found.", 404),
    );

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("Job not found.");
    expectSingleRead(spies, JOB_ID);
  });

  it("8. job_query_failed becomes the same bare not-found Error", async () => {
    const spies = makeFailingContext(
      new JobServiceError("job_query_failed", "Failed to query job.", 500),
    );

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("Failed to query job.");
    expectSingleRead(spies, JOB_ID);
  });

  it("9. a plain Error becomes the same bare not-found Error", async () => {
    const spies = makeFailingContext(new Error("connect ECONNREFUSED 127.0.0.1"));

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("ECONNREFUSED");
    expectSingleRead(spies, JOB_ID);
  });

  it("10. a non-Error throw becomes the same bare not-found Error", async () => {
    const spies = makeFailingContext({ code: "job_query_failed", detail: "22P02" });

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("22P02");
    expectSingleRead(spies, JOB_ID);
  });

  it("11. a string thrown becomes the same bare not-found Error", async () => {
    const spies = makeFailingContext("job_query_failed: pool exhausted");

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("pool exhausted");
    expectSingleRead(spies, JOB_ID);
  });

  it("12. a service with no admin-read repository wired fails closed the same way", async () => {
    const spies = makeUnwiredContext();

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expectLegacyNotFoundError(error, JOB_ID);
    expect(error.message).not.toContain("getJobAdmin");
    expect(spies.getAdminClient).toHaveBeenCalledTimes(0);
  });

  it("13. the original error is kept as `cause` and never reaches the message", async () => {
    const original = new JobServiceError("job_query_failed", "Failed to query job.", 500);
    const spies = makeFailingContext(original);

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));

    expect((error as { cause?: unknown }).cause).toBe(original);
    expect(error.message).not.toContain(original.message);
  });

  it("14. processJobMessage classifies the error as the retryable executor_error", async () => {
    // Mirrors the classifier in `process-job-message.ts`: an error with no code is
    // `executor_error`, and only the codes in its private set are terminal.
    const NON_RETRYABLE_CODES = new Set([
      "invalid_input",
      "model_not_found",
      "provider_not_found",
      "safety_filter",
    ]);
    const spies = makeFailingContext(
      new JobServiceError("job_not_found", "Job not found.", 404),
    );

    const error = await rejection(loadExecutorJob(spies.ctx, JOB_ID));
    const errorCode = (error as { code?: string }).code ?? "executor_error";

    expect(errorCode).toBe("executor_error");
    // The two codes the service's error would have contributed instead — both of
    // which change the job's history and what the front end shows.
    expect(errorCode).not.toBe("job_not_found");
    expect(errorCode).not.toBe("job_query_failed");

    const attemptCount = 1;
    const maxAttempts = 3;
    const terminal =
      attemptCount >= maxAttempts || NON_RETRYABLE_CODES.has(errorCode);
    expect(terminal).toBe(false);
    expectSingleRead(spies, JOB_ID);
  });
});
