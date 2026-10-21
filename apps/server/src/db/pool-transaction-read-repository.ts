/**
 * Read-only per-member three-pool ledger repository (workorder 38U, BL-06 / T-111).
 *
 * The three-pool charges and refunds of 37N / 37S are bookkept per TEAM
 * workspace — `public.deduct_from_pools` writes its ledger line with the team
 * workspace's id — while `GET /api/credits/transactions` listed the caller's
 * PERSONAL workspace. With `LOOMIC_CREDIT_POOLS=on` a member therefore saw
 * neither his own pool charges nor his own pool refunds in the list.
 *
 * One statement answers one member's lines out of that team workspace, carrying
 * the two pool columns the requirement (BL-06) names:
 *
 * - `pool`            the single pool the line was charged to, or SQL NULL when
 *                     the charge was split across several (`deduct_from_pools`
 *                     writes a name only for the one-pool case).
 * - `pool_breakdown`  the `{ daily, team, topup }` split of a pool charge, or
 *                     SQL NULL for every line that is not one.
 *
 * Rules this module keeps:
 *
 * - The row predicates are BOTH bound parameters, `$1::uuid` (the team
 *   workspace) and `$2::uuid` (the member). Nothing a caller passes becomes SQL
 *   text, so a member can never read another member's lines and a workspace can
 *   never widen to the table. A malformed uuid fails as a real SQL error inside
 *   the transaction, which rolls back and leaves the pool usable.
 * - `limit` is bound as `$3::int`, never written into the statement.
 * - The order is `created_at desc, id desc`. The `id` tie-break is stated
 *   explicitly because two ledger rows of one charge can share a timestamp, and
 *   a list that comes back in a different order from one call to the next is not
 *   a list. It is also the order a "newest first" screen means.
 * - `created_at` is normalised to an ISO-8601 string HERE: both drivers hand a
 *   `timestamptz` back as a `Date`, while `@loomic/shared`'s
 *   `creditTransactionSchema` declares `created_at` as `z.string()`. Passing the
 *   `Date` through would break the published shape at serialisation time, and no
 *   type check would notice.
 * - Every number is mapped through `Number()`, and an ABSENT or unusable column
 *   is drift rather than a value: this is a ledger, and folding a broken read
 *   into 0 would publish a pool split nobody measured.
 * - The read runs through the privileged transaction entry point with a NULL
 *   actor: it is a system read performed on behalf of a caller whose
 *   authorization was decided above (the route only reaches it for a member of a
 *   team workspace, with that member's own id), and the statement's two id
 *   predicates are the rule.
 * - A connect or SQL failure throws `PoolTransactionReadError`, whose message is
 *   fixed text: no SQL, no host, no connection string and no id. The driver's own
 *   error rides along as `cause`.
 */

import type { CreditTransactionType } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const LIST_MEMBER_POOL_TRANSACTIONS = "listMemberPoolTransactions";

export type PoolTransactionReadOperation = typeof LIST_MEMBER_POOL_TRANSACTIONS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or an id must never reach a log line or an HTTP body through us.
 */
export class PoolTransactionReadError extends Error {
  readonly operation: PoolTransactionReadOperation;

  constructor(operation: PoolTransactionReadOperation, cause: unknown) {
    super(
      `pool transaction read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "PoolTransactionReadError";
    this.operation = operation;
  }
}

/** The three pool names `credit_transactions.pool` may hold. */
export type LedgerPoolName = "daily" | "team" | "topup";

/** One pool charge's split across the three pools. */
export type LedgerPoolBreakdown = {
  daily: number;
  team: number;
  topup: number;
};

/**
 * One `credit_transactions` row of one member, keyed by COLUMN name, with
 * `created_at` already normalised to an ISO-8601 string and the two pool columns
 * mapped through `Number()` / `null`.
 */
export type MemberPoolTransactionRow = {
  id: string;
  transaction_type: CreditTransactionType;
  amount: number;
  balance_after: number;
  job_id: string | null;
  description: string | null;
  created_at: string;
  pool: LedgerPoolName | null;
  pool_breakdown: LedgerPoolBreakdown | null;
};

/**
 * The projection, in the order the statement below publishes it. Exported so a
 * test can hold the statement against this one list: a column added to one and
 * not the other is the drift those comparisons refuse.
 */
export const MEMBER_POOL_TRANSACTION_COLUMNS = [
  "id",
  "transaction_type",
  "amount",
  "balance_after",
  "job_id",
  "description",
  "created_at",
  "pool",
  "pool_breakdown",
] as const satisfies readonly (keyof MemberPoolTransactionRow)[];

export type PoolTransactionReadRepository = {
  /**
   * BL-06 / T-111: this member's newest `limit` ledger lines out of the team
   * workspace, newest first. An empty list is a legal answer.
   */
  listMemberPoolTransactions(input: {
    workspaceId: string;
    userId: string;
    limit: number;
  }): Promise<MemberPoolTransactionRow[]>;
};

/** Fixed row-shape label: a refusal never carries SQL, a host or an id. */
const MEMBER_POOL_TRANSACTIONS_LABEL = "member pool transaction read";

/** The inclusive bounds `limit` must sit in, matching the route's own clamp. */
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

/**
 * The one statement. `workspace_id` and `user_id` are the only row predicates, so
 * this read cannot answer another member's lines and cannot cross workspaces.
 *
 * `created_at desc, id desc` is the "newest first" order the list means, with an
 * explicit tie-break so two rows of the same charge cannot swap between calls.
 * `limit $3::int` is the caller's clamp, bound rather than written in.
 */
const LIST_MEMBER_POOL_TRANSACTIONS_SQL = `
select
  t.id::text as id,
  t.transaction_type::text as transaction_type,
  t.amount,
  t.balance_after,
  t.job_id::text as job_id,
  t.description,
  t.created_at,
  t.pool,
  t.pool_breakdown
from public.credit_transactions t
where t.workspace_id = $1::uuid
  and t.user_id = $2::uuid
order by t.created_at desc, t.id desc
limit $3::int
`;

/**
 * Build the PostgreSQL implementation over an already-created pool. Nothing here
 * connects: the pool is the caller's, and a failure only surfaces on an actual
 * read, as a `PoolTransactionReadError`.
 */
export function createPoolTransactionReadRepository(options: {
  pool: TransactionPool;
}): PoolTransactionReadRepository {
  return {
    async listMemberPoolTransactions(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const workspaceId = requireReadArgument(input.workspaceId, "workspaceId");
      const userId = requireReadArgument(input.userId, "userId");
      const limit = requireLimit(input.limit);

      try {
        return await withPrivilegedTransaction(
          options.pool,
          // System read on behalf of an already-authorised caller: the two ids are
          // the statement's own predicates, so the context is explicitly empty
          // rather than borrowed from a caller.
          null,
          async (client) => {
            const result = await client.query(
              LIST_MEMBER_POOL_TRANSACTIONS_SQL,
              [workspaceId, userId, limit],
            );

            // Zero rows is a LEGAL answer (a member with no pool lines yet), so
            // the row count is not validated here: every returned row is mapped,
            // and a row that does not carry the projection is drift.
            return result.rows.map((row) => mapMemberPoolTransactionRow(row));
          },
        );
      } catch (error) {
        throw new PoolTransactionReadError(
          LIST_MEMBER_POOL_TRANSACTIONS,
          error,
        );
      }
    },
  };
}

/**
 * A bound id is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable.
 */
function requireReadArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PoolTransactionReadError(
      LIST_MEMBER_POOL_TRANSACTIONS,
      new Error(`member pool transaction read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * The row limit. A whole number is clamped into `[1, 100]` — the SAME clamp
 * `CreditService.getTransactions` applies, so switching this read on cannot change
 * how many lines a caller gets for `?limit=0` or `?limit=1000`.
 *
 * `NaN` — what the route's `parseInt` produces for a non-numeric `?limit` — is
 * refused before any connection rather than bound as `NaN`, which no `int` bind
 * accepts; the service refuses it the same way, through the repository, and the
 * route answers its existing 500.
 */
function requireLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PoolTransactionReadError(
      LIST_MEMBER_POOL_TRANSACTIONS,
      new Error('member pool transaction read needs a whole-number "limit"'),
    );
  }

  return Math.min(Math.max(value, LIMIT_MIN), LIMIT_MAX);
}

/**
 * One ledger row, column by column.
 *
 * `transaction_type` is the database enum rendered as text; it is carried through
 * as-is and typed as `CreditTransactionType`, which is the same enum the shared
 * schema declares. `description` is a stored text column, so an EMPTY string is a
 * value while SQL NULL is `null`.
 */
function mapMemberPoolTransactionRow(
  row: unknown,
): MemberPoolTransactionRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    transaction_type: requireString(
      record,
      "transaction_type",
    ) as CreditTransactionType,
    amount: requireInteger(record, "amount"),
    balance_after: requireInteger(record, "balance_after"),
    job_id: optionalText(record, "job_id"),
    description: optionalText(record, "description"),
    created_at: requireTimestamp(record, "created_at"),
    pool: optionalPoolName(record, "pool"),
    pool_breakdown: optionalBreakdown(record, "pool_breakdown"),
  };
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned a row that is not an object`,
    );
  }

  return value as Record<string, unknown>;
}

/** A column the row cannot exist without: a non-empty string, nothing else. */
function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
    );
  }

  return value;
}

/**
 * An `integer` column, mapped through `Number()`. `amount` is signed (a deduction
 * is stored negative) and `balance_after` is a reading, so neither is bounded
 * here; a non-integer — a numeric, a text, an absent column — is drift.
 */
function requireInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
    );
  }

  return Number(value);
}

/** A nullable text column: SQL NULL is `null`, an empty string is a value. */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
    );
  }

  return value;
}

/** The three names `credit_transactions.pool` may hold, or SQL NULL. */
function optionalPoolName(
  row: Readonly<Record<string, unknown>>,
  field: string,
): LedgerPoolName | null {
  const value = row[field];
  if (value === null) return null;

  if (value === "daily" || value === "team" || value === "topup") {
    return value;
  }

  throw new Error(
    `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
  );
}

/**
 * The `jsonb` split, mapped through `Number()` per key.
 *
 * SQL NULL is `null` (every line that is not a split pool charge). A row that
 * carries an object must carry all three keys as whole numbers: a missing key or
 * a text value would let a broken split read as "0 out of that pool", which is
 * exactly the kind of invented number this module refuses.
 */
function optionalBreakdown(
  row: Readonly<Record<string, unknown>>,
  field: string,
): LedgerPoolBreakdown | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
    );
  }

  const breakdown = value as Readonly<Record<string, unknown>>;

  return {
    daily: requireBreakdownNumber(breakdown, "daily"),
    team: requireBreakdownNumber(breakdown, "team"),
    topup: requireBreakdownNumber(breakdown, "topup"),
  };
}

function requireBreakdownNumber(
  breakdown: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = breakdown[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "pool_breakdown.${key}"`,
    );
  }

  return Number(value);
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand `timestamptz` back as a `Date`, while the shared schema
 * declares `created_at` as `z.string()`. Both a `Date` and an ISO string are
 * accepted and normalised; anything else (an absent column, a number, an invalid
 * `Date`, a non-ISO string) fails loud.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(
        `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
      );
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(
    `${MEMBER_POOL_TRANSACTIONS_LABEL} returned no usable "${field}"`,
  );
}
