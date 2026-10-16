import { describe, expect, it } from "vitest";

import {
  CREDIT_TRANSACTION_COLUMNS,
  CREDIT_TRANSACTION_LIMIT_MAX,
  CREDIT_TRANSACTION_LIMIT_MIN,
  CreditReadError,
  LIST_TRANSACTIONS,
  READ_SUBSCRIPTION,
  SUBSCRIPTION_COLUMNS,
  createCreditReadRepository,
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
 * database and no `DATABASE_URL` are involved: the point is the two statements
 * the repository can issue, the actor context they carry (none), the columns
 * they project, the two bind parameters of the list read, and how every way
 * those statements can answer is classified.
 *
 * The unit tests prove WHICH statements are built — one SELECT each, one table
 * each, no batch, `limit` bound and never concatenated. The PGlite file beside
 * them (`test-support/db/credit-read-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes them against the real tables, that a malformed
 * uuid rolls back and leaves the pool usable, and that neither read moves a row.
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000021b1";
const OTHER_WORKSPACE_ID = "00000000-0000-0000-0000-0000000021b2";
const TRANSACTION_ID = "00000000-0000-0000-0000-0000000021c1";
const JOB_ID = "00000000-0000-0000-0000-0000000021c2";

/** A limit that cannot appear inside either statement by coincidence. */
const LIMIT = 37;

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

  it("case 7: the repository exposes two reads and nothing else", () => {
    const harness = createHarness(() => [transactionRow()]);
    const repository = repositoryFor(harness);

    // There is no access token, no table name and no generic filter entry point
    // a caller could widen either read with.
    expect(Object.keys(repository)).toEqual([
      LIST_TRANSACTIONS,
      READ_SUBSCRIPTION,
    ]);
    expect(repository.listTransactions).toHaveLength(1);
    expect(repository.readSubscription).toHaveLength(1);
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
