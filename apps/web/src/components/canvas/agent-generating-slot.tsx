"use client";

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
 */
export function AgentGeneratingSlot(props: {
  ws?: WebSocketHandle | undefined;
  jobId?: string | undefined;
  kind: "image" | "video";
  modelName?: string | undefined;
  startedAt?: number | undefined;
  width: number;
  height: number;
}) {
  const label = useJobProgressLabel(props.ws, props.jobId);

  return (
    <GenerationShimmer
      kind={props.kind}
      statusLabel={label}
      modelName={props.modelName}
      startedAt={props.startedAt}
      width={props.width}
      height={props.height}
    />
  );
}
