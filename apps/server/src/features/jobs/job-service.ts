import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
  Database,
  Json,
} from "@loomic/shared";

import type { PgmqClient } from "../../queue/pgmq-client.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { queueForJobType } from "./job-registry.js";

type BackgroundJobUpdate = Database["public"]["Tables"]["background_jobs"]["Update"];
type BackgroundJobStatuses = BackgroundJob["status"][];

export class JobServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "job_not_found"
    | "job_create_failed"
    | "job_query_failed"
    | "job_cancel_failed";

  constructor(
    code: JobServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CreateJobInput = {
  workspaceId: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
};

export type JobService = {
  createJob(user: AuthenticatedUser, input: CreateJobInput): Promise<BackgroundJob>;
  getJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  listJobs(
    user: AuthenticatedUser,
    filters?: { status?: BackgroundJobStatus; jobType?: BackgroundJobType },
  ): Promise<BackgroundJob[]>;
  cancelJob(user: AuthenticatedUser, jobId: string): Promise<BackgroundJob>;
  getJobAdmin(jobId: string): Promise<BackgroundJob>;

  // Admin-only methods (use admin client, no user auth).
  //
  // Every `mark*` returns whether it actually changed a row: `true` = the
  // transition happened, `false` = the guard rejected it (wrong current state,
  // or no such row). Callers use that to avoid double refunds and to skip work
  // for jobs that were cancelled meanwhile.
  setCreditsInfo(jobId: string, creditsCost: number, transactionId: string): Promise<void>;
  markRunning(jobId: string): Promise<boolean>;
  markRetrying(jobId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  markSucceeded(jobId: string, result: Record<string, unknown>): Promise<boolean>;
  markFailed(jobId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  incrementAttempt(jobId: string): Promise<{ attempt_count: number; max_attempts: number } | null>;
};

export function createJobService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  pgmq: PgmqClient;
}): JobService {
  function mapJobRow(row: Record<string, unknown>): BackgroundJob {
    return {
      id: row.id as string,
      workspace_id: row.workspace_id as string,
      project_id: (row.project_id as string) ?? null,
      canvas_id: (row.canvas_id as string) ?? null,
      session_id: (row.session_id as string) ?? null,
      thread_id: (row.thread_id as string) ?? null,
      queue_name: row.queue_name as string,
      job_type: row.job_type as BackgroundJob["job_type"],
      // `dead_letter` is a legacy value: historical rows still carry it, but the
      // worker never writes it any more and the server never exposes it — such a
      // row is terminal-failed, so that is what callers see.
      status: (row.status === "dead_letter"
        ? "failed"
        : row.status) as BackgroundJob["status"],
      payload: (row.payload as Record<string, unknown>) ?? {},
      result: (row.result as Record<string, unknown>) ?? null,
      error_code: (row.error_code as string) ?? null,
      error_message: (row.error_message as string) ?? null,
      attempt_count: row.attempt_count as number,
      max_attempts: row.max_attempts as number,
      created_by: row.created_by as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      started_at: (row.started_at as string) ?? null,
      completed_at: (row.completed_at as string) ?? null,
      failed_at: (row.failed_at as string) ?? null,
      canceled_at: (row.canceled_at as string) ?? null,
    };
  }

  const SELECT_COLS =
    "id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

  /**
   * Guarded status transition: only a row whose current status is in `from` is
   * updated, so a job that was cancelled (or already finished) cannot be
   * rewritten by a late worker. Returns whether exactly one row changed.
   */
  async function transition(
    jobId: string,
    from: BackgroundJobStatuses,
    patch: BackgroundJobUpdate,
  ): Promise<boolean> {
    const admin = options.getAdminClient();
    const { data, error } = await admin
      .from("background_jobs")
      .update(patch)
      .eq("id", jobId)
      .in("status", from)
      .select("id");

    if (error) {
      throw new JobServiceError(
        "job_query_failed",
        `Failed to update job ${jobId}: ${error.message}`,
        500,
      );
    }

    return (data?.length ?? 0) === 1;
  }

  return {
    async createJob(user, input) {
      const client = options.createUserClient(user.accessToken);
      const queueName = queueForJobType(input.jobType);

      const { data: job, error } = await client
        .from("background_jobs")
        .insert({
          workspace_id: input.workspaceId,
          project_id: input.projectId ?? null,
          canvas_id: input.canvasId ?? null,
          session_id: input.sessionId ?? null,
          thread_id: input.threadId ?? null,
          queue_name: queueName,
          job_type: input.jobType,
          payload: input.payload as Json,
          created_by: user.id,
        })
        .select(SELECT_COLS)
        .single();

      if (error || !job) {
        throw new JobServiceError(
          "job_create_failed",
          "Failed to create job record.",
          500,
        );
      }

      // Enqueue to pgmq — rollback on failure
      try {
        await options.pgmq.send(queueName, {
          job_id: job.id,
          job_type: input.jobType,
          workspace_id: input.workspaceId,
          ...(input.canvasId ? { canvas_id: input.canvasId } : {}),
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        });
      } catch (enqueueErr) {
        console.error("[job-service] pgmq.send failed:", enqueueErr);
        await client.from("background_jobs").delete().eq("id", job.id);
        throw new JobServiceError(
          "job_create_failed",
          "Failed to enqueue job.",
          500,
        );
      }

      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async getJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError("job_query_failed", "Failed to query job.", 500);
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async listJobs(user, filters) {
      const client = options.createUserClient(user.accessToken);
      let query = client
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("created_by", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (filters?.status) {
        // Filtering by "failed" must also surface legacy `dead_letter` rows,
        // which are read as failed (see mapJobRow).
        query =
          filters.status === "failed"
            ? query.in("status", ["failed", "dead_letter"])
            : query.eq("status", filters.status);
      }
      if (filters?.jobType) query = query.eq("job_type", filters.jobType);

      const { data: jobs, error } = await query;
      if (error) {
        throw new JobServiceError("job_query_failed", "Failed to list jobs.", 500);
      }
      return (jobs ?? []).map((row) =>
        mapJobRow(row as unknown as Record<string, unknown>),
      );
    },

    async cancelJob(user, jobId) {
      const client = options.createUserClient(user.accessToken);
      const { data: job, error } = await client
        .from("background_jobs")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", jobId)
        .in("status", ["queued", "running"])
        .select(SELECT_COLS)
        .maybeSingle();

      if (error) {
        throw new JobServiceError("job_cancel_failed", "Failed to cancel job.", 500);
      }
      if (!job) {
        throw new JobServiceError(
          "job_not_found",
          "Job not found or already completed.",
          404,
        );
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    async getJobAdmin(jobId) {
      const admin = options.getAdminClient();
      const { data: job, error } = await admin
        .from("background_jobs")
        .select(SELECT_COLS)
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        throw new JobServiceError("job_query_failed", "Failed to query job.", 500);
      }
      if (!job) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }
      return mapJobRow(job as unknown as Record<string, unknown>);
    },

    // --- Admin-only methods (admin client, bypasses RLS) ---

    async setCreditsInfo(jobId, creditsCost, transactionId) {
      const admin = options.getAdminClient();
      await admin
        .from("background_jobs")
        .update({
          credits_cost: creditsCost,
          credits_transaction_id: transactionId,
        })
        .eq("id", jobId);
    },

    async markRunning(jobId) {
      return transition(jobId, ["queued", "retrying"], {
        status: "running",
        started_at: new Date().toISOString(),
      });
    },

    async markRetrying(jobId, errorCode, errorMessage) {
      // Still retrying, so this is NOT a terminal failure: no failed_at.
      return transition(jobId, ["running"], {
        status: "retrying",
        error_code: errorCode,
        error_message: errorMessage,
      });
    },

    async markSucceeded(jobId, result) {
      return transition(jobId, ["running"], {
        status: "succeeded",
        result: result as Json,
        completed_at: new Date().toISOString(),
      });
    },

    async markFailed(jobId, errorCode, errorMessage) {
      return transition(jobId, ["queued", "running", "retrying"], {
        status: "failed",
        error_code: errorCode,
        error_message: errorMessage,
        failed_at: new Date().toISOString(),
      });
    },

    async incrementAttempt(jobId) {
      const admin = options.getAdminClient();
      // NOTE: increment_job_attempt may not be in generated Supabase types yet
      const { data, error } = await (admin as any).rpc("increment_job_attempt", {
        p_job_id: jobId,
      });

      if (error) {
        // Never invent a count here: a made-up attempt_count silently disables
        // the retry limit (and the caller would archive a job that was paid for).
        throw new JobServiceError(
          "job_query_failed",
          `increment_job_attempt failed for ${jobId}: ${error.message}`,
          500,
        );
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (row && typeof row === "object") {
        return {
          attempt_count: (row as any).attempt_count as number,
          max_attempts: (row as any).max_attempts as number,
        };
      }

      // No such job row — the caller decides what that means.
      return null;
    },
  };
}
