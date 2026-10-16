import { describe, expect, it } from "vitest";

import {
  JOB_ADMIN_READ_COLUMNS,
  JobAdminReadError,
  READ_JOB,
  createJobAdminReadRepository,
  type JobAdminReadRepository,
  type JobAdminReadRow,
} from "./job-admin-read-repository.js";
import { SELECT_COLS } from "../features/jobs/job-service.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor context it carries (none), the 22 columns it
 * projects, and how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built — one SELECT, one table, one
 * bind parameter, no batch. The PGlite file beside them
 * (`test-support/db/job-admin-read-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes it against the real table, that a malformed uuid
 * rolls back and leaves the pool usable, and that the read does not move the row.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000000a1";

/**
 * The projection as the service names it. `SELECT_COLS` is the string every
 * other `background_jobs` read in `job-service.ts` passes to PostgREST, so the
 * two lists agreeing is what keeps the migrated read shape-identical.
 */
const SERVICE_COLUMNS = SELECT_COLS.split(",").map((column) => column.trim());

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

function repositoryFor(harness: Harness): JobAdminReadRepository {
  return createJobAdminReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the argument named once. */
function read(repository: JobAdminReadRepository, jobId: string = JOB_ID) {
  return repository.readJob({ jobId });
}

function requireRow(row: JobAdminReadRow | null): JobAdminReadRow {
  if (row === null) throw new Error("expected a row, got null");
  return row;
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/**
 * A row shaped the way the statement answers it: `pg` hands `timestamptz` back
 * as a `Date`, `jsonb` already parsed, the enums and integers as strings and
 * numbers. Every one of the 22 columns is present, so a case that wants drift
 * removes exactly one thing.
 */
function dbRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: JOB_ID,
    workspace_id: "00000000-0000-0000-0000-0000000000b1",
    project_id: "00000000-0000-0000-0000-0000000000c1",
    canvas_id: "00000000-0000-0000-0000-0000000000d1",
    session_id: "00000000-0000-0000-0000-0000000000e1",
    thread_id: "thread-1",
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "running",
    payload: { prompt: "a cat" },
    result: { url: "oss://bucket/key.png" },
    error_code: "executor_error",
    error_message: "boom",
    attempt_count: 2,
    max_attempts: 3,
    created_by: "00000000-0000-0000-0000-0000000000f1",
    created_at: new Date("2026-02-03T04:05:06.789Z"),
    updated_at: new Date("2026-02-03T04:06:07.890Z"),
    started_at: new Date("2026-02-03T04:05:10.000Z"),
    completed_at: new Date("2026-02-03T04:05:20.000Z"),
    failed_at: new Date("2026-02-03T04:05:30.000Z"),
    canceled_at: new Date("2026-02-03T04:05:40.000Z"),
    ...overrides,
  };
}

/** The same row with every nullable column an explicit SQL NULL. */
function nullRow(): Record<string, unknown> {
  return dbRow({
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    result: null,
    error_code: null,
    error_message: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
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

describe("job-admin-read-repository: the statement it issues", () => {
  it("case 1: reads inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no probe read, no count, no second table.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // What this case owns is the SHAPE, not the statement count. Whether the
    // four transaction settings arrive as one `set_config` each or batched into
    // a single statement is `transaction.ts`'s business and is asserted by its
    // own test; pinning the count here would silently pin this suite to whichever
    // form happened to be checked out. The committed form issues one per setting,
    // so this read is 7 statements (BEGIN, four `set_config`, the SELECT, COMMIT)
    // — workorder 21I §6.1's "4 statements" was measured against the uncommitted
    // batched variant, which is why the total is not a number this suite may fix.
    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
    // Classified by exclusion, not by name: whatever is not the transaction's own
    // BEGIN/COMMIT/`set_config` is the repository's statement, and there is
    // exactly one of them — the read, with no probe and no statement the
    // transaction never asked for.
    const domainStatements = statements.filter(
      (sql) => !isTransactionStatement(sql),
    );
    expect(domainStatements).toHaveLength(1);
    expect(domainStatements).toEqual([statementText(harness.queries)]);
    const selectIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    // Between BEGIN and the read there is context and nothing else: at least one
    // `set_config`, with no other statement interleaved among them.
    const beforeSelect = statements.slice(1, selectIndex);
    expect(beforeSelect).toContain(TRANSACTION_STATEMENTS.setLocalSetting);
    expect(
      beforeSelect.every(
        (sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting,
      ),
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
    expect(sql.replace(/\s+/g, " ").trim()).toMatch(
      /where id = \$1::uuid$/,
    );
    // Exactly one table is reachable, and no other predicate narrows or widens
    // the read: no status, no workspace, no ordering, no limit.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/join/i);
  });

  it("case 4: the projection is exactly the service's 22 columns, in its order", async () => {
    const harness = createHarness(() => [dbRow()]);

    await read(repositoryFor(harness));

    const columns = selectList(statementText(harness.queries));

    // Three lists, one truth: the statement, the module's exported list and the
    // string every other `background_jobs` read in `job-service.ts` projects. A
    // column added to one and not the others is the drift this refuses.
    expect(columns).toHaveLength(22);
    expect(columns).toEqual([...JOB_ADMIN_READ_COLUMNS]);
    expect(columns).toEqual(SERVICE_COLUMNS);
    // `SELECT_COLS` is a PostgREST projection string; this statement names the
    // same columns one per line with no alias, so the keys stay the column names.
    expect(columns).toEqual([
      "id",
      "workspace_id",
      "project_id",
      "canvas_id",
      "session_id",
      "thread_id",
      "queue_name",
      "job_type",
      "status",
      "payload",
      "result",
      "error_code",
      "error_message",
      "attempt_count",
      "max_attempts",
      "created_by",
      "created_at",
      "updated_at",
      "started_at",
      "completed_at",
      "failed_at",
      "canceled_at",
    ]);
  });
});

describe("job-admin-read-repository: the row it maps", () => {
  it("case 5: every one of the 22 columns is reported, keys in column order", async () => {
    const harness = createHarness(() => [dbRow()]);

    const row = requireRow(await read(repositoryFor(harness)));

    expect(Object.keys(row)).toEqual([...JOB_ADMIN_READ_COLUMNS]);
    expect(row).toEqual({
      id: JOB_ID,
      workspace_id: "00000000-0000-0000-0000-0000000000b1",
      project_id: "00000000-0000-0000-0000-0000000000c1",
      canvas_id: "00000000-0000-0000-0000-0000000000d1",
      session_id: "00000000-0000-0000-0000-0000000000e1",
      thread_id: "thread-1",
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "running",
      payload: { prompt: "a cat" },
      result: { url: "oss://bucket/key.png" },
      error_code: "executor_error",
      error_message: "boom",
      attempt_count: 2,
      max_attempts: 3,
      created_by: "00000000-0000-0000-0000-0000000000f1",
      created_at: "2026-02-03T04:05:06.789Z",
      updated_at: "2026-02-03T04:06:07.890Z",
      started_at: "2026-02-03T04:05:10.000Z",
      completed_at: "2026-02-03T04:05:20.000Z",
      failed_at: "2026-02-03T04:05:30.000Z",
      canceled_at: "2026-02-03T04:05:40.000Z",
    } satisfies JobAdminReadRow);
  });

  it("case 6: a Date is normalised to ISO, never passed through", async () => {
    const value = new Date("2026-02-03T04:05:06.789Z");
    const harness = createHarness(() => [
      dbRow({ created_at: value, updated_at: value, started_at: value }),
    ]);

    const row = requireRow(await read(repositoryFor(harness)));

    // The shape assertion is the point: `as string` on a Date compiles and then
    // changes what the row serialises to.
    expect(typeof row.created_at).toBe("string");
    expect(row.created_at).toBe("2026-02-03T04:05:06.789Z");
    expect(row.updated_at).toBe("2026-02-03T04:05:06.789Z");
    expect(row.started_at).toBe("2026-02-03T04:05:06.789Z");
  });

  it("case 7: an ISO string is accepted and re-normalised to UTC", async () => {
    const harness = createHarness(() => [
      dbRow({
        created_at: "2026-02-03T06:05:06.789+02:00",
        updated_at: "2026-02-03T04:05:06.789Z",
        // A driver that returned text without an offset would be drift, so the
        // parseable form always carries one.
        started_at: "2026-02-03T04:05:10Z",
      }),
    ]);

    const row = requireRow(await read(repositoryFor(harness)));

    expect(row.created_at).toBe("2026-02-03T04:05:06.789Z");
    expect(row.updated_at).toBe("2026-02-03T04:05:06.789Z");
    expect(row.started_at).toBe("2026-02-03T04:05:10.000Z");
    expect(new Date(row.created_at).getTime()).toBe(
      Date.parse("2026-02-03T04:05:06.789Z"),
    );
  });

  it("case 8: an explicit SQL NULL becomes null on every nullable column", async () => {
    const harness = createHarness(() => [nullRow()]);

    const row = requireRow(await read(repositoryFor(harness)));

    for (const column of [
      "project_id",
      "canvas_id",
      "session_id",
      "thread_id",
      "result",
      "error_code",
      "error_message",
      "started_at",
      "completed_at",
      "failed_at",
      "canceled_at",
    ] as const) {
      expect(row[column]).toBeNull();
    }
    // The required pair is unaffected: a job always has a start and an update.
    expect(row.created_at).toBe("2026-02-03T04:05:06.789Z");
    expect(row.updated_at).toBe("2026-02-03T04:06:07.890Z");
  });

  it("case 9: an ABSENT nullable column fails loud where an explicit NULL does not", async () => {
    // The 20D-fixup lesson: if "column missing" were folded into "null", a
    // projection that dropped a column would read exactly like a job with no
    // project, no error and no start time — silently losing data.
    const explicitNull = createHarness(() => [nullRow()]);
    await expect(read(repositoryFor(explicitNull))).resolves.not.toBeNull();

    for (const column of [
      "project_id",
      "canvas_id",
      "session_id",
      "thread_id",
      "result",
      "error_code",
      "error_message",
      "started_at",
      "completed_at",
      "failed_at",
      "canceled_at",
    ]) {
      const harness = createHarness(() => [removeColumn(nullRow(), column)]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobAdminReadError);
      expect((error as JobAdminReadError).operation).toBe(READ_JOB);
      // The shape refusal happens INSIDE the transaction, so it rolls back on
      // exactly the same path as a real SQL failure.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 10: an absent required column, or an empty identity, fails loud", async () => {
    const required = [
      "id",
      "workspace_id",
      "queue_name",
      "job_type",
      "status",
      "created_by",
      "created_at",
      "updated_at",
      "attempt_count",
      "max_attempts",
      "payload",
    ];

    for (const column of required) {
      const harness = createHarness(() => [removeColumn(dbRow(), column)]);

      await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobAdminReadError,
      );
    }

    for (const column of [
      "id",
      "workspace_id",
      "queue_name",
      "job_type",
      "status",
      "created_by",
    ]) {
      for (const value of ["", 7, null, {}]) {
        const harness = createHarness(() => [dbRow({ [column]: value })]);

        await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
          JobAdminReadError,
        );
      }
    }
  });

  it("case 11: timestamp drift — a number, a non-ISO string, an invalid Date", async () => {
    const answers: Array<Record<string, unknown>> = [
      { created_at: 1_770_000_000_000 },
      { created_at: "2026-02-03 04:05:06+00" },
      { created_at: "not a timestamp" },
      { created_at: new Date(Number.NaN) },
      { created_at: null },
      { updated_at: 12 },
      { updated_at: "2026-02-03" },
      { updated_at: new Date(Number.NaN) },
      { updated_at: null },
      { started_at: 1_770_000_000_000 },
      { started_at: "yesterday" },
      { started_at: new Date(Number.NaN) },
      { completed_at: {} },
      { failed_at: [] },
      { canceled_at: true },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [dbRow(drift)]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobAdminReadError);
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 12: count drift — a string, a float, a negative, NaN, null", async () => {
    const answers: Array<Record<string, unknown>> = [
      { attempt_count: "2" },
      { attempt_count: 2.5 },
      { attempt_count: -1 },
      { attempt_count: Number.NaN },
      { attempt_count: null },
      { max_attempts: "3" },
      { max_attempts: 0.5 },
      { max_attempts: -3 },
      { max_attempts: Number.POSITIVE_INFINITY },
      { max_attempts: null },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [dbRow(drift)]);

      await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobAdminReadError,
      );
    }

    // Zero is a legal count (a job that never started, a retry budget of none).
    const zero = createHarness(() => [dbRow({ attempt_count: 0 })]);
    const row = requireRow(await read(repositoryFor(zero)));
    expect(row.attempt_count).toBe(0);
  });

  it("case 13: jsonb drift — an array or a scalar is not the promised record", async () => {
    const answers: Array<Record<string, unknown>> = [
      { payload: ["a"] },
      { payload: "a cat" },
      { payload: 7 },
      { result: ["url"] },
      { result: "oss://bucket/key.png" },
      { result: false },
    ];

    for (const drift of answers) {
      const harness = createHarness(() => [dbRow(drift)]);

      await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobAdminReadError,
      );
    }

    // A nested object is passed through untouched, including its arrays.
    const nested = { prompt: "x", steps: [1, 2, { depth: "deep" }] };
    const harness = createHarness(() => [
      dbRow({ payload: nested, result: JSON.parse(JSON.stringify(nested)) }),
    ]);
    const row = requireRow(await read(repositoryFor(harness)));

    expect(row.payload).toEqual(nested);
    expect(row.result).toEqual(nested);
  });

  it("case 14: a row that is not an object is a failure, not a value", async () => {
    const answers: unknown[] = [null, "not a row", [dbRow()], 42, true];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);

      await expect(read(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobAdminReadError,
      );
    }
  });
});

describe("job-admin-read-repository: zero rows, many rows, failures", () => {
  it("case 15: zero rows is the 'no such job' answer, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(read(repositoryFor(harness))).resolves.toBeNull();

    // Unlike a write that must have moved a row, zero rows is a LEGAL answer
    // here: it is the old read's `maybeSingle()` null and the service turns it
    // into its existing 404. It must therefore not roll back, and it must not be
    // reported as a failure.
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 16: more than one row is a fixed read failure, not a first row", async () => {
    const harness = createHarness(() => [dbRow(), dbRow()]);

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAdminReadError);
    expect((error as JobAdminReadError).operation).toBe(READ_JOB);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 17: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "select ... from public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAdminReadError);
    const readError = error as JobAdminReadError;
    expect(readError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(readError.message).not.toMatch(
      /public\.|background_jobs|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(readError.message).not.toContain(JOB_ID);
  });

  it("case 18: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobAdminReadError);
    expect((error as JobAdminReadError).message).toBe(
      `job admin read failed (${READ_JOB})`,
    );
    expect((error as JobAdminReadError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 19: an unusable job id is refused before any connection is opened", async () => {
    const args: unknown[] = [undefined, "", 7, null, {}];

    for (const jobId of args) {
      const harness = createHarness(() => [dbRow()]);
      const error = await repositoryFor(harness)
        .readJob({ jobId } as { jobId: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobAdminReadError);
      expect((error as JobAdminReadError).operation).toBe(READ_JOB);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 20: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createJobAdminReadRepository({
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
    expect(error).toBeInstanceOf(JobAdminReadError);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as JobAdminReadError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });

  it("case 21: the repository exposes readJob and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);
    const repository = repositoryFor(harness);

    // There is no second method, no access token, no workspace parameter and no
    // generic filter entry point a caller could widen the read with.
    expect(Object.keys(repository)).toEqual([READ_JOB]);
    expect(repository.readJob).toHaveLength(1);

    await read(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID]);
  });
});
