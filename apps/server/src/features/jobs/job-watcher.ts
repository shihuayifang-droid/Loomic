// Watches a background job and pushes its progress over the WebSocket.
//
// WHY A WATCHER AND NOT THE WORKER ITSELF
// The worker runs as a separate process and holds no WebSocket connections —
// those live in the API process. So the only place that can push is here, and the
// only way to learn about a state change is to poll `background_jobs`. That is
// exactly what the agent runtime already does for its own jobs; this is the same
// mechanism for callers that are not inside an agent run.
//
// WHAT THIS REPLACES
// POST /api/agent/generate-video held the HTTP request open for up to 300s while
// polling. Video generation takes 180-600s, so that request was the first thing
// certain to break under any real network. Now the route returns a jobId at once
// and the polling happens here, detached from any request.
import type { BackgroundJob } from "@loomic/shared";

import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { JobService } from "./job-service.js";

export interface JobWatcherDeps {
  jobService: JobService;
  connectionManager?: ConnectionManager;
}

// `retrying` is deliberately absent: the job is still alive, so the watcher
// keeps polling and the client keeps waiting.
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/**
 * Polls `jobId` until it reaches a terminal state, pushing a `job.progress` event
 * to `userId` on every status change plus a periodic heartbeat.
 *
 * Fire-and-forget: returns immediately. Never throws — a watcher failing must not
 * affect the job, which the worker owns regardless of whether anyone is watching.
 *
 * `maxWaitMs` only bounds the WATCHER, not the job. Hitting it means "we stopped
 * reporting", not "it failed", so no failure event is emitted — the client can
 * still query the job. Getting this wrong would tell users a running generation
 * had died.
 */
export function watchJob(
  deps: JobWatcherDeps,
  args: {
    jobId: string;
    userId: string;
    jobType: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
    /** Emit an unchanged-status event at least this often, so a long-running job
     * still shows movement (elapsedMs advances). */
    heartbeatMs?: number;
  },
): void {
  const {
    jobId,
    userId,
    jobType,
    pollIntervalMs = 3_000,
    maxWaitMs = 900_000, // 15 min: above the worst observed video generation
    heartbeatMs = 15_000,
  } = args;

  const { connectionManager } = deps;
  if (!connectionManager) return; // Nothing to push to; the job runs regardless.

  void (async () => {
    const startedAt = Date.now();
    let lastStatus: string | undefined;
    let lastEmit = 0;

    const emit = (job: BackgroundJob | null, status: string) => {
      const now = Date.now();
      lastEmit = now;
      const jobStartedAt = job?.started_at
        ? new Date(job.started_at).getTime()
        : null;
      // For a finished job, elapsed means how long it TOOK, not how long ago it
      // started. Using `now` here reported ~18 hours for a job that had completed
      // the previous day, which any UI would render as nonsense.
      const endedAt =
        TERMINAL.has(status) && job?.completed_at
          ? new Date(job.completed_at).getTime()
          : now;
      connectionManager.pushToUser(userId, {
        type: "job.progress",
        jobId,
        jobType,
        status,
        timestamp: new Date().toISOString(),
        // Measured from the job's own started_at, so it reflects actual work
        // rather than how long the watcher has been alive.
        ...(jobStartedAt !== null
          ? { elapsedMs: Math.max(0, endedAt - jobStartedAt) }
          : {}),
        ...(job?.attempt_count != null ? { attempt: job.attempt_count } : {}),
        ...(status === "succeeded" && job?.result
          ? { result: job.result as Record<string, unknown> }
          : {}),
        ...(job?.error_code
          ? {
              error: {
                code: job.error_code,
                message: job.error_message ?? "",
              },
            }
          : {}),
      });
    };

    while (Date.now() - startedAt < maxWaitMs) {
      let job: BackgroundJob | null = null;
      try {
        job = await deps.jobService.getJobAdmin(jobId);
      } catch (err) {
        // A transient read failure must not end the watch: the job is still
        // running and the next tick may well succeed.
        console.log(
          `[job-watcher] read failed for ${jobId}, will retry: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      if (job) {
        const status = job.status as string;
        const changed = status !== lastStatus;
        if (changed || Date.now() - lastEmit >= heartbeatMs) {
          emit(job, status);
          lastStatus = status;
        }
        if (TERMINAL.has(status)) {
          console.log(
            `[job-watcher] ${jobId} reached ${status} after ` +
              `${Date.now() - startedAt}ms`,
          );
          return;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Watcher gave up, the job did not. Say so precisely; do NOT emit a failure.
    console.log(
      `[job-watcher] stopped watching ${jobId} after ${maxWaitMs}ms ` +
        `(last status: ${lastStatus ?? "unknown"}); the job continues`,
    );
  })();
}
