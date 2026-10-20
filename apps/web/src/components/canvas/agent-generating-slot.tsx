"use client";

import { useState } from "react";

import type { WebSocketHandle } from "../../hooks/use-websocket";
import { useJobProgressLabel } from "../../hooks/use-job-progress-label";
import { GenerationShimmer } from "../media/generation-shimmer";

/**
 * GN-30: the canvas slot for a job the Agent chain started.
 *
 * `GenerationShimmer` renders the same box for the chat sidebar and the canvas,
 * but only the canvas element carries the `jobId` the backend stamped on it. So
 * the job-status wiring lives here rather than inside the shimmer: the chat's
 * copy has nothing to subscribe with, and the shimmer stays a dumb presentational
 * component that takes the label it should show.
 *
 * GN-32 / CV-02: the slot also carries the「取消」entry. It lives here for the
 * same reason — without a `jobId` there is nothing to cancel, and the chat copy
 * has no id to send.
 */
export function AgentGeneratingSlot(props: {
  ws?: WebSocketHandle | undefined;
  jobId?: string | undefined;
  kind: "image" | "video";
  modelName?: string | undefined;
  startedAt?: number | undefined;
  width: number;
  height: number;
  /**
   * GN-32: cancels the job this slot stands for. Typed `unknown` rather than
   * `void` because the caller forwards `cancelJob(...)` straight through and
   * `Promise<JobResponse>` is not assignable to `Promise<void>`.
   */
  onCancel?: (() => Promise<unknown> | void) | undefined;
}) {
  const label = useJobProgressLabel(props.ws, props.jobId);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [failed, setFailed] = useState(false);

  const onCancel = props.onCancel;
  // CV-02: no id or no handler means there is nothing to ask the server to stop.
  const canCancel = props.jobId != null && onCancel != null;

  const confirmCancel = () => {
    if (onCancel == null) return;
    setCancelling(true);
    setFailed(false);
    // Called synchronously: the click handler's job is to start the cancel, not
    // to wait a microtask before starting it.
    let result: unknown;
    try {
      result = onCancel();
    } catch {
      setFailed(true);
      setCancelling(false);
      return;
    }
    if (result != null && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).then(
        () => undefined,
        () => {
          setFailed(true);
          setCancelling(false);
        },
      );
    }
  };

  return (
    // The wrapper keeps the slot transparent to the canvas (see the shimmer's
    // own `pointerEvents: "none"`): only the controls below re-enable events,
    // so the element stays selectable and draggable while the job runs.
    <div
      style={{
        position: "relative",
        width: props.width,
        height: props.height,
        pointerEvents: "none",
      }}
    >
      <GenerationShimmer
        kind={props.kind}
        statusLabel={label}
        modelName={props.modelName}
        startedAt={props.startedAt}
        width={props.width}
        height={props.height}
      />

      {canCancel && (
        <button
          type="button"
          data-testid="canvas-generating-slot-cancel"
          aria-label="取消这次生成"
          style={{ pointerEvents: "auto" }}
          className="absolute right-2 top-2 rounded-md border-[0.5px] border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground"
          onClick={() => {
            setFailed(false);
            setConfirming(true);
          }}
        >
          取消
        </button>
      )}

      {canCancel && confirming && (
        <div
          data-testid="canvas-generating-slot-cancel-confirm"
          style={{ pointerEvents: "auto" }}
          className="absolute inset-x-2 top-2 rounded-md border-[0.5px] border-border bg-card px-2 py-2 text-[11px] text-foreground shadow-sm"
        >
          <div>取消这次生成？已开始的任务不退积分</div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              data-testid="canvas-generating-slot-cancel-ok"
              disabled={cancelling}
              style={{ pointerEvents: "auto" }}
              className="rounded-md border-[0.5px] border-border bg-muted px-2 py-1 text-[11px] font-medium disabled:opacity-50"
              onClick={confirmCancel}
            >
              确认取消
            </button>
            <button
              type="button"
              data-testid="canvas-generating-slot-cancel-back"
              disabled={cancelling}
              style={{ pointerEvents: "auto" }}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground disabled:opacity-50"
              onClick={() => setConfirming(false)}
            >
              继续生成
            </button>
          </div>
          {failed && <div className="mt-1 text-[11px]">取消失败，请重试</div>}
        </div>
      )}
    </div>
  );
}
