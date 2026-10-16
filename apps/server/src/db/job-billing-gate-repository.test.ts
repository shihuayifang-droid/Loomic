import { describe, expect, it } from "vitest";

import {
  BILLING_NOT_CONFIRMED_ERROR_CODE,
  BILLING_NOT_CONFIRMED_MESSAGE,
  FAIL_UNBILLED_IF_OVERDUE,
  JobBillingGateError,
  READ_BILLING_GATE,
  createJobBillingGateRepository,
  type JobBillingGateRepository,
} from "./job-billing-gate-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the two statements
 * the repository issues, the actor context they carry (none), which columns the
 * write may touch, and how every way those statements can answer is classified.
 *
 * The unit tests prove WHICH statements are built — one SELECT for the read and
 * one predicate-guarded UPDATE for the write, no read-then-write pair anywhere.
 * The PGlite file beside them
 * (`test-support/db/job-billing-gate-repository-db.test.ts`) proves PostgreSQL
 * actually parses, executes and rolls them back, and that the predicate really
 * is the atomic rule this module claims it is.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000000a1";

/** The confirm window every case below uses, named once. */
const TIMEOUT_SECONDS = 600;

/** A row shaped the way the read statement's projection answers. */
const CHARGED_ROW = {
  status: "queued",
  credits_cost: 10,
  billing_overdue: false,
};

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
 * A second one would mean a method split its work into a read and a write.
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

function repositoryFor(harness: Harness): JobBillingGateRepository {
  return createJobBillingGateRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The read call every read case makes, with its arguments named once. */
function read(repository: JobBillingGateRepository) {
  return repository.readBillingGate({
    jobId: JOB_ID,
    timeoutSeconds: TIMEOUT_SECONDS,
  });
}

/** The write call every write case makes, with its arguments named once. */
function fail(repository: JobBillingGateRepository) {
  return repository.failUnbilledIfOverdue({
    jobId: JOB_ID,
    timeoutSeconds: TIMEOUT_SECONDS,
  });
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/**
 * The context assertions are identical for both methods, so they are written
 * once: a worker-internal statement has no acting user, every actor setting
 * stays empty, and the mode is the explicit privileged one.
 */
function expectNoActorInPrivilegedMode(harness: Harness): void {
  const statements = harness.queries.map((entry) => entry.sql);
  expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
  expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  expect(contextParams(harness.queries)).toEqual([
    [TRANSACTION_SETTING_NAMES.userId, ""],
    [TRANSACTION_SETTING_NAMES.workspaceId, ""],
    [TRANSACTION_SETTING_NAMES.role, ""],
    [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
  ]);
}

describe("job-billing-gate-repository: the shape of the module", () => {
  it("case 1: exposes readBillingGate and failUnbilledIfOverdue and nothing else", async () => {
    const harness = createHarness(() => [CHARGED_ROW]);
    const repository = repositoryFor(harness);

    // Requirement T1 as a shape rather than a promise: there is no third method,
    // no access token, no workspace parameter, no table argument and no generic
    // patch entry point a caller could widen either statement with.
    expect(Object.keys(repository)).toEqual([
      READ_BILLING_GATE,
      FAIL_UNBILLED_IF_OVERDUE,
    ]);
    expect(repository.readBillingGate).toHaveLength(1);
    expect(repository.failUnbilledIfOverdue).toHaveLength(1);

    await read(repository);
    await fail(repository);

    expect(domainCalls(harness.queries)).toHaveLength(2);
  });

  it("case 2: the two failure messages are fixed text, distinct, and carry no SQL", async () => {
    // The message is derived from the operation name only. Both are checked
    // verbatim so a later change to one of them has to change this file.
    expect(`job billing gate failed (${READ_BILLING_GATE})`).toBe(
      "job billing gate failed (readBillingGate)",
    );
    expect(`job billing gate failed (${FAIL_UNBILLED_IF_OVERDUE})`).toBe(
      "job billing gate failed (failUnbilledIfOverdue)",
    );

    const readFailure = new JobBillingGateError(READ_BILLING_GATE, new Error("x"));
    const writeFailure = new JobBillingGateError(
      FAIL_UNBILLED_IF_OVERDUE,
      new Error("x"),
    );
    expect(readFailure.name).toBe("JobBillingGateError");
    expect(readFailure.operation).toBe(READ_BILLING_GATE);
    expect(writeFailure.operation).toBe(FAIL_UNBILLED_IF_OVERDUE);
    expect(readFailure.message).not.toBe(writeFailure.message);
  });
});

describe("job-billing-gate-repository: the read statement", () => {
  it("case 3: reads inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [CHARGED_ROW]);

    await read(repositoryFor(harness));

    expectNoActorInPrivilegedMode(harness);
    // Exactly one domain statement: no read-back, no second select, no write.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 4: binds the job id and the window, and never carries either as text", async () => {
    const harness = createHarness(() => [CHARGED_ROW]);

    await read(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, TIMEOUT_SECONDS]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2");
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain(String(TIMEOUT_SECONDS));
    expect(statement?.sql).not.toContain("${");
  });

  it("case 5: one SELECT, with the overdue decision made by the database", async () => {
    const harness = createHarness(() => [CHARGED_ROW]);

    await read(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("select status");
    expect(sql).toContain("credits_cost");
    expect(sql).toContain(
      "created_at < now() - make_interval(secs => $2) as billing_overdue",
    );
    expect(sql).toContain("where id = $1::uuid");
    // A read never writes, and it is one statement rather than a batch.
    expect(sql).not.toMatch(/^\s*(update|insert|delete)/im);
    expect(sql).not.toContain(";");
    // Exactly one table is reachable.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
  });

  it("case 6: maps a charged row, a free row and an unbilled row", async () => {
    const answers: Array<{ row: Record<string, unknown>; expected: unknown }> = [
      {
        row: { status: "queued", credits_cost: 10, billing_overdue: false },
        expected: { status: "queued", creditsCost: 10, overdue: false },
      },
      {
        // 0 is a CONFIRMATION, not a missing value: a free model writes it on
        // purpose (workorder 21H1, T3) so it can never look unbilled again.
        row: { status: "queued", credits_cost: 0, billing_overdue: false },
        expected: { status: "queued", creditsCost: 0, overdue: false },
      },
      {
        row: { status: "retrying", credits_cost: null, billing_overdue: true },
        expected: { status: "retrying", creditsCost: null, overdue: true },
      },
      {
        row: { status: "running", credits_cost: null, billing_overdue: false },
        expected: { status: "running", creditsCost: null, overdue: false },
      },
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer.row]);
      await expect(read(repositoryFor(harness))).resolves.toEqual(answer.expected);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    }
  });

  it("case 7: zero rows is the 'no such job' answer, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(read(repositoryFor(harness))).resolves.toBeNull();

    // Unlike the 21D/21E1 writes, zero rows is a LEGAL answer here: the caller's
    // original flow already archives the message on a missing job row. It must
    // therefore not roll back, and it must not be reported as a failure.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 8: more than one row is a fixed gate failure, not a first row", async () => {
    const harness = createHarness(() => [CHARGED_ROW, CHARGED_ROW]);

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobBillingGateError);
    expect((error as JobBillingGateError).operation).toBe(READ_BILLING_GATE);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 9: a drifted row shape is a fixed gate failure, never a value", async () => {
    const answers: unknown[] = [
      // Not a row at all.
      null,
      "not a row",
      [CHARGED_ROW],
      42,
      // status: missing, not a string, empty. A row whose state nobody can read
      // must not be folded into "some other status" and passed through.
      { credits_cost: 10, billing_overdue: false },
      { ...CHARGED_ROW, status: 7 },
      { ...CHARGED_ROW, status: null },
      { ...CHARGED_ROW, status: "" },
      // credits_cost: a string, a float, a negative value or a missing column.
      // `null` is deliberately NOT in this list: it is a real answer (see case 6).
      { ...CHARGED_ROW, credits_cost: "10" },
      { ...CHARGED_ROW, credits_cost: 1.5 },
      { ...CHARGED_ROW, credits_cost: -1 },
      { ...CHARGED_ROW, credits_cost: Number.NaN },
      { ...CHARGED_ROW, credits_cost: undefined },
      // billing_overdue: anything but a real boolean. A truthy string would fail
      // a job that is merely late; a missing column would defer forever.
      { ...CHARGED_ROW, billing_overdue: "true" },
      { ...CHARGED_ROW, billing_overdue: 1 },
      { ...CHARGED_ROW, billing_overdue: null },
      { ...CHARGED_ROW, billing_overdue: undefined },
      { status: "queued", credits_cost: 10 },
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobBillingGateError);
      const gateError = error as JobBillingGateError;
      expect(gateError.operation).toBe(READ_BILLING_GATE);
      expect(gateError.message).toBe(
        `job billing gate failed (${READ_BILLING_GATE})`,
      );
      // A row-shape refusal happens INSIDE the transaction, so it rolls back on
      // exactly the same path as a real SQL failure.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });
});

describe("job-billing-gate-repository: the write statement", () => {
  it("case 10: writes inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(fail(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 11: binds the job id and the window, and never carries either as text", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await fail(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, TIMEOUT_SECONDS]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2");
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain(String(TIMEOUT_SECONDS));
    expect(statement?.sql).not.toContain("${");
  });

  it("case 12: the whole rule is in the predicate, and it is one UPDATE", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await fail(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    // The three predicates ARE the atomicity: only an unstarted, unbilled,
    // overdue row can be claimed, and every one of them is re-checked by the
    // database at write time rather than by this process beforehand.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("status in ('queued', 'retrying')");
    expect(sql).toContain("credits_cost is null");
    expect(sql).toContain("created_at < now() - make_interval(secs => $2)");
    expect(sql).toContain("returning id");
    // No read first: a check-then-write pair in JavaScript would re-open exactly
    // the window against a charge that is landing right now.
    expect(sql).not.toMatch(/^\s*select/im);
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
  });

  it("case 13: set names exactly the five columns a billing failure owns", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await fail(repositoryFor(harness));

    const assignments = /set([\s\S]*?)where/i.exec(
      statementText(harness.queries),
    )?.[1];
    expect(assignments?.split(",").map((part) => part.trim())).toEqual([
      "status = 'failed'",
      `error_code = '${BILLING_NOT_CONFIRMED_ERROR_CODE}'`,
      `error_message = '${BILLING_NOT_CONFIRMED_MESSAGE}'`,
      "failed_at = now()",
      "updated_at = now()",
    ]);

    // Everything else on the row — the payload, the result, the credit link, the
    // attempt counter and the other transition stamps — is not reachable from
    // this module. In particular `credits_cost` is only ever READ here (as a
    // predicate): failing a job must not rewrite what it owed.
    const setClause = assignments ?? "";
    for (const column of [
      "credits_cost",
      "credits_transaction_id",
      "attempt_count",
      "max_attempts",
      "payload",
      "result",
      "started_at",
      "completed_at",
      "canceled_at",
      "workspace_id",
      "created_by",
      "created_at",
      "project_id",
      "canvas_id",
      "session_id",
      "thread_id",
      "queue_name",
      "job_type",
    ]) {
      expect(setClause).not.toContain(column);
    }
  });

  it("case 14: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(fail(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // Zero rows is the predicate answering "somebody else got there first" — a
    // charge that just landed, or a cancel. The caller defers on it, so it must
    // not be an error and must not roll back.
    const unchanged = createHarness(() => []);
    await expect(fail(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(unchanged.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 15: more than one changed row is a fixed gate failure, not true", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }, { id: JOB_ID }]);

    const error = await fail(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobBillingGateError);
    expect((error as JobBillingGateError).operation).toBe(
      FAIL_UNBILLED_IF_OVERDUE,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("job-billing-gate-repository: refusals", () => {
  it("case 16: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "update public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await fail(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobBillingGateError);
    const gateError = error as JobBillingGateError;
    expect(gateError.operation).toBe(FAIL_UNBILLED_IF_OVERDUE);
    expect(gateError.message).toBe(
      `job billing gate failed (${FAIL_UNBILLED_IF_OVERDUE})`,
    );
    expect(gateError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(gateError.message).not.toMatch(
      /public\.|background_jobs|credits_cost|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(gateError.message).not.toContain(JOB_ID);
  });

  it("case 17: a read failure carries the read operation and rolls back", async () => {
    const failure = new Error("select status, credits_cost failed");
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobBillingGateError);
    const gateError = error as JobBillingGateError;
    expect(gateError.operation).toBe(READ_BILLING_GATE);
    expect(gateError.message).toBe(
      `job billing gate failed (${READ_BILLING_GATE})`,
    );
    expect(gateError.message).not.toMatch(/select|credits_cost|failed:/i);
    expect(gateError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 18: a connect failure is a fixed gate failure and issues no statement", async () => {
    for (const call of ["read", "fail"] as const) {
      const harness = createHarness(() => [], {
        connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
      });
      const repository = repositoryFor(harness);

      const error = await (call === "read" ? read(repository) : fail(repository))
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobBillingGateError);
      expect((error as JobBillingGateError).operation).toBe(
        call === "read" ? READ_BILLING_GATE : FAIL_UNBILLED_IF_OVERDUE,
      );
      expect((error as JobBillingGateError).message).not.toMatch(
        /ECONNREFUSED|10\.210\.134\.37/,
      );
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 19: an unusable job id or window is refused before any connection is opened", async () => {
    const jobIds: unknown[] = [undefined, "", 7, null, {}];
    const windows: unknown[] = [
      undefined,
      null,
      "600",
      1.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];

    for (const jobId of jobIds) {
      for (const method of ["read", "fail"] as const) {
        const harness = createHarness(() => [CHARGED_ROW]);
        const repository = repositoryFor(harness);
        const input = { jobId, timeoutSeconds: TIMEOUT_SECONDS } as {
          jobId: string;
          timeoutSeconds: number;
        };

        const error = await (method === "read"
          ? repository.readBillingGate(input)
          : repository.failUnbilledIfOverdue(input)
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(JobBillingGateError);
        expect(harness.connectAttempts()).toBe(0);
        expect(harness.queries).toHaveLength(0);
      }
    }

    for (const timeoutSeconds of windows) {
      for (const method of ["read", "fail"] as const) {
        const harness = createHarness(() => [CHARGED_ROW]);
        const repository = repositoryFor(harness);
        const input = { jobId: JOB_ID, timeoutSeconds } as {
          jobId: string;
          timeoutSeconds: number;
        };

        const error = await (method === "read"
          ? repository.readBillingGate(input)
          : repository.failUnbilledIfOverdue(input)
        ).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(JobBillingGateError);
        // The refusal names the FIELD, never the value: the message may not
        // become a channel for whatever the caller passed in.
        expect((error as JobBillingGateError).message).not.toContain("timeout");
        expect(harness.connectAttempts()).toBe(0);
        expect(harness.queries).toHaveLength(0);
      }
    }
  });

  it("case 20: building never resolves a pool; a missing DATABASE_URL fails on the call", async () => {
    let resolutions = 0;
    const repository = createJobBillingGateRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const readError = await read(repository).catch((reason: unknown) => reason);
    const failError = await fail(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(2);
    expect(readError).toBeInstanceOf(JobBillingGateError);
    expect(failError).toBeInstanceOf(JobBillingGateError);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    for (const error of [readError, failError]) {
      expect((error as JobBillingGateError).message).not.toMatch(
        /DATABASE_URL|postgres:\/\//,
      );
    }
  });
});
