import { describe, expect, it } from "vitest";

import {
  JobTransitionError,
  MARK_FAILED,
  MARK_RETRYING,
  MARK_RUNNING,
  MARK_SUCCEEDED,
  createJobTransitionRepository,
  type JobTransitionRepository,
} from "./job-transition-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the four statements
 * the repository issues, the actor context they carry (none), which columns each
 * transition may touch, and how every way those statements can answer is
 * classified.
 *
 * The unit tests prove WHICH statements are built — one guarded UPDATE per
 * method, with the `from` set and the `to` status written into the SQL text
 * rather than bound as arguments. The PGlite file beside them
 * (`test-support/db/job-transition-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes them, that the 4x6 status matrix behaves, and
 * that the guards really are the atomic rules this module claims they are.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000000c1";
const STARTED_AT = "2026-10-16T01:02:03.456Z";
const COMPLETED_AT = "2026-10-16T04:05:06.789Z";
const FAILED_AT = "2026-10-16T07:08:09.012Z";

/** Every status the column's enum carries. None of them may be a parameter. */
const ALL_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
];

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

/** The `set ... where` clause of a statement, verbatim. */
function setClause(sql: string): string {
  return /set([\s\S]*?)where/i.exec(sql)?.[1] ?? "";
}

/** The assignments of a statement, as a list of trimmed strings. */
function assignments(sql: string): string[] {
  return setClause(sql)
    .split(",")
    .map((part) => part.trim());
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

function repositoryFor(harness: Harness): JobTransitionRepository {
  return createJobTransitionRepository({
    getTransactionPool: () => harness.pool,
  });
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

function statements(harness: Harness): string[] {
  return harness.queries.map((entry) => entry.sql);
}

/** The running call, with its arguments named once. */
function running(
  repository: JobTransitionRepository,
  overrides: Record<string, unknown> = {},
) {
  return repository.markRunning({
    jobId: JOB_ID,
    startedAt: STARTED_AT,
    ...overrides,
  } as { jobId: string; startedAt: string });
}

function retrying(
  repository: JobTransitionRepository,
  overrides: Record<string, unknown> = {},
) {
  return repository.markRetrying({
    jobId: JOB_ID,
    errorCode: "executor_error",
    errorMessage: "boom",
    ...overrides,
  } as { jobId: string; errorCode: string; errorMessage: string });
}

function succeeded(
  repository: JobTransitionRepository,
  overrides: Record<string, unknown> = {},
) {
  return repository.markSucceeded({
    jobId: JOB_ID,
    result: { url: "oss://bucket/key.png" },
    completedAt: COMPLETED_AT,
    ...overrides,
  } as {
    jobId: string;
    result: Record<string, unknown>;
    completedAt: string;
  });
}

function failed(
  repository: JobTransitionRepository,
  overrides: Record<string, unknown> = {},
) {
  return repository.markFailed({
    jobId: JOB_ID,
    errorCode: "executor_error",
    errorMessage: "boom",
    failedAt: FAILED_AT,
    ...overrides,
  } as {
    jobId: string;
    errorCode: string;
    errorMessage: string;
    failedAt: string;
  });
}

/** The four calls, in one place, for the cases that treat them alike. */
function allCalls(repository: JobTransitionRepository) {
  return [
    { operation: MARK_RUNNING, run: () => running(repository) },
    { operation: MARK_RETRYING, run: () => retrying(repository) },
    { operation: MARK_SUCCEEDED, run: () => succeeded(repository) },
    { operation: MARK_FAILED, run: () => failed(repository) },
  ] as const;
}

/**
 * The context assertions are identical for all four methods, so they are written
 * once: a system worker write has no acting user, every actor setting stays
 * empty, and the mode is the explicit privileged one.
 */
function expectNoActorInPrivilegedMode(harness: Harness): void {
  const issued = statements(harness);
  expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
  expect(issued.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  expect(contextParams(harness.queries)).toEqual([
    [TRANSACTION_SETTING_NAMES.userId, ""],
    [TRANSACTION_SETTING_NAMES.workspaceId, ""],
    [TRANSACTION_SETTING_NAMES.role, ""],
    [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
  ]);
}

/** Every column outside the four transitions' own `set` clauses. */
const UNREACHABLE_COLUMNS = [
  "payload",
  "attempt_count",
  "max_attempts",
  "credits_cost",
  "credits_transaction_id",
  "workspace_id",
  "created_by",
  "created_at",
  "project_id",
  "canvas_id",
  "session_id",
  "thread_id",
  "queue_name",
  "job_type",
  "canceled_at",
];

describe("job-transition-repository: the shape of the module", () => {
  it("case 1: exposes the four transitions and nothing else", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const repository = repositoryFor(harness);

    // Requirement T1 as a shape rather than a promise: there is no fifth method,
    // no access token, no workspace parameter, no status argument, no table
    // argument and no generic patch entry point a caller could re-aim a
    // transition with.
    expect(Object.keys(repository)).toEqual([
      MARK_RUNNING,
      MARK_RETRYING,
      MARK_SUCCEEDED,
      MARK_FAILED,
    ]);
    for (const call of allCalls(repository)) {
      const method = repository[call.operation];
      expect(method).toHaveLength(1);
    }

    for (const call of allCalls(repository)) await call.run();

    // One statement per method: no read-back, no second select, no write pair.
    expect(domainCalls(harness.queries)).toHaveLength(4);
  });

  it("case 2: the four failure messages are fixed text, distinct, and carry no SQL", async () => {
    // The message is derived from the operation name only. All four are checked
    // verbatim so a later change to one of them has to change this file.
    expect(`job status transition failed (${MARK_RUNNING})`).toBe(
      "job status transition failed (markRunning)",
    );
    expect(`job status transition failed (${MARK_RETRYING})`).toBe(
      "job status transition failed (markRetrying)",
    );
    expect(`job status transition failed (${MARK_SUCCEEDED})`).toBe(
      "job status transition failed (markSucceeded)",
    );
    expect(`job status transition failed (${MARK_FAILED})`).toBe(
      "job status transition failed (markFailed)",
    );

    const failures = [
      new JobTransitionError(MARK_RUNNING, new Error("x")),
      new JobTransitionError(MARK_RETRYING, new Error("x")),
      new JobTransitionError(MARK_SUCCEEDED, new Error("x")),
      new JobTransitionError(MARK_FAILED, new Error("x")),
    ];
    for (const failure of failures) {
      expect(failure.name).toBe("JobTransitionError");
      // Neither the statement nor the row may travel with the failure. The
      // operation name is the only thing the message is built from, and it names
      // no table, no column and no SQL keyword.
      expect(failure.message).not.toMatch(
        /public\.|background_jobs|update|returning|::|uuid|2026-|'/i,
      );
      for (const column of UNREACHABLE_COLUMNS) {
        expect(failure.message).not.toContain(column);
      }
    }
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(4);
    expect(failures.map((failure) => failure.operation)).toEqual([
      MARK_RUNNING,
      MARK_RETRYING,
      MARK_SUCCEEDED,
      MARK_FAILED,
    ]);
  });

  it("case 3: no status is ever a bind parameter, in any of the four statements", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const repository = repositoryFor(harness);

    for (const call of allCalls(repository)) await call.run();

    const issued = domainCalls(harness.queries);
    expect(issued).toHaveLength(4);

    for (const statement of issued) {
      // The state machine is SQL text: every statement names the statuses it
      // guards on and the one it writes...
      expect(
        ALL_STATUSES.some((status) => statement.sql.includes(`'${status}'`)),
      ).toBe(true);
      // ...and no status is ever a bound value. A `from` list travelling as a
      // parameter is exactly the shape this migration removes.
      for (const status of ALL_STATUSES) {
        expect([...(statement.params ?? [])]).not.toContain(status);
      }
    }

    // Each statement names the statuses it guards on, in its own text.
    expect(issued[0]?.sql).toContain("status in ('queued', 'retrying')");
    expect(issued[1]?.sql).toContain("status = 'running'");
    expect(issued[2]?.sql).toContain("status = 'running'");
    expect(issued[3]?.sql).toContain("status in ('queued', 'running', 'retrying')");
  });

  it("case 4: extra arguments cannot re-aim a transition — the statements are byte-identical", async () => {
    const plainHarness = createHarness(() => [{ id: JOB_ID }]);
    const plain = repositoryFor(plainHarness);
    await allCalls(plain)[0].run();
    await allCalls(plain)[1].run();
    await allCalls(plain)[2].run();
    await allCalls(plain)[3].run();

    // The shape of the removed API: a caller-chosen `from` array and a
    // caller-chosen patch object. Both are ignored, because neither is read.
    const forgedHarness = createHarness(() => [{ id: JOB_ID }]);
    const forged = repositoryFor(forgedHarness);
    await running(forged, {
      from: ["succeeded"],
      patch: { status: "canceled" },
      status: "canceled",
    });
    await retrying(forged, { from: ["queued"], patch: { status: "succeeded" } });
    await succeeded(forged, { from: ["queued"], patch: { failed_at: FAILED_AT } });
    await failed(forged, { from: ["succeeded"], patch: { status: "succeeded" } });

    expect(domainCalls(forgedHarness.queries).map((entry) => entry.sql)).toEqual(
      domainCalls(plainHarness.queries).map((entry) => entry.sql),
    );
  });
});

describe("job-transition-repository: markRunning", () => {
  it("case 5: writes inside one privileged transaction with NO actor, binding the id and the instant", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(running(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, STARTED_AT]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2::timestamptz");
    // The values are binds, never text spliced into the statement.
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain(STARTED_AT);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 6: the guard is exactly queued/retrying and the write owns exactly two columns", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await running(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    // The whole rule, re-checked by the database at write time: a running,
    // terminal or cancelled row is not startable, so its status is left alone.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("status in ('queued', 'retrying')");
    expect(sql).toContain("returning id");
    expect(sql.trim().endsWith("returning id")).toBe(true);
    expect(sql).not.toMatch(/^\s*select/im);
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);

    expect(assignments(sql)).toEqual([
      "status = 'running'",
      "started_at = $2::timestamptz",
    ]);

    // `error_code`/`error_message` are left alone on purpose (this attempt is a
    // retry of an earlier failure), and `updated_at` is not this statement's
    // column: the table's BEFORE UPDATE trigger stamps it.
    for (const column of [
      ...UNREACHABLE_COLUMNS,
      "error_code",
      "error_message",
      "failed_at",
      "completed_at",
      "updated_at",
    ]) {
      expect(setClause(sql)).not.toContain(column);
    }
  });

  it("case 7: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(running(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // Zero rows is the guard answering "this row is not startable": it was
    // cancelled or already finished, or does not exist. Folding it into an error
    // would strand the message instead of letting the caller retire it.
    const unchanged = createHarness(() => []);
    await expect(running(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(unchanged)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 8: an unusable instant is refused before any connection is opened", async () => {
    for (const startedAt of [
      "yesterday",
      "2026-10-16",
      "2026-10-16 01:02:03",
      "2026-10-16T01:02:03Z",
      1_760_000_000_000,
      new Date(STARTED_AT),
      null,
      undefined,
      "",
    ]) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const error = await running(repositoryFor(harness), { startedAt }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(MARK_RUNNING);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });
});

describe("job-transition-repository: markRetrying", () => {
  it("case 9: writes inside one privileged transaction with NO actor, binding three values", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(retrying(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, "executor_error", "boom"]);
    expect(statement?.sql).not.toContain("executor_error");
    expect(statement?.sql).not.toContain("boom");
  });

  it("case 10: it is running-only, and it never writes failed_at", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await retrying(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    expect(sql).toContain("where id = $1::uuid");
    // `retrying` is not a terminal state (GN-30), so the column a terminal
    // failure owns must not appear anywhere in this statement.
    expect(sql).toContain("status = 'running'");
    expect(sql).not.toContain("failed_at");
    expect(sql).not.toContain("completed_at");
    expect(sql).toContain("returning id");
    expect(sql.trim().endsWith("returning id")).toBe(true);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);

    expect(assignments(sql)).toEqual([
      "status = 'retrying'",
      "error_code = $2",
      "error_message = $3",
    ]);

    for (const column of [...UNREACHABLE_COLUMNS, "started_at", "updated_at"]) {
      expect(setClause(sql)).not.toContain(column);
    }
  });

  it("case 11: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(retrying(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    const unchanged = createHarness(() => []);
    await expect(retrying(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("case 12: a non-string error field is refused before any connection is opened", async () => {
    for (const [field, value] of [
      ["errorCode", undefined],
      ["errorCode", null],
      ["errorCode", 7],
      ["errorCode", {}],
      ["errorMessage", undefined],
      ["errorMessage", null],
      ["errorMessage", ["boom"]],
    ] as const) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const error = await retrying(repositoryFor(harness), {
        [field]: value,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(MARK_RETRYING);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 13: an EMPTY error field is a real string and is bound as one", async () => {
    // `processJobMessage` derives the code and the message from an arbitrary
    // thrown value, so an empty string is reachable and the previous writer
    // stored it verbatim. Refusing it here would be a behaviour change hidden
    // inside a migration — what must never happen is a NULL, because that ERASES
    // the recorded failure.
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(
      retrying(repositoryFor(harness), { errorCode: "", errorMessage: "" }),
    ).resolves.toBe(true);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID, "", ""]);
  });
});

describe("job-transition-repository: markSucceeded", () => {
  it("case 14: writes inside one privileged transaction with NO actor, binding the id, the document and the instant", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(succeeded(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([
      JOB_ID,
      JSON.stringify({ url: "oss://bucket/key.png" }),
      COMPLETED_AT,
    ]);
    expect(statement?.sql).toContain("$2::jsonb");
    expect(statement?.sql).toContain("$3::timestamptz");
  });

  it("case 15: the document is bound as a JSON STRING, never as the JavaScript value", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const result = {
      images: ["a.png", "b.png"],
      meta: { width: 512, layers: [{ depth: "deep" }] },
    };

    await succeeded(repositoryFor(harness), { result });

    const bound = domainCalls(harness.queries)[0]?.params?.[1];
    expect(typeof bound).toBe("string");
    expect(bound).not.toBe(result);
    // A nested array is the 2026-10-15 incident: handed to the driver
    // unserialised, it becomes a PostgreSQL array literal instead of JSON.
    expect(JSON.parse(String(bound))).toEqual(result);
    expect(String(bound).startsWith("{")).toBe(true);
  });

  it("case 16: it is running-only, and the write owns exactly three columns", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await succeeded(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("status = 'running'");
    expect(sql).toContain("returning id");
    expect(sql.trim().endsWith("returning id")).toBe(true);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);

    expect(assignments(sql)).toEqual([
      "status = 'succeeded'",
      "result = $2::jsonb",
      "completed_at = $3::timestamptz",
    ]);

    for (const column of [...UNREACHABLE_COLUMNS, "failed_at", "updated_at"]) {
      expect(setClause(sql)).not.toContain(column);
    }
  });

  it("case 17: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(succeeded(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // Cancelled while the executor was running: the user's status is kept and
    // this write changes nothing, which the caller reports as "left as is".
    const unchanged = createHarness(() => []);
    await expect(succeeded(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("case 18: an array, null or string result is refused before any connection is opened", async () => {
    for (const result of [
      ["a.png"],
      [],
      null,
      undefined,
      "oss://bucket/key.png",
      42,
      new Date(COMPLETED_AT),
      new Map([["url", "x"]]),
      new Set(["x"]),
    ]) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const error = await succeeded(repositoryFor(harness), { result }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(MARK_SUCCEEDED);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 19: a prototype-less object is still a document, and an object literal is the normal case", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const bare: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    bare.url = "oss://bucket/key.png";

    await expect(succeeded(repositoryFor(harness), { result: bare })).resolves.toBe(
      true,
    );
    expect(domainCalls(harness.queries)[0]?.params?.[1]).toBe(
      JSON.stringify(bare),
    );
  });

  it("case 20: an unusable instant is refused before any connection is opened", async () => {
    for (const completedAt of ["2026-10-16T04:05:06Z", "tomorrow", 0, null]) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const error = await succeeded(repositoryFor(harness), { completedAt }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(MARK_SUCCEEDED);
      expect(harness.connectAttempts()).toBe(0);
    }
  });
});

describe("job-transition-repository: markFailed", () => {
  it("case 21: writes inside one privileged transaction with NO actor, binding four values", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(failed(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, "executor_error", "boom", FAILED_AT]);
    expect(statement?.sql).toContain("$4::timestamptz");
    expect(statement?.sql).not.toContain(FAILED_AT);
  });

  it("case 22: the guard accepts every non-terminal state and the write owns four columns", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await failed(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("status in ('queued', 'running', 'retrying')");
    // `canceled` and `succeeded` are deliberately absent: a cancelled job keeps
    // the user's own status, and a finished one is already answered.
    expect(sql).not.toContain("'canceled'");
    expect(sql).not.toContain("'succeeded'");
    expect(sql).toContain("returning id");
    expect(sql.trim().endsWith("returning id")).toBe(true);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);

    expect(assignments(sql)).toEqual([
      "status = 'failed'",
      "error_code = $2",
      "error_message = $3",
      "failed_at = $4::timestamptz",
    ]);

    for (const column of [...UNREACHABLE_COLUMNS, "started_at", "updated_at"]) {
      expect(setClause(sql)).not.toContain(column);
    }
  });

  it("case 23: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(failed(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // THE refund boundary: `false` is what stops the worker from paying the same
    // charge twice, so a zero-row write must answer false — and COMMIT, because
    // the guard answering "not mine" is a normal race, not a broken write.
    const unchanged = createHarness(() => []);
    await expect(failed(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(unchanged)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 24: an unusable instant is refused before any connection is opened", async () => {
    for (const failedAt of ["", "2026-10-16T07:08:09+00:00", {}, []]) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const error = await failed(repositoryFor(harness), { failedAt }).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(MARK_FAILED);
      expect(harness.connectAttempts()).toBe(0);
    }
  });
});

describe("job-transition-repository: refusals", () => {
  it("case 25: more than one changed row is a fixed failure, not true, on all four", async () => {
    for (const call of [
      { operation: MARK_RUNNING, run: running },
      { operation: MARK_RETRYING, run: retrying },
      { operation: MARK_SUCCEEDED, run: succeeded },
      { operation: MARK_FAILED, run: failed },
    ] as const) {
      const harness = createHarness(() => [{ id: JOB_ID }, { id: JOB_ID }]);
      const repository = repositoryFor(harness);

      const error = await call.run(repository).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(call.operation);
      // A write that answered two rows has not answered: the transaction must be
      // rolled back rather than half-applied.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 26: an unusable job id is refused before any connection is opened, on all four", async () => {
    for (const jobId of [undefined, "", 7, null, {}, []]) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const repository = repositoryFor(harness);

      const errors = await Promise.all(
        [
          // Spelled out rather than routed through the helpers: those carry a
          // default id, and a default would turn `undefined` back into a usable
          // value.
          repository.markRunning({ jobId, startedAt: STARTED_AT } as {
            jobId: string;
            startedAt: string;
          }),
          repository.markRetrying({
            jobId,
            errorCode: "executor_error",
            errorMessage: "boom",
          } as { jobId: string; errorCode: string; errorMessage: string }),
          repository.markSucceeded({
            jobId,
            result: {},
            completedAt: COMPLETED_AT,
          } as { jobId: string; result: Record<string, unknown>; completedAt: string }),
          repository.markFailed({
            jobId,
            errorCode: "executor_error",
            errorMessage: "boom",
            failedAt: FAILED_AT,
          } as {
            jobId: string;
            errorCode: string;
            errorMessage: string;
            failedAt: string;
          }),
        ].map((call) => call.catch((reason: unknown) => reason)),
      );

      for (const error of errors) {
        expect(error).toBeInstanceOf(JobTransitionError);
      }
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 27: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "update public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await failed(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobTransitionError);
    const transitionError = error as JobTransitionError;
    expect(transitionError.operation).toBe(MARK_FAILED);
    expect(transitionError.message).toBe(
      `job status transition failed (${MARK_FAILED})`,
    );
    expect(transitionError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(transitionError.message).not.toMatch(
      /public\.|background_jobs|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(transitionError.message).not.toContain(JOB_ID);
  });

  it("case 28: a connect failure is a fixed failure and issues no statement", async () => {
    for (const call of [
      { operation: MARK_RUNNING, run: running },
      { operation: MARK_RETRYING, run: retrying },
      { operation: MARK_SUCCEEDED, run: succeeded },
      { operation: MARK_FAILED, run: failed },
    ] as const) {
      const harness = createHarness(() => [], {
        connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
      });
      const repository = repositoryFor(harness);

      const error = await call.run(repository).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobTransitionError);
      expect((error as JobTransitionError).operation).toBe(call.operation);
      expect((error as JobTransitionError).message).not.toMatch(
        /ECONNREFUSED|10\.210\.134\.37/,
      );
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 29: building never resolves a pool; a missing DATABASE_URL fails on the call", async () => {
    let resolutions = 0;
    const repository = createJobTransitionRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const errors = await Promise.all(
      allCalls(repository).map((call) =>
        call.run().catch((reason: unknown) => reason),
      ),
    );

    expect(resolutions).toBe(4);
    for (const error of errors) {
      expect(error).toBeInstanceOf(JobTransitionError);
      // The fixed message is the only thing a caller may surface: no connection
      // string, no environment variable name.
      expect((error as JobTransitionError).message).not.toMatch(
        /DATABASE_URL|postgres:\/\//,
      );
    }
  });

  it("case 30: every statement is one guarded UPDATE of the one table, with nothing after it", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const repository = repositoryFor(harness);

    for (const call of allCalls(repository)) await call.run();

    for (const statement of domainCalls(harness.queries)) {
      expect(statement.sql).toContain("update public.background_jobs");
      expect(statement.sql).toContain("where id = $1::uuid");
      expect(statement.sql).toContain("returning id");
      // One statement, so there is no read-then-write window a second worker
      // could slip into, and no second write behind a `;`.
      expect(statement.sql.match(/public\.[a-z_]+/g)).toEqual([
        "public.background_jobs",
      ]);
      expect(statement.sql).not.toContain(";");
      expect(statement.sql).not.toMatch(/^\s*select/im);
      // `updated_at` belongs to the table's trigger, not to any of these.
      expect(statement.sql).not.toContain("updated_at");
    }
  });
});
