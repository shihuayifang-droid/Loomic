import { describe, expect, it } from "vitest";

import {
  COUNT_ACTIVE_JOBS,
  JobConcurrencyError,
  createJobConcurrencyRepository,
  type JobConcurrencyRepository,
} from "./job-concurrency-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor context it carries (none), the three statuses
 * it writes INTO that statement, and how it classifies every way the statement
 * can answer.
 *
 * The unit tests prove WHICH statement is built — one SELECT, one table, one
 * bind parameter, no batch, no status parameter. The PGlite file beside them
 * (`test-support/db/job-concurrency-repository-db.test.ts`) proves PostgreSQL
 * actually parses and executes it against the real enum column, that the cast
 * really yields a JavaScript number, that a malformed uuid rolls back and leaves
 * the pool usable, and that the count does not move the rows it counted.
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c1";

/**
 * The three statuses the plan rule is about, named here INDEPENDENTLY of the
 * module: this list is the second opinion the statement's own literal list is
 * held against. A status added to the statement and not to this list (or the
 * other way round) fails case 4.
 */
const ACTIVE_STATUSES = ["queued", "running", "retrying"] as const;

/** The four statuses that hold no slot: finished, or finished and abandoned. */
const INACTIVE_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
] as const;

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
 * second one would mean the count was split (a probe first, then the number).
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statementText(queries: readonly QueryRecord[]): string {
  return domainCalls(queries)[0]?.sql ?? "";
}

/** The statement as one line, for shape assertions that must not care about layout. */
function flatStatement(queries: readonly QueryRecord[]): string {
  return statementText(queries).replace(/\s+/g, " ").trim();
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

function repositoryFor(harness: Harness): JobConcurrencyRepository {
  return createJobConcurrencyRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the argument named once. */
function count(
  repository: JobConcurrencyRepository,
  workspaceId: string = WORKSPACE_ID,
) {
  return repository.countActiveJobs({ workspaceId });
}

/** A count answer shaped the way the statement answers it. */
function countRow(active: unknown): Record<string, unknown> {
  return { active };
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

function removeColumn(row: Record<string, unknown>, column: string) {
  const copy = { ...row };
  delete copy[column];
  return copy;
}

describe("job-concurrency-repository: the statement it issues", () => {
  it("case 1: counts inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [countRow(3)]);

    await count(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no probe read, no second table, no follow-up.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // What this case owns is the SHAPE, not the statement count. Whether the
    // four transaction settings arrive as one `set_config` each or batched into
    // a single statement is `transaction.ts`'s business and is asserted by its
    // own test; pinning the count here would silently pin this suite to whichever
    // form happened to be checked out (workorder 21I-fixup).
    const isTransactionStatement = (sql: string): boolean =>
      sql === TRANSACTION_STATEMENTS.begin ||
      sql === TRANSACTION_STATEMENTS.commit ||
      sql === TRANSACTION_STATEMENTS.rollback ||
      sql === TRANSACTION_STATEMENTS.setLocalSetting;
    // Classified by exclusion, not by name: whatever is not the transaction's own
    // BEGIN/COMMIT/ROLLBACK/`set_config` is the repository's statement, and there
    // is exactly one of them — the count, with no probe and no statement the
    // transaction never asked for.
    const domainStatements = statements.filter(
      (sql) => !isTransactionStatement(sql),
    );
    expect(domainStatements).toHaveLength(1);
    expect(domainStatements).toEqual([statementText(harness.queries)]);
    const selectIndex = statements.findIndex(
      (sql) => !isTransactionStatement(sql),
    );
    // Between BEGIN and the count there is context and nothing else: at least one
    // `set_config`, with no other statement interleaved among them.
    const beforeSelect = statements.slice(1, selectIndex);
    expect(beforeSelect).toContain(TRANSACTION_STATEMENTS.setLocalSetting);
    expect(
      beforeSelect.every(
        (sql) => sql === TRANSACTION_STATEMENTS.setLocalSetting,
      ),
    ).toBe(true);
    // The count is the last thing inside the transaction: COMMIT follows it
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

  it("case 2: binds the workspace id as a parameter, never as statement text", async () => {
    const harness = createHarness(() => [countRow(0)]);

    await count(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([WORKSPACE_ID]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).not.toContain(WORKSPACE_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: one table, one aggregate, and not a batch", async () => {
    const harness = createHarness(() => [countRow(0)]);

    await count(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toMatch(/from public\.background_jobs/);
    expect(flatStatement(harness.queries)).toMatch(
      /where workspace_id = \$1::uuid and status in \(/,
    );
    // Exactly one table is reachable, and no other predicate narrows or widens
    // the count: no id, no job type, no date, no ordering and no limit.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
    expect(sql).not.toMatch(/order by|limit|\boffset\b/i);
    expect(sql).not.toContain(";");
    expect(sql).not.toMatch(/join/i);
    expect(sql).not.toMatch(/insert|update|delete/i);
  });

  it("case 4: the three statuses are written into the statement, not bound as a parameter", async () => {
    const harness = createHarness(() => [countRow(2)]);

    await count(repositoryFor(harness));

    const sql = flatStatement(harness.queries);
    // The literal list, exactly: a bind parameter here would be a `text[]`, and
    // `status` is the enum `public.background_job_status` — `text[]` and that
    // enum have no common type, so the statement would fail to plan.
    expect(sql).toContain(
      `status in ('${ACTIVE_STATUSES.join("', '")}')`,
    );
    expect(sql).toMatch(/status in \('queued', 'running', 'retrying'\)/);
    // And NO other status is named anywhere in the statement.
    for (const status of INACTIVE_STATUSES) {
      expect([status, sql.includes(`'${status}'`)]).toEqual([status, false]);
    }

    // The parameter list is the workspace id and nothing else: no array, no
    // status, no placeholder for the list.
    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([WORKSPACE_ID]);
    for (const param of statement?.params ?? []) {
      expect(Array.isArray(param)).toBe(false);
      expect(typeof param).toBe("string");
    }
    expect(statement?.params).not.toContain("queued");
    // One placeholder, and it is the uuid cast above.
    expect(sql.match(/\$\d/g)).toEqual(["$1"]);
  });

  it("case 5: the count is cast to int and projected as `active`", async () => {
    const harness = createHarness(() => [countRow(1)]);

    await count(repositoryFor(harness));

    // `count(*)` is bigint, which `pg` hands back as a string; the cast is what
    // makes the answer a JavaScript number, and the alias is the key the mapper
    // reads. Both are part of the contract, not decoration.
    expect(flatStatement(harness.queries)).toMatch(
      /^select count\(\*\)::int as active from public\.background_jobs /,
    );
  });
});

describe("job-concurrency-repository: the number it maps", () => {
  it("case 6: a non-negative integer count is reported as a JavaScript number", async () => {
    const answers = [0, 1, 3, 12];

    for (const answer of answers) {
      const harness = createHarness(() => [countRow(answer)]);
      const result = await count(repositoryFor(harness));

      expect(result).toBe(answer);
      expect(typeof result).toBe("number");
    }
  });

  it("case 7: a STRING count throws instead of being coerced", async () => {
    // The whole point of the cast: if the cast were dropped, `bigint` arrives as
    // this exact string and `"3" >= 2` would still be true by accident, while
    // the 429 message silently changed shape.
    const harness = createHarness(() => [countRow("3")]);

    const error = await count(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobConcurrencyError);
    expect((error as JobConcurrencyError).operation).toBe(COUNT_ACTIVE_JOBS);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 8: a NEGATIVE count throws", async () => {
    const harness = createHarness(() => [countRow(-1)]);

    await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
      JobConcurrencyError,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 9: a FRACTIONAL count throws", async () => {
    const harness = createHarness(() => [countRow(1.5)]);

    await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
      JobConcurrencyError,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 10: a NULL count throws — a count is never 'no answer'", async () => {
    const harness = createHarness(() => [countRow(null)]);

    await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
      JobConcurrencyError,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 11: a MISSING `active` column throws — absent is not zero", async () => {
    const harness = createHarness(() => [removeColumn(countRow(3), "active")]);

    await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
      JobConcurrencyError,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 12: every other non-integer shape throws: NaN, infinity, boolean, object, array", async () => {
    const drift = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      true,
      false,
      {},
      [],
      "0",
      "3.0",
    ];

    for (const value of drift) {
      const harness = createHarness(() => [countRow(value)]);

      await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobConcurrencyError,
      );
      expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    }
  });

  it("case 13: zero rows is a failure — count(*) always answers one row", async () => {
    const harness = createHarness(() => []);

    const error = await count(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobConcurrencyError);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 14: more than one row is a failure, not a first row", async () => {
    const harness = createHarness(() => [countRow(3), countRow(9)]);

    const error = await count(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobConcurrencyError);
    expect((error as JobConcurrencyError).operation).toBe(COUNT_ACTIVE_JOBS);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 15: a row that is not an object is a failure, not a value", async () => {
    const answers: unknown[] = [null, "3", [countRow(3)], 42, true];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);

      await expect(count(repositoryFor(harness))).rejects.toBeInstanceOf(
        JobConcurrencyError,
      );
    }
  });
});

describe("job-concurrency-repository: failures keep their cause and leak nothing", () => {
  it("case 16: a SQL failure rolls back, keeps its cause and leaks nothing", async () => {
    const failure = new Error(
      "select count(*) from public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await count(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobConcurrencyError);
    const countError = error as JobConcurrencyError;
    expect(countError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    // The fixed text is what `TierGuard` is allowed to log; nothing that could
    // carry a host, a statement or the workspace id may ride along in it.
    expect(countError.message).toBe(
      `job concurrency count failed (${COUNT_ACTIVE_JOBS})`,
    );
    expect(countError.message).not.toMatch(
      /public\.|background_jobs|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(countError.message).not.toContain(WORKSPACE_ID);
  });

  it("case 17: a connect failure is a fixed failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await count(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobConcurrencyError);
    expect((error as JobConcurrencyError).message).toBe(
      `job concurrency count failed (${COUNT_ACTIVE_JOBS})`,
    );
    expect((error as JobConcurrencyError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 18: an unusable workspace id is refused before any connection is opened", async () => {
    const args: unknown[] = [undefined, "", 7, null, {}];

    for (const workspaceId of args) {
      const harness = createHarness(() => [countRow(0)]);
      const error = await repositoryFor(harness)
        .countActiveJobs({ workspaceId } as { workspaceId: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(JobConcurrencyError);
      expect((error as JobConcurrencyError).operation).toBe(COUNT_ACTIVE_JOBS);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 19: building never resolves a pool; a missing DATABASE_URL fails on the count", async () => {
    let resolutions = 0;
    const repository = createJobConcurrencyRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await count(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(JobConcurrencyError);
    // The fixed message is the only thing a caller may log: no connection
    // string, no environment variable name. `TierGuard` logs exactly this class
    // of failure, and it would otherwise carry the driver's message into a log
    // line (workorder 21J §6).
    expect((error as JobConcurrencyError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });

  it("case 20: the repository exposes countActiveJobs and nothing else", async () => {
    const harness = createHarness(() => [countRow(0)]);
    const repository = repositoryFor(harness);

    // There is no second method, no access token and no generic filter entry
    // point a caller could widen the count with.
    expect(Object.keys(repository)).toEqual([COUNT_ACTIVE_JOBS]);
    expect(repository.countActiveJobs).toHaveLength(1);

    await count(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([WORKSPACE_ID]);
  });

  it("case 21: the workspace id is the only caller input the statement sees", async () => {
    const harness = createHarness(() => [countRow(1)]);
    const otherWorkspace = "00000000-0000-0000-0000-0000000000d1";

    await count(repositoryFor(harness), otherWorkspace);

    // No cached, defaulted or borrowed workspace: the bound value is the one the
    // caller passed, on every call.
    expect(domainCalls(harness.queries)[0]?.params).toEqual([otherWorkspace]);
    expect(statementText(harness.queries)).not.toContain(otherWorkspace);

    await count(repositoryFor(harness), WORKSPACE_ID);
    expect(domainCalls(harness.queries)[1]?.params).toEqual([WORKSPACE_ID]);
  });
});
