import { z } from "zod";

import { poolBalancesSchema } from "./credits.js";

// --- Enums ---

export const backgroundJobStatusSchema = z.enum([
  "queued",
  "running",
  // GN-30: "this attempt failed but another one is coming". Written by the
  // worker instead of "failed" so a still-retrying job is not shown as terminal.
  "retrying",
  "succeeded",
  "failed",
  "canceled",
  // Legacy value: kept so historical rows and existing client string comparisons
  // still parse, but the server never writes it and never returns it (rows read
  // as "failed").
  "dead_letter",
]);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;

export const backgroundJobTypeSchema = z.enum([
  "image_generation",
  "video_generation",
  // Every server-side tool (remove background, quick edit, ...) is one job
  // type; the payload's tool_id picks the tool.
  "tool_execution",
]);
export type BackgroundJobType = z.infer<typeof backgroundJobTypeSchema>;

// --- Timing constants ---

/** GN-02 ② / GN-39: the slow safety-net poll beside the WebSocket push. One value for every client. */
export const JOB_POLL_INTERVAL_MS = 3_000;
/** GN-39: how long a client keeps polling one job before giving up. */
export const JOB_POLL_MAX_DURATION_MS = 10 * 60 * 1_000;

// --- Payloads ---

export const imageGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
  size: z.string().optional(),
});
export type ImageGenerationPayload = z.infer<typeof imageGenerationPayloadSchema>;

export const videoGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type VideoGenerationPayload = z.infer<typeof videoGenerationPayloadSchema>;

export const createVideoJobRequestSchema = z.object({
  project_id: z.string().uuid().optional(),
  canvas_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
  // ED-00m: the browser-chosen submission id. The length bounds are the same
  // ones the `client_request_id` CHECK constraint uses (workorder 34T), so a
  // request the route accepts can never fail the insert on length alone.
  client_request_id: z.string().min(8).max(128).optional(),
});
export type CreateVideoJobRequest = z.infer<typeof createVideoJobRequestSchema>;

// --- Job artifacts ---

/**
 * GN-02 (5): one produced file of a finished job, as the job result carries it.
 *
 * The job result used to name a single asset through loose keys; this is the
 * array shape the client reads so that a multi-artifact job (GN-41) needs no new
 * field. `index` is the position the client must use when it lays the artifacts
 * out, so two artifacts can never collide on it. `format` is the MIME type, and
 * `width` / `height` are the dimensions the provider actually reported — they are
 * never filled in from the requested parameters.
 */
export const jobArtifactSchema = z.object({
  artifact_id: z.string().min(1),
  index: z.number().int().nonnegative(),
  format: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type JobArtifact = z.infer<typeof jobArtifactSchema>;

// --- Job entity ---

export const backgroundJobSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  canvas_id: z.string().uuid().nullable(),
  session_id: z.string().uuid().nullable(),
  thread_id: z.string().nullable(),
  queue_name: z.string(),
  job_type: backgroundJobTypeSchema,
  status: backgroundJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

// --- API Request schemas ---

export const createImageJobRequestSchema = z.object({
  project_id: z.string().uuid().optional(),
  canvas_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
  // ED-00m: see the video schema above — same field, same bounds.
  client_request_id: z.string().min(8).max(128).optional(),
});
export type CreateImageJobRequest = z.infer<typeof createImageJobRequestSchema>;

// --- API Response schemas ---

/**
 * GN-03 / workorder 38D: the job status carries the caller's available credits,
 * so the top bar and the account centre refresh from the poll they already make
 * instead of calling the balance route beside it.
 *
 * Additive only — `job` is untouched. `balance` is absent when the deployment
 * wired no pool reader, `null` when the caller has no team workspace (the pools
 * are bookkept per team, 37M / 37N) or when the read failed, and a filled object
 * otherwise. `available` is the shared `availableCredits` rule, not a second
 * derivation, so this figure and `GET /api/credits` cannot disagree;
 * `monthlyCapRemaining` is the personal cap minus what this member already took
 * from the team pool this month.
 */
export const jobResponseSchema = z.object({
  job: backgroundJobSchema,
  balance: z
    .object({
      balances: poolBalancesSchema,
      available: z.number().int().nonnegative(),
      monthlyCapRemaining: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export type JobResponse = z.infer<typeof jobResponseSchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

/**
 * GN-35 / CV-02: the credits of ONE job, as the owner may see them.
 *
 * This is deliberately NOT a set of extra columns on `backgroundJobSchema`: the
 * 22-column projection of a job is pinned by a long list of contract cases, and
 * widening it to carry two money fields would change every one of them. The
 * route that serves this shape is read-only and answers for the caller's OWN
 * job only (workorder 36K).
 *
 * `credits_cost` is null for a job that was never charged (a free job, or a job
 * created before a price was known): null means "not billed", it does NOT mean
 * zero. `credits_refunded` is never null — a job with no refund row reports 0,
 * which is what the "已退回 N 积分" line needs to render. `credits_transaction_id`
 * is null exactly when the charge was never linked to a ledger row.
 */
export const jobCreditsResponseSchema = z.object({
  job_id: z.string().uuid(),
  credits_cost: z.number().int().nonnegative().nullable(),
  credits_refunded: z.number().int().nonnegative(),
  credits_transaction_id: z.string().uuid().nullable(),
});
export type JobCreditsResponse = z.infer<typeof jobCreditsResponseSchema>;
