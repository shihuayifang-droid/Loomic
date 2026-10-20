"use client";

import React, { useEffect, useState } from "react";

import { formatModelDisplayName } from "../chat/utils";

/**
 * The "generating…" placeholder, shared by the chat sidebar and the canvas.
 *
 * It lives here rather than inside the chat tool block because the canvas shows
 * the SAME state for the SAME job: a slot is reserved the moment generation
 * starts, and it must read as the same thing in both places. The canvas version
 * used to be a baked inline SVG, which could not animate at all.
 *
 * Sizing has two modes:
 *  - chat: pass `aspectRatio`, the box follows the container width
 *  - canvas: pass explicit `width`/`height` in element units, matching how
 *    Excalidraw sizes custom embeddable content (see VideoCanvasElement)
 */

/** Typical wall-clock cost of one generation, used only as a soft hint. */
const TYPICAL_SECONDS = { image: 60, video: 180 } as const;

export type GenerationKind = "image" | "video";

export function GenerationShimmer({
  kind,
  aspectRatio,
  modelName,
  width,
  height,
  startedAt,
  statusLabel,
}: {
  kind: GenerationKind;
  aspectRatio?: string;
  modelName?: string | undefined;
  width?: number;
  height?: number;
  /**
   * Epoch ms the job actually started. Pass it wherever it is known (the canvas
   * stores it on the element) so the counter stays honest across reloads; the
   * chat has no such record and falls back to mount time.
   *
   * `| undefined` is required, not redundant: with exactOptionalPropertyTypes a
   * plain `?:` rejects an explicitly undefined value, and callers forward
   * `number | undefined` straight from the element.
   */
  startedAt?: number | undefined;
  /**
   * GN-30: replaces the default 「图片/视频生成中...」 copy, e.g. 「重试中（2/3）」 while
   * the job is between attempts. Null/empty = keep the default.
   *
   * The default copy claims a specific thing ("it is generating"), which is a lie
   * during a retry: the attempt that just ran has already failed. So the caller
   * gets to say what is actually happening rather than the box guessing.
   */
  statusLabel?: string | null;
}) {
  const isVideo = kind === "video";
  const fixedSize = width != null && height != null;
  const customLabel =
    statusLabel != null && statusLabel !== "" ? statusLabel : null;

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-card"
      style={
        fixedSize
          ? {
              width,
              height,
              // Purely decorative: let every pointer event reach the canvas
              // underneath so the slot can be selected and dragged like any
              // other element while the job runs. Unlike the video player, this
              // has nothing to click.
              pointerEvents: "none",
            }
          : undefined
      }
    >
      <div
        className={
          fixedSize
            ? "relative min-h-0 flex-1 overflow-hidden"
            : "relative max-h-[280px] w-full overflow-hidden"
        }
        style={
          fixedSize
            ? undefined
            : { aspectRatio: (aspectRatio ?? "1:1").replace(":", " / ") }
        }
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted">
          <MediaIcon isVideo={isVideo} />
        </div>
        {/* Shimmer sweep — the only thing that signals "still working" at a glance */}
        <div className="absolute inset-0 animate-shimmer-scan">
          <div
            className="h-full w-1/2"
            style={{
              background:
                "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)",
            }}
          />
        </div>
      </div>

      <div className="shrink-0 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <div
            className="text-[12px] font-medium text-muted-foreground/70"
            data-testid="canvas-generation-status"
            data-state={customLabel === null ? "default" : "custom"}
          >
            {customLabel ?? (isVideo ? "视频生成中..." : "图片生成中...")}
          </div>
          <ElapsedTimer isVideo={isVideo} startedAt={startedAt} />
        </div>
        {modelName && (
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {formatModelDisplayName(modelName)}
          </div>
        )}
      </div>
    </div>
  );
}

const MediaIcon = React.memo(function MediaIcon({
  isVideo,
}: {
  isVideo: boolean;
}) {
  if (isVideo) {
    return (
      <svg
        className="h-10 w-10 text-muted-foreground/50"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
      </svg>
    );
  }
  return (
    <svg
      className="h-10 w-10 text-muted-foreground/50"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
  );
});

/**
 * Shows ELAPSED time as the primary number, not a countdown. Real generations
 * swing between roughly 30 and 90 seconds with queue depth, so a countdown would
 * have to invent a total and would then sit at "1s remaining" whenever the
 * estimate missed.
 */
const ElapsedTimer = React.memo(function ElapsedTimer({
  isVideo,
  startedAt,
}: {
  isVideo: boolean;
  // `| undefined` is required, not redundant: the project builds with
  // exactOptionalPropertyTypes, which rejects passing an explicit undefined to a
  // plain `?:` prop — and the caller's startedAt is genuinely `number | undefined`.
  startedAt?: number | undefined;
}) {
  const [seconds, setSeconds] = useState(() =>
    startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0,
  );

  useEffect(() => {
    const started = startedAt ?? Date.now();
    const tick = () =>
      setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const typical = isVideo ? TYPICAL_SECONDS.video : TYPICAL_SECONDS.image;
  const overdue = seconds > typical;
  const remaining = Math.max(0, typical - seconds);

  return (
    <div className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
      <span className="font-medium">{formatDuration(seconds)}</span>
      <span className="text-muted-foreground/50">
        {overdue ? "即将完成" : `约剩 ${formatDuration(remaining)}`}
      </span>
    </div>
  );
});

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}
