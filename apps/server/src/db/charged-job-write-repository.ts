/**
 * Charged job write repository (workorder 39F, GN-33 step 2).
 *
 * One privileged transaction that calls the database function
 * `public.create_charged_job` (workorder 39E): the job row, the charge and the
 * queue message are written together, so a refused charge or a failed enqueue
 * rolls all three back. The job row is then read back in the same transaction
 * and returned whole.
 *
 * Database errors are thrown as they are, with their SQLSTATE `code` intact:
 * the caller maps P0402 / P0403 / P0404 to credit errors.
 *
 * The pool is reached through a getter, so importing or wiring this module
 * never reads `DATABASE_URL` and never connects. Nothing here goes through the
 * REST layer.
 */

import type { BackgroundJobType } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type ChargedJobInput = {
  workspaceId: string;
  userId: string;
  projectId: string | null;
  canvasId: string | null;
  sessionId: string | null;
  threadId: string | null;
  queueName: string;
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  clientRequestId: string | null;
  amount: number;
  description: string | null;
  usePools: boolean;
  chargeWorkspaceId: string;
  message: Record<string, unknown>;
};

export type ChargedJobWriteRepository = {
  createChargedJob(
    input: ChargedJobInput,
  ): Promise<{ row: Record<string, unknown>; transactionId: string }>;
};

const CREATE_CHARGED_JOB_SQL = `
select * from public.create_charged_job(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text,
  $7::text, $8::public.background_job_type, $9::jsonb, $10::text,
  $11::int, $12::text, $13::boolean, $14::uuid, $15::jsonb
)
`;

const READ_JOB_SQL = `
select id, workspace_id, project_id, canvas_id, session_id, thread_id, queue_name, job_type, status, payload, result, error_code, error_message, attempt_count, max_attempts, created_by, created_at, updated_at, started_at, completed_at, failed_at, canceled_at
  from public.background_jobs
 where id = $1::uuid
`;

export function createChargedJobWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ChargedJobWriteRepository {
  return {
    async createChargedJob(input) {
      const pool = options.getTransactionPool();

      return withPrivilegedTransaction(pool, null, async (client) => {
        const created = await client.query(CREATE_CHARGED_JOB_SQL, [
          input.workspaceId,
          input.userId,
          input.projectId,
          input.canvasId,
          input.sessionId,
          input.threadId,
          input.queueName,
          input.jobType,
          JSON.stringify(input.payload),
          input.clientRequestId,
          input.amount,
          input.description,
          input.usePools,
          input.chargeWorkspaceId,
          JSON.stringify(input.message),
        ]);

        const head = created.rows[0] as
          | { job_id?: unknown; transaction_id?: unknown }
          | undefined;
        if (!head || typeof head.job_id !== "string") {
          throw new Error("create_charged_job returned no job id");
        }

        const read = await client.query(READ_JOB_SQL, [head.job_id]);
        const row = read.rows[0] as Record<string, unknown> | undefined;
        if (!row) {
          throw new Error("charged job row was not readable");
        }

        return { row, transactionId: String(head.transaction_id) };
      });
    },
  };
}
