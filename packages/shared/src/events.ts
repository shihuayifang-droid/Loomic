import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";
import {
  conversationIdSchema,
  messageIdSchema,
  runIdSchema,
  sessionIdSchema,
  timestampSchema,
  toolCallIdSchema,
} from "./contracts.js";
import { loomicErrorSchema } from "./errors.js";

export { imageArtifactSchema, videoArtifactSchema, placementSchema, toolArtifactSchema } from "./artifacts.js";
export type { ImageArtifact, VideoArtifact, Placement, ToolArtifact } from "./artifacts.js";

export const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  timestamp: timestampSchema,
});

export const messageDeltaEventSchema = z.object({
  type: z.literal("message.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  input: z.record(z.unknown()).optional(),
  timestamp: timestampSchema,
});

export const toolCompletedEventSchema = z.object({
  type: z.literal("tool.completed"),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolName: z.string().min(1),
  output: z.record(z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
  timestamp: timestampSchema,
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runCanceledEventSchema = z.object({
  type: z.literal("run.canceled"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: runIdSchema,
  error: loomicErrorSchema,
  timestamp: timestampSchema,
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  runId: runIdSchema,
  messageId: messageIdSchema,
  delta: z.string(),
  timestamp: timestampSchema,
});

export const canvasSyncEventSchema = z.object({
  type: z.literal("canvas.sync"),
  runId: runIdSchema,
  timestamp: timestampSchema,
});

export const billingErrorCodeSchema = z.enum([
  "insufficient_credits",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
  // 工单31B / GN-07: the price table has no row for this model, so it is not
  // sellable at all. Deliberately separate from `model_not_accessible` (a plan
  // limit): upgrading the plan does not fix this one, and nothing was charged.
  "model_not_available",
]);

export type BillingErrorCode = z.infer<typeof billingErrorCodeSchema>;

export const billingErrorEventSchema = z.object({
  type: z.literal("billing.error"),
  runId: runIdSchema,
  timestamp: timestampSchema,
  code: billingErrorCodeSchema,
  message: z.string(),
  // Credits-specific (only for insufficient_credits)
  currentBalance: z.number().optional(),
  requiredAmount: z.number().optional(),
  plan: z.string().optional(),
  dailyClaimed: z.boolean().optional(),
});

/**
 * Progress of a background job, for callers that are NOT inside an agent run —
 * the image and video generator panels, which submit directly.
 *
 * WHY THIS EXISTS
 * POST /api/agent/generate-video used to hold the HTTP request open while polling
 * the job, up to 300s. Video generation is 180-600s, so that request was the first
 * thing guaranteed to break: any proxy, load balancer or laptop lid in between
 * kills it, and the work is then invisible to the client even though the job
 * completes fine. Now the request returns a jobId immediately and the outcome
 * arrives here.
 *
 * NO PERCENTAGE, DELIBERATELY. `background_jobs` has a status enum and
 * `started_at`, and no provider we use reports fractional progress. `elapsedMs`
 * is a real measurement; a percentage would be invented. If a provider ever does
 * expose one, add it as an explicit optional field rather than deriving a fake.
 *
 * Note this event carries no `runId`: it is not part of a run. Consumers that
 * read `event.runId` must handle it being absent.
 */
export const jobProgressEventSchema = z.object({
  type: z.literal("job.progress"),
  jobId: z.string().uuid(),
  jobType: z.string(),
  /** queued | running | retrying | succeeded | failed | canceled */
  status: z.string(),
  timestamp: timestampSchema,
  /** Milliseconds since the job started running. Absent while still queued. */
  elapsedMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
  /** GN-30: the job's attempt cap, so a retrying job can show "2/3" without a REST read. */
  maxAttempts: z.number().int().positive().optional(),
  /** Present on success, so the client does not need a follow-up request. */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
});

export const streamEventSchema = z.discriminatedUnion("type", [
  runStartedEventSchema,
  messageDeltaEventSchema,
  thinkingDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  runCanceledEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  canvasSyncEventSchema,
  billingErrorEventSchema,
  jobProgressEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
