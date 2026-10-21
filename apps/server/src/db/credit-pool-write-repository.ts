/**
 * The three-pool charge and refund (workorder 37T, BL-04 / BL-41 / BL-45).
 *
 * Three statements over `public.deduct_from_pools` (37N) and
 * `public.refund_to_pools` (37S), plus the lookup of the team workspace those
 * functions are keyed by. They run through the privileged transaction entry
 * point of workorder 19 with a NULL actor: the caller's authorization was
 * decided above, and the functions are service-role only.
 *
 * Rules this module keeps:
 *
 * - A database error is NOT wrapped. It is thrown as it came, so the SQLSTATE
 *   (`err.code`: P0402 / P0403 / P0404) reaches `withCreditPools`, which maps it
 *   to a `CreditServiceError`. The transaction has rolled back by then, so a
 *   refused charge never leaves a half-written ledger.
 * - Which workspace is "the team" is decided by SQL, not by this process: the
 *   earliest `workspaces` row with `type = 'team'` (the same rule the grant
 *   repository uses). No such row answers `null`.
 * - All ids and numbers are bind parameters; nothing a caller passes becomes
 *   SQL text.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type CreditPoolWriteRepository = {
  /** The team workspace id, or null when there is none. */
  resolveTeamWorkspaceId(): Promise<string | null>;
  /** Charge `amount` across the pools; returns the ledger row id. Throws the database error as is (`code` = SQLSTATE). */
  deductFromPools(input: {
    workspaceId: string;
    userId: string;
    amount: number;
    jobId?: string | undefined;
    description?: string | undefined;
  }): Promise<string>;
  /** Refund a job back to the pools it was charged to; returns the ledger row id, or null when that job was not charged by pool. */
  refundToPools(input: {
    jobId: string;
    description?: string | undefined;
  }): Promise<string | null>;
};

const RESOLVE_TEAM_SQL = `
select w.id
  from public.workspaces w
 where w.type = 'team'
 order by w.created_at asc
 limit 1
`;

const DEDUCT_SQL =
  "select public.deduct_from_pools($1::uuid, $2::uuid, $3::int, $4::uuid, $5::text) as id";

const REFUND_SQL = "select public.refund_to_pools($1::uuid, $2::text) as id";

export function createCreditPoolWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CreditPoolWriteRepository {
  return {
    async resolveTeamWorkspaceId() {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(RESOLVE_TEAM_SQL);
          const row = result.rows[0] as { id?: unknown } | undefined;
          if (row === undefined) return null;
          if (typeof row.id !== "string" || row.id.length === 0) {
            throw new Error("credit pool write returned no usable team id");
          }
          return row.id;
        },
      );
    },

    async deductFromPools(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(DEDUCT_SQL, [
            input.workspaceId,
            input.userId,
            input.amount,
            input.jobId ?? null,
            input.description ?? null,
          ]);
          const row = result.rows[0] as { id?: unknown } | undefined;
          if (row === undefined || typeof row.id !== "string" || row.id.length === 0) {
            throw new Error("credit pool write returned no deduction id");
          }
          return row.id;
        },
      );
    },

    async refundToPools(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(REFUND_SQL, [
            input.jobId,
            input.description ?? null,
          ]);
          const row = result.rows[0] as { id?: unknown } | undefined;
          if (row === undefined || row.id === null || row.id === undefined) {
            return null;
          }
          if (typeof row.id !== "string" || row.id.length === 0) {
            throw new Error("credit pool write returned no usable refund id");
          }
          return row.id;
        },
      );
    },
  };
}
