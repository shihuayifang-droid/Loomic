// GN-30: the pushed `job.progress` event must carry the attempt cap, so a
// retrying job can render "2/3" from the event alone instead of issuing a
// second REST read just to learn the denominator.
import {
  jobProgressEventSchema,
  type BackgroundJob,
  type StreamEvent,
} from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { JobService } from "./job-service.js";
import { watchJob } from "./job-watcher.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_BY = "44444444-4444-4444-8444-444444444444";

interface JobRowOptions {
  status: BackgroundJob["status"];
  attempt_count?: number;
  max_attempts?: number;
  result?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
}

/** A complete `background_jobs` row, so the fake read has the real shape. */
function jobRow(options: JobRowOptions): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "default",
    job_type: "video_generation",
    status: options.status,
    payload: { prompt: "x" },
    result: options.result ?? null,
    error_code: options.error_code ?? null,
    error_message: options.error_message ?? null,
    attempt_count: options.attempt_count ?? 1,
    max_attempts: options.max_attempts ?? 3,
    created_by: CREATED_BY,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

interface Pushed {
  userId: string;
  event: StreamEvent;
}

/**
 * Starts a watch against a fake job service that returns `rows` in order and
 * repeats the last row afterwards, so a watch that has not reached a terminal
 * state yet cannot fall off the end of the list.
 *
 * `pollIntervalMs: 1` keeps real timers usable: each test waits for the pushes
 * it expects with `vi.waitFor`, and every fixture ends on a terminal row so the
 * background loop has returned before the test finishes.
 */
function startWatch(rows: BackgroundJob[]) {
  const pushed: Pushed[] = [];
  let reads = 0;
  const getJobAdmin = vi.fn(async () => {
    const row = rows[Math.min(reads, rows.length - 1)];
    reads += 1;
    if (!row) throw new Error("fake job service has no rows");
    return row;
  });
  const jobService = { getJobAdmin } as unknown as JobService;
  const connectionManager = {
    pushToUser: (userId: string, event: StreamEvent) => {
      pushed.push({ userId, event });
    },
  } as unknown as ConnectionManager;

  watchJob(
    { jobService, connectionManager },
    {
      jobId: JOB_ID,
      userId: USER_ID,
      jobType: "video_generation",
      pollIntervalMs: 1,
      heartbeatMs: 1_000_000,
    },
  );

  return { pushed, getJobAdmin };
}

/** The pushed events, asserted to all be `job.progress`. */
function progressEvents(pushed: Pushed[]) {
  return pushed.map(({ event }) => {
    if (event.type !== "job.progress") {
      throw new Error(`expected job.progress, got ${event.type}`);
    }
    return event;
  });
}

/** A short real wait, long enough for a still-running loop to push again. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("watchJob job.progress payload (GN-30)", () => {
  it("GN-30: a retrying job's progress carries attempt and maxAttempts", async () => {
    const { pushed } = startWatch([
      jobRow({ status: "retrying", attempt_count: 2, max_attempts: 3 }),
      jobRow({ status: "succeeded", attempt_count: 2, max_attempts: 3 }),
    ]);

    await vi.waitFor(() => expect(pushed.length).toBe(2));

    const events = progressEvents(pushed);
    expect(events[0]?.status).toBe("retrying");
    expect(events[0]?.attempt).toBe(2);
    expect(events[0]?.maxAttempts).toBe(3);
    expect(events[1]?.status).toBe("succeeded");

    // `succeeded` is terminal, so the watch returned after that push.
    await settle();
    expect(pushed.length).toBe(2);
  });

  it("GN-30: every pushed event parses with the shared schema", async () => {
    const { pushed } = startWatch([
      jobRow({ status: "retrying", attempt_count: 2, max_attempts: 3 }),
      jobRow({ status: "succeeded", attempt_count: 2, max_attempts: 3 }),
    ]);

    await vi.waitFor(() => expect(pushed.length).toBe(2));

    expect(pushed.length).toBe(2);
    for (const { event } of pushed) {
      expect(() => jobProgressEventSchema.parse(event)).not.toThrow();
    }
  });

  it("GN-30: a missing connection manager pushes nothing and reads nothing", async () => {
    const getJobAdmin = vi.fn(async () => jobRow({ status: "running" }));
    const jobService = { getJobAdmin } as unknown as JobService;

    watchJob(
      { jobService },
      {
        jobId: JOB_ID,
        userId: USER_ID,
        jobType: "video_generation",
        pollIntervalMs: 1,
        heartbeatMs: 1_000_000,
      },
    );

    await settle();
    expect(getJobAdmin).not.toHaveBeenCalled();
  });

  it("GN-30: a terminal job is reported once and the watch stops", async () => {
    const { pushed, getJobAdmin } = startWatch([
      jobRow({
        status: "failed",
        error_code: "timeout",
        error_message: "x",
      }),
    ]);

    await vi.waitFor(() => expect(pushed.length).toBe(1));

    const events = progressEvents(pushed);
    expect(events[0]?.error).toEqual({ code: "timeout", message: "x" });

    await settle();
    expect(pushed.length).toBe(1);
    expect(getJobAdmin).toHaveBeenCalledTimes(1);
  });
});
