"use client";

import { AlertTriangle } from "lucide-react";
import type { JSX } from "react";

/**
 * GN-19 / CV-02: the "generation failed" placeholder.
 *
 * The server rewrites a running job's slot to
 * `customData: { generating: false, failed: true, failureMessage, … }` when the
 * job dies or times out. This component renders that dead slot on the canvas so
 * it is distinguishable from a live one at a glance: the border switches from
 * `border-border` (see GenerationShimmer) to the destructive colour, and the
 * shimmer is replaced by an icon plus the one-line reason the server sanitised
 * for us.
 *
 * Sizing follows GenerationShimmer's canvas mode: explicit `width`/`height` in
 * element units, and `pointerEvents: "none"` on the outer box so the slot can
 * still be selected and dragged like any other element. Only the buttons opt back
 * in to pointer events — they are the only clickable things.
 *
 * GN-19: when the slot carries a usable `retryRequest` the caller passes
 * `onRetry`, and a "重试" button appears next to "删除". Retrying does NOT resubmit
 * the dead job: the caller swaps this placeholder for a fresh generator prefilled
 * with the original parameters, so the user re-quotes and confirms first.
 */
export function FailedGenerationSlot(props: {
  kind: "image" | "video";
  /** One-line reason, already sanitised by the server. */
  message: string;
  width: number;
  height: number;
  onDelete: () => void;
  /** GN-19: present only when the slot can be retried with its original request. */
  onRetry?: () => void;
}): JSX.Element {
  const { kind, message, width, height, onDelete, onRetry } = props;

  return (
    <div
      data-testid="canvas-failed-slot"
      data-kind={kind}
      className="flex flex-col overflow-hidden rounded-xl border-[0.5px] border-destructive bg-card"
      style={{ width, height, pointerEvents: "none" }}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-destructive/5">
          <AlertTriangle
            className="h-10 w-10 text-destructive/70"
            aria-hidden="true"
          />
          <div className="text-[12px] font-medium text-destructive">
            生成失败
          </div>
        </div>
      </div>

      <div className="shrink-0 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div
            data-testid="canvas-failed-slot-message"
            title={message}
            className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
          >
            {message}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onRetry ? (
              <button
                type="button"
                data-testid="canvas-failed-slot-retry"
                aria-label="用原参数重试"
                onClick={onRetry}
                className="shrink-0 rounded-md border-[0.5px] border-border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
                style={{ pointerEvents: "auto" }}
              >
                重试
              </button>
            ) : null}
            <button
              type="button"
              data-testid="canvas-failed-slot-delete"
              aria-label="删除失败的占位"
              onClick={onDelete}
              className="shrink-0 rounded-md border-[0.5px] border-border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
              // The outer box is pointer-transparent so the canvas keeps receiving
              // events; the buttons are the sole exception.
              style={{ pointerEvents: "auto" }}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
