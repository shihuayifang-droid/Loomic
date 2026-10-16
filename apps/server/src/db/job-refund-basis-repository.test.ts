import { describe, expect, it } from "vitest";

import {
  JOB_REFUND_BASIS_COLUMNS,
  JobRefundBasisError,
  READ_REFUND_BASIS,
  createJobRefundBasisRepository,
  type JobRefundBasisRepository,
  type JobRefundBasisRow,
} from "./job-refund-basis-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor context it carries (none), the three columns
 * it projects, and how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built and how each answer is mapped.
 * The PGlite file beside them
 * (`test-support/db/job-refund-basis-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes it against the real table, that a malformed uuid
 * rolls back and leaves the pool usable, and that the read does not move the row.
 *
 * This read feeds a refund, so the drift cases below are not stylistic: a cost
 * that arrived as a string, a float or a negative number must never reach
 * `refundCredits`, and a column that is missing must never read as "no cost".
 */

const JOB_ID = "00000000-0000-0000-0000-000000002001";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000002002";
const USER_ID = "00000000-0000-0000-0000-000000002003";

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
 * The repository's own statement, and only it: BEGIN/COMMIT/set_config carry no
 * schema-qualified name, so anything naming `public.` is a domain statement. A
 * second one would mean the read was split (a probe first, then the row).
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

function repositoryFor(harness: Harness): JobRefundBasisRepository {
  return createJobRefundBasisRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the argument named once. */
function read(repository: JobRefundBasisRepository, jobId: string = JOB_ID) {
  return repository.readRefundBasis({ jobId });
}

function requireBasis(row: JobRefundBasisRow | null): JobRefundBasisRow {
  if (row === null) throw new Error("expected a refund basis, got null");
  return row;
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/** The row as the statement answers it: integers as numbers, uuids as strings. */
function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credits_cost: 10,
    workspace_id: WORKSPACE_ID,
    created_by: USER_ID,
    ...overrides,
  };
}

function removeColumn(
  row: Record<string, unknown>,
  column: string,
): Record<string, unknown> {
  const copy = { ...row };
  delete copy[column];
  return copy;
}

describe("job-refund-basis-repository: the statement it issues", () => {
  it("case 1: reads inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no probe read, no count, no second table.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // What this case owns is the SHAPE, not the statement count: the count is
    // `transaction.ts`'s business (and is asserted by its own test), so this
    // suite classifies by exclusion instead of pinning how many `set_config`
    // statements the entry point happens to issue today.
    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
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
    // The read is the last thing inside the transaction: COMMIT follows it.
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

  it("case 2: binds the job id as a parameter, never as statement text", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: one table, one row by primary key, and not a batch", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toMatch(/from public\.background_jobs/);
    expect(sql.replace(/\s+/g, " ").trim()).toMatch(/where id = \$1::uuid$/);
    // Exactly one table is reachable, and no other predicate narrows or widens
    // the read: no status, no workspace, no ordering, no limit.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/join/i);
  });

  it("case 4: the projection is exactly the three refund columns, in the displaced call's order", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const columns = selectList(statementText(harness.queries));

    // Two lists, one truth: the statement and the module's exported list. A
    // column added to one and not the other is the drift this refuses.
    expect(columns).toEqual([...JOB_REFUND_BASIS_COLUMNS]);
    // Named out loud as well: the displaced read projected exactly these three,
    // in this order, and nothing about the refund decision reads a fourth.
    expect(columns).toEqual(["credits_cost", "workspace_id", "created_by"]);
    // No alias: the row is keyed by column name, which is what the mapper reads.
    expect(columns.some((column) => column.includes(" as "))).toBe(false);
  });
});

describe("job-refund-basis-repository: the row it maps", () => {
  it("case 5: a charged job reports its amount, its account and its creator", async () => {
    const harness = createHarness(() => [dbRow()]);

    const basis = requireBasis(await read(repositoryFor(harness)));

    expect(basis).toEqual({
      creditsCost: 10,
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
    });
    // The promised key set, in the promised order: the caller destructures these
    // three names and a renamed key would silently read `undefined`.
    expect(Object.keys(basis)).toEqual([
      "creditsCost",
      "workspaceId",
      "createdBy",
    ]);
  });

  it("case 6: a cost of zero is a value, not 'no cost'", async () => {
    const harness = createHarness(() => [dbRow({ credits_cost: 0 })]);

    const basis = requireBasis(await read(repositoryFor(harness)));

    // Zero and NULL must not be conflated anywhere in this module: the caller's
    // `?? 0` turns NULL into 0 and then refuses both, but a repository that
    // reported 0 for a NULL column would hide the difference from every test
    // that pins the refund condition.
    expect(basis.creditsCost).toBe(0);
    expect(basis.creditsCost).not.toBeNull();
  });

  it("case 7: an explicit SQL NULL cost stays null and does NOT become zero", async () => {
    const harness = createHarness(() => [dbRow({ credits_cost: null })]);

    const basis = requireBasis(await read(repositoryFor(harness)));

    expect(basis.creditsCost).toBeNull();
    // The account and the creator are unaffected by a null cost.
    expect(basis.workspaceId).toBe(WORKSPACE_ID);
    expect(basis.createdBy).toBe(USER_ID);
  });

  it("case 8: a large integer amount passes through unchanged", async () => {
    const harness = createHarness(() => [dbRow({ credits_cost: 2_000_000_000 })]);

    const basis = requireBasis(await read(repositoryFor(harness)));

    expect(basis.creditsCost).toBe(2_000_000_000);
    expect(Number.isInteger(basis.creditsCost)).toBe(true);
  });

  it("case 9: cost drift — a string, a negative, a float, NaN, Infinity, a boolean, an object", async () => {
    const drift: unknown[] = [
      "10",
      -1,
      -0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      true,
      {},
      [],
      "0",
    ];

    for (const credits_cost of drift) {
      const harness = createHarness(() => [dbRow({ credits_cost })]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect([credits_cost, error instanceof JobRefundBasisError]).toEqual([
        credits_cost,
        true,
      ]);
      // The refusal happens INSIDE the transaction, so it rolls back on exactly
      // the same path as a real SQL failure and never commits a wrong amount.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 10: created_by is a string or an explicit NULL; anything else fails loud", async () => {
    const asNull = createHarness(() => [dbRow({ created_by: null })]);
    const nullBasis = requireBasis(await read(repositoryFor(asNull)));
    // A historic row with no creator: reported as null, never invented.
    expect(nullBasis.createdBy).toBeNull();
    expect(lastStatement(asNull)).toBe(TRANSACTION_STATEMENTS.commit);

    for (const created_by of [7, {}, [], true, undefined]) {
      const harness = createHarness(() => [dbRow({ created_by })]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobRefundBasisError);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 11: workspace_id drift — an empty string, a number, null or an object", async () => {
    for (const workspace_id of ["", 7, null, {}, [], true]) {
      const harness = createHarness(() => [dbRow({ workspace_id })]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      // A refund with nowhere to go must not be a value: the column is NOT NULL
      // in the schema, so an unusable one is drift rather than a workspace.
      expect(error).toBeInstanceOf(JobRefundBasisError);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 12: an ABSENT column fails loud where an explicit NULL does not", async () => {
    // The 20D-fixup lesson: if "column missing" were folded into "null", a
    // projection that dropped a column would read exactly like a job that was
    // never charged by a user who no longer exists — silently refunding nothing
    // and saying nothing about why.
    for (const column of [...JOB_REFUND_BASIS_COLUMNS]) {
      const harness = createHarness(() => [removeColumn(dbRow(), column)]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect([column, error instanceof JobRefundBasisError]).toEqual([
        column,
        true,
      ]);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 13: a row that is not an object is a failure, not a value", async () => {
    const answers: unknown[] = [null, "not a row", [dbRow()], 42, true];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);

      await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobRefundBasisError,
      );
    }
  });
});

describe("job-refund-basis-repository: zero rows, many rows, failures", () => {
  it("case 14: zero rows is the 'no such job' answer, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(read(repositoryFor(harness))).resolves.toBeNull();

    // Zero rows is a LEGAL answer: it is the displaced read's null row, and the
    // refund path turns it into "refund nothing". It must therefore not roll
    // back and must not be reported as a failure.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 15: more than one row is a fixed read failure, not a first row", async () => {
    const harness = createHarness(() => [
      dbRow({ credits_cost: 10 }),
      dbRow({ credits_cost: 100 }),
    ]);

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    // Picking a row would pick an AMOUNT. The id is the primary key, so this is
    // a statement/mapper disagreement and must never resolve to a refund.
    expect(error).toBeInstanceOf(JobRefundBasisError);
    expect((error as JobRefundBasisError).operation).toBe(READ_REFUND_BASIS);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 16: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "select credits_cost from public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobRefundBasisError);
    const basisError = error as JobRefundBasisError;
    expect(basisError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(basisError.message).toBe(
      `job refund basis read failed (${READ_REFUND_BASIS})`,
    );
    expect(basisError.message).not.toMatch(
      /public\.|background_jobs|credits_cost|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(basisError.message).not.toContain(JOB_ID);
  });

  it("case 17: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobRefundBasisError);
    expect((error as JobRefundBasisError).message).toBe(
      `job refund basis read failed (${READ_REFUND_BASIS})`,
    );
    expect((error as JobRefundBasisError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 18: an unusable job id is refused before any connection is opened", async () => {
    const args: unknown[] = [undefined, "", 7, null, {}];

    for (const jobId of args) {
      const harness = createHarness(() => [dbRow()]);
      const error = await repositoryFor(harness)
        .readRefundBasis({ jobId } as { jobId: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobRefundBasisError);
      expect((error as JobRefundBasisError).operation).toBe(READ_REFUND_BASIS);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 19: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createJobRefundBasisRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await read(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(JobRefundBasisError);
    // The fixed message is the only thing a caller may surface — and the worker
    // LOGS this message, so it must carry no connection string and no
    // environment variable name.
    expect((error as JobRefundBasisError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });

  it("case 20: the repository exposes readRefundBasis and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);
    const repository = repositoryFor(harness);

    // There is no second method, no access token, no workspace parameter and no
    // generic filter entry point a caller could widen the read with.
    expect(Object.keys(repository)).toEqual([READ_REFUND_BASIS]);
    expect(repository.readRefundBasis).toHaveLength(1);

    await read(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID]);
  });

  it("case 21: the error carries its own name, operation and a non-enumerable-friend cause", async () => {
    const harness = createHarness(() => [dbRow({ credits_cost: "10" })]);

    const error = (await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    )) as JobRefundBasisError;

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("JobRefundBasisError");
    expect(error.operation).toBe(READ_REFUND_BASIS);
    // The row-shape refusal keeps the reason it refused for as its cause, so a
    // caller can classify drift without the reason reaching a log line.
    expect((error.cause as Error).message).toContain("credits_cost");
    expect(error.message).not.toContain("credits_cost");
  });
});
