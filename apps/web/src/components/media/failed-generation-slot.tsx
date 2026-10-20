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
 * still be selected and dragged like any other element. Only the delete button
 * opts back in to pointer events — it is the one thing that can be clicked.
 */
export function FailedGenerationSlot(props: {
  kind: "image" | "video";
  /** One-line reason, already sanitised by the server. */
  message: string;
  width: number;
  height: number;
  onDelete: () => void;
}): JSX.Element {
  const { kind, message, width, height, onDelete } = props;

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
          <button
            type="button"
            data-testid="canvas-failed-slot-delete"
            aria-label="删除失败的占位"
            onClick={onDelete}
            className="shrink-0 rounded-md border-[0.5px] border-border px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted"
            // The outer box is pointer-transparent so the canvas keeps receiving
            // events; the button is the sole exception.
            style={{ pointerEvents: "auto" }}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
