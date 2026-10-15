import { describe, expect, it } from "vitest";

import {
  INCREMENT_ATTEMPT,
  JobAttemptWriteError,
  createJobAttemptRepository,
  type JobAttemptRow,
} from "./job-attempt-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor context it carries (none), which column it
 * may write, and how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built — one self-referential UPDATE,
 * no status predicate, no read-then-write pair. The PGlite file beside them
 * (`test-support/db/job-attempt-repository-db.test.ts`) proves PostgreSQL
 * actually parses, executes and rolls it back, and that the semantics of the
 * replaced `increment_job_attempt` function still hold.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000000c1";

/** A row shaped the way `RETURNING attempt_count, max_attempts` answers. */
const ATTEMPT_ROW = { attempt_count: 2, max_attempts: 3 };

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
 * second one would mean the increment was split (a read first, then a write).
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

function repositoryFor(harness: Harness) {
  return createJobAttemptRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the argument named once. */
function increment(repository: ReturnType<typeof repositoryFor>) {
  return repository.incrementAttempt({ jobId: JOB_ID });
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

describe("job-attempt-repository: the statement it issues", () => {
  it("case 1: writes inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW]);

    await increment(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no read-back, no check-then-write pair, no
    // second update, no cleanup.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // A worker-internal write has no acting user. Every actor setting stays
    // empty — forging one from the caller would put a person on an audit trail
    // they had nothing to do with — and the mode is the explicit privileged one.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ""],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds the job id as a parameter, never as statement text", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW]);

    await increment(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: the counter is moved by the database, in one self-referential assignment", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW]);

    await increment(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    // The new value is read and written inside the statement: no `select` first,
    // so there is no window in which two workers could read the same count.
    expect(sql).toContain("set attempt_count = attempt_count + 1");
    expect(sql).not.toMatch(/select[\s\S]*attempt_count[\s\S]*update/i);
    expect(sql).not.toMatch(/^\s*select/im);
    expect(sql).toContain("updated_at = now()");
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("returning attempt_count, max_attempts");
    // One statement, never a batch.
    expect(sql).not.toContain(";");
  });

  it("case 4: no status predicate and no other column — the old RPC semantics", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW]);

    await increment(repositoryFor(harness));

    const sql = statementText(harness.queries);
    // A terminal or cancelled job must still count an attempt, exactly as the
    // replaced database function did: narrowing the row set here would be a
    // silent behaviour change smuggled in under a migration.
    expect(sql).not.toContain("status");
    // `set` names exactly two columns. Everything else on the row — the payload,
    // the error fields, the credit link, the timestamps of the state machine —
    // is not reachable from this module.
    const assignments = /set([\s\S]*?)where/i.exec(sql)?.[1] ?? "";
    expect(assignments.split(",").map((part) => part.trim())).toEqual([
      "attempt_count = attempt_count + 1",
      "updated_at = now()",
    ]);
    for (const column of [
      "status",
      "payload",
      "result",
      "error_code",
      "error_message",
      "credits_cost",
      "credits_transaction_id",
      "workspace_id",
      "created_by",
      "project_id",
      "canvas_id",
      "session_id",
      "thread_id",
      "started_at",
      "completed_at",
      "failed_at",
      "canceled_at",
      "max_attempts",
    ]) {
      expect(assignments).not.toContain(column);
    }
    // Exactly one table is reachable.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
  });

  it("case 5: maps the returned row", async () => {
    const harness = createHarness(() => [
      { attempt_count: 4, max_attempts: 5 },
    ]);

    const row = await increment(repositoryFor(harness));

    expect(row).toEqual({
      attemptCount: 4,
      maxAttempts: 5,
    } satisfies JobAttemptRow);
  });

  it("case 6: the repository exposes incrementAttempt and nothing else", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW]);
    const repository = repositoryFor(harness);

    // Requirement 1 of workorder 21F, as a shape rather than a promise: there is
    // no second method, no access token, no workspace parameter and no generic
    // patch entry point a caller could widen the write with.
    expect(Object.keys(repository)).toEqual([INCREMENT_ATTEMPT]);
    expect(repository.incrementAttempt).toHaveLength(1);

    await increment(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID]);
  });
});

describe("job-attempt-repository: zero rows and row shapes", () => {
  it("case 7: zero rows is the 'no such job' answer, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(increment(repositoryFor(harness))).resolves.toBeNull();

    // Unlike the 21D/21E1 writes, zero rows is a LEGAL answer here: the old
    // function answered zero rows for an unknown job id and the caller archives
    // the message on it. It must therefore not roll back, and it must not be
    // reported as a failure.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 8: more than one row is a fixed write failure, not a first row", async () => {
    const harness = createHarness(() => [ATTEMPT_ROW, ATTEMPT_ROW]);

    const error = await increment(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAttemptWriteError);
    expect((error as JobAttemptWriteError).operation).toBe(INCREMENT_ATTEMPT);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 9: a row that is not an object, or an unusable count, is a fixed write failure", async () => {
    const answers: unknown[] = [
      null,
      "not a row",
      [ATTEMPT_ROW],
      42,
      // attempt_count: missing, not a number, empty, fractional, negative.
      { max_attempts: 3 },
      { ...ATTEMPT_ROW, attempt_count: "2" },
      { ...ATTEMPT_ROW, attempt_count: null },
      { ...ATTEMPT_ROW, attempt_count: 2.5 },
      { ...ATTEMPT_ROW, attempt_count: -1 },
      { ...ATTEMPT_ROW, attempt_count: Number.NaN },
      // max_attempts: the retry budget, held to the same rule.
      { attempt_count: 2 },
      { ...ATTEMPT_ROW, max_attempts: "3" },
      { ...ATTEMPT_ROW, max_attempts: null },
      { ...ATTEMPT_ROW, max_attempts: 3.5 },
      { ...ATTEMPT_ROW, max_attempts: -3 },
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      const error = await increment(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobAttemptWriteError);
      const writeError = error as JobAttemptWriteError;
      expect(writeError.operation).toBe(INCREMENT_ATTEMPT);
      expect(writeError.message).toBe(
        `job attempt write failed (${INCREMENT_ATTEMPT})`,
      );
      // A row-shape refusal happens INSIDE the transaction, so it rolls back on
      // exactly the same path as a real SQL failure.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });
});

describe("job-attempt-repository: refusals", () => {
  it("case 10: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "update public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await increment(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAttemptWriteError);
    const writeError = error as JobAttemptWriteError;
    expect(writeError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(writeError.message).not.toMatch(
      /public\.|background_jobs|attempt_count|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(writeError.message).not.toContain(JOB_ID);
  });

  it("case 11: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await increment(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAttemptWriteError);
    expect((error as JobAttemptWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 12: an unusable job id is refused before any connection is opened", async () => {
    const args: unknown[] = [undefined, "", 7, null, {}];

    for (const jobId of args) {
      const harness = createHarness(() => [ATTEMPT_ROW]);
      const error = await repositoryFor(harness)
        .incrementAttempt({ jobId } as { jobId: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobAttemptWriteError);
      expect((error as JobAttemptWriteError).operation).toBe(INCREMENT_ATTEMPT);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 13: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createJobAttemptRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await increment(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(JobAttemptWriteError);
    expect((error as JobAttemptWriteError).operation).toBe(INCREMENT_ATTEMPT);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as JobAttemptWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
