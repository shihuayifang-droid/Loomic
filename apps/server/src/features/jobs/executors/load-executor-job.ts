import type { BackgroundJob } from "@loomic/shared";

import type { ExecutorContext } from "../job-executor.js";

/**
 * The six columns the generation executors need off a job row. The names stay
 * snake_case, exactly as they arrive on `BackgroundJob`, so both call sites keep
 * reading `jobRow.created_by`, `jobRow.payload` and the rest without a rename.
 */
export type ExecutorJobRow = {
  created_by: string | null;
  workspace_id: string | null;
  canvas_id: string | null;
  project_id: string | null;
  session_id: string | null;
  payload: Record<string, unknown>;
};

/**
 * Read one background job for an executor.
 *
 * ADR-0001 / workorder 21N: this replaces the admin PostgREST single-row read
 * that `image-generation.ts` and `video-generation.ts` used to carry verbatim.
 * The read now goes through `JobService.getJobAdmin` — the server's one admin job
 * read, whose SQL already lives in a `pg` repository (workorder 21I) — so the
 * legacy `dead_letter` → `failed` translation and the `payload` null → `{}`
 * default happen in exactly one place instead of three.
 *
 * The FAILURE contract is deliberately the pre-21N one, unchanged to the letter:
 * every way that read can fail — a missing row, a failed query, a service built
 * without the repository, or anything else thrown — becomes the same bare `Error`
 * whose message is `Job <id> not found in database`. The new error carries no
 * `code`, so `processJobMessage` keeps classifying it as the retryable
 * `executor_error`; letting the service's own `JobServiceError` through instead
 * would reclassify the job as `job_not_found` / `job_query_failed` and change
 * both its history and what the front end shows. The original error is attached
 * as `cause` for debugging and never enters the message.
 */
export async function loadExecutorJob(
  ctx: ExecutorContext,
  jobId: string,
): Promise<ExecutorJobRow> {
  let job: BackgroundJob;
  try {
    job = await ctx.jobService.getJobAdmin(jobId);
  } catch (cause) {
    throw new Error(`Job ${jobId} not found in database`, { cause });
  }

  return {
    created_by: job.created_by ?? null,
    workspace_id: job.workspace_id ?? null,
    canvas_id: job.canvas_id ?? null,
    project_id: job.project_id ?? null,
    session_id: job.session_id ?? null,
    payload: job.payload ?? {},
  };
}
