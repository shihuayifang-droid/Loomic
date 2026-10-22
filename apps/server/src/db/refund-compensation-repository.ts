/**
 * Refund compensation repository (workorder 39J, BL-41 compensation queue).
 *
 * A refund that failed is not allowed to vanish: it is recorded once per job in
 * `refund_compensations`, retried every five minutes and given up on after the
 * twelfth failure. This module is the server's door to that queue. It holds
 * three methods, each of them one call to one SQL function that owns the whole
 * rule:
 *
 * - `record` — `record_refund_compensation`: one row per job; a second failure
 *   for the same job only refreshes the error.
 * - `claimDue` — `claim_refund_compensations`: take the rows that are due, count
 *   one attempt on each and push them five minutes ahead.
 * - `finish` — `finish_refund_compensation`: close one attempt as done, still
 *   pending, or exhausted.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter with an explicit cast; no caller value is
 *   ever part of statement text.
 * - Each call runs through the transaction entry point in `privileged` mode with
 *   a NULL actor: this is the server's own bookkeeping, no user is behind it.
 * - Arguments are checked before a connection is opened. A bad argument is a
 *   `RefundCompensationError`, not a database failure.
 * - A connect, SQL or row-shape failure throws `RefundCompensationError`, whose
 *   message is fixed text built from the operation name: no SQL, no host, no id.
 *   The driver's error rides along as `cause`.
 * - The pool is reached through a getter, so importing or building this module
 *   never reads `DATABASE_URL` and never connects.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const RECORD_REFUND_COMPENSATION = "record";
export const CLAIM_DUE_REFUND_COMPENSATIONS = "claimDue";
export const FINISH_REFUND_COMPENSATION = "finish";

export type RefundCompensationOperation =
  | typeof RECORD_REFUND_COMPENSATION
  | typeof CLAIM_DUE_REFUND_COMPENSATIONS
  | typeof FINISH_REFUND_COMPENSATION;

export type RefundCompensationStatus = "pending" | "done" | "exhausted";

export type RecordRefundCompensationInput = {
  jobId: string;
  workspaceId: string;
  userId: string;
  /** A positive whole number of credits. */
  amount: number;
  description: string;
  /** True when the job also has to be marked `credits_link_refunded` afterwards. */
  markLinkRefunded: boolean;
  error: string | null;
};

export type DueRefundCompensation = {
  id: string;
  jobId: string;
  workspaceId: string;
  userId: string;
  amount: number;
  description: string;
  markLinkRefunded: boolean;
  /** Attempts including the one this claim just counted. */
  attempts: number;
  maxAttempts: number;
};

export type FinishRefundCompensationInput = {
  id: string;
  ok: boolean;
  refundTransactionId: string | null;
  error: string | null;
};

export type RefundCompensationRepository = {
  /** Record a failed refund; returns the id of the one row of this job. */
  record(input: RecordRefundCompensationInput): Promise<string>;
  /** Take up to `limit` due rows, one attempt counted on each. */
  claimDue(limit: number): Promise<DueRefundCompensation[]>;
  /** Close one attempt and return the row's resulting status. */
  finish(input: FinishRefundCompensationInput): Promise<RefundCompensationStatus>;
};

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only, so a driver error that embeds a statement, a host or a
 * credential never reaches a log line through us.
 */
export class RefundCompensationError extends Error {
  readonly operation: RefundCompensationOperation;

  constructor(operation: RefundCompensationOperation, cause: unknown) {
    super(
      `refund compensation failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "RefundCompensationError";
    this.operation = operation;
  }
}

const RECORD_SQL = `
select public.record_refund_compensation(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::boolean, $7::text
) as id
`;

const CLAIM_DUE_SQL = `
select id, job_id, workspace_id, user_id, amount, description,
       mark_link_refunded, attempts, max_attempts
  from public.claim_refund_compensations($1::integer)
`;

const FINISH_SQL = `
select public.finish_refund_compensation(
  $1::uuid, $2::boolean, $3::uuid, $4::text
) as status
`;

const STATUSES: readonly string[] = ["pending", "done", "exhausted"];

export function createRefundCompensationRepository(options: {
  getTransactionPool: () => TransactionPool;
}): RefundCompensationRepository {
  return {
    async record(input) {
      const operation = RECORD_REFUND_COMPENSATION;
      const params = [
        requireText(operation, input.jobId),
        requireText(operation, input.workspaceId),
        requireText(operation, input.userId),
        requirePositiveInteger(operation, input.amount),
        requireText(operation, input.description),
        requireBoolean(operation, input.markLinkRefunded),
        requireTextOrNull(operation, input.error),
      ];

      const rows = await runQuery(operation, options, RECORD_SQL, params);
      const id = (rows[0] as { id?: unknown } | undefined)?.id;
      if (rows.length !== 1 || typeof id !== "string" || id.length === 0) {
        throw new RefundCompensationError(
          operation,
          new Error("record answered with an unusable row"),
        );
      }

      return id;
    },

    async claimDue(limit) {
      const operation = CLAIM_DUE_REFUND_COMPENSATIONS;
      const params = [requirePositiveInteger(operation, limit)];

      const rows = await runQuery(operation, options, CLAIM_DUE_SQL, params);

      try {
        return rows.map(mapDueRow);
      } catch (error) {
        throw new RefundCompensationError(operation, error);
      }
    },

    async finish(input) {
      const operation = FINISH_REFUND_COMPENSATION;
      const params = [
        requireText(operation, input.id),
        requireBoolean(operation, input.ok),
        requireTextOrNull(operation, input.refundTransactionId),
        requireTextOrNull(operation, input.error),
      ];

      const rows = await runQuery(operation, options, FINISH_SQL, params);
      const status = (rows[0] as { status?: unknown } | undefined)?.status;
      if (
        rows.length !== 1 ||
        typeof status !== "string" ||
        !STATUSES.includes(status)
      ) {
        throw new RefundCompensationError(
          operation,
          new Error("finish answered with an unusable status"),
        );
      }

      return status as RefundCompensationStatus;
    },
  };
}

/** One privileged transaction, one statement; every failure becomes the fixed error. */
async function runQuery(
  operation: RefundCompensationOperation,
  options: { getTransactionPool: () => TransactionPool },
  sql: string,
  params: readonly unknown[],
): Promise<unknown[]> {
  try {
    const pool = options.getTransactionPool();

    return await withPrivilegedTransaction(pool, null, async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });
  } catch (error) {
    throw new RefundCompensationError(operation, error);
  }
}

function mapDueRow(row: unknown): DueRefundCompensation {
  const value = row as Record<string, unknown>;

  const id = value.id;
  const jobId = value.job_id;
  const workspaceId = value.workspace_id;
  const userId = value.user_id;
  const amount = value.amount;
  const description = value.description;
  const markLinkRefunded = value.mark_link_refunded;
  const attempts = value.attempts;
  const maxAttempts = value.max_attempts;

  if (
    typeof id !== "string" ||
    typeof jobId !== "string" ||
    typeof workspaceId !== "string" ||
    typeof userId !== "string" ||
    typeof amount !== "number" ||
    typeof description !== "string" ||
    typeof markLinkRefunded !== "boolean" ||
    typeof attempts !== "number" ||
    typeof maxAttempts !== "number"
  ) {
    throw new Error("claimed refund compensation row has an unexpected shape");
  }

  return {
    id,
    jobId,
    workspaceId,
    userId,
    amount,
    description,
    markLinkRefunded,
    attempts,
    maxAttempts,
  };
}

function refuse(operation: RefundCompensationOperation, message: string): never {
  throw new RefundCompensationError(operation, new Error(message));
}

function requireText(operation: RefundCompensationOperation, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    refuse(operation, "refund compensation needs a non-empty text value");
  }

  return value;
}

function requireTextOrNull(
  operation: RefundCompensationOperation,
  value: unknown,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    refuse(operation, "refund compensation needs a text value or null");
  }

  return value;
}

function requireBoolean(operation: RefundCompensationOperation, value: unknown): boolean {
  if (typeof value !== "boolean") {
    refuse(operation, "refund compensation needs a boolean value");
  }

  return value;
}

function requirePositiveInteger(
  operation: RefundCompensationOperation,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    refuse(operation, "refund compensation needs a positive whole number");
  }

  return value;
}
