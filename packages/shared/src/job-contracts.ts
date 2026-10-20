import { z } from "zod";

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
]);
export type BackgroundJobType = z.infer<typeof backgroundJobTypeSchema>;

// --- Payloads ---

export const imageGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
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

export const jobResponseSchema = z.object({
  job: backgroundJobSchema,
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
