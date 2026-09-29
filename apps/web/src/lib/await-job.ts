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
 */
import type { WebSocketHandle } from "../hooks/use-websocket";
import { fetchJob, type JobRecord } from "./server-api";

const TERMINAL = new Set(["succeeded", "failed", "dead_letter", "canceled"]);

export interface AwaitJobOptions {
  ws?: WebSocketHandle | undefined;
  signal?: AbortSignal | undefined;
  /** Called on every status change, for UI that wants to show progress. */
  onProgress?: (info: { status: string; elapsedMs?: number }) => void;
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
    pollIntervalMs = 5_000,
    timeoutMs = 900_000, // 15 min, above the worst observed video generation
  } = opts;

  return new Promise<JobRecord>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

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
          .catch((e) => finish(() => reject(e)));
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
        onProgress?.({ status: event.status, elapsedMs: event.elapsedMs });
        if (TERMINAL.has(event.status)) {
          settleFromStatus(
            event.status,
            // The event carries the job's result payload on success; shape it
            // like a JobRecord so both paths resolve with the same thing.
            event.result ? ({ id: jobId, status: event.status, result: event.result } as JobRecord) : null,
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
        onProgress?.({ status: job.status });
        if (TERMINAL.has(job.status)) return settleFromStatus(job.status, job);
      } catch {
        // A failed read is not a failed job; try again on the next tick.
      }
      if (!settled) pollTimer = setTimeout(poll, pollIntervalMs);
    };
    pollTimer = setTimeout(poll, pollIntervalMs);
  });
}
