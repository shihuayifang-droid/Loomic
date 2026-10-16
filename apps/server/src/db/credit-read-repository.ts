/**
 * Read-only credits repository (workorder 21K, ADR-0001 migration step 2).
 *
 * TWO admin PostgREST reads move here, both behind
 * `features/credits/credit-service.ts`:
 *
 * 1. the recent-transactions list of one workspace
 *    (`credit_transactions` filtered by `workspace_id`, newest first, `limit`),
 *    read by `GET /api/credits/transactions`;
 * 2. the single subscription row of one workspace (`subscriptions`, at most one
 *    row because `UNIQUE (workspace_id)` holds it), read by `getSubscription`
 *    on the billing gate's path.
 *
 * Rules this module keeps:
 *
 * - `listTransactions` and `readSubscription` are the entire interface. There is
 *   no access token, no table name, no generic predicate object and no column
 *   selector, so a caller cannot widen either read: the only rows these
 *   statements can return are the ones their own `workspace_id = $1::uuid`
 *   predicate selects.
 * - The projection names its columns explicitly, in the order the PostgREST
 *   select strings named them, and the row keeps the COLUMN names as its keys.
 *   The camelCase projection of the subscription belongs to `credit-service.ts`
 *   and stays there, because the defaults it applies (`plan` -> `"free"`, the
 *   other six -> `null`) are part of the HTTP contract, not of the row.
 * - Every value is a bind parameter. The workspace id is `$1::uuid`, so a
 *   malformed one fails as a real SQL error (SQLSTATE 22P02) inside the
 *   transaction instead of silently matching something else. `limit` is
 *   `$2::int` and is NEVER concatenated into the statement, so no value a caller
 *   can pass becomes SQL text.
 * - `limit` is validated BEFORE the pool is touched: it must be an integer in
 *   1..100, otherwise the call fails without opening a connection, without a
 *   transaction and without a statement. The service's own clamp
 *   (`Math.min(Math.max(limit, 1), 100)`) keeps `NaN` as `NaN`, and `NaN` is not
 *   an integer — so a `NaN` limit is refused here rather than being sent to the
 *   database, while the service still answers its existing
 *   `credit_query_failed` 500.
 * - Timestamps are NORMALISED, never passed through: `pg` and PGlite hand back
 *   `timestamptz` as a `Date`, while `created_at` in `creditTransactionSchema`
 *   is `z.string()` — a `Date` would fail that parse and turn a working read
 *   into a 500. Anything that is neither a `Date` nor an ISO string with an
 *   explicit offset is drift and fails loud.
 * - `amount` and `balance_after` are `integer NOT NULL` columns, so a string, a
 *   float, `NaN`, an infinity or an absent column is drift rather than a value.
 *   `amount` is legitimately NEGATIVE (a deduction), so no sign test is applied.
 * - A column that is MISSING from the row is a failure, not a null. Only an
 *   explicit SQL NULL becomes `null`. Folding the two together would let a
 *   projection that dropped a column read exactly like a transaction with no job
 *   and no description.
 * - An empty list is a LEGAL answer (a workspace with no transactions yet) and
 *   commits. For the subscription, zero rows is the "no subscription yet"
 *   answer and is reported as `null`, while MORE THAN ONE row is a
 *   statement/mapper disagreement rather than a value, because
 *   `UNIQUE (workspace_id)` makes it impossible and a caller must not have to
 *   guess which row is the subscription.
 * - Both statements run through workorder 19's transaction entry point in
 *   `privileged` mode with a NULL actor. These are reads on behalf of a request
 *   whose authorization is decided above (the viewer's own workspace id is
 *   passed in); forging an actor would put a person's id on an audit trail they
 *   had nothing to do with, and the statements' own predicate is the rule.
 * - A connect, SQL or row-shape failure throws `CreditReadError`, whose own
 *   message is fixed text: no SQL, no host, no connection string, no workspace
 *   id. The driver's own error rides along as `cause`.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 *   There is no fallback path: a caller that was handed this repository either
 *   reads through it or fails, and with no repository wired `CreditService`
 *   fails closed rather than reaching for the admin client these two methods
 *   used to hold.
 */

import type {
  BillingPeriod,
  CreditTransactionType,
  SubscriptionPlan,
} from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * One `credit_transactions` row, keyed by COLUMN name, with `created_at` already
 * normalised to an ISO-8601 string.
 *
 * `job_id` and `description` are the schema's two nullable columns among the
 * seven projected; both are `null` exactly when the database says NULL.
 */
export type CreditTransactionReadRow = {
  id: string;
  transaction_type: CreditTransactionType;
  amount: number;
  balance_after: number;
  job_id: string | null;
  description: string | null;
  created_at: string;
};

/**
 * One `subscriptions` row, keyed by COLUMN name, with the three nullable
 * timestamps already normalised to ISO-8601 strings or `null`.
 *
 * `plan` is NOT NULL with a `free` default; the other six projected columns are
 * nullable. An absent workspace row is `null` from `readSubscription`, never a
 * row of defaults — the defaults belong to the service's return object.
 */
export type SubscriptionReadRow = {
  plan: SubscriptionPlan;
  billing_period: BillingPeriod | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
};

export type CreditReadRepository = {
  /**
   * The newest `limit` transactions of that workspace, newest first. An empty
   * list is a legal answer.
   */
  listTransactions(input: {
    workspaceId: string;
    limit: number;
  }): Promise<CreditTransactionReadRow[]>;
  /**
   * The one subscription row of that workspace, or `null` when the workspace has
   * none yet. A missing subscription is not an error the caller should retry.
   */
  readSubscription(input: {
    workspaceId: string;
  }): Promise<SubscriptionReadRow | null>;
};

export const LIST_TRANSACTIONS = "listTransactions";
export const READ_SUBSCRIPTION = "readSubscription";

export type CreditReadOperation =
  | typeof LIST_TRANSACTIONS
  | typeof READ_SUBSCRIPTION;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host, a
 * credential or the workspace id must never reach a log line or an HTTP body
 * through us.
 */
export class CreditReadError extends Error {
  readonly operation: CreditReadOperation;

  constructor(operation: CreditReadOperation, cause: unknown) {
    super(
      `credit read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "CreditReadError";
    this.operation = operation;
  }
}

/**
 * The projection, in the order the credit transaction list publishes it. It is
 * exported so a test can hold the statement's select list and the service's
 * column list against this one list: a column added to one and not the others is
 * the drift those comparisons refuse.
 */
export const CREDIT_TRANSACTION_COLUMNS = [
  "id",
  "transaction_type",
  "amount",
  "balance_after",
  "job_id",
  "description",
  "created_at",
] as const satisfies readonly (keyof CreditTransactionReadRow)[];

/** The subscription projection, in the order the service maps it. */
export const SUBSCRIPTION_COLUMNS = [
  "plan",
  "billing_period",
  "stripe_customer_id",
  "stripe_subscription_id",
  "current_period_start",
  "current_period_end",
  "canceled_at",
] as const satisfies readonly (keyof SubscriptionReadRow)[];

/** The inclusive bounds `limit` must sit in, matching the service's clamp. */
export const CREDIT_TRANSACTION_LIMIT_MIN = 1;
export const CREDIT_TRANSACTION_LIMIT_MAX = 100;

/** Fixed row-shape labels: a refusal never carries SQL, a host or a workspace. */
const TRANSACTION_LABEL = "credit transaction read";
const SUBSCRIPTION_LABEL = "credit subscription read";

/**
 * The transaction list. `where workspace_id = $1::uuid` is the only row
 * predicate; `order by created_at desc` matches the read it replaces (and the
 * `(workspace_id, created_at DESC)` index behind it), and `limit $2::int` is the
 * caller's clamp, bound — never written into the statement.
 *
 * The tie-break is deliberately absent, exactly as the PostgREST read had none:
 * two rows sharing `created_at` may come back in either order from one call to
 * the next, and adding `id` here would be a behaviour change nobody asked for.
 */
const LIST_TRANSACTIONS_SQL = `
select
  id,
  transaction_type,
  amount,
  balance_after,
  job_id,
  description,
  created_at
from public.credit_transactions
where workspace_id = $1::uuid
order by created_at desc
limit $2::int
`;

/**
 * The subscription row. One table, one bind parameter, no ordering and no limit:
 * `UNIQUE (workspace_id)` makes this at most one row, and this module refuses a
 * second one instead of picking.
 */
const READ_SUBSCRIPTION_SQL = `
select
  plan,
  billing_period,
  stripe_customer_id,
  stripe_subscription_id,
  current_period_start,
  current_period_end,
  canceled_at
from public.subscriptions
where workspace_id = $1::uuid
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `CreditReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createCreditReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CreditReadRepository {
  return {
    async listTransactions(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const workspaceId = requireReadArgument(
        LIST_TRANSACTIONS,
        input.workspaceId,
        "workspaceId",
      );
      const limit = requireReadLimit(input.limit);

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // System read on behalf of an already-authorised caller: the workspace
          // id is the statement's own predicate, so the context is explicitly
          // empty rather than borrowed from a caller.
          null,
          async (client) => {
            const result = await client.query(LIST_TRANSACTIONS_SQL, [
              workspaceId,
              limit,
            ]);

            return result.rows.map((row) => mapTransactionRow(row));
          },
        );
      } catch (error) {
        throw new CreditReadError(LIST_TRANSACTIONS, error);
      }
    },

    async readSubscription(input) {
      const workspaceId = requireReadArgument(
        READ_SUBSCRIPTION,
        input.workspaceId,
        "workspaceId",
      );

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(READ_SUBSCRIPTION_SQL, [
            workspaceId,
          ]);

          // No subscription row yet is the old `maybeSingle()` null and is
          // reported as `null`, NOT as a failure: the service turns it into its
          // existing `free` + six-null answer, and the transaction still COMMITs.
          if (result.rows.length === 0) return null;

          // `UNIQUE (workspace_id)` makes a second row impossible, so it is a
          // statement/mapper disagreement rather than a value.
          if (result.rows.length !== 1) {
            throw new Error("credit subscription read returned more than one row");
          }

          return mapSubscriptionRow(result.rows[0]);
        });
      } catch (error) {
        throw new CreditReadError(READ_SUBSCRIPTION, error);
      }
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 */
function requireReadArgument(
  operation: CreditReadOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CreditReadError(
      operation,
      new Error(`credit read needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * `limit` reaches the statement as `$2::int`, so only a real integer inside the
 * published bounds is bindable at all.
 *
 * `NaN`, a float, a string, a negative and anything above 100 are refused HERE,
 * before `getTransactionPool()` is called: the caller's clamp keeps `NaN` as
 * `NaN`, and a value that was never a limit must not become a query.
 */
function requireReadLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < CREDIT_TRANSACTION_LIMIT_MIN ||
    value > CREDIT_TRANSACTION_LIMIT_MAX
  ) {
    throw new CreditReadError(
      LIST_TRANSACTIONS,
      new Error(
        "credit transaction read needs an integer limit between " +
          `${CREDIT_TRANSACTION_LIMIT_MIN} and ${CREDIT_TRANSACTION_LIMIT_MAX}`,
      ),
    );
  }

  return value;
}

function mapTransactionRow(row: unknown): CreditTransactionReadRow {
  const record = asReadRow(row, TRANSACTION_LABEL);

  return {
    id: requireString(record, "id", TRANSACTION_LABEL),
    transaction_type: requireEnumText(
      record,
      "transaction_type",
      TRANSACTION_LABEL,
    ) as CreditTransactionType,
    amount: requireInteger(record, "amount", TRANSACTION_LABEL),
    balance_after: requireInteger(record, "balance_after", TRANSACTION_LABEL),
    job_id: optionalText(record, "job_id", TRANSACTION_LABEL),
    description: optionalText(record, "description", TRANSACTION_LABEL),
    created_at: requireTimestamp(record, "created_at", TRANSACTION_LABEL),
  };
}

function mapSubscriptionRow(row: unknown): SubscriptionReadRow {
  const record = asReadRow(row, SUBSCRIPTION_LABEL);

  return {
    plan: requireEnumText(record, "plan", SUBSCRIPTION_LABEL) as SubscriptionPlan,
    billing_period: optionalEnumText(
      record,
      "billing_period",
      SUBSCRIPTION_LABEL,
    ) as BillingPeriod | null,
    stripe_customer_id: optionalText(
      record,
      "stripe_customer_id",
      SUBSCRIPTION_LABEL,
    ),
    stripe_subscription_id: optionalText(
      record,
      "stripe_subscription_id",
      SUBSCRIPTION_LABEL,
    ),
    current_period_start: optionalTimestamp(
      record,
      "current_period_start",
      SUBSCRIPTION_LABEL,
    ),
    current_period_end: optionalTimestamp(
      record,
      "current_period_end",
      SUBSCRIPTION_LABEL,
    ),
    canceled_at: optionalTimestamp(record, "canceled_at", SUBSCRIPTION_LABEL),
  };
}

function asReadRow(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned a row that is not an object`);
  }

  return value as Record<string, unknown>;
}

/** A column the row cannot exist without: a non-empty string, nothing else. */
function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} returned no usable "${field}"`);
  }

  return value;
}

/**
 * An enum column. The membership of the five `subscription_plan` values, the two
 * `billing_period` values and the seven `credit_transaction_type` values is NOT
 * re-checked here: the database's own type is the authority, the shared unions
 * describe exactly those values, and a value outside them would already be
 * refused by the response schema at the HTTP boundary. What this function owns
 * is the SHAPE — a non-empty string and nothing else.
 */
function requireEnumText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  return requireString(row, field, label);
}

/**
 * A nullable enum column: an explicit SQL NULL, or the same text shape. An
 * ABSENT column is a failure, which is the whole point of reading the two apart.
 * An empty string is not a legal enum value and is refused by `requireString`.
 */
function optionalEnumText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  return requireEnumText(row, field, label);
}

/**
 * A nullable TEXT or uuid column. The only two usable answers are an explicit
 * SQL NULL (`null`) and a string; an ABSENT column is a failure. An empty string
 * is passed along rather than rejected: `description` is plain `text`, and a
 * stored empty string is a value the old read returned too.
 */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`${label} returned no usable "${field}"`);
  }

  return value;
}

/**
 * An `integer` column. Both drivers hand `integer` back as a JavaScript number,
 * so a string, a float, `NaN`, an infinity or an absent column is drift rather
 * than a value. The sign is NOT checked: `amount` is negative on every
 * `generation_deduct` row, which is exactly what the ledger is for.
 */
function requireInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} returned no usable "${field}"`);
  }

  return value;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`, while
 * `creditTransactionSchema` declares `created_at` as `z.string()` and the
 * subscription contract publishes strings. Both are accepted and normalised,
 * anything else (an absent column, a number, a non-ISO string, an invalid
 * `Date`) fails loud. Passing the `Date` through would break the published shape
 * the moment the row is serialised, and no type check would notice.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${label} returned no usable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`${label} returned no usable "${field}"`);
}

/** A nullable `timestamptz`: an explicit NULL, or the normalised timestamp. */
function optionalTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  return requireTimestamp(row, field, label);
}
