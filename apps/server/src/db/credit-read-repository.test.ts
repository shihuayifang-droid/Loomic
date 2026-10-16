import { describe, expect, it } from "vitest";

import {
  BALANCE_SNAPSHOT_COLUMNS,
  CREDIT_TRANSACTION_COLUMNS,
  CREDIT_TRANSACTION_LIMIT_MAX,
  CREDIT_TRANSACTION_LIMIT_MIN,
  CreditReadError,
  LIST_TRANSACTIONS,
  READ_BALANCE_SNAPSHOT,
  READ_SUBSCRIPTION,
  SUBSCRIPTION_COLUMNS,
  createCreditReadRepository,
  type BalanceSnapshotReadRow,
  type CreditReadRepository,
  type CreditTransactionReadRow,
  type SubscriptionReadRow,
} from "./credit-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the three statements
 * the repository can issue, the actor context they carry (none), the columns
 * they project, the bind parameters of the list read and of the balance
 * snapshot, and how every way those statements can answer is classified.
 *
 * The unit tests prove WHICH statements are built — one SELECT each, one table
 * each, no batch, `limit` bound and never concatenated, the claim date bound as
 * `$2::date` and never as `current_date`. The PGlite file beside them
 * (`test-support/db/credit-read-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes them against the real tables, that a malformed
 * uuid rolls back and leaves the pool usable, and that none of the three reads
 * moves a row.
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000021b1";
const OTHER_WORKSPACE_ID = "00000000-0000-0000-0000-0000000021b2";
const TRANSACTION_ID = "00000000-0000-0000-0000-0000000021c1";
const JOB_ID = "00000000-0000-0000-0000-0000000021c2";

/** A limit that cannot appear inside either statement by coincidence. */
const LIMIT = 37;

/** The day the snapshot is asked about, and a day it must not answer for. */
const CLAIM_DATE = "2026-10-17";
const OTHER_CLAIM_DATE = "2026-10-16";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (sql === TRANSACTION_STATEMENTS.setLocalSetting) return { rows: [] };
      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;
        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

/**
 * The repository's own statements, and only them: BEGIN/COMMIT/set_config carry
 * no schema-qualified name, so anything naming `public.` is a domain statement.
 * A second one would mean a read was split (a probe first, then the rows).
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statementText(queries: readonly QueryRecord[]): string {
  return domainCalls(queries)[0]?.sql ?? "";
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);
  const pairs: unknown[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]]);
  }
  return pairs;
}

/** The select list, as written in the statement, in order. */
function selectList(sql: string): string[] {
  const body = /select([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? "";
  return body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function repositoryFor(harness: Harness): CreditReadRepository {
  return createCreditReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/**
 * The shape of a transaction row as the statement answers it: `pg` hands
 * `timestamptz` back as a `Date`, the enum as its text and `integer` as a
 * number. Every one of the seven columns is present, so a case that wants drift
 * removes exactly one thing.
 */
function transactionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TRANSACTION_ID,
    transaction_type: "generation_deduct",
    amount: -12,
    balance_after: 88,
    job_id: JOB_ID,
    description: "image generation",
    created_at: new Date("2026-04-05T06:07:08.901Z"),
    ...overrides,
  };
}

/** The same row with both nullable text columns an explicit SQL NULL. */
function nullTransactionRow(): Record<string, unknown> {
  return transactionRow({ job_id: null, description: null });
}

function subscriptionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    plan: "pro",
    billing_period: "monthly",
    stripe_customer_id: "cus_21k",
    stripe_subscription_id: "sub_21k",
    current_period_start: new Date("2026-04-01T00:00:00.000Z"),
    current_period_end: new Date("2026-05-01T00:00:00.000Z"),
    canceled_at: new Date("2026-04-15T12:30:45.678Z"),
    ...overrides,
  };
}

/**
 * The same row with the five nullable columns an explicit SQL NULL and the
 * plan at its schema default, which is the shape a workspace's row has before
 * anything fills it in.
 */
function nullSubscriptionRow(): Record<string, unknown> {
  return subscriptionRow({
    plan: "free",
    billing_period: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_start: null,
    current_period_end: null,
    canceled_at: null,
  });
}

function removeColumn(
  row: Record<string, unknown>,
  column: string,
): Record<string, unknown> {
  const copy = { ...row };
  delete copy[column];
  return copy;
}

function list(
  repository: CreditReadRepository,
  input: { workspaceId?: unknown; limit?: unknown } = {},
) {
  // `in` rather than `??`: an EXPLICIT `undefined` is one of the refused
  // arguments, so it must not be replaced by the default here.
  return repository.listTransactions({
    workspaceId: ("workspaceId" in input
      ? input.workspaceId
      : WORKSPACE_ID) as string,
    limit: ("limit" in input ? input.limit : LIMIT) as number,
  });
}

function subscription(
  repository: CreditReadRepository,
  input: { workspaceId?: unknown } = {},
) {
  // `in` rather than `??`: an EXPLICIT `undefined` is one of the refused
  // arguments, so it must not be replaced by the default here.
  return repository.readSubscription({
    workspaceId: ("workspaceId" in input
      ? input.workspaceId
      : WORKSPACE_ID) as string,
  });
}

function requireRow<T>(row: T | null): T {
  if (row === null) throw new Error("expected a row, got null");
  return row;
}

/**
 * The one row the balance snapshot answers, in the shape the statement produces
 * it: `integer` for the balance, the plan enum as its text and a real boolean
 * from `exists`.
 */
function balanceSnapshotRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { balance: 42, plan: "pro", daily_claimed: true, ...overrides };
}

/**
 * The same row for a workspace with neither a balance row nor a subscription
 * row: the two columns are explicit SQL NULLs and `exists` still answers false.
 */
function absentBalanceSnapshotRow(): Record<string, unknown> {
  return balanceSnapshotRow({ balance: null, plan: null, daily_claimed: false });
}

function snapshot(
  repository: CreditReadRepository,
  input: { workspaceId?: unknown; claimDate?: unknown } = {},
) {
  // `in` rather than `??`: an EXPLICIT `undefined` is one of the refused
  // arguments, so it must not be replaced by the default here.
  return repository.readBalanceSnapshot({
    workspaceId: ("workspaceId" in input
      ? input.workspaceId
      : WORKSPACE_ID) as string,
    claimDate: ("claimDate" in input ? input.claimDate : CLAIM_DATE) as string,
  });
}

/** The statement with every run of whitespace collapsed, for shape assertions. */
function normalized(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("credit-read-repository: the statements it issues", () => {
  it("case 1: listTransactions reads inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [transactionRow()]);

    await list(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no probe read, no count, no second table.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // What this case owns is the SHAPE, not the statement count. Whether the
    // four transaction settings arrive batched or one by one is
    // `transaction.ts`'s business and is asserted by its own test; pinning the
    // count here would pin this suite to whichever form is checked out.
    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
    // Classified by exclusion, not by name: whatever is not the transaction's
    // own BEGIN/COMMIT/`set_config` is the repository's statement, and there is
    // exactly one of them.
    const domainStatements = statements.filter(
      (sql) => !isTransactionStatement(sql),
    );
    expect(domainStatements).toHaveLength(1);
    expect(domainStatements).toEqual([statementText(harness.queries)]);

    const selectIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    // Between BEGIN and the read there is context and nothing else.
    const beforeSelect = statements.slice(1, selectIndex);
    expect(beforeSelect).toContain(TRANSACTION_STATEMENTS.setLocalSetting);
    expect(
      beforeSelect.every((sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting),
    ).toBe(true);
    // The read is the last thing inside the transaction: COMMIT follows it
    // immediately, with no statement in between.
    expect(statements[selectIndex + 1]).toBe(TRANSACTION_STATEMENTS.commit);

    // A system read has no acting user. Every actor setting stays empty —
    // forging one from the caller would put a person on an audit trail they had
    // nothing to do with — and the mode is the explicit privileged one.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ""],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds the workspace id and the limit as parameters, never as statement text", async () => {
    const harness = createHarness(() => [transactionRow()]);

    await list(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([WORKSPACE_ID, LIMIT]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("limit $2::int");
    // The limit is a BIND PARAMETER: neither value appears in the statement.
    expect(statement?.sql).not.toContain(WORKSPACE_ID);
    expect(statement?.sql).not.toContain(String(LIMIT));
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: one table, one workspace predicate, newest first, and not a batch", async () => {
    const harness = createHarness(() => [transactionRow()]);

    await list(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toMatch(/from public\.credit_transactions/);
    expect(sql.replace(/\s+/g, " ").trim()).toMatch(
      /where workspace_id = \$1::uuid order by created_at desc limit \$2::int$/,
    );
    // Exactly one table is reachable, and no other predicate narrows or widens
    // the read: no status, no user, no id, no offset.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.credit_transactions"]);
    expect(sql).not.toMatch(/\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/join/i);
    // No tie-break was invented: the read it replaces had none either.
    expect(sql.replace(/\s+/g, " ")).not.toMatch(/order by created_at desc, /);
  });

  it("case 4: the projection is exactly the seven published columns, in order", async () => {
    const harness = createHarness(() => [transactionRow()]);

    await list(repositoryFor(harness));

    const columns = selectList(statementText(harness.queries));

    // Two lists, one truth: the statement and the module's exported list. A
    // column added to one and not the other is the drift this refuses.
    expect(columns).toHaveLength(7);
    expect(columns).toEqual([...CREDIT_TRANSACTION_COLUMNS]);
    expect(columns).toEqual([
      "id",
      "transaction_type",
      "amount",
      "balance_after",
      "job_id",
      "description",
      "created_at",
    ]);
  });

  it("case 5: readSubscription issues one privileged statement with one bind parameter", async () => {
    const harness = createHarness(() => [subscriptionRow()]);

    await subscription(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([WORKSPACE_ID]);
    const sql = statementText(harness.queries);
    expect(sql).toMatch(/from public\.subscriptions/);
    expect(sql).toMatch(/where workspace_id = \$1::uuid/);
    expect(sql).not.toContain(WORKSPACE_ID);
    // `UNIQUE (workspace_id)` is the rule, so there is no ordering and no limit
    // to widen the read with.
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.subscriptions"]);

    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ""],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 6: the subscription projection is exactly the seven mapped columns, in order", async () => {
    const harness = createHarness(() => [subscriptionRow()]);

    await subscription(repositoryFor(harness));

    const columns = selectList(statementText(harness.queries));

    expect(columns).toHaveLength(7);
    expect(columns).toEqual([...SUBSCRIPTION_COLUMNS]);
    expect(columns).toEqual([
      "plan",
      "billing_period",
      "stripe_customer_id",
      "stripe_subscription_id",
      "current_period_start",
      "current_period_end",
      "canceled_at",
    ]);
  });

  it("case 7: the repository exposes three reads and nothing else", () => {
    const harness = createHarness(() => [transactionRow()]);
    const repository = repositoryFor(harness);

    // There is no access token, no table name and no generic filter entry point
    // a caller could widen any read with.
    expect(Object.keys(repository)).toEqual([
      LIST_TRANSACTIONS,
      READ_SUBSCRIPTION,
      READ_BALANCE_SNAPSHOT,
    ]);
    expect(repository.listTransactions).toHaveLength(1);
    expect(repository.readSubscription).toHaveLength(1);
    // One argument object: the snapshot cannot be asked for without the date it
    // is about, and the date travels in the same call as the workspace.
    expect(repository.readBalanceSnapshot).toHaveLength(1);
  });
});

describe("credit-read-repository: the rows it maps", () => {
  it("case 8: every one of the seven transaction columns is reported, keys in column order", async () => {
    const harness = createHarness(() => [transactionRow()]);

    const rows = await list(repositoryFor(harness));
    const row = requireRow(rows[0] ?? null);

    expect(Object.keys(row)).toEqual([...CREDIT_TRANSACTION_COLUMNS]);
    expect(row).toEqual({
      id: TRANSACTION_ID,
      transaction_type: "generation_deduct",
      amount: -12,
      balance_after: 88,
      job_id: JOB_ID,
      description: "image generation",
      created_at: "2026-04-05T06:07:08.901Z",
    } satisfies CreditTransactionReadRow);

    // Every row of the answer is mapped, not just the first one.
    const many = createHarness(() => [transactionRow(), transactionRow()]);
    await expect(list(repositoryFor(many))).resolves.toHaveLength(2);
  });

  it("case 9: a Date is normalised to ISO, never passed through", async () => {
    const value = new Date("2026-04-05T06:07:08.901Z");
    const harness = createHarness(() => [transactionRow({ created_at: value })]);

    const row = requireRow((await list(repositoryFor(harness)))[0] ?? null);

    // The shape assertion is the point: `as string` on a Date compiles and then
    // makes the HTTP response schema reject the row.
    expect(typeof row.created_at).toBe("string");
    expect(row.created_at).toBe("2026-04-05T06:07:08.901Z");
    expect(row.created_at).not.toBeInstanceOf(Date);
  });

  it("case 10: an ISO string is accepted and re-normalised to UTC", async () => {
    const harness = createHarness(() => [
      transactionRow({ created_at: "2026-04-05T08:07:08.901+02:00" }),
    ]);

    const row = requireRow((await list(repositoryFor(harness)))[0] ?? null);

    expect(row.created_at).toBe("2026-04-05T06:07:08.901Z");
    expect(new Date(row.created_at).getTime()).toBe(
      Date.parse("2026-04-05T06:07:08.901Z"),
    );
  });

  it("case 11: an explicit SQL NULL becomes null on both nullable columns", async () => {
    const harness = createHarness(() => [nullTransactionRow()]);

    const row = requireRow((await list(repositoryFor(harness)))[0] ?? null);

    expect(row.job_id).toBeNull();
    expect(row.description).toBeNull();
    // The required columns are unaffected: a ledger row always has an id, a
    // type, both integers and a timestamp.
    expect(row.id).toBe(TRANSACTION_ID);
    expect(row.created_at).toBe("2026-04-05T06:07:08.901Z");
  });

  it("case 12: an ABSENT nullable column fails loud where an explicit NULL does not", async () => {
    // The 20D-fixup lesson: if "column missing" were folded into "null", a
    // projection that dropped a column would read exactly like a transaction
    // with no job and no description — silently losing data.
    const explicitNull = createHarness(() => [nullTransactionRow()]);
    await expect(
      list(repositoryFor(explicitNull)),
    ).resolves.toHaveLength(1);

    for (const column of ["job_id", "description"]) {
      const harness = createHarness(() => [
        removeColumn(nullTransactionRow(), column),
      ]);
      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(CreditReadError);
      expect((error as CreditReadError).operation).toBe(LIST_TRANSACTIONS);
      // The shape refusal happens INSIDE the transaction, so it rolls back on
      // exactly the same path as a real SQL failure.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 13: an absent required transaction column fails loud", async () => {
    for (const column of [
      "id",
      "transaction_type",
      "amount",
      "balance_after",
      "created_at",
    ]) {
      const harness = createHarness(() => [removeColumn(transactionRow(), column)]);

      await expect(list(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 14: integer drift — a string, a float, NaN, an infinity, null", async () => {
    const answers: Array<Record<string, unknown>> = [
      { amount: "-12" },
      { amount: -12.5 },
      { amount: Number.NaN },
      { amount: Number.POSITIVE_INFINITY },
      { amount: null },
      { amount: { value: -12 } },
      { balance_after: "88" },
      { balance_after: 88.25 },
      { balance_after: Number.NaN },
      { balance_after: null },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [transactionRow(drift)]);

      await expect(list(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 15: integer values pass through as numbers, negative amounts included", async () => {
    const harness = createHarness(() => [
      transactionRow({ amount: -12, balance_after: 88 }),
      transactionRow({ id: "00000000-0000-0000-0000-0000000021c3", amount: 0, balance_after: 0 }),
    ]);

    const rows = await list(repositoryFor(harness));

    expect(rows.map((row) => row.amount)).toEqual([-12, 0]);
    expect(rows.map((row) => row.balance_after)).toEqual([88, 0]);
    for (const row of rows) {
      expect(typeof row.amount).toBe("number");
      expect(typeof row.balance_after).toBe("number");
    }
  });

  it("case 16: timestamp drift — a number, a non-ISO string, an invalid Date, null", async () => {
    const answers: Array<Record<string, unknown>> = [
      { created_at: 1_775_000_000_000 },
      { created_at: "2026-04-05 06:07:08+00" },
      { created_at: "not a timestamp" },
      { created_at: new Date(Number.NaN) },
      { created_at: null },
      { created_at: {} },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [transactionRow(drift)]);

      await expect(list(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 17: the subscription row is mapped column by column, keys in column order", async () => {
    const harness = createHarness(() => [subscriptionRow()]);

    const row = requireRow(await subscription(repositoryFor(harness)));

    expect(Object.keys(row)).toEqual([...SUBSCRIPTION_COLUMNS]);
    expect(row).toEqual({
      plan: "pro",
      billing_period: "monthly",
      stripe_customer_id: "cus_21k",
      stripe_subscription_id: "sub_21k",
      current_period_start: "2026-04-01T00:00:00.000Z",
      current_period_end: "2026-05-01T00:00:00.000Z",
      canceled_at: "2026-04-15T12:30:45.678Z",
    } satisfies SubscriptionReadRow);
    // The three timestamps are strings, not the Dates the driver handed back.
    for (const column of [
      "current_period_start",
      "current_period_end",
      "canceled_at",
    ] as const) {
      expect(typeof row[column]).toBe("string");
    }
  });

  it("case 18: the six nullable subscription columns are null when SQL says NULL", async () => {
    const harness = createHarness(() => [nullSubscriptionRow()]);

    const row = requireRow(await subscription(repositoryFor(harness)));

    // `plan` is NOT NULL with a `free` default: it is a value even here, and the
    // "no subscription at all" answer is the null ROW, never a row of defaults.
    expect(row.plan).toBe("free");
    for (const column of [
      "billing_period",
      "stripe_customer_id",
      "stripe_subscription_id",
      "current_period_start",
      "current_period_end",
      "canceled_at",
    ] as const) {
      expect([column, row[column]]).toEqual([column, null]);
    }
  });

  it("case 19: an absent subscription column fails loud on every projected column", async () => {
    for (const column of [...SUBSCRIPTION_COLUMNS]) {
      const harness = createHarness(() => [removeColumn(subscriptionRow(), column)]);

      await expect(subscription(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 20: subscription drift — a non-string plan, an unusable timestamp, an empty enum", async () => {
    const answers: Array<Record<string, unknown>> = [
      { plan: 7 },
      { plan: "" },
      { plan: null },
      { billing_period: 1 },
      { billing_period: "" },
      { stripe_customer_id: 7 },
      { stripe_subscription_id: false },
      { current_period_start: 1_775_000_000_000 },
      { current_period_end: "yesterday" },
      { canceled_at: new Date(Number.NaN) },
      { canceled_at: {} },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [subscriptionRow(drift)]);

      await expect(subscription(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 21: a row that is not an object is a failure, not a value", async () => {
    for (const answer of [null, "not a row", [transactionRow()], 42, true]) {
      const harness = createHarness(() => [answer]);

      await expect(list(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
    }

    for (const answer of [null, "not a row", [subscriptionRow()], 42, true]) {
      const harness = createHarness(() => [answer]);

      await expect(subscription(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
    }
  });
});

describe("credit-read-repository: zero rows, many rows and failures", () => {
  it("case 22: an empty transaction list is a legal answer and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(list(repositoryFor(harness))).resolves.toEqual([]);

    // Zero rows is the answer for a workspace with no ledger entries yet, not a
    // failure: it must not roll back and it must not be reported as an error.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 23: no subscription row is null, not an error, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(subscription(repositoryFor(harness))).resolves.toBeNull();
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 24: more than one subscription row is a fixed read failure, not a first row", async () => {
    const harness = createHarness(() => [subscriptionRow(), subscriptionRow()]);

    const error = await subscription(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CreditReadError);
    expect((error as CreditReadError).operation).toBe(READ_SUBSCRIPTION);
    // `UNIQUE (workspace_id)` makes this impossible, so it is a disagreement
    // between the statement and this module — and it must not be resolved by
    // silently picking one of the two.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 25: an unusable limit is refused before any connection is opened", async () => {
    const refusals: unknown[] = [
      0,
      CREDIT_TRANSACTION_LIMIT_MAX + 1,
      1.5,
      Number.NaN,
      -1,
      Number.POSITIVE_INFINITY,
      "3",
      null,
      undefined,
      {},
    ];

    for (const limit of refusals) {
      const harness = createHarness(() => [transactionRow()]);
      const error = await list(repositoryFor(harness), { limit }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(CreditReadError);
      expect((error as CreditReadError).operation).toBe(LIST_TRANSACTIONS);
      // Nothing was connected, nothing was begun and nothing was sent: a value
      // that is not a limit must never become a query.
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 26: both ends of the accepted limit range are bound as integers", async () => {
    for (const limit of [CREDIT_TRANSACTION_LIMIT_MIN, CREDIT_TRANSACTION_LIMIT_MAX]) {
      const harness = createHarness(() => [transactionRow()]);

      await list(repositoryFor(harness), { limit });

      expect(domainCalls(harness.queries)[0]?.params).toEqual([
        WORKSPACE_ID,
        limit,
      ]);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    }
  });

  it("case 27: an unusable workspace id is refused before any connection is opened", async () => {
    for (const workspaceId of [undefined, "", 7, null, {}]) {
      const harness = createHarness(() => [transactionRow()]);
      const listError = await list(repositoryFor(harness), { workspaceId }).catch(
        (reason: unknown) => reason,
      );

      expect(listError).toBeInstanceOf(CreditReadError);
      // The operation travels with the refusal: a subscription refusal must not
      // be reported as a transaction one.
      expect((listError as CreditReadError).operation).toBe(LIST_TRANSACTIONS);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);

      const subscriptionHarness = createHarness(() => [subscriptionRow()]);
      const subscriptionError = await subscription(
        repositoryFor(subscriptionHarness),
        { workspaceId },
      ).catch((reason: unknown) => reason);

      expect(subscriptionError).toBeInstanceOf(CreditReadError);
      expect((subscriptionError as CreditReadError).operation).toBe(
        READ_SUBSCRIPTION,
      );
      expect(subscriptionHarness.connectAttempts()).toBe(0);
      expect(subscriptionHarness.queries).toHaveLength(0);
    }
  });

  it("case 28: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "select ... from public.credit_transactions failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await list(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CreditReadError);
    const readError = error as CreditReadError;
    expect(readError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(readError.message).not.toMatch(
      /public\.|credit_transactions|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The workspace id never reaches the message either: a failure is not a
    // lookup, and this one is shared by every workspace.
    expect(readError.message).not.toContain(WORKSPACE_ID);
    expect(readError.message).not.toContain(OTHER_WORKSPACE_ID);
  });

  it("case 29: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await subscription(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CreditReadError);
    expect((error as CreditReadError).message).toBe(
      `credit read failed (${READ_SUBSCRIPTION})`,
    );
    expect((error as CreditReadError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 30: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createCreditReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const listError = await list(repository).catch((reason: unknown) => reason);
    expect(resolutions).toBe(1);
    expect(listError).toBeInstanceOf(CreditReadError);
    expect((listError as CreditReadError).message).toBe(
      `credit read failed (${LIST_TRANSACTIONS})`,
    );
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((listError as CreditReadError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );

    const subscriptionError = await subscription(repository).catch(
      (reason: unknown) => reason,
    );
    expect(resolutions).toBe(2);
    expect((subscriptionError as CreditReadError).message).toBe(
      `credit read failed (${READ_SUBSCRIPTION})`,
    );

    // A refused argument must not even resolve the pool: the check runs first.
    let reachedPool = 0;
    const guarded = createCreditReadRepository({
      getTransactionPool: () => {
        reachedPool += 1;
        throw new Error("the pool must not be resolved for a refused argument");
      },
    });
    await expect(list(guarded, { limit: Number.NaN })).rejects.toBeInstanceOf(
      CreditReadError,
    );
    await expect(
      subscription(guarded, { workspaceId: "" }),
    ).rejects.toBeInstanceOf(CreditReadError);
    expect(reachedPool).toBe(0);
  });
});

describe("credit-read-repository: the balance snapshot statement", () => {
  it("case 31: one privileged statement, two bind parameters and NO actor", async () => {
    const harness = createHarness(() => [balanceSnapshotRow()]);

    await snapshot(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // ONE domain statement: the three answers are not three round trips, so a
    // claim cannot land between them and make the row describe two instants.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
    const domainStatements = statements.filter(
      (sql) => !isTransactionStatement(sql),
    );
    expect(domainStatements).toHaveLength(1);

    // Between BEGIN and the read there is context and nothing else, and COMMIT
    // follows the read immediately.
    const selectIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    expect(
      statements
        .slice(1, selectIndex)
        .every((sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting),
    ).toBe(true);
    expect(statements[selectIndex + 1]).toBe(TRANSACTION_STATEMENTS.commit);

    // A system read on behalf of an already-authorised caller: no acting user is
    // forged, and the mode is the explicit privileged label.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ""],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 32: the statement is exactly three scalar subqueries plus exists", async () => {
    const harness = createHarness(() => [balanceSnapshotRow()]);

    await snapshot(repositoryFor(harness));

    const sql = normalized(statementText(harness.queries));
    expect(sql).toBe(
      "select " +
        "(select b.balance from public.credit_balances b " +
        "where b.workspace_id = $1::uuid) as balance, " +
        "(select s.plan from public.subscriptions s " +
        "where s.workspace_id = $1::uuid) as plan, " +
        "exists (select 1 from public.daily_credit_claims d " +
        "where d.workspace_id = $1::uuid and d.claim_date = $2::date) " +
        "as daily_claimed",
    );

    // Three tables, each read once, each behind the caller's own workspace id.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual([
      "public.credit_balances",
      "public.subscriptions",
      "public.daily_credit_claims",
    ]);
    // `exists` is SQL, NOT `count(*)`: `count` returns `bigint`, which both
    // drivers hand back as a STRING, so the boolean would have to be rebuilt
    // outside the statement.
    expect(sql).not.toMatch(/count\s*\(/i);
    expect(sql).toContain("exists (select 1");
    // One row, always: no ordering, no limit, no offset narrows or widens it.
    expect(sql).not.toMatch(/\border by\b|\blimit\b|\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/\bjoin\b/i);
    // The date is the CALLER's, bound as `$2::date`. `current_date` would move
    // the day into the database's timezone, which is a different question.
    expect(sql).toContain("d.claim_date = $2::date");
    expect(sql).not.toContain("current_date");
  });

  it("case 33: the workspace id and the claim date are bind parameters, never statement text", async () => {
    const harness = createHarness(() => [balanceSnapshotRow()]);

    await snapshot(repositoryFor(harness), { claimDate: OTHER_CLAIM_DATE });

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([WORKSPACE_ID, OTHER_CLAIM_DATE]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2::date");
    // Neither value appears in the statement, and nothing is interpolated.
    expect(statement?.sql).not.toContain(WORKSPACE_ID);
    expect(statement?.sql).not.toContain(OTHER_CLAIM_DATE);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 34: a claim date that is not YYYY-MM-DD is refused before any connection", async () => {
    const refusals: unknown[] = [
      "2026-1-5",
      "2026/01/05",
      "",
      "2026-01-05T00:00",
      "2026-01-05T00:00:00.000Z",
      "05-01-2026",
      " 2026-01-05",
      "2026-01-05 ",
      undefined,
      null,
      20260105,
      {},
      new Date("2026-01-05T00:00:00.000Z"),
    ];

    for (const claimDate of refusals) {
      const harness = createHarness(() => [balanceSnapshotRow()]);
      const error = await snapshot(repositoryFor(harness), { claimDate }).catch(
        (reason: unknown) => reason,
      );

      expect([claimDate, error instanceof CreditReadError]).toEqual([
        claimDate,
        true,
      ]);
      expect((error as CreditReadError).operation).toBe(READ_BALANCE_SNAPSHOT);
      // Nothing was connected, nothing was begun and nothing was sent: a value
      // that is not a date of the agreed shape must never become a query, and
      // the failure must not be reported as a database one.
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 35: a refused claim date never resolves the pool", async () => {
    let reachedPool = 0;
    const guarded = createCreditReadRepository({
      getTransactionPool: () => {
        reachedPool += 1;
        throw new Error("the pool must not be resolved for a refused date");
      },
    });

    for (const claimDate of ["2026-1-5", "2026/01/05", "", "2026-01-05T00:00"]) {
      await expect(
        snapshot(guarded, { claimDate }),
      ).rejects.toBeInstanceOf(CreditReadError);
    }
    await expect(
      snapshot(guarded, { workspaceId: "" }),
    ).rejects.toBeInstanceOf(CreditReadError);

    expect(reachedPool).toBe(0);
  });
});

describe("credit-read-repository: the balance snapshot row", () => {
  it("case 36: the row is read by name, keys in column order", async () => {
    const harness = createHarness(() => [balanceSnapshotRow()]);

    const row = await snapshot(repositoryFor(harness));

    expect(Object.keys(row)).toEqual([...BALANCE_SNAPSHOT_COLUMNS]);
    expect(row).toEqual({
      balance: 42,
      plan: "pro",
      daily_claimed: true,
    } satisfies BalanceSnapshotReadRow);
    // A balance of zero is a VALUE, not an absence: the two must not be folded
    // together, because the service turns the absence into the same zero.
    const zero = createHarness(() => [
      balanceSnapshotRow({ balance: 0, daily_claimed: false }),
    ]);
    await expect(snapshot(repositoryFor(zero))).resolves.toEqual({
      balance: 0,
      plan: "pro",
      daily_claimed: false,
    });
  });

  it("case 37: balance drift — a string, a negative, a float, NaN, an infinity, an absent column", async () => {
    // Each answer is a COMPLETE row, because `removeColumn` has to be the last
    // word on the key it removes: spreading a partial override onto the default
    // row would put the removed column straight back.
    const answers: Array<Record<string, unknown>> = [
      balanceSnapshotRow({ balance: "5" }),
      // `CHECK (balance >= 0)` makes a negative impossible, so it is drift.
      balanceSnapshotRow({ balance: -1 }),
      balanceSnapshotRow({ balance: 42.5 }),
      balanceSnapshotRow({ balance: Number.NaN }),
      balanceSnapshotRow({ balance: Number.POSITIVE_INFINITY }),
      balanceSnapshotRow({ balance: {} }),
      removeColumn(balanceSnapshotRow(), "balance"),
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [drift]);
      const error = await snapshot(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect([drift, error instanceof CreditReadError]).toEqual([drift, true]);
      expect((error as CreditReadError).operation).toBe(READ_BALANCE_SNAPSHOT);
      // The shape refusal happens INSIDE the transaction, so it rolls back on
      // exactly the same path as a real SQL failure.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 38: plan drift — a non-string, an empty string and an absent column", async () => {
    const answers: Array<Record<string, unknown>> = [
      balanceSnapshotRow({ plan: 7 }),
      balanceSnapshotRow({ plan: "" }),
      balanceSnapshotRow({ plan: false }),
      removeColumn(balanceSnapshotRow(), "plan"),
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [drift]);

      await expect(snapshot(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 39: daily_claimed drift — text, a number, null and an absent column", async () => {
    // `"t"` is what a `count(*) > 0` or a `boolean::text` projection produces;
    // accepting it would turn a broken projection into "already claimed today".
    const answers: Array<Record<string, unknown>> = [
      balanceSnapshotRow({ daily_claimed: "t" }),
      balanceSnapshotRow({ daily_claimed: "true" }),
      balanceSnapshotRow({ daily_claimed: 1 }),
      balanceSnapshotRow({ daily_claimed: 0 }),
      balanceSnapshotRow({ daily_claimed: null }),
      removeColumn(balanceSnapshotRow(), "daily_claimed"),
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [drift]);

      await expect(snapshot(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 40: an all-absent row is a legal answer and the transaction commits", async () => {
    const harness = createHarness(() => [absentBalanceSnapshotRow()]);

    await expect(snapshot(repositoryFor(harness))).resolves.toEqual({
      balance: null,
      plan: null,
      daily_claimed: false,
    });

    // A workspace that has neither row is not an error: the service turns the
    // two nulls into `0` and `"free"`, and the read must not roll back.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 41: zero rows and more than one row are both failures, and both roll back", async () => {
    // The statement has no `from` clause of its own, so it answers exactly one
    // row for EVERY workspace; any other count is a disagreement between the
    // statement and this mapper rather than a value.
    for (const rows of [
      [],
      [balanceSnapshotRow(), balanceSnapshotRow()],
      [balanceSnapshotRow(), balanceSnapshotRow(), balanceSnapshotRow()],
    ]) {
      const harness = createHarness(() => rows);
      const error = await snapshot(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(CreditReadError);
      expect((error as CreditReadError).operation).toBe(READ_BALANCE_SNAPSHOT);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 42: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "select ... from public.credit_balances failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await snapshot(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CreditReadError);
    const readError = error as CreditReadError;
    expect(readError.operation).toBe(READ_BALANCE_SNAPSHOT);
    expect(readError.message).toBe(
      `credit read failed (${READ_BALANCE_SNAPSHOT})`,
    );
    expect(readError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(readError.message).not.toMatch(
      /public\.|credit_balances|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(readError.message).not.toContain(WORKSPACE_ID);
    expect(readError.message).not.toContain(CLAIM_DATE);
  });

  it("case 43: a row that is not an object is a failure, not a value", async () => {
    for (const answer of [null, "not a row", [balanceSnapshotRow()], 42, true]) {
      const harness = createHarness(() => [answer]);

      await expect(snapshot(repositoryFor(harness))).rejects.toBeInstanceOf(
        CreditReadError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });
});
