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
 *
 * Workorder 39T adds a SECOND statement, `listAdminAdjustmentDetails`: the pool
 * projection above is pinned column by column, so the operator and the reason of
 * an `admin_adjustment` line are read separately, by the ids the list already
 * returned, and merged onto those rows by the route.
 */

import type { CreditTransactionType } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export const LIST_MEMBER_POOL_TRANSACTIONS = "listMemberPoolTransactions";

/**
 * BL-06 / workorder 39T: the second read of this module. It exists because the
 * list projection above is pinned column by column (a db test holds every row's
 * keys against `MEMBER_POOL_TRANSACTION_COLUMNS`), so the operator and the reason
 * of an admin adjustment cannot be added to it: they are read here, by the ids the
 * list already returned, and merged onto those rows by the route.
 */
export const LIST_ADMIN_ADJUSTMENT_DETAILS = "listAdminAdjustmentDetails";

export type PoolTransactionReadOperation =
  | typeof LIST_MEMBER_POOL_TRANSACTIONS
  | typeof LIST_ADMIN_ADJUSTMENT_DETAILS;

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

  /**
   * BL-06 / workorder 39T: who made each admin adjustment among `transactionIds`,
   * and why. OPTIONAL on purpose — the stand-in repositories written for the
   * route's own tests before 39T do not implement it, and the route must therefore
   * treat "no such method" as "nothing to merge" rather than as a broken read.
   */
  listAdminAdjustmentDetails?(input: {
    workspaceId: string;
    transactionIds: string[];
  }): Promise<AdminAdjustmentDetail[]>;
};

/**
 * One `admin_adjustment` line's operator and reason, as read from its `metadata`.
 *
 * `operator` is `null` when the line carries no usable `operator_id`; `reason` is
 * `null` when it carries none. A line whose `operator_id` names no profile still
 * reports the operator it was written with, with `name: null`.
 */
export type AdminAdjustmentDetail = {
  transactionId: string;
  operator: { id: string; name: string | null } | null;
  reason: string | null;
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
 * BL-06 / workorder 39T: the operator and the reason of the `admin_adjustment`
 * lines the list just returned.
 *
 * `workspace_id` and `id = any($2::uuid[])` are the row predicates and BOTH are
 * bound parameters, so a caller can only ask about lines of one workspace that it
 * already named by id. `transaction_type = 'admin_adjustment'` is the second gate:
 * a charge id passed in by mistake answers nothing rather than somebody's metadata.
 *
 * The operator is read OUT of the column and joined to `profiles` for a name. The
 * shape check in front of the cast matters: `metadata` is free jsonb written by
 * several writers, and a non-uuid `operator_id` there would otherwise turn the
 * whole list into a 22P02 — one bad line must not hide every other line. A line
 * whose `operator_id` names no profile keeps its operator, with a NULL name.
 *
 * `coalesce(display_name, email)` is the same fallback the admin screens use: a
 * profile with no display name is still identified by its address.
 */
const LIST_ADMIN_ADJUSTMENT_DETAILS_SQL = `
select
  t.id::text as id,
  case
    when t.metadata->>'operator_id' ~ '^[0-9a-fA-F-]{36}$'
      then t.metadata->>'operator_id'
  end as operator_id,
  coalesce(op.display_name, op.email) as operator_name,
  t.metadata->>'reason' as reason
from public.credit_transactions t
left join public.profiles op
  on op.id = (
    case
      when t.metadata->>'operator_id' ~ '^[0-9a-fA-F-]{36}$'
        then (t.metadata->>'operator_id')::uuid
    end
  )
where t.workspace_id = $1::uuid
  and t.id = any($2::uuid[])
  and t.transaction_type = 'admin_adjustment'
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

    async listAdminAdjustmentDetails(input) {
      // Arguments first, and an EMPTY id list before anything else: "no ids" is
      // "nothing to answer", so it must not open a connection at all.
      const workspaceId = requireDetailWorkspaceId(input.workspaceId);
      const transactionIds = requireTransactionIds(input.transactionIds);
      if (transactionIds.length === 0) return [];

      try {
        return await withPrivilegedTransaction(
          options.pool,
          // Same system read as above: the caller's authorization was decided by
          // the route, and the two bound predicates are the rule.
          null,
          async (client) => {
            const result = await client.query(
              LIST_ADMIN_ADJUSTMENT_DETAILS_SQL,
              [workspaceId, transactionIds],
            );

            // Zero rows is a LEGAL answer: the ids may name no adjustment at all.
            return result.rows.map((row) => mapAdminAdjustmentDetailRow(row));
          },
        );
      } catch (error) {
        throw new PoolTransactionReadError(
          LIST_ADMIN_ADJUSTMENT_DETAILS,
          error,
        );
      }
    },
  };
}

/** Fixed row-shape label for the details read: a refusal carries no SQL and no id. */
const ADMIN_ADJUSTMENT_DETAILS_LABEL = "admin adjustment details read";

/**
 * The workspace id of the details read. Same rule as the list read: a non-empty
 * bound string only, and the UUID shape is PostgreSQL's to refuse (22P02 inside
 * the transaction, which rolls back and leaves the pool usable).
 */
function requireDetailWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PoolTransactionReadError(
      LIST_ADMIN_ADJUSTMENT_DETAILS,
      new Error('admin adjustment details read needs a non-empty "workspaceId"'),
    );
  }

  return value;
}

/**
 * The ids to ask about. Every one is bound as `::uuid`, so a malformed id is
 * PostgreSQL's error rather than a silently empty answer; a non-array or a
 * non-string element is refused before any connection.
 */
function requireTransactionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PoolTransactionReadError(
      LIST_ADMIN_ADJUSTMENT_DETAILS,
      new Error(
        'admin adjustment details read needs an array of "transactionIds"',
      ),
    );
  }

  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new PoolTransactionReadError(
        LIST_ADMIN_ADJUSTMENT_DETAILS,
        new Error(
          'admin adjustment details read needs non-empty "transactionIds"',
        ),
      );
    }

    return entry;
  });
}

/**
 * One detail row. `id` is the key the merge is done on, so it must be a usable
 * string; the three metadata-derived fields are optional by nature and read as
 * `null` when the row carries none.
 */
function mapAdminAdjustmentDetailRow(row: unknown): AdminAdjustmentDetail {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(
      `${ADMIN_ADJUSTMENT_DETAILS_LABEL} returned a row that is not an object`,
    );
  }

  const record = row as Readonly<Record<string, unknown>>;
  const transactionId = record["id"];
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new Error(
      `${ADMIN_ADJUSTMENT_DETAILS_LABEL} returned no usable "id"`,
    );
  }

  const operatorId = optionalDetailText(record, "operator_id");
  const operatorName = optionalDetailText(record, "operator_name");

  return {
    transactionId,
    // The operator is reported whenever the line names one — a profile that could
    // not be found leaves the NAME null rather than dropping the operator.
    operator:
      operatorId === null ? null : { id: operatorId, name: operatorName },
    reason: optionalDetailText(record, "reason"),
  };
}

/** A nullable text field of a detail row: absent and NULL both read as `null`. */
function optionalDetailText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    throw new Error(
      `${ADMIN_ADJUSTMENT_DETAILS_LABEL} returned no usable "${field}"`,
    );
  }

  return value;
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
