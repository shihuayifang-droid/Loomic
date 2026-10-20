// GN-30 / T-58 ③: a job the Agent submitted has to report progress to the user
// the same way a generator-panel job does. These tests pin both halves: the
// wiring refuses to start without a connection manager, and with one it really
// pushes a `job.progress` event.
import { type BackgroundJob, type StreamEvent } from "@loomic/shared";
import { describe, expect, it, vi } from "vitest";

import type { ConnectionManager } from "../ws/connection-manager.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { watchJob } from "../features/jobs/job-watcher.js";
import { startAgentJobProgress } from "./agent-job-progress.js";

const JOB_ID = "job-1";
const USER_ID = "user-1";

/** A complete `background_jobs` row, so the fake read has the real shape. */
function jobRow(): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: "workspace-1",
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "default",
    job_type: "video_generation",
    status: "succeeded",
    payload: { prompt: "x" },
    result: { signed_url: "https://example.invalid/v.mp4" },
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: USER_ID,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:10.000Z",
    failed_at: null,
    canceled_at: null,
  };
}

describe("startAgentJobProgress (GN-30 / T-58 ③)", () => {
  it("T-58 ③: with a connection manager the watcher starts for the Agent's job", () => {
    const watch = vi.fn();
    const jobService = {} as unknown as JobService;
    const connectionManager = {} as unknown as ConnectionManager;

    const started = startAgentJobProgress(
      { jobService, connectionManager },
      { jobId: JOB_ID, userId: USER_ID, jobType: "image_generation" },
      watch as unknown as typeof watchJob,
    );

    expect(started).toBe(true);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0]?.[1]).toEqual({
      jobId: JOB_ID,
      userId: USER_ID,
      jobType: "image_generation",
    });
    expect((watch.mock.calls[0]?.[0] as { connectionManager?: unknown }).connectionManager)
      .toBe(connectionManager);
  });

  it("T-58 ③: without a connection manager nothing starts", () => {
    const watch = vi.fn();
    const jobService = {} as unknown as JobService;

    const started = startAgentJobProgress(
      { jobService },
      { jobId: JOB_ID, userId: USER_ID, jobType: "image_generation" },
      watch as unknown as typeof watchJob,
    );

    expect(started).toBe(false);
    expect(watch).toHaveBeenCalledTimes(0);
  });

  it("T-58 ③: the real watcher pushes a job.progress to the user", async () => {
    const pushed: { userId: string; event: StreamEvent }[] = [];
    const getJobAdmin = vi.fn(async () => jobRow());
    const jobService = { getJobAdmin } as unknown as JobService;
    const connectionManager = {
      pushToUser: (userId: string, event: StreamEvent) => {
        pushed.push({ userId, event });
      },
    } as unknown as ConnectionManager;

    startAgentJobProgress(
      { jobService, connectionManager },
      { jobId: JOB_ID, userId: USER_ID, jobType: "video_generation" },
    );

    await vi.waitFor(() => expect(pushed).toHaveLength(1));

    const [first] = pushed;
    expect(first?.userId).toBe(USER_ID);
    const event = first?.event;
    if (!event || event.type !== "job.progress") {
      throw new Error(`expected job.progress, got ${event?.type ?? "nothing"}`);
    }
    expect(event.jobType).toBe("video_generation");
    expect(event.maxAttempts).toBe(3);
  });
});
