import { describe, expect, it } from "vitest";

import {
  CANCELABLE_JOB_STATUSES,
  CANCEL_OWN_JOB,
  JOB_OWNER_WRITE_COLUMNS,
  JobOwnerWriteError,
  createJobOwnerWriteRepository,
  type JobOwnerWriteRepository,
  type JobOwnerWriteRow,
} from "./job-owner-write-repository.js";
import { SELECT_COLS } from "../features/jobs/job-service.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the ONE statement
 * the repository issues, the actor context it carries, the 22 columns it
 * projects, and how the repository classifies every way that statement can
 * answer.
 *
 * The unit tests prove WHICH statement is built — one UPDATE, one table, the ACL
 * and the status guard written into the statement itself, the stamp bound with
 * its cast, `updated_at` left to the trigger, no batch and no dynamic SQL. The
 * PGlite file beside them (`test-support/db/job-owner-write-repository-db.test.ts`)
 * proves PostgreSQL actually parses and executes it against the real table, that
 * the six statuses answer what the guard says, and that the answers match what
 * the RLS policy decided for the same identity.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000a2";
const JOB_ID = "00000000-0000-0000-0000-0000000000b1";
const CANCELED_AT = "2026-10-16T12:34:56.789Z";

/**
 * The projection as the service names it. `SELECT_COLS` is the string the
 * remaining `background_jobs` reads in `job-service.ts` still pass to PostgREST,
 * so the three lists agreeing is what keeps the migrated write shape-identical to
 * the reads.
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
 * no schema-qualified name, so anything naming `public.background_jobs` is the
 * domain statement. A second one would mean the write was split (a probe first,
 * then the update) or that the repository issued something nobody asked for.
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

/** The returning list, as written in the statement, in order. */
function returningList(sql: string): string[] {
  const body = /\breturning\b([\s\S]*)$/i.exec(sql)?.[1] ?? "";
  return body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The `set` clause between `set` and `where`, split into assignments. */
function setAssignments(sql: string): string[] {
  const body = /\bset\b([\s\S]*?)\bwhere\b/i.exec(sql)?.[1] ?? "";
  return body
    .split(",")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter((part) => part.length > 0);
}

function repositoryFor(harness: Harness): JobOwnerWriteRepository {
  return createJobOwnerWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/**
 * The call every case below makes, with each argument named once.
 *
 * A field that is PRESENT is passed through verbatim — `undefined` included — so
 * a case can hand the repository an unusable value on purpose. Only an absent
 * field falls back to the valid default.
 */
function cancelOwn(
  repository: JobOwnerWriteRepository,
  input: { actorId?: unknown; jobId?: unknown; canceledAt?: unknown } = {},
) {
  return repository.cancelOwnJob({
    actorId: "actorId" in input ? input.actorId : ACTOR_ID,
    jobId: "jobId" in input ? input.jobId : JOB_ID,
    canceledAt: "canceledAt" in input ? input.canceledAt : CANCELED_AT,
  } as { actorId: string; jobId: string; canceledAt: string });
}

function requireRow(row: JobOwnerWriteRow | null): JobOwnerWriteRow {
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
    workspace_id: "00000000-0000-0000-0000-0000000000c1",
    project_id: "00000000-0000-0000-0000-0000000000c2",
    canvas_id: "00000000-0000-0000-0000-0000000000c3",
    session_id: "00000000-0000-0000-0000-0000000000c4",
    thread_id: "thread-1",
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "canceled",
    payload: { prompt: "a cat" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: ACTOR_ID,
    created_at: new Date("2026-10-16T12:00:00.111Z"),
    updated_at: new Date("2026-10-16T12:34:56.789Z"),
    started_at: new Date("2026-10-16T12:01:00.222Z"),
    completed_at: null,
    failed_at: null,
    canceled_at: new Date(CANCELED_AT),
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

describe("job-owner-write-repository: the statement it issues", () => {
  it("case 1: cancelOwnJob runs inside one privileged transaction, AS the caller", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

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
    const writeIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    const beforeWrite = statements.slice(1, writeIndex);
    expect(beforeWrite).toContain(TRANSACTION_STATEMENTS.setLocalSetting);
    expect(
      beforeWrite.every((sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting),
    ).toBe(true);
    expect(statements[writeIndex + 1]).toBe(TRANSACTION_STATEMENTS.commit);

    // The actor is the CALLER, not an empty system context: the write is
    // attributable, even though the statement's own predicate is what decides
    // which rows exist. The mode is the explicit privileged label.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ACTOR_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: the three arguments are BOUND, never written into the statement", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    // Position matters and is part of the contract: $1 is the ACL value, $2 the
    // row key, $3 the stamp.
    expect(statement?.params).toEqual([ACTOR_ID, JOB_ID, CANCELED_AT]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2::uuid");
    expect(statement?.sql).toContain("$3::timestamptz");
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain(CANCELED_AT);
    expect(statement?.sql).not.toContain("${");
    // One statement, never a batch.
    expect(statement?.sql).not.toContain(";");
  });

  it("case 3: the predicate is the id AND the actor AND the guard, and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);
    const flat = sql.replace(/\s+/g, " ").trim();

    expect(flat).toMatch(/^update public\.background_jobs/);
    expect(flat).toMatch(
      /where id = \$2::uuid and created_by = \$1::uuid and status in \('queued', 'running'\)/,
    );
    // Exactly one table is reachable, and nothing else narrows or widens the
    // write: no workspace term, no membership subquery, no ordering, no limit.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql).not.toMatch(/\bjoin\b/i);
    expect(sql).not.toMatch(/returning[\s\S]*\bwhere\b/i);
  });

  it("case 4: the set clause writes exactly two columns and never updated_at", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);
    const assignments = setAssignments(sql);

    expect(assignments).toEqual([
      "status = 'canceled'",
      "canceled_at = $3::timestamptz",
    ]);
    // The trigger owns `updated_at`; a second writer would give the column two
    // sources that can disagree.
    expect(assignments.some((part) => part.includes("updated_at"))).toBe(false);
    expect(sql).not.toMatch(/updated_at\s*=/);
    // And the status written is a literal, not a bind parameter.
    expect(sql).not.toContain("$4");
  });

  it("case 5: the guard set is statement text, never a parameter and never a caller value", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);

    // The two statuses are spelled out in the statement...
    expect(sql.replace(/\s+/g, " ")).toContain(
      "status in ('queued', 'running')",
    );
    // ...so they are NOT in the bound list, and no extra parameter exists that a
    // caller could put them in.
    expect(domainCalls(harness.queries)[0]?.params).toHaveLength(3);
    for (const status of CANCELABLE_JOB_STATUSES) {
      expect(domainCalls(harness.queries)[0]?.params).not.toContain(status);
    }

    // The exported mirror and the statement are held against each other: the
    // constant can never say something the SQL does not, and `retrying` — which
    // is deliberately NOT cancellable — is in neither.
    expect([...CANCELABLE_JOB_STATUSES]).toEqual(["queued", "running"]);
    expect(sql).not.toContain("retrying");
    expect(sql).not.toContain("dead_letter");
    // `canceled` is the status WRITTEN, never one that may be cancelled again.
    expect(sql.replace(/\s+/g, " ")).toContain("status in ('queued', 'running')");
    expect(sql.replace(/\s+/g, " ")).not.toContain("status in ('canceled'");
  });

  it("case 6: no membership check exists in the statement", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const sql = statementText(harness.queries);

    // The RLS policy this replaces reads `auth.uid() = created_by` and nothing
    // else. A membership predicate would stop a user cancelling their own job
    // after they leave the team, so it must not appear here — not even as a
    // subquery.
    expect(sql).not.toMatch(/workspace_members/i);
    expect(sql).not.toMatch(/is_workspace_member|can_read|auth\.uid/i);
    expect(sql).not.toMatch(/\bexists\b/i);
    expect(sql.match(/from\s+[a-z_.]+/gi)).toBeNull();
  });

  it("case 7: the projection is exactly the service's 22 columns, in its order", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness));

    const columns = returningList(statementText(harness.queries));

    // Three lists, one truth: the statement, the module's exported list and the
    // string the remaining `background_jobs` reads in `job-service.ts` project.
    // A column added to one and not the others is the drift this refuses.
    expect(columns).toHaveLength(22);
    expect(columns).toEqual([...JOB_OWNER_WRITE_COLUMNS]);
    expect(columns).toEqual(SERVICE_COLUMNS);
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

  it("case 8: the repository exposes one method and nothing else", async () => {
    const harness = createHarness(() => [dbRow()]);
    const repository = repositoryFor(harness);

    // No access token, no workspace parameter, no status list and no column set
    // a caller could widen the write with.
    expect(Object.keys(repository)).toEqual([CANCEL_OWN_JOB]);
    expect(repository.cancelOwnJob).toHaveLength(1);

    await cancelOwn(repository);
    expect(domainCalls(harness.queries)).toHaveLength(1);

    // A caller-supplied extra field changes neither the statement nor the
    // parameters: the arguments are read one by one, never spread into the SQL.
    const withExtra = createHarness(() => [dbRow()]);
    await repositoryFor(withExtra).cancelOwnJob({
      actorId: ACTOR_ID,
      jobId: JOB_ID,
      canceledAt: CANCELED_AT,
      status: "retrying",
      table: "public.somewhere_else",
    } as never);

    expect(statementText(withExtra.queries)).toBe(
      statementText(harness.queries),
    );
    expect(domainCalls(withExtra.queries)[0]?.params).toEqual([
      ACTOR_ID,
      JOB_ID,
      CANCELED_AT,
    ]);
  });
});

describe("job-owner-write-repository: the row it maps", () => {
  it("case 9: the returned row is the mapped record, keyed in column order", async () => {
    const harness = createHarness(() => [dbRow()]);

    const row = requireRow(await cancelOwn(repositoryFor(harness)));

    // The mapping is REUSED from workorder 21I, timestamps normalised and all:
    // the cancel answer and the reads must not disagree about the same row.
    expect(Object.keys(row)).toEqual([...JOB_OWNER_WRITE_COLUMNS]);
    expect(row).toEqual({
      id: JOB_ID,
      workspace_id: "00000000-0000-0000-0000-0000000000c1",
      project_id: "00000000-0000-0000-0000-0000000000c2",
      canvas_id: "00000000-0000-0000-0000-0000000000c3",
      session_id: "00000000-0000-0000-0000-0000000000c4",
      thread_id: "thread-1",
      queue_name: "image_generation_jobs",
      job_type: "image_generation",
      status: "canceled",
      payload: { prompt: "a cat" },
      result: null,
      error_code: null,
      error_message: null,
      attempt_count: 1,
      max_attempts: 3,
      created_by: ACTOR_ID,
      created_at: "2026-10-16T12:00:00.111Z",
      updated_at: "2026-10-16T12:34:56.789Z",
      started_at: "2026-10-16T12:01:00.222Z",
      completed_at: null,
      failed_at: null,
      canceled_at: CANCELED_AT,
    } satisfies JobOwnerWriteRow);
  });

  it("case 10: a legacy dead_letter row leaves here RAW", async () => {
    const harness = createHarness(() => [dbRow({ status: "dead_letter" })]);

    // The translation to `failed` belongs to `JobService.mapJobRow` and stays
    // there: moving it into the repository would let the cancel answer drift away
    // from `getJob` and `getJobAdmin`.
    expect((await cancelOwn(repositoryFor(harness)))?.status).toBe("dead_letter");
  });

  it("case 11: a column missing from the returning list fails loud, and rolls back", async () => {
    for (const column of ["canceled_at", "updated_at", "created_by", "payload"]) {
      const harness = createHarness(() => [removeColumn(dbRow(), column)]);

      const error = await cancelOwn(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobOwnerWriteError);
      expect((error as JobOwnerWriteError).operation).toBe(CANCEL_OWN_JOB);
      // A projection that dropped a column must not read like a job that has no
      // cancel stamp.
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });
});

describe("job-owner-write-repository: zero rows, unusable arguments, failures", () => {
  it("case 12: zero rows is the 'guard matched nothing' answer, and it commits", async () => {
    const harness = createHarness(() => []);

    // Someone else's job, a job in a terminal state and an unknown id all read
    // exactly the same — which is what the RLS policy produced too, and what the
    // service's 404 publishes.
    await expect(cancelOwn(repositoryFor(harness))).resolves.toBeNull();

    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 13: more than one row from the single-row write is a fixed failure", async () => {
    const harness = createHarness(() => [dbRow(), dbRow()]);

    const error = await cancelOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerWriteError);
    expect((error as JobOwnerWriteError).operation).toBe(CANCEL_OWN_JOB);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 14: an unusable actor or job id is refused before any connection is opened", async () => {
    for (const actorId of [undefined, "", 7, null, {}]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await cancelOwn(repositoryFor(harness), {
        actorId: actorId as string,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerWriteError);
      expect((error as JobOwnerWriteError).operation).toBe(CANCEL_OWN_JOB);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    for (const jobId of [undefined, "", 7, null, {}]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await cancelOwn(repositoryFor(harness), {
        jobId: jobId as string,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerWriteError);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    // A malformed but non-empty id is NOT refused here: it is bound as `::uuid`,
    // so PostgreSQL rejects it inside the transaction and the rollback path is
    // exercised instead of hidden.
    const malformed = createHarness(() => [dbRow()]);
    await expect(
      cancelOwn(repositoryFor(malformed), { jobId: "not-a-uuid" }),
    ).resolves.not.toBeNull();
    expect(domainCalls(malformed.queries)[0]?.params).toEqual([
      ACTOR_ID,
      "not-a-uuid",
      CANCELED_AT,
    ]);
  });

  it("case 15: a canceledAt that is not a canonical ISO instant is refused before any connection", async () => {
    for (const canceledAt of [
      undefined,
      "",
      7,
      null,
      {},
      new Date(CANCELED_AT),
      "not a timestamp",
      "2026-10-16",
      "2026-10-16 12:34:56+00",
      "2026-10-16T12:34:56Z",
      "2026-10-16T12:34:56.789+02:00",
      "2026-10-16T12:34:56.789z",
      "2026-02-30T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
    ]) {
      const harness = createHarness(() => [dbRow()]);
      const error = await cancelOwn(repositoryFor(harness), {
        canceledAt: canceledAt as string,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobOwnerWriteError);
      expect((error as JobOwnerWriteError).operation).toBe(CANCEL_OWN_JOB);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
      // The refusal is fixed text: it names neither the value nor any SQL.
      expect((error as JobOwnerWriteError).message).toBe(
        `job owner write failed (${CANCEL_OWN_JOB})`,
      );
    }

    // The canonical form the service produces is accepted VERBATIM — not
    // re-formatted, not rounded: what the repository binds is what the service
    // stamped.
    const accepted = createHarness(() => [dbRow()]);
    await cancelOwn(repositoryFor(accepted), {
      canceledAt: "2026-10-16T00:00:00.000Z",
    });
    expect(domainCalls(accepted.queries)[0]?.params?.[2]).toBe(
      "2026-10-16T00:00:00.000Z",
    );
  });

  it("case 16: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      'invalid input syntax for type uuid: "not-a-uuid" | ' +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await cancelOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerWriteError);
    const writeError = error as JobOwnerWriteError;
    expect(writeError.operation).toBe(CANCEL_OWN_JOB);
    expect(writeError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(writeError.message).toBe(
      `job owner write failed (${CANCEL_OWN_JOB})`,
    );
    expect(writeError.message).not.toMatch(
      /public\.|background_jobs|postgres:\/\/|10\.210\.134\.37|secret|uuid|canceled/i,
    );
    // Neither the actor nor the job id reaches the message: a failure is not a
    // lookup.
    expect(writeError.message).not.toContain(ACTOR_ID);
    expect(writeError.message).not.toContain(JOB_ID);
    expect(writeError.message).not.toContain(CANCELED_AT);
  });

  it("case 17: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await cancelOwn(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobOwnerWriteError);
    expect((error as JobOwnerWriteError).message).toBe(
      `job owner write failed (${CANCEL_OWN_JOB})`,
    );
    expect((error as JobOwnerWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 18: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createJobOwnerWriteRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await cancelOwn(repository).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobOwnerWriteError);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as JobOwnerWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
    expect(resolutions).toBe(1);
  });

  it("case 19: the actor is read per call, so two actors never share a predicate", async () => {
    const harness = createHarness(() => [dbRow()]);

    await cancelOwn(repositoryFor(harness), { actorId: ACTOR_ID });
    await cancelOwn(repositoryFor(harness), { actorId: OTHER_ACTOR_ID });

    const params = domainCalls(harness.queries).map((entry) => entry.params);
    expect(params).toEqual([
      [ACTOR_ID, JOB_ID, CANCELED_AT],
      [OTHER_ACTOR_ID, JOB_ID, CANCELED_AT],
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
