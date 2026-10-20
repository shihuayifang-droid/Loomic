import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERSIST_FAILED_MESSAGE,
  usePersistFailedNotice,
} from "../src/hooks/use-persist-failed-notice";

/**
 * 工单 33O T3 · AG-35 §4 前端提示。
 *
 * 假 ws 只做三件事：记下回调、可手动推事件、退订后不再收到事件。
 * 不 mock toast：这一层只关心 notify 被调了几次、文案是什么。
 */
function makeFakeWs() {
  const listeners = new Set<(event: any) => void>();
  return {
    onEvent(cb: (event: any) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(event: any) {
      for (const cb of Array.from(listeners)) cb(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

const persistFailed = (runId: string) => ({
  type: "message.persist_failed",
  runId,
  sessionId: "s",
  timestamp: "t",
});

afterEach(() => {
  cleanup();
});

describe("usePersistFailedNotice", () => {
  it("AG-35: a persist_failed event shows the fixed notice once", () => {
    const ws = makeFakeWs();
    const notify = vi.fn();

    renderHook(() => usePersistFailedNotice(ws, notify));

    ws.emit(persistFailed("r1"));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(PERSIST_FAILED_MESSAGE);
    expect(PERSIST_FAILED_MESSAGE).toBe("这条回复未能保存，刷新后可能消失");
  });

  it("AG-35: the same run is noticed only once", () => {
    const ws = makeFakeWs();
    const notify = vi.fn();

    renderHook(() => usePersistFailedNotice(ws, notify));

    ws.emit(persistFailed("r1"));
    ws.emit(persistFailed("r1"));

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("AG-35: other events are ignored", () => {
    const ws = makeFakeWs();
    const notify = vi.fn();

    renderHook(() => usePersistFailedNotice(ws, notify));

    ws.emit({ type: "run.completed", runId: "r1" });
    ws.emit({ type: "job.progress", runId: "r1", percent: 50 });

    expect(notify).not.toHaveBeenCalled();
  });

  it("AG-35: unmount unsubscribes", () => {
    const ws = makeFakeWs();
    const notify = vi.fn();

    const { unmount } = renderHook(() =>
      usePersistFailedNotice(ws, notify),
    );

    expect(ws.listenerCount()).toBe(1);
    unmount();
    expect(ws.listenerCount()).toBe(0);

    ws.emit(persistFailed("r1"));

    expect(notify).not.toHaveBeenCalled();
  });
});
