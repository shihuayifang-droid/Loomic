import { describe, expect, it } from "vitest";

import {
  JOB_OWNER_READ_COLUMNS,
  JobOwnerReadError,
  LIST_OWN_JOBS,
  LIST_OWN_JOBS_LIMIT,
  READ_OWN_JOB,
  createJobOwnerReadRepository,
  type JobOwnerReadRepository,
  type JobOwnerReadRow,
} from "./job-owner-read-repository.js";
import { SELECT_COLS } from "../features/jobs/job-service.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the two statements
 * the repository issues, the actor context they carry, the 22 columns they
 * project, and how the repository classifies every way those statements can
 * answer.
 *
 * The unit tests prove WHICH statement is built — one SELECT, one table, the
 * ACL written into the predicate, the filter values bound WITH their enum casts,
 * no batch and no dynamic SQL. The PGlite file beside them
 * (`test-support/db/job-owner-read-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes them against the real table, that the answers
 * match what RLS answered for the same identity, and that an invalid filter
 * value fails instead of quietly matching nothing.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000a2";
const JOB_ID = "00000000-0000-0000-0000-0000000000b1";

/**
 * The projection as the service names it. `SELECT_COLS` is the string the other
 * `background_jobs` reads in `job-service.ts` still pass to PostgREST, so the
 * three lists agreeing is what keeps the migrated reads shape-identical.
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
 * The repository's own statements, and only them: BEGIN/COMMIT/set_config carry
 * no schema-qualified name, so anything naming `public.background_jobs` is a
 * domain statement. A second one would mean a read was split (a probe first,
 * then the rows) or that the repository issued something nobody asked for.
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public.background_jobs"));
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

function repositoryFor(harness: Harness): JobOwnerReadRepository {
  return createJobOwnerReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

/**
 * The two calls every case below makes, with each argument named once.
 *
 * A field that is PRESENT is passed through verbatim — `undefined` included — so
 * a case can hand the repository an unusable value on purpose. Only an absent
 * field falls back to the valid default.
 */
function readOwn(
  repository: JobOwnerReadRepository,
  input: { actorId?: unknown; jobId?: unknown } = {},
) {
  return repository.readOwnJob({
    actorId: "actorId" in input ? input.actorId : ACTOR_ID,
    jobId: "jobId" in input ? input.jobId : JOB_ID,
  } as { actorId: string; jobId: string });
}

function listOwn(
  repository: JobOwnerReadRepository,
  input: { actorId?: unknown; status?: unknown; jobType?: unknown } = {},
) {
  return repository.listOwnJobs({
    actorId: "actorId" in input ? input.actorId : ACTOR_ID,
    status: "status" in input ? input.status : null,
    jobType: "jobType" in input ? input.jobType : null,
  } as { actorId: string; status: string | null; jobType: string | null });
}

function requireRow(row: JobOwnerReadRow | null): JobOwnerReadRow {
  if (row === null) throw new Error("expected a row, got null");
  return row;
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/**
 * A row shaped the way the statements answer it: `pg` hands `timestamptz` back
 * as a `Date`, `jsonb` already parsed, the enums and integers as strings and
 * numbers. Every one of the 22 columns is present, so a case that wants drift
 * removes exactly one thing.
 */
function dbRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: JOB_ID,
    workspace_id: "00000000-0000-0000-0000-0000000000c1",
    project_id: "00000000-0000-0000-0000-0000000000c2",
    canvas_id: "00000000-0000-0000-0000-0000000000c3",
    session_id: "00000000-0000-0000-0000-0000000000c4",
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
    created_by: ACTOR_ID,
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

describe("job-owner-read-repository: the statements it issues", () => {
  it("case 1: readOwnJob runs inside one privileged transaction, AS the caller", async () => {
    const harness = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // What this case owns is the SHAPE, not the statement count. Whether the
    // four transaction settings arrive as one `set_config` each or batched into a
    // single statement is `transaction.ts`'s business and is asserted by its own
    // test; pinning the count here would silently pin this suite to whichever
    // form happened to be checked out.
    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
    const domainStatements = statements.filter(
      (sql) => !isTransactionStatement(sql),
    );
    expect(domainStatements).toEqual([statementText(harness.queries)]);
    const selectIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    const beforeSelect = statements.slice(1, selectIndex);
    expect(beforeSelect).toContain(TRANSACTION_STATEMENTS.setLocalSetting);
    expect(
      beforeSelect.every((sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting),
    ).toBe(true);
    expect(statements[selectIndex + 1]).toBe(TRANSACTION_STATEMENTS.commit);

    // The actor is the CALLER, not an empty system context: the read is
    // attributable, even though the statement's own predicate is what decides
    // which rows exist. The mode is the explicit privileged label.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ACTOR_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: listOwnJobs runs inside the same privileged transaction, and the actor is the bound value", async () => {
    const harness = createHarness(() => [dbRow()]);

    await listOwn(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(domainCalls(harness.queries)).toHaveLength(1);

    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ACTOR_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);

    // The actor the context carries is the SAME value the statement binds, so the
    // session label and the ACL can never disagree.
    expect(domainCalls(harness.queries)[0]?.params?.[0]).toBe(ACTOR_ID);
  });

  it("case 3: readOwnJob binds the actor and the job id, never as statement text", async () => {
    const harness = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    // Position matters and is part of the contract: $1 is the ACL value, $2 the
    // row key.
    expect(statement?.params).toEqual([ACTOR_ID, JOB_ID]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2::uuid");
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 4: readOwnJob's predicate is the id AND the actor, and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toMatch(/from public\.background_jobs/);
    expect(sql.replace(/\s+/g, " ").trim()).toMatch(
      /where id = \$2::uuid and created_by = \$1::uuid$/,
    );
    // Exactly one table is reachable, and no other predicate narrows or widens
    // the read: no status, no workspace, no ordering, no limit.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/join/i);
  });

  it("case 5: listOwnJobs writes the ACL, the order and the cap into the statement", async () => {
    const harness = createHarness(() => [dbRow()]);

    await listOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);
    const flat = sql.replace(/\s+/g, " ").trim();

    expect(flat).toMatch(/where created_by = \$1::uuid/);
    expect(flat).toMatch(/order by created_at desc limit 50$/);
    // The 50 is literal statement text, never a placeholder a caller could bind.
    expect(LIST_OWN_JOBS_LIMIT).toBe(50);
    expect(flat).toContain("limit 50");
    expect(sql).not.toContain("$4");
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/\boffset\b/i);
  });

  it("case 6: both filter values are bound WITH their enum cast, never as text", async () => {
    const harness = createHarness(() => [dbRow()]);

    await listOwn(repositoryFor(harness), { status: "queued", jobType: "image_generation" });

    const sql = statementText(harness.queries);
    const flat = sql.replace(/\s+/g, " ");

    // The cast is the whole reason an unknown value stays a 500 instead of
    // quietly matching nothing: as text, `status = 'bogus'` is a valid comparison
    // that answers zero rows.
    expect(flat).toContain("$2::public.background_job_status");
    expect(flat).toContain("$3::public.background_job_type");
    expect(flat).toMatch(
      /\(\s*\$3::public\.background_job_type is null or job_type = \$3::public\.background_job_type\s*\)/,
    );

    // No text comparison anywhere: neither parameter is compared as text, and
    // neither filter value is written into the statement.
    expect(sql).not.toContain("::text");
    expect(sql).not.toContain("queued");
    expect(sql).not.toContain("image_generation");

    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      ACTOR_ID,
      "queued",
      "image_generation",
    ]);
  });

  it("case 7: the status filter is ONE statement with `is null or`, and `failed` admits dead_letter", async () => {
    const harness = createHarness(() => [dbRow()]);

    await listOwn(repositoryFor(harness), { status: "failed" });

    const sql = statementText(harness.queries);
    const flat = sql.replace(/\s+/g, " ");

    // All four filter combinations are fixed in one statement: there is no
    // call-site branch that appends a clause, which is what would make the SQL
    // differ per request.
    expect(flat).toContain("$2::public.background_job_status is null");
    expect(flat).toContain("or status = $2::public.background_job_status");
    expect(flat).toContain(
      "or ($2::public.background_job_status = 'failed' and status = 'dead_letter')",
    );

    // And the legacy value stays in the statement even when the caller filtered
    // by something else — the statement is the same text either way.
    const other = createHarness(() => [dbRow()]);
    await listOwn(repositoryFor(other), { status: "queued" });
    expect(statementText(other.queries)).toBe(sql);
    expect(statementText(other.queries)).toContain("'dead_letter'");
  });

  it("case 8: no membership check exists in either statement", async () => {
    const read = createHarness(() => [dbRow()]);
    const list = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(read));
    await listOwn(repositoryFor(list));

    for (const sql of [statementText(read.queries), statementText(list.queries)]) {
      // The RLS policy this replaces reads `auth.uid() = created_by` and nothing
      // else. A membership predicate would hide a user's own history from them
      // after they leave the team, so it must not appear here — not even as a
      // subquery.
      expect(sql).not.toMatch(/workspace_members/i);
      expect(sql).not.toMatch(/is_workspace_member|can_read|auth\.uid/i);
      expect(sql).not.toMatch(/\bexists\b/i);
      // And exactly one table is ever reachable.
      expect(sql.match(/from\s+[a-z_.]+/gi)).toEqual([
        "from public.background_jobs",
      ]);
    }
  });

  it("case 9: the projection is exactly the service's 22 columns, in its order", async () => {
    const read = createHarness(() => [dbRow()]);
    const list = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(read));
    await listOwn(repositoryFor(list));

    for (const sql of [statementText(read.queries), statementText(list.queries)]) {
      const columns = selectList(sql);

      // Three lists, one truth: the statement, the module's exported list and the
      // string the remaining `background_jobs` reads in `job-service.ts` project.
      // A column added to one and not the others is the drift this refuses.
      expect(columns).toHaveLength(22);
      expect(columns).toEqual([...JOB_OWNER_READ_COLUMNS]);
      expect(columns).toEqual(SERVICE_COLUMNS);
    }

    // The two statements project the SAME list, so `getJob` and `listJobs` cannot
    // disagree about a row's shape.
    expect(selectList(statementText(read.queries))).toEqual(
      selectList(statementText(list.queries)),
    );
    expect(
      selectList(statementText(read.queries)).map((column) => column.trim()),
    ).toEqual([
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

  it("case 10: the repository exposes the two owner reads and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);
    const repository = repositoryFor(harness);

    // No access token, no workspace parameter, no ordering and no page size a
    // caller could widen the read with.
    expect(Object.keys(repository)).toEqual([READ_OWN_JOB, LIST_OWN_JOBS]);
    expect(repository.readOwnJob).toHaveLength(1);
    expect(repository.listOwnJobs).toHaveLength(1);

    await readOwn(repository);
    await listOwn(repository);

    expect(domainCalls(harness.queries)).toHaveLength(2);
  });
});

describe("job-owner-read-repository: the rows it maps", () => {
  it("case 11: readOwnJob reports all 22 columns, keyed in column order", async () => {
    const harness = createHarness(() => [dbRow()]);

    const row = requireRow(await readOwn(repositoryFor(harness)));

    expect(Object.keys(row)).toEqual([...JOB_OWNER_READ_COLUMNS]);
    expect(row).toEqual({
      id: JOB_ID,
      workspace_id: "00000000-0000-0000-0000-0000000000c1",
      project_id: "00000000-0000-0000-0000-0000000000c2",
      canvas_id: "00000000-0000-0000-0000-0000000000c3",
      session_id: "00000000-0000-0000-0000-0000000000c4",
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
      created_by: ACTOR_ID,
      created_at: "2026-02-03T04:05:06.789Z",
      updated_at: "2026-02-03T04:06:07.890Z",
      started_at: "2026-02-03T04:05:10.000Z",
      completed_at: "2026-02-03T04:05:20.000Z",
      failed_at: "2026-02-03T04:05:30.000Z",
      canceled_at: "2026-02-03T04:05:40.000Z",
    } satisfies JobOwnerReadRow);
  });

  it("case 12: listOwnJobs maps EVERY row, in the order the database answered", async () => {
    const rows = [
      dbRow({ id: "job-3", status: "failed" }),
      dbRow({ id: "job-2", status: "dead_letter" }),
      dbRow({ id: "job-1", status: "queued" }),
    ];
    const harness = createHarness(() => rows);

    const mapped = await listOwn(repositoryFor(harness));

    expect(mapped.map((row) => row.id)).toEqual(["job-3", "job-2", "job-1"]);
    expect(mapped.map((row) => row.status)).toEqual([
      "failed",
      "dead_letter",
      "queued",
    ]);
    for (const row of mapped) {
      expect(Object.keys(row)).toEqual([...JOB_OWNER_READ_COLUMNS]);
    }
    // The mapping is not a shallow copy of the array: the timestamps really were
    // normalised on every element.
    expect(mapped[0]?.created_at).toBe("2026-02-03T04:05:06.789Z");
    expect(mapped[2]?.updated_at).toBe("2026-02-03T04:06:07.890Z");
  });

  it("case 13: a legacy dead_letter row leaves here RAW", async () => {
    const harness = createHarness(() => [dbRow({ status: "dead_letter" })]);
    const list = createHarness(() => [dbRow({ status: "dead_letter" })]);

    // The translation to `failed` belongs to `JobService.mapJobRow` and stays
    // there: moving it into the repository would let `getJob` and `listJobs`
    // drift away from `getJobAdmin`.
    expect(
      (await readOwn(repositoryFor(harness)))?.status,
    ).toBe("dead_letter");
    expect((await listOwn(repositoryFor(list)))[0]?.status).toBe("dead_letter");
  });

  it("case 14: an explicit SQL NULL becomes null, and an ABSENT column fails loud", async () => {
    const nulled = createHarness(() => [nullRow()]);
    const row = requireRow(await readOwn(repositoryFor(nulled)));

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
      expect([column, row[column]]).toEqual([column, null]);
    }

    // The 20D-fixup lesson, on BOTH methods: if "column missing" were folded into
    // "null", a projection that dropped a column would read exactly like a job
    // with no project, no error and no start time.
    for (const column of [
      "project_id",
      "thread_id",
      "result",
      "started_at",
      "canceled_at",
    ]) {
      const missing = createHarness(() => [removeColumn(nullRow(), column)]);
      const error = await readOwn(repositoryFor(missing)).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(JobOwnerReadError);
      expect((error as JobOwnerReadError).operation).toBe(READ_OWN_JOB);
      expect(lastStatement(missing)).toBe(TRANSACTION_STATEMENTS.rollback);

      const inList = createHarness(() => [
        dbRow(),
        removeColumn(nullRow(), column),
      ]);
      await expect(listOwn(repositoryFor(inList))).rejects.toBeInstanceOf(
        JobOwnerReadError,
      );
      // One bad row fails the whole list rather than dropping it: a silently
      // shorter list is not the answer the caller asked for.
      expect(lastStatement(inList)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 15: timestamp, count and jsonb drift all fail loud, on both methods", async () => {
    const drift: Array<Record<string, unknown>> = [
      { created_at: 1_770_000_000_000 },
      { created_at: "2026-02-03 04:05:06+00" },
      { created_at: "not a timestamp" },
      { created_at: new Date(Number.NaN) },
      { created_at: null },
      { updated_at: "2026-02-03" },
      { started_at: {} },
      { completed_at: [] },
      { failed_at: true },
      { canceled_at: "yesterday" },
      { attempt_count: "2" },
      { attempt_count: 2.5 },
      { attempt_count: -1 },
      { max_attempts: Number.NaN },
      { payload: ["a"] },
      { payload: "a cat" },
      { result: 7 },
    ];

    for (const overrides of drift) {
      const harness = createHarness(() => [dbRow(overrides)]);
      await expect(readOwn(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobOwnerReadError,
      );

      const list = createHarness(() => [dbRow(overrides)]);
      await expect(listOwn(repositoryFor(list))).rejects.toBeInstanceOf(
        JobOwnerReadError,
      );
    }

    // A zero count is a legal count, not drift.
    const zero = createHarness(() => [dbRow({ attempt_count: 0 })]);
    expect((await readOwn(repositoryFor(zero)))?.attempt_count).toBe(0);
  });

  it("case 16: a row that is not an object is a failure, not a value", async () => {
    const answers: unknown[] = [null, "not a row", [dbRow()], 42, true];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      await expect(readOwn(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobOwnerReadError,
      );

      const list = createHarness(() => [answer]);
      await expect(listOwn(repositoryFor(list))).rejects.toBeInstanceOf(
        JobOwnerReadError,
      );
    }
  });
});

describe("job-owner-read-repository: zero rows, unusable arguments, failures", () => {
  it("case 17: zero rows is the 'no such job for this actor' answer, and it commits", async () => {
    const harness = createHarness(() => []);

    // The other user's job reads exactly like a job that does not exist — which
    // is what the RLS policy produced too, and what the service's 404 publishes.
    await expect(readOwn(repositoryFor(harness))).resolves.toBeNull();

    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 18: an empty list is a legal answer, and it commits", async () => {
    const harness = createHarness(() => []);

    await expect(listOwn(repositoryFor(harness))).resolves.toEqual([]);

    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 19: more than one row from the single-row read is a fixed failure", async () => {
    const harness = createHarness(() => [dbRow(), dbRow()]);

    const error = await readOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerReadError);
    expect((error as JobOwnerReadError).operation).toBe(READ_OWN_JOB);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 20: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "invalid input value for enum background_job_status: \"bogus\" | " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await listOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerReadError);
    const readError = error as JobOwnerReadError;
    expect(readError.operation).toBe(LIST_OWN_JOBS);
    expect(readError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(readError.message).not.toMatch(
      /public\.|background_jobs|postgres:\/\/|10\.210\.134\.37|secret|bogus/i,
    );
    // Neither the actor nor the job id reaches the message: a failure is not a
    // lookup.
    expect(readError.message).not.toContain(ACTOR_ID);
    expect(readError.message).not.toContain(JOB_ID);
  });

  it("case 21: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await readOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerReadError);
    expect((error as JobOwnerReadError).message).toBe(
      `job owner read failed (${READ_OWN_JOB})`,
    );
    expect((error as JobOwnerReadError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 22: an unusable actor or job id is refused before any connection is opened", async () => {
    for (const actorId of [undefined, "", 7, null, {}]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await readOwn(repositoryFor(harness), {
        actorId: actorId as string,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerReadError);
      expect((error as JobOwnerReadError).operation).toBe(READ_OWN_JOB);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    for (const jobId of [undefined, "", 7, null, {}]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await readOwn(repositoryFor(harness), {
        jobId: jobId as string,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerReadError);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    // A malformed but non-empty id is NOT refused here: it is bound as `::uuid`,
    // so PostgreSQL rejects it inside the transaction and the rollback path is
    // exercised instead of hidden.
    const malformed = createHarness(() => [dbRow()]);
    await expect(
      readOwn(repositoryFor(malformed), { jobId: "not-a-uuid" }),
    ).resolves.not.toBeNull();
    expect(domainCalls(malformed.queries)[0]?.params).toEqual([
      ACTOR_ID,
      "not-a-uuid",
    ]);
  });

  it("case 23: null filters are a VALUE — the statement stays one statement", async () => {
    const bothNull = createHarness(() => [dbRow()]);
    await listOwn(repositoryFor(bothNull));

    // `null` means "no filter on this column" and is BOUND as null, so the
    // statement's text is identical to the filtered one.
    expect(domainCalls(bothNull.queries)[0]?.params).toEqual([
      ACTOR_ID,
      null,
      null,
    ]);
    expect(domainCalls(bothNull.queries)).toHaveLength(1);

    const filtered = createHarness(() => [dbRow()]);
    await listOwn(repositoryFor(filtered), { status: "failed", jobType: null });
    expect(statementText(filtered.queries)).toBe(
      statementText(bothNull.queries),
    );
    expect(domainCalls(filtered.queries)[0]?.params).toEqual([
      ACTOR_ID,
      "failed",
      null,
    ]);
  });

  it("case 24: an unusable filter value is refused before any connection is opened", async () => {
    // `undefined` is NOT the same as `null`: the service always passes both keys
    // explicitly, so a missing one is a caller that would otherwise get the
    // unfiltered list by accident.
    for (const status of [undefined, "", 7, {}, []]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await listOwn(repositoryFor(harness), {
        status: status as string | null,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerReadError);
      expect((error as JobOwnerReadError).operation).toBe(LIST_OWN_JOBS);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    for (const jobType of [undefined, "", 7, {}, []]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await listOwn(repositoryFor(harness), {
        jobType: jobType as string | null,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerReadError);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    // An unknown but well-formed value is NOT refused here either: the enum cast
    // is what rejects it, which is the 500 the old read produced.
    const unknown = createHarness(() => [dbRow()]);
    await expect(
      listOwn(repositoryFor(unknown), { status: "bogus" }),
    ).resolves.toHaveLength(1);
    expect(domainCalls(unknown.queries)[0]?.params).toEqual([
      ACTOR_ID,
      "bogus",
      null,
    ]);
  });

  it("case 25: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createJobOwnerReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    for (const call of [readOwn(repository), listOwn(repository)]) {
      const error = await call.catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerReadError);
      // The fixed message is the only thing a caller may surface: no connection
      // string, no environment variable name.
      expect((error as JobOwnerReadError).message).not.toMatch(
        /DATABASE_URL|postgres:\/\//,
      );
    }

    expect(resolutions).toBe(2);
  });

  it("case 26: the actor is read per call, so two actors never share a predicate", async () => {
    const harness = createHarness(() => [dbRow()]);

    await readOwn(repositoryFor(harness), { actorId: ACTOR_ID });
    await readOwn(repositoryFor(harness), { actorId: OTHER_ACTOR_ID });

    const params = domainCalls(harness.queries).map((entry) => entry.params);
    expect(params).toEqual([
      [ACTOR_ID, JOB_ID],
      [OTHER_ACTOR_ID, JOB_ID],
    ]);
    expect(contextParams(harness.queries)[0]).toEqual([
      TRANSACTION_SETTING_NAMES.userId,
      ACTOR_ID,
    ]);
    expect(contextParams(harness.queries)[4]).toEqual([
      TRANSACTION_SETTING_NAMES.userId,
      OTHER_ACTOR_ID,
    ]);
  });
});
