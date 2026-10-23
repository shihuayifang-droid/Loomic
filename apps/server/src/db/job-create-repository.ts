/**
 * Job row create / compensating delete as repository SQL (workorder 44P,
 * migration plan 25).
 *
 * Two writes move here, both on `background_jobs`:
 *
 * - `insertOwnJob`: the insert the job service used to run with the caller's own
 *   client. `created_by` comes ONLY from `actorId`; the optional
 *   `client_request_id` is written as given (null when absent). Any insert error,
 *   including the 23505 of a repeated (created_by, client_request_id) pair, is
 *   thrown as it came, with its `code` kept.
 * - `deleteOwnJob`: the compensating delete after a failed enqueue. The ACL is
 *   the statement's own predicate (`created_by = actor`), so a row of another
 *   user is never touched; the answer is the number of rows deleted
 *   (counted from the returned ids, as the pool contract exposes rows only).
 *
 * The returned row has the 22 columns of the service's shared column list, in
 * the same order, keyed by column name. The six timestamps are returned as ISO
 * strings (the JSON rendering of a timestamptz), the shape the old client
 * returned, so both drivers answer with the same text.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type JobCreateInput = {
  actorId: string;
  workspaceId: string;
  projectId: string | null;
  canvasId: string | null;
  sessionId: string | null;
  threadId: string | null;
  queueName: string;
  jobType: string;
  payload: unknown;
  clientRequestId?: string | null;
};

export type JobCreateRepository = {
  insertOwnJob(input: JobCreateInput): Promise<Record<string, unknown>>;
  deleteOwnJob(input: { actorId: string; jobId: string }): Promise<number>;
};

const INSERT_OWN_JOB_SQL = `
with inserted as (
  insert into public.background_jobs (
    workspace_id, project_id, canvas_id, session_id, thread_id,
    queue_name, job_type, payload, created_by, client_request_id
  ) values (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
    $6::text, $7::public.background_job_type, $8::jsonb, $9::uuid, $10::text
  )
  returning
    id, workspace_id, project_id, canvas_id, session_id, thread_id,
    queue_name, job_type, status, payload, result, error_code, error_message,
    attempt_count, max_attempts, created_by,
    created_at, updated_at, started_at, completed_at, failed_at, canceled_at
)
select
  id,
  workspace_id,
  project_id,
  canvas_id,
  session_id,
  thread_id,
  queue_name,
  job_type,
  status,
  payload,
  result,
  error_code,
  error_message,
  attempt_count,
  max_attempts,
  created_by,
  to_jsonb(created_at) #>> '{}' as created_at,
  to_jsonb(updated_at) #>> '{}' as updated_at,
  to_jsonb(started_at) #>> '{}' as started_at,
  to_jsonb(completed_at) #>> '{}' as completed_at,
  to_jsonb(failed_at) #>> '{}' as failed_at,
  to_jsonb(canceled_at) #>> '{}' as canceled_at
from inserted
`;

const DELETE_OWN_JOB_SQL =
  "delete from public.background_jobs where id = $1::uuid and created_by = $2::uuid returning id";

export function createJobCreateRepository(options: {
  getTransactionPool: () => TransactionPool;
}): JobCreateRepository {
  return {
    async insertOwnJob(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: input.actorId },
        async (client) => {
          const result = await client.query(INSERT_OWN_JOB_SQL, [
            input.workspaceId,
            input.projectId,
            input.canvasId,
            input.sessionId,
            input.threadId,
            input.queueName,
            input.jobType,
            JSON.stringify(input.payload),
            input.actorId,
            input.clientRequestId ?? null,
          ]);
          const row = result.rows[0];
          if (result.rows.length !== 1 || row === null || typeof row !== "object") {
            throw new Error("job create: expected one row from the insert");
          }
          return row as Record<string, unknown>;
        },
      );
    },

    async deleteOwnJob(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: input.actorId },
        async (client) => {
          const result = await client.query(DELETE_OWN_JOB_SQL, [
            input.jobId,
            input.actorId,
          ]);
          return result.rows.length;
        },
      );
    },
  };
}
