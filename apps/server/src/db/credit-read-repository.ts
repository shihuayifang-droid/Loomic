/**
 * Read-only credits repository (workorder 21K, ADR-0001 migration step 2).
 *
 * THREE admin PostgREST reads move here, all behind
 * `features/credits/credit-service.ts`:
 *
 * 1. the recent-transactions list of one workspace
 *    (`credit_transactions` filtered by `workspace_id`, newest first, `limit`),
 *    read by `GET /api/credits/transactions`;
 * 2. the single subscription row of one workspace (`subscriptions`, at most one
 *    row because `UNIQUE (workspace_id)` holds it), read by `getSubscription`
 *    on the billing gate's path;
 * 3. the three answers `getBalance` needs — the balance, the plan and whether
 *    one specific claim date has already been claimed — which used to be THREE
 *    parallel PostgREST reads and are now ONE statement, so all three answers
 *    belong to the same database snapshot.
 *
 * Rules this module keeps:
 *
 * - `listTransactions`, `readSubscription` and `readBalanceSnapshot` are the
 *   entire interface. There is no access token, no table name, no generic
 *   predicate object and no column selector, so a caller cannot widen any read:
 *   the only rows these statements can return are the ones their own
 *   `workspace_id = $1::uuid` predicate selects.
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
 * - `claimDate` is validated before the pool is touched as well, and unlike the
 *   uuid it IS shape-checked: it must be a string of the exact form
 *   `YYYY-MM-DD`, the one shape the caller computes from the system clock and
 *   the only one `$2::date` can be trusted to read the same way everywhere. A
 *   well-shaped but impossible date (`2026-02-31`) is deliberately left to
 *   PostgreSQL, exactly as a malformed uuid is: the `$2::date` cast refuses it
 *   inside the transaction, which rolls back and leaves the pool usable.
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
 * - The balance snapshot is the opposite case: its statement has no `from`
 *   clause of its own, so its three scalar subqueries answer EXACTLY one row for
 *   every workspace, known or not, and anything other than one row is a
 *   disagreement between the statement and this module rather than a value.
 *   Inside that row, `balance` and `plan` are `null` when the workspace has no
 *   such row — a legal answer the service turns into `0` and `"free"` — while
 *   `daily_claimed` is a real boolean from `exists`, never null and never a
 *   text: folding a row count into the answer, or a `count(*)` bigint into a
 *   boolean, is exactly what the shape checks below refuse.
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

/**
 * The one-row balance snapshot `getBalance` is built from, keyed by the column
 * names the statement aliases: the workspace's `credit_balances.balance`, its
 * `subscriptions.plan`, and whether `daily_credit_claims` holds the requested
 * `claim_date` — all three read in ONE statement, so they cannot disagree about
 * which instant they describe.
 *
 * `balance` and `plan` are `null` exactly when the workspace has no such row
 * (both tables are `UNIQUE (workspace_id)`, so at most one each). That is the
 * "absent" answer, and the defaults the HTTP contract publishes (`0`,
 * `"free"`) are applied by the service, not here. `daily_claimed` is a real
 * boolean and is never null: `exists` always answers true or false.
 */
export type BalanceSnapshotReadRow = {
  balance: number | null;
  plan: SubscriptionPlan | null;
  daily_claimed: boolean;
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
  /**
   * The balance, the plan and the claim answer of that workspace in ONE
   * statement. `claimDate` is a `YYYY-MM-DD` string and is refused before any
   * connection when it is not.
   */
  readBalanceSnapshot(input: {
    workspaceId: string;
    claimDate: string;
  }): Promise<BalanceSnapshotReadRow>;
};

export const LIST_TRANSACTIONS = "listTransactions";
export const READ_SUBSCRIPTION = "readSubscription";
export const READ_BALANCE_SNAPSHOT = "readBalanceSnapshot";

export type CreditReadOperation =
  | typeof LIST_TRANSACTIONS
  | typeof READ_SUBSCRIPTION
  | typeof READ_BALANCE_SNAPSHOT;

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

/**
 * The balance snapshot projection: the three aliases of the one statement, in
 * the order the service maps them. A snapshot that grew a fourth answer without
 * the service learning about it is the drift this list is compared against.
 */
export const BALANCE_SNAPSHOT_COLUMNS = [
  "balance",
  "plan",
  "daily_claimed",
] as const satisfies readonly (keyof BalanceSnapshotReadRow)[];

/** The inclusive bounds `limit` must sit in, matching the service's clamp. */
export const CREDIT_TRANSACTION_LIMIT_MIN = 1;
export const CREDIT_TRANSACTION_LIMIT_MAX = 100;

/** Fixed row-shape labels: a refusal never carries SQL, a host or a workspace. */
const TRANSACTION_LABEL = "credit transaction read";
const SUBSCRIPTION_LABEL = "credit subscription read";
const BALANCE_SNAPSHOT_LABEL = "credit balance snapshot read";

/** The ONE shape `claimDate` may have: the caller's own `YYYY-MM-DD`. */
const CLAIM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
 * The balance snapshot: THREE scalar subqueries, one statement, one row.
 *
 * The three answers `getBalance` publishes used to be three separate reads, so
 * they could describe three different instants — a claim landing between them
 * would be reported as "balance before the claim, already claimed". One
 * statement makes that impossible: a single statement sees one snapshot.
 *
 * The date is the caller's, bound as `$2::date`, and NOT `current_date`: the
 * service's date is the JavaScript UTC date, the credits rules use the
 * database's own `current_date`, and the two disagree whenever the database
 * timezone is not UTC. That disagreement is a separate, already-registered
 * problem; this statement deliberately keeps the caller's date so the read
 * answers for exactly the day the caller asked about.
 *
 * `exists` is written as SQL on purpose and NOT as `count(*)`: `count` returns
 * `bigint`, which both drivers hand back as a STRING, so `count(*) > 0` would
 * have to be folded back into a boolean somewhere else. `exists` is already a
 * boolean and needs no such step.
 *
 * `$1::uuid` is the only row predicate of all three subqueries, so nothing a
 * caller passes can widen the read.
 */
const READ_BALANCE_SNAPSHOT_SQL = `
select
  (select b.balance
     from public.credit_balances b
    where b.workspace_id = $1::uuid) as balance,
  (select s.plan
     from public.subscriptions s
    where s.workspace_id = $1::uuid) as plan,
  exists (select 1
            from public.daily_credit_claims d
           where d.workspace_id = $1::uuid
             and d.claim_date = $2::date) as daily_claimed
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

    async readBalanceSnapshot(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const workspaceId = requireReadArgument(
        READ_BALANCE_SNAPSHOT,
        input.workspaceId,
        "workspaceId",
      );
      const claimDate = requireClaimDate(input.claimDate);

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(READ_BALANCE_SNAPSHOT_SQL, [
            workspaceId,
            claimDate,
          ]);

          // The statement has no `from` clause of its own, so it answers exactly
          // one row for EVERY workspace — the known one, an unknown one, and a
          // workspace with no balance row and no subscription row alike. Zero
          // rows and more than one row are therefore both a disagreement between
          // the statement and this module rather than a value.
          if (result.rows.length !== 1) {
            throw new Error(
              "credit balance snapshot read returned " +
                `${result.rows.length} rows instead of one`,
            );
          }

          return mapBalanceSnapshotRow(result.rows[0]);
        });
      } catch (error) {
        throw new CreditReadError(READ_BALANCE_SNAPSHOT, error);
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

/**
 * The date the caller asks about. It reaches the statement as `$2::date`, so
 * only the exact `YYYY-MM-DD` shape is bindable — the shape
 * `Date.prototype.toISOString().slice(0, 10)` produces, which is the only date
 * the service has ever queried with.
 *
 * Every other shape is refused HERE, before `getTransactionPool()` is called: a
 * localized form (`2026/01/05`), a single-digit month or day (`2026-1-5`), a
 * timestamp (`2026-01-05T00:00`), an empty string and a non-string would
 * otherwise be read by PostgreSQL under whatever `DateStyle` the session
 * happens to carry — and a timestamp would be cast to a day the caller never
 * asked about. The comparison keeps the caller's own semantics only while the
 * shape is guaranteed.
 *
 * A well-shaped but impossible date (`2026-02-31`) is NOT checked here: like a
 * malformed uuid it is left to PostgreSQL, whose `$2::date` cast refuses it
 * inside the transaction.
 */
function requireClaimDate(value: unknown): string {
  if (typeof value !== "string" || !CLAIM_DATE_PATTERN.test(value)) {
    throw new CreditReadError(
      READ_BALANCE_SNAPSHOT,
      new Error(
        'credit balance snapshot read needs a "claimDate" of the form YYYY-MM-DD',
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

/**
 * The three answers of the snapshot, each read from the row by name.
 *
 * `balance` and `plan` are the two columns a workspace can legitimately have no
 * row for, so an explicit SQL NULL is the "absent" answer. An ABSENT column is
 * still a failure: a projection that dropped `plan` must not read like a
 * workspace without a subscription.
 *
 * `daily_claimed` is a boolean and nothing else. The old read answered this by
 * asking whether a row came back at all; the statement answers it with `exists`,
 * and TEXT — the `"t"` a `count(*)`/`boolean::text` projection would produce — is
 * drift that must fail loud rather than become a truthy claim.
 */
function mapBalanceSnapshotRow(row: unknown): BalanceSnapshotReadRow {
  const record = asReadRow(row, BALANCE_SNAPSHOT_LABEL);

  return {
    balance: optionalNonNegativeInteger(
      record,
      "balance",
      BALANCE_SNAPSHOT_LABEL,
    ),
    plan: optionalEnumText(
      record,
      "plan",
      BALANCE_SNAPSHOT_LABEL,
    ) as SubscriptionPlan | null,
    daily_claimed: requireBoolean(
      record,
      "daily_claimed",
      BALANCE_SNAPSHOT_LABEL,
    ),
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

/**
 * A nullable `integer` column that also carries the table's own rule
 * `CHECK (balance >= 0)`.
 *
 * An explicit SQL NULL is a legal answer — the workspace has no balance row yet,
 * which the service turns into `0` — while a NEGATIVE number is drift: the
 * column's check constraint makes it impossible, so a negative means the row did
 * not come from this schema, and reporting it as a balance would publish a debt
 * the credits system cannot represent. A string, a float, `NaN` and an absent
 * column are refused by `requireInteger`, which this reuses.
 */
function optionalNonNegativeInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): number | null {
  const value = row[field];
  if (value === null) return null;

  const integer = requireInteger(row, field, label);
  if (integer < 0) {
    throw new Error(`${label} returned a negative "${field}"`);
  }

  return integer;
}

/**
 * A `boolean` column. `exists (...)` answers a real boolean in both drivers, so
 * the text a `boolean::text` projection would produce, a number, and an absent
 * column are all drift rather than a value — and folding them into a truthy
 * answer would turn a broken read into "already claimed today".
 */
function requireBoolean(
  row: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
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
