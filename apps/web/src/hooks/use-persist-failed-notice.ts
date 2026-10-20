import { useEffect, useRef } from "react";
import type { WebSocketHandle } from "./use-websocket";

/** AG-35 §4: the copy the spec fixes for a reply the server could not store. */
export const PERSIST_FAILED_MESSAGE = "这条回复未能保存，刷新后可能消失";

/**
 * AG-35 §4: a standing subscription, not a per-run one. The server stores the
 * reply only after the stream ends, so this event arrives AFTER run.completed —
 * when the per-run listeners in chat-sidebar have already unsubscribed.
 * The reply itself stays in memory; this only tells the user it is not saved.
 * One notice per runId, however many times the event is replayed.
 */
export function usePersistFailedNotice(
  ws: Pick<WebSocketHandle, "onEvent">,
  notify: (message: string) => void,
): void {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const seen = useRef(new Set<string>());
  useEffect(() => {
    return ws.onEvent((event: any) => {
      if (event?.type !== "message.persist_failed") return;
      const runId = typeof event.runId === "string" ? event.runId : "";
      if (runId && seen.current.has(runId)) return;
      if (runId) seen.current.add(runId);
      notifyRef.current(PERSIST_FAILED_MESSAGE);
    });
  }, [ws]);
}
