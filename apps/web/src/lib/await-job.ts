/**
 * Waits for a background job to finish.
 *
 * WHY THIS EXISTS
 * The video route used to keep the HTTP request open while the server polled, up
 * to 300s. Video generation runs 180-600s, so that request was the first thing
 * guaranteed to be cut by a proxy, a VPN reconnect or a closed laptop — and when
 * it was, the client had nothing, even though the job finished fine and the
 * credits were spent. Now the route returns a jobId and the waiting happens here.
 *
 * ONE WAIT, TWO WAKE-UP SOURCES — not two implementations:
 *   - `job.progress` over the WebSocket: arrives within a second of the change.
 *   - a slow poll: the safety net for a dropped socket, a page that was
 *     backgrounded, or a server with no connection manager configured.
 * Whichever reports the terminal state first resolves the promise. Dropping the
 * poll would make the whole flow depend on the socket staying up for ten minutes,
 * which is the fragility we are removing.
 *
 * GN-30: `retrying` is NOT terminal. A retrying job is still coming, so the
 * wait continues and nothing is rejected — only `succeeded / failed / canceled`
 * end it (see `lib/job-status.ts`, the single definition). The socket event
 * carries the denominator (`maxAttempts`) itself, so the cap is known from the
 * very first callback and no REST read is needed for it. Only an older server,
 * whose event has no `maxAttempts`, still costs one REST read: the first
 * `retrying` asks once and the answer is cached — the cap cannot change under a
 * running job, and asking again on every attempt would turn a status stream
 * into a poll.
 */
import { JOB_POLL_INTERVAL_MS } from "@loomic/shared";

import type { WebSocketHandle } from "../hooks/use-websocket";
import { isTerminalJobStatus, normalizeJobStatus } from "./job-status";
import { fetchJob, type JobRecord } from "./server-api";

/** What the UI gets on every status change. */
export interface JobProgress {
  status: string;
  elapsedMs?: number;
  /** 1-based attempt number, when the source reports one. */
  attempt?: number;
  /** Total attempts the job may use. Absent until a retrying job told us. */
  maxAttempts?: number;
}

export interface AwaitJobOptions {
  ws?: WebSocketHandle | undefined;
  signal?: AbortSignal | undefined;
  /** Called on every status change, for UI that wants to show progress. */
  onProgress?: (info: JobProgress) => void;
  /** Safety-net poll interval. Deliberately slow — the socket is the fast path. */
  pollIntervalMs?: number;
  /**
   * Bounds the WAIT, not the job. On timeout this rejects, but the job keeps
   * running and stays queryable; the message says so rather than implying failure.
   */
  timeoutMs?: number;
}

export class JobWaitTimeout extends Error {
  constructor(public readonly jobId: string) {
    super(
      `Still waiting on job ${jobId}. It is likely still running — check again ` +
        `in a moment rather than resubmitting, or the work is paid for twice.`,
    );
    this.name = "JobWaitTimeout";
  }
}

export class JobFailed extends Error {
  constructor(
    public readonly jobId: string,
    /**
     * The job's `error_code` (e.g. `timeout`, `upstream_busy`). Kept so the
     * error catalogue can turn it into user copy instead of a generic line.
     */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobFailed";
  }
}

export async function awaitJobCompletion(
  accessToken: string,
  jobId: string,
  opts: AwaitJobOptions = {},
): Promise<JobRecord> {
  const {
    ws,
    signal,
    onProgress,
    pollIntervalMs = JOB_POLL_INTERVAL_MS,
    timeoutMs = 900_000, // 15 min, above the worst observed video generation
  } = opts;

  return new Promise<JobRecord>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * GN-30: the denominator now normally arrives on the socket event itself, so
     * it is already known by the time we get here. An older server's event has
     * no `maxAttempts`, and a retrying job would then read `重试中` with no
     * fraction: we ask REST once, the first time we see `retrying`, and keep the
     * answer for the rest of this wait.
     */
    let maxAttempts: number | undefined;
    let maxAttemptsAsked = false;

    const cleanup = () => {
      unsubscribe?.();
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    function onAbort() {
      finish(() => reject(new DOMException("Aborted", "AbortError")));
    }

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    timeoutTimer = setTimeout(
      () => finish(() => reject(new JobWaitTimeout(jobId))),
      timeoutMs,
    );

    /** Builds the payload without claiming fields a source does not have. */
    const progressOf = (
      status: string,
      elapsedMs: number | undefined,
      attempt: number | undefined,
    ): JobProgress => ({
      status,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });

    /**
     * One REST read per wait, only when a retrying job left the denominator
     * unknown. A failed read is not worth retrying: the label degrades to
     * `重试中`, which is still true.
     */
    const learnMaxAttempts = (
      status: string,
      attempt: number | undefined,
      elapsedMs: number | undefined,
    ) => {
      if (maxAttemptsAsked) return;
      maxAttemptsAsked = true;
      void fetchJob(accessToken, jobId)
        .then(({ job }) => {
          if (settled) return;
          if (typeof job.max_attempts === "number") {
            maxAttempts = job.max_attempts;
          }
          // Re-emit so the caller can draw "2/3" now that the cap is known.
          onProgress?.(progressOf(status, elapsedMs, attempt));
        })
        .catch((e: unknown) => {
          console.warn("[await-job] Could not read max_attempts for", jobId, e);
        });
    };

    /** Shared terminal handling, whichever source reported it. */
    const settleFromStatus = (
      status: string,
      job: JobRecord | null,
      error?: { code: string; message: string },
    ) => {
      if (status === "succeeded") {
        if (job) return finish(() => resolve(job));
        // Socket said succeeded but carried no record — poll once for it rather
        // than resolving with nothing.
        void fetchJob(accessToken, jobId)
          .then((fetched) => finish(() => resolve(fetched.job)))
          .catch((e: unknown) => finish(() => reject(e)));
        return;
      }
      finish(() =>
        reject(
          new JobFailed(
            jobId,
            error?.code ?? job?.error_code ?? status,
            error?.message ??
              job?.error_message ??
              `Job ended with status "${status}".`,
          ),
        ),
      );
    };

    // Fast path.
    if (ws) {
      unsubscribe = ws.onEvent((event: any) => {
        if (event?.type !== "job.progress" || event.jobId !== jobId) return;
        const status = normalizeJobStatus(String(event.status));
        const elapsedMs =
          typeof event.elapsedMs === "number" ? event.elapsedMs : undefined;
        const attempt =
          typeof event.attempt === "number" ? event.attempt : undefined;
        // GN-30: the server now sends the cap on the event itself (33I). Take it
        // and skip the REST read; an older server without it still gets the
        // one-time fallback below.
        if (typeof event.maxAttempts === "number") {
          maxAttempts = event.maxAttempts;
          maxAttemptsAsked = true;
        }
        onProgress?.(progressOf(status, elapsedMs, attempt));
        if (status === "retrying") learnMaxAttempts(status, attempt, elapsedMs);
        if (isTerminalJobStatus(status)) {
          settleFromStatus(
            status,
            // The event carries the job's result payload on success; shape it
            // like a JobRecord so both paths resolve with the same thing.
            event.result
              ? ({ id: jobId, status, result: event.result } as JobRecord)
              : null,
            event.error,
          );
        }
      });
    }

    // Safety net.
    const poll = async () => {
      if (settled) return;
      try {
        const { job } = await fetchJob(accessToken, jobId);
        const status = normalizeJobStatus(job.status);
        if (typeof job.max_attempts === "number") maxAttempts = job.max_attempts;
        const attempt =
          typeof job.attempt_count === "number" ? job.attempt_count : undefined;
        onProgress?.(progressOf(status, undefined, attempt));
        if (isTerminalJobStatus(status)) return settleFromStatus(status, job);
      } catch {
        // A failed read is not a failed job; try again on the next tick.
      }
      if (!settled) pollTimer = setTimeout(poll, pollIntervalMs);
    };
    pollTimer = setTimeout(poll, pollIntervalMs);
  });
}
