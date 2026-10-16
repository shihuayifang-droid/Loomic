import type { PGlite } from "@electric-sql/pglite";
import { creditTransactionSchema, creditTransactionsResponseSchema } from "@loomic/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BALANCE_SNAPSHOT_COLUMNS,
  CREDIT_TRANSACTION_COLUMNS,
  CreditReadError,
  LIST_TRANSACTIONS,
  READ_BALANCE_SNAPSHOT,
  READ_SUBSCRIPTION,
  SUBSCRIPTION_COLUMNS,
  createCreditReadRepository,
  type CreditReadRepository,
  type CreditTransactionReadRow,
  type SubscriptionReadRow,
} from "../../db/credit-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  CreditServiceError,
  createCreditService,
} from "../../features/credits/credit-service.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the credits read repository (workorders 21K and 21P).
 *
 * The unit tests beside the repository prove WHICH statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * tables, and that the properties the callers rest on are facts of the database
 * rather than of this process:
 *
 *   - the transaction list returns the newest `limit` rows of ONE workspace,
 *     newest first, with another workspace's newer row never taking a slot;
 *   - all seven columns come back keyed by column name, with `created_at` an ISO
 *     string whose instant is the database's own millisecond value, and the whole
 *     row parses as `creditTransactionSchema` — the schema that declares
 *     `created_at` as `z.string()` and would reject the `Date` `pg` hands back;
 *   - a nullable column that holds SQL NULL reads as `null`, while the required
 *     columns are never null;
 *   - the subscription row is the workspace's own, at most one by
 *     `UNIQUE (workspace_id)`, and an absent row is `null` rather than defaults;
 *   - the balance snapshot is ONE row for every workspace — including one that
 *     does not exist — carrying that workspace's own balance, its own plan and
 *     whether ITS row for the requested day is there; a workspace whose two rows
 *     were deleted answers `null`/`null`/`false`, which the service turns into
 *     `0`/`"free"`/`false`;
 *   - a malformed uuid is a real SQL error that rolls back and leaves the same
 *     pool usable, for all three reads;
 *   - none of the reads moves a row, and the transaction-local context of a read
 *     does not survive COMMIT;
 *   - with no repository wired the service fails closed instead of reaching for
 *     the admin client those reads used to go through.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-0000000021f0";
const OTHER_USER_ID = "00000000-0000-0000-0000-0000000021f1";
const EMPTY_USER_ID = "00000000-0000-0000-0000-0000000021f2";

/**
 * Four further workspaces for the balance snapshot, each with ONE job:
 * `pristineWorkspaceId` is never written to, so the trigger's own defaults can
 * be read back; `snapshotWorkspaceId` is the mutable subject; the other two
 * exist so the isolation and "no rows at all" answers are measured on rows no
 * earlier case touched.
 */
const PRISTINE_USER_ID = "00000000-0000-0000-0000-0000000021f3";
const SNAPSHOT_USER_ID = "00000000-0000-0000-0000-0000000021f4";
const NEIGHBOUR_USER_ID = "00000000-0000-0000-0000-0000000021f5";
const GUTTED_USER_ID = "00000000-0000-0000-0000-0000000021f6";

/** The days the snapshot cases ask about, and a day none of them claims. */
const CLAIM_DATE = "2026-10-17";
const PREVIOUS_CLAIM_DATE = "2026-10-16";
const UNRELATED_CLAIM_DATE = "2000-01-01";

const JOB_ID = "00000000-0000-0000-0000-000000002100";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/** A valid uuid that names no workspace at all. */
const UNKNOWN_WORKSPACE_ID = "00000000-0000-0000-0000-0000000021ff";

/**
 * Five ledger rows of ONE workspace, oldest to newest, with distinct
 * millisecond-exact timestamps so no rounding can blur the ordering.
 */
const TRANSACTION_FIXTURES = [
  {
    id: "00000000-0000-0000-0000-0000000021a1",
    type: "subscription_grant",
    amount: 1000,
    balanceAfter: 1000,
    jobId: null,
    description: "pro plan monthly grant",
    createdAt: "2026-05-01T00:00:01.001Z",
  },
  {
    id: "00000000-0000-0000-0000-0000000021a2",
    type: "daily_grant",
    amount: 5,
    balanceAfter: 1005,
    jobId: null,
    description: "daily free credits",
    createdAt: "2026-05-01T00:00:02.002Z",
  },
  {
    id: "00000000-0000-0000-0000-0000000021a3",
    type: "generation_deduct",
    amount: -20,
    balanceAfter: 985,
    jobId: JOB_ID,
    description: "image generation",
    createdAt: "2026-05-01T00:00:03.003Z",
  },
  {
    id: "00000000-0000-0000-0000-0000000021a4",
    type: "generation_refund",
    amount: 20,
    balanceAfter: 1005,
    jobId: JOB_ID,
    description: null,
    createdAt: "2026-05-01T00:00:04.004Z",
  },
  {
    id: "00000000-0000-0000-0000-0000000021a5",
    type: "bonus",
    amount: 2,
    balanceAfter: 1007,
    jobId: null,
    description: "",
    createdAt: "2026-05-01T00:00:05.005Z",
  },
] as const;

/** The newest row of all belongs to the OTHER workspace on purpose. */
const OTHER_TRANSACTION_ID = "00000000-0000-0000-0000-0000000021b1";
const OTHER_TRANSACTION_AT = "2026-05-01T00:00:09.009Z";

/** A second row for a workspace that already has one: the constraint's probe. */
const SUBSCRIPTION_ID = "00000000-0000-0000-0000-0000000021c1";
const SUBSCRIPTION_START = "2026-05-01T00:00:00.000Z";
const SUBSCRIPTION_END = "2026-06-01T00:00:00.000Z";
const SUBSCRIPTION_CANCELED_AT = "2026-05-15T12:30:45.678Z";

let db: PGlite;
let pool: TransactionPool;
let repository: CreditReadRepository;
let workspaceId = "";
let otherWorkspaceId = "";
let emptyWorkspaceId = "";
let pristineWorkspaceId = "";
let snapshotWorkspaceId = "";
let neighbourWorkspaceId = "";
let guttedWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** `timestamptz` rendered as the ISO string the HTTP contract publishes. */
function iso(column: string): string {
  return (
    `to_char(${column} at time zone 'UTC', ` +
    `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`
  );
}

/**
 * The rows as the DATABASE describes them: the same seven columns the repository
 * projects (so the two are compared field by field), with the timestamp in the
 * same ISO shape. It is the independent second opinion — if the repository
 * invented, dropped or reordered a value, this is what disagrees.
 */
const SELECT_TRANSACTION_TRUTH_SQL = `
select
  id::text as id,
  transaction_type::text as transaction_type,
  amount,
  balance_after,
  job_id::text as job_id,
  description,
  ${iso("created_at")}
from public.credit_transactions
where workspace_id = $1::uuid
order by created_at desc
limit $2::int
`;

const SELECT_SUBSCRIPTION_TRUTH_SQL = `
select
  plan::text as plan,
  billing_period::text as billing_period,
  stripe_customer_id,
  stripe_subscription_id,
  ${iso("current_period_start")},
  ${iso("current_period_end")},
  ${iso("canceled_at")}
from public.subscriptions
where workspace_id = $1::uuid
`;

/** Both tables as one comparable value per workspace, for "nothing moved". */
async function snapshot(): Promise<string> {
  return firstRow(
    (
      await db.query<{ rows_text: string }>(
        `select
           (select coalesce(string_agg(t::text, '|' order by t.id), '')
              from public.credit_transactions as t) as rows_text`,
      )
    ).rows,
  ).rows_text;
}

async function subscriptionSnapshot(): Promise<string> {
  return firstRow(
    (
      await db.query<{ rows_text: string }>(
        `select
           (select coalesce(string_agg(s::text, '|' order by s.id), '')
              from public.subscriptions as s) as rows_text`,
      )
    ).rows,
  ).rows_text;
}

const READ_SETTINGS_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type SettingsRow = {
  user_id: string;
  workspace_id: string;
  role: string;
  execution_mode: string;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

const INSERT_TRANSACTION_SQL = `
insert into public.credit_transactions (
  id, workspace_id, user_id, transaction_type, amount, balance_after,
  job_id, description, created_at
) values (
  $1, $2, $3, $4::public.credit_transaction_type, $5, $6, $7, $8, $9
)
`;

const INSERT_SUBSCRIPTION_SQL = `
insert into public.subscriptions (
  id, workspace_id, plan, billing_period, stripe_customer_id,
  stripe_subscription_id, current_period_start, current_period_end, canceled_at
) values (
  $1, $2, $3::public.subscription_plan, $4::public.billing_period, $5, $6, $7, $8, $9
)
`;

/**
 * The subscription row is not INSERTed into a fresh workspace: the
 * `trg_init_workspace_credits` trigger of `20260331200000_credits_system.sql`
 * already creates one (`plan = 'free'`, six NULLs) for every workspace, so the
 * fixture fills THAT row in. A second insert would be a `UNIQUE (workspace_id)`
 * violation, which is the constraint the single-row read rests on.
 */
const UPDATE_SUBSCRIPTION_SQL = `
update public.subscriptions
   set plan = $2::public.subscription_plan,
       billing_period = $3::public.billing_period,
       stripe_customer_id = $4,
       stripe_subscription_id = $5,
       current_period_start = $6,
       current_period_end = $7,
       canceled_at = $8
 where workspace_id = $1::uuid
`;

/**
 * The balance snapshot fixtures: the balance and the plan are UPDATEd rather
 * than inserted, because `trg_init_workspace_credits` already gave every
 * workspace one row of each, and the claim table starts empty.
 */
const UPDATE_BALANCE_SQL = `
update public.credit_balances
   set balance = $2
 where workspace_id = $1::uuid
`;

/**
 * Putting a DELETED balance row back. An `update` cannot do it — it matches no
 * row — so the restore is an upsert, which also covers the case where the row is
 * still there.
 */
const RESTORE_BALANCE_SQL = `
insert into public.credit_balances (workspace_id, balance)
values ($1::uuid, $2)
on conflict (workspace_id) do update set balance = excluded.balance
`;

const UPDATE_PLAN_SQL = `
update public.subscriptions
   set plan = $2::public.subscription_plan
 where workspace_id = $1::uuid
`;

const INSERT_CLAIM_SQL = `
insert into public.daily_credit_claims (workspace_id, claim_date, amount)
values ($1::uuid, $2::date, $3)
`;

const DELETE_CLAIMS_SQL =
  "delete from public.daily_credit_claims where workspace_id = $1::uuid";

const DELETE_BALANCE_SQL =
  "delete from public.credit_balances where workspace_id = $1::uuid";

const DELETE_SUBSCRIPTION_SQL =
  "delete from public.subscriptions where workspace_id = $1::uuid";

/**
 * The balance, the subscription and the claim tables as ONE comparable text, for
 * "the read moved nothing". Independent of the repository: it is the database's
 * own rendering of every row of the three tables the snapshot touches.
 */
async function creditTablesSnapshot(): Promise<string> {
  const row = firstRow(
    (
      await db.query<{ rows_text: string }>(
        `select
           (select coalesce(string_agg(b::text, '|' order by b.id), '')
              from public.credit_balances as b) ||
           (select coalesce(string_agg(s::text, '|' order by s.id), '')
              from public.subscriptions as s) ||
           (select coalesce(string_agg(d::text, '|' order by d.id), '')
              from public.daily_credit_claims as d) as rows_text`,
      )
    ).rows,
  );

  return row.rows_text;
}

/** The database's own answer for one workspace's list, in the repository shape. */
async function transactionTruth(
  workspace: string,
  limit: number,
): Promise<CreditTransactionReadRow[]> {
  return (
    await db.query<CreditTransactionReadRow>(SELECT_TRANSACTION_TRUTH_SQL, [
      workspace,
      limit,
    ])
  ).rows;
}

/**
 * The service under test: the REAL repository over the PGlite pool, and an admin
 * client that throws. Neither migrated read may touch PostgREST, so a fallback
 * would not quietly succeed here — it would fail the case.
 */
function buildService(withoutRepository = false) {
  return createCreditService({
    getAdminClient: () => {
      throw new Error("credit reads must not reach for the admin client");
    },
    ...(withoutRepository ? {} : { creditReadRepository: repository }),
  });
}

/** The service call with its refusal captured instead of thrown. */
async function serviceRefusal(
  call: () => Promise<unknown>,
): Promise<CreditServiceError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(CreditServiceError);
  return error as CreditServiceError;
}

/** The balance snapshot read, over the real repository and real SQL. */
function readSnapshot(
  input: { workspaceId?: string; claimDate?: string } = {},
) {
  return repository.readBalanceSnapshot({
    workspaceId: input.workspaceId ?? pristineWorkspaceId,
    claimDate: input.claimDate ?? CLAIM_DATE,
  });
}

async function personalWorkspaceId(userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `select id
           from public.workspaces
          where owner_user_id = $1
            and type = 'personal'`,
        [userId],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createCreditReadRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "credit-read@hahart.test");
  await createUser(db, OTHER_USER_ID, "credit-read-other@hahart.test");
  await createUser(db, EMPTY_USER_ID, "credit-read-empty@hahart.test");
  await createUser(db, PRISTINE_USER_ID, "credit-read-pristine@hahart.test");
  await createUser(db, SNAPSHOT_USER_ID, "credit-read-snapshot@hahart.test");
  await createUser(db, NEIGHBOUR_USER_ID, "credit-read-neighbour@hahart.test");
  await createUser(db, GUTTED_USER_ID, "credit-read-gutted@hahart.test");
  workspaceId = await personalWorkspaceId(USER_ID);
  otherWorkspaceId = await personalWorkspaceId(OTHER_USER_ID);
  emptyWorkspaceId = await personalWorkspaceId(EMPTY_USER_ID);
  pristineWorkspaceId = await personalWorkspaceId(PRISTINE_USER_ID);
  snapshotWorkspaceId = await personalWorkspaceId(SNAPSHOT_USER_ID);
  neighbourWorkspaceId = await personalWorkspaceId(NEIGHBOUR_USER_ID);
  guttedWorkspaceId = await personalWorkspaceId(GUTTED_USER_ID);

  // `pristineWorkspaceId` is deliberately left exactly as the trigger built it:
  // its `0` / `free` row is the "a new workspace starts here" answer.
  //
  // `guttedWorkspaceId` loses both rows, because the trigger guarantees a
  // workspace HAS them: "no balance row and no subscription row" is only
  // reachable once they are gone.
  await db.query(DELETE_BALANCE_SQL, [guttedWorkspaceId]);
  await db.query(DELETE_SUBSCRIPTION_SQL, [guttedWorkspaceId]);

  // The job one ledger row points at, so `job_id` can carry a real value
  // instead of NULL in the row that populates every column.
  await db.query(
    `insert into public.background_jobs (
       id, workspace_id, queue_name, job_type, status, created_by
     ) values ($1, $2, 'image_generation_jobs', 'image_generation', 'succeeded', $3)`,
    [JOB_ID, workspaceId, USER_ID],
  );

  for (const fixture of TRANSACTION_FIXTURES) {
    await db.query(INSERT_TRANSACTION_SQL, [
      fixture.id,
      workspaceId,
      USER_ID,
      fixture.type,
      fixture.amount,
      fixture.balanceAfter,
      fixture.jobId,
      fixture.description,
      fixture.createdAt,
    ]);
  }

  // The other workspace's single row is NEWER than every row above: a read that
  // filtered after limiting, or limited across workspaces, would show it.
  await db.query(INSERT_TRANSACTION_SQL, [
    OTHER_TRANSACTION_ID,
    otherWorkspaceId,
    OTHER_USER_ID,
    "purchase",
    500,
    500,
    null,
    "credit pack",
    OTHER_TRANSACTION_AT,
  ]);

  // The workspace trigger already created this workspace's `free` row, so the
  // fixture fills it in rather than inserting a second one.
  await db.query(UPDATE_SUBSCRIPTION_SQL, [
    workspaceId,
    "pro",
    "yearly",
    "cus_21k",
    "sub_21k",
    SUBSCRIPTION_START,
    SUBSCRIPTION_END,
    SUBSCRIPTION_CANCELED_AT,
  ]);

  // The second workspace keeps the row the trigger gave it: `plan = 'free'` with
  // every nullable column NULL, so "six nulls" is measured on a REAL row rather
  // than on one this file wrote.

  // The third workspace's row is REMOVED, because the trigger guarantees that a
  // workspace always starts with one: "no subscription row" is only reachable
  // for a workspace whose row is gone (or an unknown workspace id).
  await db.query("delete from public.subscriptions where workspace_id = $1::uuid", [
    emptyWorkspaceId,
  ]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("credit transactions: the rows PostgreSQL hands back", () => {
  it("case 1: limit 3 returns the newest three rows of this workspace, newest first", async () => {
    const rows = await repository.listTransactions({
      workspaceId,
      limit: 3,
    });

    expect(rows.map((row) => row.id)).toEqual([
      TRANSACTION_FIXTURES[4].id,
      TRANSACTION_FIXTURES[3].id,
      TRANSACTION_FIXTURES[2].id,
    ]);
    // The order is the timestamps' order, not the ids' and not insertion order.
    expect(rows.map((row) => row.created_at)).toEqual([
      TRANSACTION_FIXTURES[4].createdAt,
      TRANSACTION_FIXTURES[3].createdAt,
      TRANSACTION_FIXTURES[2].createdAt,
    ]);
  });

  it("case 2: the limit is a limit on THIS workspace's rows only", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 3 });

    // The other workspace's row is the newest in the table; if the predicate
    // were applied after the limit, or dropped, it would be first here.
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id)).not.toContain(OTHER_TRANSACTION_ID);
    expect(rows.map((row) => row.description)).not.toContain("credit pack");

    const other = await repository.listTransactions({
      workspaceId: otherWorkspaceId,
      limit: 100,
    });
    expect(other.map((row) => row.id)).toEqual([OTHER_TRANSACTION_ID]);

    // And a wider limit on this workspace still never crosses over.
    const all = await repository.listTransactions({ workspaceId, limit: 100 });
    expect(all).toHaveLength(TRANSACTION_FIXTURES.length);
    expect(all.map((row) => row.id)).not.toContain(OTHER_TRANSACTION_ID);
  });

  it("case 3: a workspace with no ledger returns an empty list", async () => {
    await expect(
      repository.listTransactions({ workspaceId: emptyWorkspaceId, limit: 20 }),
    ).resolves.toEqual([]);
    // A workspace that does not exist at all answers the same way, and neither
    // is an error.
    await expect(
      repository.listTransactions({
        workspaceId: UNKNOWN_WORKSPACE_ID,
        limit: 20,
      }),
    ).resolves.toEqual([]);
  });

  it("case 4: every one of the seven columns is read from the row, one by one", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 100 });
    const truth = await transactionTruth(workspaceId, 100);

    expect(rows).toEqual(truth);
    expect(rows).toHaveLength(TRANSACTION_FIXTURES.length);

    // Column by column against the database's own projection of the same rows.
    for (const [index, row] of rows.entries()) {
      const expected = truth[index];
      expect(Object.keys(row)).toEqual([...CREDIT_TRANSACTION_COLUMNS]);
      for (const column of CREDIT_TRANSACTION_COLUMNS) {
        expect([column, row[column]]).toEqual([column, expected?.[column]]);
      }
    }

    // And the values themselves, named, so a silently reordered projection
    // cannot pass by matching a row that moved with it.
    const deduct = firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[2].id));
    expect(deduct.transaction_type).toBe("generation_deduct");
    expect(deduct.amount).toBe(-20);
    expect(deduct.balance_after).toBe(985);
    expect(deduct.job_id).toBe(JOB_ID);
    expect(deduct.description).toBe("image generation");
    expect(deduct.created_at).toBe(TRANSACTION_FIXTURES[2].createdAt);

    const grant = firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[0].id));
    expect(grant.transaction_type).toBe("subscription_grant");
    expect(grant.amount).toBe(1000);
    expect(grant.balance_after).toBe(1000);
    expect(grant.job_id).toBeNull();
    expect(grant.description).toBe("pro plan monthly grant");
  });

  it("case 5: a negative amount and a zero-crossing balance are values, not drift", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 100 });

    for (const row of rows) {
      expect(Number.isInteger(row.amount)).toBe(true);
      expect(Number.isInteger(row.balance_after)).toBe(true);
    }
    // The ledger's whole point: a deduction is stored negative.
    expect(firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[2].id)).amount).toBeLessThan(0);
  });

  it("case 6: a NULL job_id or description is null, and an empty description is a value", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 100 });

    const refund = firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[3].id));
    expect(refund.description).toBeNull();
    expect(refund.job_id).toBe(JOB_ID);

    const grant = firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[0].id));
    expect(grant.job_id).toBeNull();

    // An empty string is stored text, not an absence: it survives as "".
    const bonus = firstRow(rows.filter((row) => row.id === TRANSACTION_FIXTURES[4].id));
    expect(bonus.description).toBe("");
    expect(bonus.description).not.toBeNull();
  });

  it("case 7: created_at is an ISO string whose instant is the database's", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 100 });

    for (const row of rows) {
      expect(typeof row.created_at).toBe("string");
      expect(row.created_at).not.toBeInstanceOf(Date);
      expect(new Date(row.created_at).getTime()).toBe(
        Date.parse(row.created_at),
      );
    }
    expect(rows.map((row) => row.created_at)).toEqual(
      [...TRANSACTION_FIXTURES].reverse().map((fixture) => fixture.createdAt),
    );
  });

  it("case 8: every row parses as the published credit transaction schema", async () => {
    const rows = await repository.listTransactions({ workspaceId, limit: 100 });

    for (const row of rows) {
      // The functional requirement, not a nicety: `created_at` is `z.string()`,
      // so a `Date` straight from the driver would fail this parse and turn a
      // working read into a 500 at the HTTP boundary.
      expect(creditTransactionSchema.safeParse(row).success).toBe(true);
      expect(creditTransactionSchema.parse(row)).toEqual(row);
    }

    // The control: the very value the driver hands back for the same column is
    // REFUSED by that schema, which is why the normalisation has to happen here.
    const raw = firstRow(rows);
    expect(
      creditTransactionSchema.safeParse({
        ...raw,
        created_at: new Date(raw.created_at),
      }).success,
    ).toBe(false);

    // And the response wrapper the route actually parses accepts the list.
    expect(
      creditTransactionsResponseSchema.safeParse({ transactions: rows }).success,
    ).toBe(true);
  });
});

describe("credit subscription: the row PostgreSQL hands back", () => {
  it("case 9: the workspace's own row is mapped column by column", async () => {
    const row = await repository.readSubscription({ workspaceId });

    const truth = firstRow(
      (
        await db.query<SubscriptionReadRow>(SELECT_SUBSCRIPTION_TRUTH_SQL, [
          workspaceId,
        ])
      ).rows,
    );
    expect(row).toEqual(truth);
    expect(Object.keys(row ?? {})).toEqual([...SUBSCRIPTION_COLUMNS]);
    expect(row).toEqual({
      plan: "pro",
      billing_period: "yearly",
      stripe_customer_id: "cus_21k",
      stripe_subscription_id: "sub_21k",
      current_period_start: SUBSCRIPTION_START,
      current_period_end: SUBSCRIPTION_END,
      canceled_at: SUBSCRIPTION_CANCELED_AT,
    } satisfies SubscriptionReadRow);
  });

  it("case 10: the three nullable timestamps are ISO strings when they hold a value", async () => {
    const row = await repository.readSubscription({ workspaceId });

    for (const [column, expected] of [
      ["current_period_start", SUBSCRIPTION_START],
      ["current_period_end", SUBSCRIPTION_END],
      ["canceled_at", SUBSCRIPTION_CANCELED_AT],
    ] as const) {
      const value = row?.[column];
      expect(typeof value).toBe("string");
      expect(value).toBe(expected);
      expect(new Date(value as string).getTime()).toBe(Date.parse(expected));
    }
  });

  it("case 11: the same three timestamps are null when SQL says NULL", async () => {
    const row = await repository.readSubscription({
      workspaceId: otherWorkspaceId,
    });

    // `plan` is NOT NULL with a `free` default, so it is a value even here — and
    // this row was written by the workspace trigger, not by this test file.
    expect(row?.plan).toBe("free");
    expect(row?.billing_period).toBeNull();
    expect(row?.stripe_customer_id).toBeNull();
    expect(row?.stripe_subscription_id).toBeNull();
    expect(row?.current_period_start).toBeNull();
    expect(row?.current_period_end).toBeNull();
    expect(row?.canceled_at).toBeNull();
  });

  it("case 12: a workspace with no subscription row is null, not defaults", async () => {
    await expect(
      repository.readSubscription({ workspaceId: emptyWorkspaceId }),
    ).resolves.toBeNull();
    await expect(
      repository.readSubscription({ workspaceId: UNKNOWN_WORKSPACE_ID }),
    ).resolves.toBeNull();
  });

  it("case 13: `UNIQUE (workspace_id)` is what makes the read single-row", async () => {
    // The database refuses the second row, so "more than one row" cannot be
    // produced by the data — the repository's own refusal covers the case the
    // constraint is supposed to make impossible.
    await expect(
      db.query(INSERT_SUBSCRIPTION_SQL, [
        SUBSCRIPTION_ID,
        workspaceId,
        "ultra",
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    ).rejects.toThrow(/duplicate key|unique/i);

    const rows = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.subscriptions where workspace_id = $1::uuid",
        [workspaceId],
      )
    ).rows;
    expect(firstRow(rows).n).toBe(1);

    // The constraint is not the only reason a workspace can be relied on to have
    // a row: `trg_init_workspace_credits` creates one for every workspace the
    // moment it is inserted, which is why case 12 had to DELETE the third
    // workspace's row to reach the "no row" answer at all.
    const created = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.subscriptions where workspace_id = $1::uuid",
        [otherWorkspaceId],
      )
    ).rows;
    expect(firstRow(created).n).toBe(1);
  });
});

describe("credit reads: they roll back, leave nothing behind and move nothing", () => {
  it("case 14: a malformed uuid is a real SQL error, and the pool stays usable", async () => {
    const beforeTransactions = await snapshot();
    const beforeSubscriptions = await subscriptionSnapshot();

    // Independent of the repository: the server itself rejects the bind, for
    // both statements.
    await expect(
      db.query(SELECT_TRANSACTION_TRUTH_SQL, [INVALID_ID, 3]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
    await expect(
      db.query(SELECT_SUBSCRIPTION_TRUTH_SQL, [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const listError = await repository
      .listTransactions({ workspaceId: INVALID_ID, limit: 3 })
      .catch((reason: unknown) => reason);

    expect(listError).toBeInstanceOf(CreditReadError);
    const readError = listError as CreditReadError;
    expect(readError.operation).toBe(LIST_TRANSACTIONS);
    // The fixed message carries no SQL, no host, no workspace id and no
    // existence answer; the cause is the PostgreSQL parse failure.
    expect(readError.message).toBe(`credit read failed (${LIST_TRANSACTIONS})`);
    expect(readError.message).not.toMatch(
      /public\.|credit_transactions|invalid input|postgres:\/\//i,
    );
    expect((readError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    const subscriptionError = await repository
      .readSubscription({ workspaceId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(subscriptionError).toBeInstanceOf(CreditReadError);
    expect((subscriptionError as CreditReadError).operation).toBe(
      READ_SUBSCRIPTION,
    );
    expect((subscriptionError as CreditReadError).message).toBe(
      `credit read failed (${READ_SUBSCRIPTION})`,
    );

    // Neither failed transaction moved anything, and the very same pool answers.
    expect(await snapshot()).toBe(beforeTransactions);
    expect(await subscriptionSnapshot()).toBe(beforeSubscriptions);

    const rows = await repository.listTransactions({ workspaceId, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(firstRow(rows).id).toBe(TRANSACTION_FIXTURES[4].id);
    await expect(
      repository.readSubscription({ workspaceId }),
    ).resolves.toMatchObject({ plan: "pro" });
  });

  it("case 15: neither read changes a row", async () => {
    const beforeTransactions = await snapshot();
    const beforeSubscriptions = await subscriptionSnapshot();

    await repository.listTransactions({ workspaceId, limit: 100 });
    await repository.listTransactions({ workspaceId: otherWorkspaceId, limit: 100 });
    await repository.readSubscription({ workspaceId });
    await repository.readSubscription({ workspaceId: otherWorkspaceId });

    // The whole tables as `::text`, before and after: no timestamp moved, no
    // counter was touched, no column was rewritten by the read.
    expect(await snapshot()).toBe(beforeTransactions);
    expect(await subscriptionSnapshot()).toBe(beforeSubscriptions);
  });

  it("case 16: the reads' transaction context is privileged, empty, and does not leak", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of
    // the transaction the statement ran in, not a reconstruction.
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (
              sql.includes("public.credit_transactions") ||
              sql.includes("public.subscriptions")
            ) {
              observed.push(firstRow((await inner.query(READ_SETTINGS_SQL)).rows) as SettingsRow);
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createCreditReadRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.listTransactions({ workspaceId, limit: 2 }),
    ).resolves.toHaveLength(2);
    await expect(
      observing.readSubscription({ workspaceId }),
    ).resolves.not.toBeNull();

    expect(observed).toHaveLength(2);
    // No forged user: this is a system read, so every actor setting is empty and
    // the mode is the explicit privileged label.
    for (const settings of observed) {
      expect(settings).toEqual({
        user_id: "",
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone, so the
    // context of one read cannot become the context of the next statement.
    const gone = firstRow(
      (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows,
    );
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

describe("credit reads: through the real CreditService", () => {
  it("case 17: the transaction list reaches the caller as the HTTP contract's rows", async () => {
    const service = buildService();

    const transactions = await service.getTransactions(workspaceId, 3);

    expect(transactions).toHaveLength(3);
    // The route's own parse, on rows that came through the repository and the
    // service: this is the whole chain the ticket moves.
    expect(
      creditTransactionsResponseSchema.parse({ transactions }),
    ).toEqual({ transactions });
    expect(transactions.map((row) => row.created_at)).toEqual([
      TRANSACTION_FIXTURES[4].createdAt,
      TRANSACTION_FIXTURES[3].createdAt,
      TRANSACTION_FIXTURES[2].createdAt,
    ]);
  });

  it("case 18: the service's subscription mapping and defaults over real rows", async () => {
    const service = buildService();

    await expect(service.getSubscription(workspaceId)).resolves.toEqual({
      plan: "pro",
      billingPeriod: "yearly",
      stripeCustomerId: "cus_21k",
      stripeSubscriptionId: "sub_21k",
      currentPeriodStart: SUBSCRIPTION_START,
      currentPeriodEnd: SUBSCRIPTION_END,
      canceledAt: SUBSCRIPTION_CANCELED_AT,
    });

    // A row exists for this workspace, and its six nullable columns are NULL:
    // the answer is the same six nulls, with the row's own plan.
    await expect(
      service.getSubscription(otherWorkspaceId),
    ).resolves.toEqual({
      plan: "free",
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    });

    // No row at all: the free default, still six nulls.
    await expect(service.getSubscription(emptyWorkspaceId)).resolves.toEqual({
      plan: "free",
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    });
  });

  it("case 19: with no repository wired the service fails closed, even where the rows exist", async () => {
    const service = buildService(true);

    const listError = await serviceRefusal(() =>
      service.getTransactions(workspaceId, 3),
    );
    expect(listError.code).toBe("credit_query_failed");
    expect(listError.statusCode).toBe(500);
    expect(listError.message).toBe("Failed to query transactions.");

    const subscriptionError = await serviceRefusal(() =>
      service.getSubscription(workspaceId),
    );
    expect(subscriptionError.code).toBe("credit_query_failed");
    expect(subscriptionError.statusCode).toBe(500);
    expect(subscriptionError.message).toBe("Failed to query subscription.");

    // The rows are really there — the refusal is the missing dependency, not an
    // empty workspace, and nothing fell back to the admin client (whose stub
    // would have thrown a different error).
    await expect(
      repository.listTransactions({ workspaceId, limit: 1 }),
    ).resolves.toHaveLength(1);
    await expect(
      repository.readSubscription({ workspaceId }),
    ).resolves.not.toBeNull();
  });

  it("case 20: neither migrated read touches the admin client on either path", async () => {
    // The stub throws on contact, so the success and failure assertions below
    // can only pass while both reads stay off PostgREST entirely.
    const service = buildService();

    await expect(service.getTransactions(workspaceId, 1)).resolves.toHaveLength(1);
    await expect(service.getSubscription(workspaceId)).resolves.toMatchObject({
      plan: "pro",
    });
    await expect(
      serviceRefusal(() => service.getTransactions(INVALID_ID, 1)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    await expect(
      serviceRefusal(() => service.getSubscription(INVALID_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
  });
});

describe("credit balance snapshot: the row PostgreSQL answers", () => {
  it("case 21: a workspace the trigger just built reads 0, free and no claim of the day", async () => {
    const row = await readSnapshot({ workspaceId: pristineWorkspaceId });

    // `trg_init_workspace_credits` creates BOTH rows for every new workspace
    // (T-48), so "the defaults" are measured on rows this file never wrote.
    expect(row).toEqual({ balance: 0, plan: "free", daily_claimed: false });
    expect(Object.keys(row)).toEqual([...BALANCE_SNAPSHOT_COLUMNS]);

    // The same three answers with a date the workspace has no row for at all.
    await expect(
      readSnapshot({ workspaceId: pristineWorkspaceId, claimDate: PREVIOUS_CLAIM_DATE }),
    ).resolves.toEqual({
      balance: 0,
      plan: "free",
      daily_claimed: false,
    });
  });

  it("case 22: the balance and the plan are THIS workspace's own rows", async () => {
    await db.query(UPDATE_BALANCE_SQL, [snapshotWorkspaceId, 42]);
    await db.query(UPDATE_PLAN_SQL, [snapshotWorkspaceId, "pro"]);
    await db.query(UPDATE_BALANCE_SQL, [neighbourWorkspaceId, 7]);
    await db.query(UPDATE_PLAN_SQL, [neighbourWorkspaceId, "ultra"]);

    await expect(readSnapshot({ workspaceId: snapshotWorkspaceId })).resolves.toEqual({
      balance: 42,
      plan: "pro",
      daily_claimed: false,
    });
    await expect(readSnapshot({ workspaceId: neighbourWorkspaceId })).resolves.toEqual({
      balance: 7,
      plan: "ultra",
      daily_claimed: false,
    });
    // A third workspace keeps the trigger's row while the other two moved: the
    // predicate is the workspace id, not "any row of the table".
    await expect(readSnapshot({ workspaceId: pristineWorkspaceId })).resolves.toEqual({
      balance: 0,
      plan: "free",
      daily_claimed: false,
    });
  });

  it("case 23: a claim in ANOTHER workspace is not this workspace's claim", async () => {
    await db.query(DELETE_CLAIMS_SQL, [snapshotWorkspaceId]);
    await db.query(DELETE_CLAIMS_SQL, [neighbourWorkspaceId]);
    await db.query(INSERT_CLAIM_SQL, [neighbourWorkspaceId, CLAIM_DATE, 5]);

    // The neighbour has the row; the subject does not.
    await expect(readSnapshot({ workspaceId: snapshotWorkspaceId })).resolves.toMatchObject(
      { daily_claimed: false },
    );
    await expect(readSnapshot({ workspaceId: neighbourWorkspaceId })).resolves.toMatchObject(
      { daily_claimed: true },
    );

    // And now the other way round, so neither answer can come from a
    // table-wide "does anyone hold this date" question.
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, CLAIM_DATE, 3]);
    await db.query(DELETE_CLAIMS_SQL, [neighbourWorkspaceId]);

    await expect(readSnapshot({ workspaceId: snapshotWorkspaceId })).resolves.toMatchObject(
      { daily_claimed: true },
    );
    await expect(readSnapshot({ workspaceId: neighbourWorkspaceId })).resolves.toMatchObject(
      { daily_claimed: false },
    );
  });

  it("case 24: a claim on the PREVIOUS day is not the claim of the asked day", async () => {
    await db.query(DELETE_CLAIMS_SQL, [snapshotWorkspaceId]);
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, PREVIOUS_CLAIM_DATE, 5]);

    // The row is really there — reading the day it belongs to proves it — while
    // the asked day must still answer false.
    await expect(
      readSnapshot({ workspaceId: snapshotWorkspaceId, claimDate: CLAIM_DATE }),
    ).resolves.toMatchObject({ daily_claimed: false });
    await expect(
      readSnapshot({
        workspaceId: snapshotWorkspaceId,
        claimDate: PREVIOUS_CLAIM_DATE,
      }),
    ).resolves.toMatchObject({ daily_claimed: true });

    // And with the asked day claimed as well, the two days answer differently
    // from the very same table.
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, CLAIM_DATE, 3]);

    await expect(
      readSnapshot({ workspaceId: snapshotWorkspaceId, claimDate: CLAIM_DATE }),
    ).resolves.toMatchObject({ daily_claimed: true, balance: 42, plan: "pro" });
    await expect(
      readSnapshot({
        workspaceId: snapshotWorkspaceId,
        claimDate: UNRELATED_CLAIM_DATE,
      }),
    ).resolves.toMatchObject({ daily_claimed: false });
  });

  it("case 25: a missing balance row and a missing subscription row are null, not defaults", async () => {
    const row = await readSnapshot({ workspaceId: guttedWorkspaceId });

    // Both rows were deleted in `beforeAll`: the read answers `null` for the two
    // columns rather than inventing the schema defaults, and `exists` — which has
    // no row to find either — still answers a boolean.
    expect(row).toEqual({ balance: null, plan: null, daily_claimed: false });
    expect(Object.keys(row)).toEqual([...BALANCE_SNAPSHOT_COLUMNS]);
  });

  it("case 26: a workspace that does not exist answers the same single all-absent row", async () => {
    // The statement has no `from` clause of its own, so "no such workspace" is
    // not zero rows: it is one row of three absent answers.
    const rows = (
      await db.query(
        `select
           (select b.balance
              from public.credit_balances b
             where b.workspace_id = $1::uuid) as balance,
           (select s.plan
              from public.subscriptions s
             where s.workspace_id = $1::uuid) as plan,
           exists (select 1
                     from public.daily_credit_claims d
                    where d.workspace_id = $1::uuid
                      and d.claim_date = $2::date) as daily_claimed`,
        [UNKNOWN_WORKSPACE_ID, CLAIM_DATE],
      )
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      balance: null,
      plan: null,
      daily_claimed: false,
    });
    await expect(
      readSnapshot({ workspaceId: UNKNOWN_WORKSPACE_ID }),
    ).resolves.toEqual(rows[0]);
  });

  it("case 27: a malformed uuid is a real SQL error, rolls back, and the pool stays usable", async () => {
    const before = await creditTablesSnapshot();

    // Independent of the repository: the server itself refuses the bind.
    await expect(db.query("select $1::uuid as workspace_id", [INVALID_ID])).rejects.toThrow(
      /invalid input syntax for type uuid/,
    );

    const error = await readSnapshot({ workspaceId: INVALID_ID }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CreditReadError);
    const readError = error as CreditReadError;
    expect(readError.operation).toBe(READ_BALANCE_SNAPSHOT);
    // The fixed message carries no SQL, no host, no workspace id and no
    // existence answer; the cause is the PostgreSQL parse failure.
    expect(readError.message).toBe(
      `credit read failed (${READ_BALANCE_SNAPSHOT})`,
    );
    expect(readError.message).not.toMatch(
      /public\.|credit_balances|invalid input|postgres:\/\//i,
    );
    expect((readError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // The failed transaction moved nothing, and the very same pool answers.
    expect(await creditTablesSnapshot()).toBe(before);
    await expect(readSnapshot({ workspaceId: snapshotWorkspaceId })).resolves.toMatchObject(
      { balance: 42, plan: "pro" },
    );
  });

  it("case 28: the read is privileged, carries no actor, and its context does not leak", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction that statement ran in, not a reconstruction.
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.credit_balances")) {
              observed.push(
                firstRow((await inner.query(READ_SETTINGS_SQL)).rows) as SettingsRow,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createCreditReadRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.readBalanceSnapshot({
        workspaceId: pristineWorkspaceId,
        claimDate: CLAIM_DATE,
      }),
    ).resolves.toEqual({ balance: 0, plan: "free", daily_claimed: false });

    expect(observed).toHaveLength(1);
    // No forged user: this is a system read on behalf of an already-authorised
    // caller, so every actor setting is empty and the mode is explicit.
    expect(observed[0]).toEqual({
      user_id: "",
      workspace_id: "",
      role: "",
      execution_mode: "privileged",
    });

    // And immediately after COMMIT the same four settings are gone, so the
    // context of one read cannot become the context of the next statement.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });

  it("case 29: the read changes no row of any of the three tables", async () => {
    const before = await creditTablesSnapshot();

    await readSnapshot({ workspaceId: snapshotWorkspaceId });
    await readSnapshot({ workspaceId: neighbourWorkspaceId });
    await readSnapshot({ workspaceId: pristineWorkspaceId, claimDate: PREVIOUS_CLAIM_DATE });
    await readSnapshot({ workspaceId: guttedWorkspaceId });

    // Every row of all three tables as `::text`, before and after: no balance
    // moved, no plan moved, no claim and no `updated_at` was touched.
    expect(await creditTablesSnapshot()).toBe(before);
  });
});

describe("credit balance snapshot: through the real CreditService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("case 30: getBalance over the real statement and a frozen UTC clock", async () => {
    await db.query(UPDATE_BALANCE_SQL, [snapshotWorkspaceId, 42]);
    await db.query(UPDATE_PLAN_SQL, [snapshotWorkspaceId, "pro"]);
    await db.query(DELETE_CLAIMS_SQL, [snapshotWorkspaceId]);
    // The claim belongs to the 17th; the frozen instant is 23:30 on the 16th at
    // UTC-8, which IS the 17th in UTC. Only the JS UTC date can find this row.
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, CLAIM_DATE, 5]);

    // Only `Date` is faked: PGlite keeps its real timers, so the database is not
    // affected by the clock this test pins.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));

    const service = buildService();

    expect(new Date().toISOString()).toBe("2026-10-17T07:30:00.000Z");
    await expect(service.getBalance(snapshotWorkspaceId)).resolves.toEqual({
      balance: 42,
      plan: "pro",
      dailyClaimed: true,
    });
    // A workspace with no claim of that day answers false through the same path.
    await expect(service.getBalance(pristineWorkspaceId)).resolves.toEqual({
      balance: 0,
      plan: "free",
      dailyClaimed: false,
    });
  });

  it("case 31: a claim on the previous day answers false through the service", async () => {
    await db.query(DELETE_CLAIMS_SQL, [snapshotWorkspaceId]);
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, PREVIOUS_CLAIM_DATE, 5]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));

    const service = buildService();

    const row = await service.getBalance(snapshotWorkspaceId);

    expect(row).toEqual({ balance: 42, plan: "pro", dailyClaimed: false });
    // The 16th's row exists — the 17th simply is not the 16th.
    const claims = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.daily_credit_claims where workspace_id = $1::uuid",
        [snapshotWorkspaceId],
      )
    ).rows;
    expect(firstRow(claims).n).toBe(1);
  });

  it("case 32: a deleted balance row still answers 0 while the claim stays true", async () => {
    await db.query(DELETE_CLAIMS_SQL, [snapshotWorkspaceId]);
    await db.query(INSERT_CLAIM_SQL, [snapshotWorkspaceId, CLAIM_DATE, 3]);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));

    const service = buildService();

    // The claim is a row of its OWN table, so removing the balance must not take
    // the other two answers with it: 0 is the default, `true` is a real claim.
    await db.query(DELETE_BALANCE_SQL, [snapshotWorkspaceId]);

    await expect(service.getBalance(snapshotWorkspaceId)).resolves.toEqual({
      balance: 0,
      plan: "pro",
      dailyClaimed: true,
    });

    // Put the balance back for the cases that follow. An update cannot restore a
    // row that is gone, so this is an upsert.
    await db.query(RESTORE_BALANCE_SQL, [snapshotWorkspaceId, 42]);
  });

  it("case 33: an unknown workspace answers 0, free and false rather than failing", async () => {
    const service = buildService();

    await expect(service.getBalance(UNKNOWN_WORKSPACE_ID)).resolves.toEqual({
      balance: 0,
      plan: "free",
      dailyClaimed: false,
    });
    // The same answer the workspace whose rows were deleted gives: through the
    // service the two are indistinguishable, exactly as they were before.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));
    await expect(service.getBalance(guttedWorkspaceId)).resolves.toEqual({
      balance: 0,
      plan: "free",
      dailyClaimed: false,
    });
  });

  it("case 34: with no repository wired the balance read fails closed too", async () => {
    const service = buildService(true);

    const error = await serviceRefusal(() =>
      service.getBalance(snapshotWorkspaceId),
    );

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query credit balance.");

    // The rows really are there — the refusal is the missing dependency, not a
    // workspace without a balance, and nothing fell back to the admin client
    // (whose stub would have thrown a different error).
    await expect(readSnapshot({ workspaceId: snapshotWorkspaceId })).resolves.toMatchObject(
      { balance: 42, plan: "pro" },
    );
  });

  it("case 35: a malformed uuid is the same 500 through the service", async () => {
    const service = buildService();

    const error = await serviceRefusal(() => service.getBalance(INVALID_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query credit balance.");
    // The driver's own message never reaches the response.
    expect(error.message).not.toMatch(/uuid|invalid input|public\./i);
  });
});
