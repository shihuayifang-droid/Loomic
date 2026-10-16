import type {
  BackgroundJob,
  BackgroundJobStatus,
  BackgroundJobType,
  Json,
} from "@loomic/shared";

import type { PgmqClient } from "../../queue/pgmq-client.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../../db/canvas-read-repository.js";
import type {
  ProjectReadRepository,
  ProjectWorkspaceLookupRow,
} from "../../db/project-read-repository.js";
import type { JobAttemptRepository } from "../../db/job-attempt-repository.js";
import type { JobAdminReadRepository } from "../../db/job-admin-read-repository.js";
import type { JobOwnerReadRepository } from "../../db/job-owner-read-repository.js";
import type { JobOwnerWriteRepository } from "../../db/job-owner-write-repository.js";
import type { JobCreditsLinkRepository } from "../../db/job-credits-link-repository.js";
import type { JobTransitionRepository } from "../../db/job-transition-repository.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { queueForJobType } from "./job-registry.js";

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
  //
  // Workorder 21H1: `transactionId` is nullable because a job that was never
  // charged still has to say so. The free-model and billing-disabled paths write
  // `(jobId, 0, null)` — a deliberate "confirmed, costs nothing" record that the
  // worker's billing gate can tell apart from "nothing recorded yet".
  //
  // Workorder 21H2: this write now CHECKS its answer and THROWS
  // `job_query_failed` when it did not land (a broken write, or a row the
  // predicate no longer owns). It used to be an admin update whose `error` and
  // row count nobody read, so a charge that was never attributed looked exactly
  // like one that was (21H0 H12). Zero rows is not success here.
  setCreditsInfo(
    jobId: string,
    creditsCost: number,
    transactionId: string | null,
  ): Promise<void>;
  /**
   * Workorder 21H2: take ownership of a job whose charge was never linked, so
   * its refund is issued exactly once.
   *
   * `true` = this call claimed the row; `false` = the claim was refused (already
   * billed, already claimed, or a state no compensation may touch). A missing or
   * failing repository throws `job_query_failed` — the refund must never be
   * attempted without knowing whether the claim succeeded.
   */
  claimUnlinkedCharge(jobId: string): Promise<boolean>;
  /**
   * Workorder 21H2: record that a claimed job's charge was refunded, so a later
   * compensation pass stops seeing it as owing anything.
   */
  markChargeRefunded(jobId: string): Promise<boolean>;
  markRunning(jobId: string): Promise<boolean>;
  markRetrying(jobId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  markSucceeded(jobId: string, result: Record<string, unknown>): Promise<boolean>;
  markFailed(jobId: string, errorCode: string, errorMessage: string): Promise<boolean>;
  incrementAttempt(jobId: string): Promise<{ attempt_count: number; max_attempts: number } | null>;
};

/**
 * The projection every `background_jobs` read in this file asks for, in one
 * place so no read can quietly widen or narrow it.
 *
 * Workorder 21I: `getJobAdmin` no longer passes this string to a client — its
 * read moved into `JobAdminReadRepository`, whose SQL names the same 22 columns
 * explicitly (and whose test holds the two lists against each other, so a column
 * added here and not there is a failure rather than a silently missing field).
 * It stays exported for exactly that comparison.
 */
export const SELECT_COLS =
  "id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at";

export function createJobService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  pgmq: PgmqClient;
  /**
   * ADR-0001 / workorder 21F: the atomic attempt counter the worker runs before
   * it starts a job. It is the only writer of `background_jobs.attempt_count`.
   *
   * Optional so a caller CAN build the service without one; there is
   * deliberately no fallback behind it. A missing repository is handled exactly
   * like a failing one — the same `job_query_failed` 500 and no count.
   */
  jobAttemptRepository?: JobAttemptRepository;
  /**
   * ADR-0001 / workorder 21H2: the job's credits link and the two steps of the
   * compensation that owns an unlinked charge (`claimUnlinkedCharge`,
   * `markChargeRefunded`). It is the only writer of `background_jobs.credits_cost`
   * and `credits_transaction_id`.
   *
   * Optional for the same reason the attempt repository is, and with the same
   * consequence: with no repository wired, or with a failing one, every method
   * fails closed as the same `job_query_failed` 500. There is deliberately no
   * PostgREST fallback — the unchecked admin update this replaces is exactly the
   * defect (21H0 H12) workorder 21H2 removes.
   */
  jobCreditsLinkRepository?: JobCreditsLinkRepository;
  /**
   * ADR-0001 / workorder 21I: the admin single-row read behind `getJobAdmin`.
   * It is the only reader of a job row for an admin caller (the job watcher's
   * poll and the agent runtime's re-read).
   *
   * Optional for the same reason the two repositories above are, and with the
   * same consequence: with no repository wired, or with a failing one, the read
   * fails closed as the same `job_query_failed` 500 with the same message. There
   * is deliberately no admin-client fallback — the read this replaces is exactly
   * the PostgREST path workorder 21I removes, and a missing dependency must not
   * be able to bring it back.
   */
  jobAdminReadRepository?: JobAdminReadRepository;
  /**
   * ADR-0001 / workorder 21T: the caller's OWN job reads behind `getJob` and
   * `listJobs`. It is the only reader of a job row for the user who asks for it,
   * and its ACL is the explicit `created_by = actor` predicate in its own SQL —
   * the same rule the table's RLS policy applied, with no workspace membership
   * check added.
   *
   * Optional for the same reason the repositories above are, and with the same
   * consequence: with no repository wired, or with a failing one, both reads fail
   * closed as the same `job_query_failed` 500 they already published. There is
   * deliberately no user-client fallback — the two PostgREST reads this replaces
   * are exactly what workorder 21T removes, and a missing dependency must not be
   * able to bring them back.
   *
   * `createUserClient` stays: `createJob` still reads and writes through it.
   */
  jobOwnerReadRepository?: JobOwnerReadRepository;
  /**
   * ADR-0001 / workorder 21U: the caller's OWN job cancel behind `cancelJob` —
   * the `POST /api/jobs/:jobId/cancel` route, and the reaction `withBilling` runs
   * when a charge fails. Its ACL is the explicit `created_by = actor` predicate
   * in its own SQL, and its guard — `status in ('queued', 'running')`, with
   * `retrying` deliberately NOT cancellable — plus the two columns it writes are
   * statement text rather than caller arguments.
   *
   * Optional for the same reason the repositories above are, and with the same
   * consequence: with no repository wired, or with a failing one, the cancel
   * fails closed as the same `job_cancel_failed` 500 it already published. There
   * is deliberately no user-client fallback — the PostgREST update this replaces
   * is exactly what workorder 21U removes, and a missing dependency must not be
   * able to bring it back.
   *
   * `createUserClient` stays: `createJob` still reads and writes through it, and
   * `cancelJob` no longer touches it at all.
   */
  jobOwnerWriteRepository?: JobOwnerWriteRepository;
  /**
   * ADR-0001 / workorder 21M: the four guarded status transitions of the worker
   * (`markRunning`, `markRetrying`, `markSucceeded`, `markFailed`). It is the
   * only writer of a job's `status` and of the four stamps that go with it.
   *
   * Optional for the same reason the other repositories are, and with the same
   * consequence: with no repository wired, or with a failing one, every one of
   * the four fails closed as the same `job_query_failed` 500. There is
   * deliberately no PostgREST fallback — the caller-chosen `from` list and patch
   * object this replaces are exactly the shape workorder 21M removes, and a
   * missing dependency must not be able to bring them back.
   */
  jobTransitionRepository?: JobTransitionRepository;
  /**
   * ADR-0001 / workorder 21V: the canvas → project authorization read `createJob`
   * performs before it inserts anything, for a job submitted FROM a canvas. It is
   * the same question the Agent runtime asks (workorder 21R), through the same
   * method, so a canvas resolves to a project the same way on both paths.
   *
   * Its ACL is `private.can_read_project` verbatim and it deliberately carries NO
   * `archived_at` filter — the RLS policy it replaces has none either, and adding
   * one would refuse every generation submitted from an archived project's canvas
   * (the defect workorder 21R already hit).
   *
   * Optional for the same reason the repositories above are, and with the same
   * consequence: with no repository wired, or with a failing one, the read fails
   * closed as this method's existing `job_create_failed` 500 ("Failed to verify
   * the job canvas."). There is deliberately no user-client fallback — the
   * PostgREST read this replaces is exactly what workorder 21V removes, and a
   * missing dependency must not be able to bring it back.
   */
  canvasReadRepository?: CanvasReadRepository;
  /**
   * ADR-0001 / workorder 21V: the project authorization read `createJob` performs
   * for a job submitted with a project and NO canvas.
   *
   * `findReadableProjectWorkspaceForMutation` is the no-archive-filter read on
   * purpose: its ACL is the one the `projects_select_owner_or_admin` policy
   * applied (membership, then author or `admin`/`owner`), and the archived clause
   * belongs to the READ contract, not to this write-authorization question.
   *
   * Optional for the same reason the repositories above are, and with the same
   * consequence: with no repository wired, or with a failing one, the read fails
   * closed as this method's existing `job_create_failed` 500 ("Failed to verify
   * the job project."). There is deliberately no user-client fallback.
   */
  projectReadRepository?: ProjectReadRepository;
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

  /**
   * One guarded status transition, through the repository that owns them
   * (workorder 21M).
   *
   * The timestamps stay THIS process's clock: each input object is built here
   * with `new Date().toISOString()` and passed down, exactly as the removed
   * update built its patch. What moved is the guard and the write — the `from`
   * set, the columns and the row predicate are the repository's fixed SQL now,
   * so no call site decides them any more.
   *
   * A missing repository throws exactly what a failing one throws: there is no
   * fallback that could reach the update this replaces.
   */
  async function runTransition(
    jobId: string,
    run: (repository: JobTransitionRepository) => Promise<boolean>,
  ): Promise<boolean> {
    const repository = options.jobTransitionRepository;
    if (!repository) throw jobTransitionFailed(jobId);

    try {
      return await run(repository);
    } catch {
      throw jobTransitionFailed(jobId);
    }
  }

  return {
    async createJob(user, input) {
      const client = options.createUserClient(user.accessToken);
      const queueName = queueForJobType(input.jobType);

      // "Which project did this come from?" is not the caller's decision: the
      // worker records asset ownership from the job's project, and a job whose
      // project is wrong (or absent) produces media a private bucket can no
      // longer authorise for the project that asked for it.
      //
      // ADR-0001 / workorder 21V: both authorization reads moved from the
      // CALLER's PostgREST client to the existing repositories, so the ACL each
      // one applied is now statement text in SQL rather than a policy PostgreSQL
      // applies for us. What did NOT move is the answer for answer contract: a
      // `null` row is still the same 403 ("not found or not accessible"), a read
      // that threw — or a repository that was never wired — is still the same 500
      // ("Failed to verify ..."), the canvas/project mismatch is still the same
      // 400, and nothing is inserted or enqueued on any of those paths.
      //
      // `client` is still built here (and still the caller's): the INSERT below
      // and the compensation DELETE of a failed enqueue both run through it.
      let projectId = input.projectId;

      if (input.canvasId) {
        // The canvas is read through the repository, whose statement applies
        // `private.can_read_project` — the same rule the `canvases` RLS policy
        // applied — and, deliberately, no `archived_at` filter.
        const repository = options.canvasReadRepository;
        if (!repository) throw jobCanvasNotVerified();

        let canvas: CanvasProjectLinkRow | null;
        try {
          canvas = await repository.findReadableCanvasProjectLink({
            actorId: user.id,
            canvasId: input.canvasId,
          });
        } catch {
          throw jobCanvasNotVerified();
        }

        if (!canvas?.project_id) {
          throw new JobServiceError(
            "job_create_failed",
            "Canvas not found or not accessible to this user.",
            403,
          );
        }
        if (projectId && projectId !== canvas.project_id) {
          throw new JobServiceError(
            "job_create_failed",
            "Canvas and project do not match.",
            400,
          );
        }

        projectId = canvas.project_id;
      } else if (projectId) {
        // The no-archive-filter read again: the archived clause belongs to the
        // read contract, and this is the write-authorization question the
        // `projects` RLS policy answered.
        const repository = options.projectReadRepository;
        if (!repository) throw jobProjectNotVerified();

        let project: ProjectWorkspaceLookupRow | null;
        try {
          project = await repository.findReadableProjectWorkspaceForMutation({
            actorId: user.id,
            projectId,
          });
        } catch {
          throw jobProjectNotVerified();
        }

        if (!project) {
          throw new JobServiceError(
            "job_create_failed",
            "Project not found or not accessible to this user.",
            403,
          );
        }
      }

      const { data: job, error } = await client
        .from("background_jobs")
        .insert({
          workspace_id: input.workspaceId,
          project_id: projectId ?? null,
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
      // ADR-0001 / workorder 21T: the caller's own job row moved from the user
      // client to the narrow `pg` repository. What did NOT move is the contract:
      // `null` from the repository is this method's existing `job_not_found` 404,
      // and a repository that threw (a connect failure, a SQL error, or the 22P02
      // a malformed uuid raises) is its existing `job_query_failed` 500 — a bad
      // argument is not a missing job, so it is NOT turned into a 404 here.
      //
      // The ACL moved WITH the read: the repository's statement carries
      // `created_by = actor`, so a job belonging to somebody else is `null` here,
      // exactly as the RLS policy used to make it. The user client is no longer
      // involved, which is why `user.accessToken` is not read any more.
      //
      // There is deliberately no user-client fallback behind this: with no
      // repository wired, the call fails closed with exactly the error a broken
      // read produces, so a missing dependency can never revive the old read.
      const repository = options.jobOwnerReadRepository;
      if (!repository) {
        throw new JobServiceError("job_query_failed", "Failed to query job.", 500);
      }

      let row: Record<string, unknown> | null;
      try {
        row = await repository.readOwnJob({ actorId: user.id, jobId });
      } catch {
        throw new JobServiceError("job_query_failed", "Failed to query job.", 500);
      }

      if (row === null) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }

      return mapJobRow(row);
    },

    async listJobs(user, filters) {
      // ADR-0001 / workorder 21T: the caller's own job list moved with the same
      // two rules as `getJob` above — the repository's fixed statement owns the
      // `created_by` ACL, the newest-first order and the 50-row cap, and a
      // repository that threw or was never wired is the existing
      // `job_query_failed` 500 rather than a fallback.
      //
      // The filters are passed DOWN as they arrive, `undefined` normalised to an
      // explicit `null`: "no filter on this column" is a value the statement
      // understands, and an unknown one is bound as its enum type so PostgreSQL
      // rejects it — which is the 500 the old read produced, not an empty list.
      const repository = options.jobOwnerReadRepository;
      if (!repository) {
        throw new JobServiceError("job_query_failed", "Failed to list jobs.", 500);
      }

      let rows: Record<string, unknown>[];
      try {
        rows = await repository.listOwnJobs({
          actorId: user.id,
          status: filters?.status ?? null,
          jobType: filters?.jobType ?? null,
        });
      } catch {
        throw new JobServiceError("job_query_failed", "Failed to list jobs.", 500);
      }

      return rows.map((row) => mapJobRow(row));
    },

    async cancelJob(user, jobId) {
      // ADR-0001 / workorder 21U: the caller's own cancel moved from the user
      // client to the narrow `pg` repository. What did NOT move is the contract:
      // `null` from the repository is this method's existing `job_not_found` 404
      // (the guard matched no row — somebody else's job, an unknown id, or a
      // state that may not be cancelled), and a repository that threw (a connect
      // failure, a SQL error, or the 22P02 a malformed uuid raises) is its
      // existing `job_cancel_failed` 500.
      //
      // The ACL moved WITH the write: the repository's statement carries
      // `created_by = actor`, so a job belonging to somebody else matches no row
      // here, exactly as the RLS policy used to make it. The status guard moved
      // too, and it is still exactly queued/running — `retrying` stays
      // uncancellable. The user client is no longer involved, which is why
      // `user.accessToken` is not read any more.
      //
      // The timestamp is still THIS process's clock: it is built here and passed
      // down, exactly as the removed update built its patch.
      //
      // There is deliberately no user-client fallback behind this: with no
      // repository wired, the call fails closed with exactly the error a broken
      // write produces, so a missing dependency can never revive the old update.
      const repository = options.jobOwnerWriteRepository;
      if (!repository) {
        throw new JobServiceError("job_cancel_failed", "Failed to cancel job.", 500);
      }

      let row: Record<string, unknown> | null;
      try {
        row = await repository.cancelOwnJob({
          actorId: user.id,
          jobId,
          canceledAt: new Date().toISOString(),
        });
      } catch {
        throw new JobServiceError("job_cancel_failed", "Failed to cancel job.", 500);
      }

      if (row === null) {
        throw new JobServiceError(
          "job_not_found",
          "Job not found or already completed.",
          404,
        );
      }

      return mapJobRow(row);
    },

    async getJobAdmin(jobId) {
      // ADR-0001 / workorder 21I: the admin single-row read moved from the admin
      // PostgREST client to the narrow `pg` repository. What did NOT move is the
      // contract: `null` from the repository is this method's existing
      // `job_not_found` 404, and a repository that threw (a connect failure, a
      // SQL error, or the 22P02 a malformed uuid raises) is its existing
      // `job_query_failed` 500 — a bad argument is not a missing job, so it is
      // NOT turned into a 404 here.
      //
      // There is deliberately no admin-client fallback behind this: with no
      // repository wired, the call fails closed with exactly the error a broken
      // read produces, so a missing dependency can never revive the old read.
      const repository = options.jobAdminReadRepository;
      if (!repository) throw jobAdminQueryFailed();

      let row: Record<string, unknown> | null;
      try {
        row = await repository.readJob({ jobId });
      } catch {
        throw jobAdminQueryFailed();
      }

      if (row === null) {
        throw new JobServiceError("job_not_found", "Job not found.", 404);
      }

      // `mapJobRow` stays the server's single mapping point (workorder 21I §6):
      // this row arrives keyed by column name precisely so the legacy
      // `dead_letter` → `failed` translation happens here and nowhere else.
      return mapJobRow(row);
    },

    // --- Admin-only methods (admin client, bypasses RLS) ---

    async setCreditsInfo(jobId, creditsCost, transactionId) {
      // ADR-0001 / workorder 21H2: the write that records WHICH transaction paid
      // for the job moved from an unchecked admin PostgREST update to the narrow
      // `pg` repository, and it now CHECKS its answer.
      //
      // What the old update did: one admin PostgREST update on
      // `background_jobs`, matching the job id — with no projection, no `error`
      // read and no row count. A database error and a zero-row update were both
      // indistinguishable from success, so the job could keep a NULL
      // `credits_transaction_id` while its charge had already been taken
      // (21H0 H12).
      //
      // There is deliberately no PostgREST fallback behind this: with no
      // repository wired, the call fails closed with exactly the error a broken
      // write produces, so a missing dependency can never revive the update.
      const repository = options.jobCreditsLinkRepository;
      if (!repository) throw jobCreditsNotRecorded(jobId);

      let linked: boolean;
      try {
        linked = await repository.linkCredits({
          jobId,
          creditsCost,
          transactionId,
        });
      } catch {
        throw jobCreditsNotRecorded(jobId);
      }

      // Zero rows is a legal answer at the repository level — it means the
      // predicate matched nothing (the job was already billed, or it is no
      // longer in a pre-execution state) — but it is a FAILURE here: the caller
      // asked for this job's charge to be recorded and it was not. Reporting
      // success would leave a taken charge unattributable, which is the state
      // this workorder exists to remove. The two messages are fixed and
      // distinct, so a log can tell "the write broke" from "the row was not
      // billable" without either one carrying driver text.
      if (!linked) throw jobCreditsNotBillable(jobId);
    },

    async claimUnlinkedCharge(jobId) {
      // Workorder 21H2: the refund's authority. The caller may refund only after
      // this answered `true`, so a missing or failing repository must never look
      // like a refusal — that would either refund without ownership (a second
      // refund, since `refund_credits` does not de-duplicate by job id) or lose
      // the compensation silently. It throws, and the caller decides.
      const repository = options.jobCreditsLinkRepository;
      if (!repository) throw unlinkedChargeNotClaimed(jobId);

      try {
        return await repository.claimUnlinkedCharge({ jobId });
      } catch {
        throw unlinkedChargeNotClaimed(jobId);
      }
    },

    async markChargeRefunded(jobId) {
      const repository = options.jobCreditsLinkRepository;
      if (!repository) throw chargeRefundNotMarked(jobId);

      try {
        return await repository.markChargeRefunded({ jobId });
      } catch {
        throw chargeRefundNotMarked(jobId);
      }
    },

    async markRunning(jobId) {
      // ADR-0001 / workorder 21M: `queued|retrying -> running`, with the
      // `from` set and the columns now owned by `JobTransitionRepository`
      // instead of by this call site.
      return runTransition(jobId, (repository) =>
        repository.markRunning({
          jobId,
          startedAt: new Date().toISOString(),
        }),
      );
    },

    async markRetrying(jobId, errorCode, errorMessage) {
      // Still retrying, so this is NOT a terminal failure: no failed_at. The
      // repository's statement has no such column at all.
      return runTransition(jobId, (repository) =>
        repository.markRetrying({ jobId, errorCode, errorMessage }),
      );
    },

    async markSucceeded(jobId, result) {
      // `result` reaches the repository as the caller's document; the repository
      // is what serialises it for the jsonb column, once, for every caller.
      return runTransition(jobId, (repository) =>
        repository.markSucceeded({
          jobId,
          result,
          completedAt: new Date().toISOString(),
        }),
      );
    },

    async markFailed(jobId, errorCode, errorMessage) {
      // This boolean is the refund's only authorisation (see the JobService
      // header): the repository answers `false` when the guard matched no row,
      // and that answer is passed through unchanged.
      return runTransition(jobId, (repository) =>
        repository.markFailed({
          jobId,
          errorCode,
          errorMessage,
          failedAt: new Date().toISOString(),
        }),
      );
    },

    async incrementAttempt(jobId) {
      // ADR-0001 / workorder 21F: the atomic counter moved from the
      // `increment_job_attempt` RPC to a narrow `pg` repository. What did NOT
      // move is the contract — a failure is thrown rather than answered with an
      // invented count (a made-up `attempt_count` silently disables the retry
      // limit, and the caller would archive a job that was paid for), and `null`
      // still means "no such job row".
      //
      // There is no PostgREST fallback behind this: with no repository wired the
      // call fails closed with exactly the error a broken write produces, so a
      // missing dependency can never resurrect the RPC.
      const repository = options.jobAttemptRepository;
      if (!repository) {
        throw incrementAttemptFailed(jobId);
      }

      let row;
      try {
        row = await repository.incrementAttempt({ jobId });
      } catch {
        throw incrementAttemptFailed(jobId);
      }

      // No such job row — the caller decides what that means.
      if (row === null) return null;

      return {
        attempt_count: row.attemptCount,
        max_attempts: row.maxAttempts,
      };
    },
  };
}

/**
 * The one failure the admin job read can report (workorder 21I).
 *
 * Like `incrementAttemptFailed`, it is a function rather than a constant so
 * every caller gets its own error, and the message is the FIXED text the method
 * has always published — the driver's own text is deliberately not concatenated,
 * because it can name the statement, the host or a credential. The repository
 * already carries the raw failure as `cause` for whoever needs to classify it.
 *
 * A repository that threw, a repository whose pool could not be resolved and a
 * repository that was never injected must be indistinguishable from the outside.
 */
function jobAdminQueryFailed(): JobServiceError {
  return new JobServiceError("job_query_failed", "Failed to query job.", 500);
}

/**
 * The one failure the attempt counter can report. It is a function rather than a
 * constant so every caller gets its own error, and it is the ONLY place the
 * code, the wording and the status live: a repository that threw, a repository
 * whose pool could not be resolved and a repository that was never injected must
 * be indistinguishable from the outside.
 *
 * The driver's own text is deliberately NOT concatenated any more: it can name
 * the statement, the host or a credential, and the repository already carries the
 * raw failure as `cause` for whoever needs to classify it.
 */
function incrementAttemptFailed(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `increment_job_attempt failed for ${jobId}`,
    500,
  );
}

/**
 * The one failure the four status transitions can report (workorder 21M).
 *
 * Like `incrementAttemptFailed`, it is a function rather than a constant so
 * every caller gets its own error, and it is the ONLY place the code, the
 * wording and the status live: a repository that threw, a repository whose pool
 * could not be resolved and a repository that was never injected must be
 * indistinguishable from the outside.
 *
 * The driver's own text is deliberately NOT concatenated any more (the removed
 * update appended `error.message`, which can name the statement, the host or a
 * credential); the repository already carries the raw failure as `cause` for
 * whoever needs to classify it. The job id stays in the message because a failed
 * transition is otherwise unattributable in a log.
 */
function jobTransitionFailed(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `Failed to update job ${jobId}.`,
    500,
  );
}

/**
 * The four failures the credits-link path can report (workorder 21H2).
 *
 * Like `incrementAttemptFailed`, these are functions rather than constants so
 * every caller gets its own error, and each message is FIXED text: the driver's
 * own text is deliberately not concatenated, because it can name the statement,
 * the host or a credential. The repository already carries the raw failure as
 * `cause` for whoever needs to classify it.
 *
 * `jobCreditsNotRecorded` and `jobCreditsNotBillable` are two different messages
 * on purpose: "the write broke" and "the row was not billable any more" are
 * different incidents — the first is an outage, the second is a race the
 * compensation path handles — and folding them into one string would erase that
 * from every log line.
 */
/**
 * The two failures the authorization reads of `createJob` can report (workorder
 * 21V).
 *
 * Like the helpers above they are functions rather than constants, so every
 * caller gets its own error, and each message is FIXED text: the driver's own
 * text is deliberately not concatenated, because it can name the statement, the
 * host or a credential — and the repository already carries the raw failure as
 * `cause` for whoever needs to classify it.
 *
 * The two are separate messages on purpose. "The canvas could not be verified"
 * and "the project could not be verified" are different reads, and each one is
 * also deliberately kept apart from its 403: a read that failed is a server
 * fault, while a read that answered no row is "you may not use this".
 */
function jobCanvasNotVerified(): JobServiceError {
  return new JobServiceError(
    "job_create_failed",
    "Failed to verify the job canvas.",
    500,
  );
}

function jobProjectNotVerified(): JobServiceError {
  return new JobServiceError(
    "job_create_failed",
    "Failed to verify the job project.",
    500,
  );
}

function jobCreditsNotRecorded(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `Failed to record the job credits for ${jobId}.`,
    500,
  );
}

function jobCreditsNotBillable(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `The job credits for ${jobId} were not recorded: the job is no longer billable.`,
    500,
  );
}

function unlinkedChargeNotClaimed(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `Failed to claim the unlinked charge of ${jobId}.`,
    500,
  );
}

function chargeRefundNotMarked(jobId: string): JobServiceError {
  return new JobServiceError(
    "job_query_failed",
    `Failed to mark the charge of ${jobId} as refunded.`,
    500,
  );
}
