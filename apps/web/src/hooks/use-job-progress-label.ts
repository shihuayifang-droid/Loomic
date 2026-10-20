"use client";

import { useEffect, useState } from "react";

import { formatRetryLabel, normalizeJobStatus } from "../lib/job-status";
import type { WebSocketHandle } from "./use-websocket";

/**
 * GN-30: what a generating slot says about its job, from `job.progress` events.
 * Null = keep the default text.
 *
 * A slot only knows the `jobId` the backend stamped on the element, so this hook
 * is the one place that turns that id into "how is it doing right now?". It
 * deliberately says nothing about `running` and the terminal statuses: those
 * either look like the plain 「图片生成中...」 the slot already shows, or the slot
 * is about to be replaced by the result / the failure placeholder. `retrying` is
 * the state that has no other surface — treating it as `running` is exactly how
 * a job that is still being retried used to look dead.
 *
 * Only `job.progress` events for THIS job are considered: the socket fans every
 * event of every job out to every listener (see `lib/await-job.ts`).
 */
export function useJobProgressLabel(
  ws: Pick<WebSocketHandle, "onEvent"> | undefined,
  jobId: string | undefined,
): string | null {
  const [label, setLabel] = useState<string | null>(null);

  // Depend on the primitives, not on the object identities: `ws` can be a fresh
  // handle every render, and re-subscribing on every render would drop events.
  useEffect(() => {
    // No job to watch means no custom copy — the default one is right.
    setLabel(null);
    if (!ws || !jobId) return;

    const unsubscribe = ws.onEvent((event: any) => {
      if (event?.type !== "job.progress" || event.jobId !== jobId) return;
      const status = normalizeJobStatus(String(event.status));
      if (status === "retrying") {
        // The counters ride on the event itself (33I). Only pass real numbers so
        // a server without them degrades to 「重试中」 instead of a fake fraction.
        const attempt =
          typeof event.attempt === "number" ? event.attempt : undefined;
        const maxAttempts =
          typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
        setLabel(formatRetryLabel(attempt, maxAttempts));
        return;
      }
      if (status === "queued") {
        setLabel("排队中");
        return;
      }
      // running (and every terminal status) reads as the default copy again, so
      // a retry that succeeded in getting going stops saying 「重试中」.
      setLabel(null);
    });

    return unsubscribe;
  }, [ws, jobId]);

  return label;
}
