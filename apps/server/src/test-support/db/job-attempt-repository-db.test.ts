import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INCREMENT_ATTEMPT,
  JobAttemptWriteError,
  createJobAttemptRepository,
  type JobAttemptRepository,
} from "../../db/job-attempt-repository.js";
import type {
  TransactionConnection,
  TransactionPool,
} from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the job attempt counter repository (workorder 21F).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves PostgreSQL actually parses and executes it against the real table, and
 * that the semantics of the replaced `increment_job_attempt` function survive
 * the move:
 *
 *   - the counter is moved by the database, one increment per call, and the
 *     answer is the row's new pair (sequential and overlapping);
 *   - an unknown job id answers `null` and changes nothing;
 *   - a malformed uuid is a real SQL error whose ROLLBACK leaves the pool
 *     usable, and the same holds for a SQL error and for a broken row shape;
 *   - the attempt count is the ONLY business column that moves, on a terminal
 *     and on a cancelled row too — the old function had no status predicate and
 *     neither does this statement;
 *   - the transaction context is a privileged one with NO actor, and none of the
 *     four settings survives the call.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 *
 * PGlite holds ONE session, so it cannot run two transactions at the same time.
 * The overlapping case below therefore measures something narrower and states it
 * honestly: the statement the repository issues is fired several times without
 * waiting, and every execution must observe the previous one's result (distinct,
 * consecutive counts). That is exactly the property that makes a lost increment
 * impossible — the value is read and written inside the statement — while the
 * timing of two real parallel connections is out of this engine's reach. The
 * structural half (one self-referential UPDATE, no read-then-write pair) is
 * pinned in `src/db/job-attempt-repository.test.ts`.
 */

const USER_ID = "00000000-0000-0000-0000-000000000f01";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would move the
 * attempt count of every job in the table. This case exists to prove it does not.
 */
const INJECTION_ID = "' or '1'='1";

const SEQUENTIAL_JOB = "00000000-0000-0000-0000-000000000f11";
const OVERLAPPING_JOB = "00000000-0000-0000-0000-000000000f12";
const FAILED_JOB = "00000000-0000-0000-0000-000000000f13";
const SUCCEEDED_JOB = "00000000-0000-0000-0000-000000000f14";
const CANCELED_JOB = "00000000-0000-0000-0000-000000000f15";
const CONTEXT_JOB = "00000000-0000-0000-0000-000000000f16";

const READ_SETTINGS_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type JobRecord = Record<string, unknown> & {
  id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  updated_at: string;
};

type SettingsRow = {
  user_id: string;
  workspace_id: string;
  role: string;
  execution_mode: string;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

let db: PGlite;
let pool: TransactionPool;
let repository: JobAttemptRepository;
let workspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function jobRow(jobId: string): Promise<JobRecord | null> {
  const rows = (
    await db.query<JobRecord>(
      "select * from public.background_jobs where id = $1",
      [jobId],
    )
  ).rows;
  return rows[0] ?? null;
}

async function requiresJobRow(jobId: string): Promise<JobRecord> {
  const row = await jobRow(jobId);
  if (row === null) throw new Error(`job ${jobId} is missing`);
  return row;
}

async function attemptCount(jobId: string): Promise<number> {
  return (await requiresJobRow(jobId)).attempt_count;
}

/** Every job's count, for "the table did not move" assertions. */
async function allCounts(): Promise<Array<{ id: string; n: number }>> {
  return (
    await db.query<{ id: string; n: number }>(
      "select id, attempt_count::int as n from public.background_jobs order by id",
    )
  ).rows;
}

async function createJob(input: {
  id: string;
  status?: string;
  maxAttempts?: number;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by)
     values ($1, $2, 'image_generation', 'image_generation',
             $3::public.background_job_status, $4, $5)`,
    [input.id, workspaceId, input.status ?? "queued", input.maxAttempts ?? 3, USER_ID],
  );
}

/**
 * The repository call, with the refusal captured instead of thrown.
 *
 * A pass-through pool that records the domain statement the repository issued,
 * so the overlapping case can fire THAT text rather than a copy of it that could
 * drift from the implementation.
 */
function createRecordingRepository(): {
  repository: JobAttemptRepository;
  statements: string[];
} {
  const statements: string[] = [];
  const recordingPool: TransactionPool = {
    async connect(): Promise<TransactionConnection> {
      const inner = await pool.connect();
      return {
        async query(sql: string, params?: readonly unknown[]) {
          if (sql.includes("public.")) statements.push(sql);
          return inner.query(sql, params);
        },
        release(error?: Error | boolean) {
          inner.release(error);
        },
      };
    },
  };

  return {
    repository: createJobAttemptRepository({
      getTransactionPool: () => recordingPool,
    }),
    statements,
  };
}

async function refusal(input: { jobId: string }): Promise<JobAttemptWriteError> {
  const error = await repository
    .incrementAttempt(input)
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobAttemptWriteError);
  const writeError = error as JobAttemptWriteError;
  expect(writeError.operation).toBe(INCREMENT_ATTEMPT);
  expect(writeError.message).toBe(
    `job attempt write failed (${INCREMENT_ATTEMPT})`,
  );
  return writeError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobAttemptRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-attempt@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).id;

  await createJob({ id: SEQUENTIAL_JOB, maxAttempts: 3 });
  await createJob({ id: OVERLAPPING_JOB, maxAttempts: 9 });
  await createJob({ id: FAILED_JOB, status: "failed", maxAttempts: 3 });
  await createJob({ id: SUCCEEDED_JOB, status: "succeeded", maxAttempts: 3 });
  await createJob({ id: CANCELED_JOB, status: "canceled", maxAttempts: 3 });
  await createJob({ id: CONTEXT_JOB, maxAttempts: 3 });

  // Terminal rows carry the state-machine columns this write must not touch, so
  // the "only the counter moved" assertion below has something to compare.
  await db.query(
    `update public.background_jobs
        set payload = $2::jsonb, result = $3::jsonb,
            error_code = 'executor_error', error_message = 'terminal row, do not touch',
            credits_cost = 7, credits_transaction_id = $4,
            thread_id = 'thread-21f', failed_at = now(), completed_at = now()
      where id = $1`,
    [FAILED_JOB, JSON.stringify({ prompt: "keep-me" }), JSON.stringify({ url: "x" }), randomUUID()],
  );
  await db.query(
    `update public.background_jobs
        set result = $2::jsonb, completed_at = now()
      where id = $1`,
    [SUCCEEDED_JOB, JSON.stringify({ url: "done" })],
  );
  await db.query(
    `update public.background_jobs set canceled_at = now() where id = $1`,
    [CANCELED_JOB],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job attempt repository: the counter moves in the database", () => {
  it("case 1: sequential calls report 1, 2, 3 and storage agrees", async () => {
    expect(await attemptCount(SEQUENTIAL_JOB)).toBe(0);

    for (const expected of [1, 2, 3]) {
      const row = await repository.incrementAttempt({ jobId: SEQUENTIAL_JOB });

      expect(row).toEqual({ attemptCount: expected, maxAttempts: 3 });
      // The answer is the row's state, not a value this process computed.
      expect(await attemptCount(SEQUENTIAL_JOB)).toBe(expected);
    }

    // The counter is the only column that moved; the budget is untouched.
    const stored = await requiresJobRow(SEQUENTIAL_JOB);
    expect(stored.max_attempts).toBe(3);
    expect(stored.status).toBe("queued");
  });

  it("case 2: overlapping calls cannot lose an increment, and the answer is never reused", async () => {
    const recording = createRecordingRepository();
    // One real call first, both to capture the statement the repository issues
    // and to prove the capture is the statement PostgreSQL accepts.
    expect(
      await recording.repository.incrementAttempt({ jobId: OVERLAPPING_JOB }),
    ).toEqual({ attemptCount: 1, maxAttempts: 9 });
    expect(recording.statements).toHaveLength(1);

    const sql = recording.statements[0]!;
    const overlapping = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.query<{ attempt_count: number; max_attempts: number }>(sql, [
          OVERLAPPING_JOB,
        ]),
      ),
    );

    // Each execution observed the previous one's result: nine calls (the first
    // plus the eight) produced nine DISTINCT, consecutive counts. A lost
    // increment would show up as a duplicate or as a gap here.
    const counts = overlapping
      .map((result) => firstRow(result.rows).attempt_count)
      .sort((left, right) => left - right);
    expect(counts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await attemptCount(OVERLAPPING_JOB)).toBe(9);

    // And the budget travelled with every answer unchanged.
    for (const result of overlapping) {
      expect(firstRow(result.rows).max_attempts).toBe(9);
    }
  });
});

describe("job attempt repository: unknown ids and refusals", () => {
  it("case 3: an unknown job id is null and the table does not move", async () => {
    const before = await allCounts();

    expect(
      await repository.incrementAttempt({ jobId: randomUUID() }),
    ).toBeNull();

    expect(await allCounts()).toEqual(before);
  });

  it("case 4: a malformed uuid is a real SQL error, wrapped, and the pool stays usable", async () => {
    const before = await allCounts();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.background_jobs where id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await refusal({ jobId: INVALID_ID });

    // The fixed message carries no SQL, no host and no existence answer.
    expect(error.message).not.toMatch(
      /public\.|background_jobs|invalid input|postgres:\/\//i,
    );
    // The cause is the PostgreSQL parse failure, not a zero-row or shape answer.
    expect((error.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );
    expect(await allCounts()).toEqual(before);

    // The failed transaction rolled back, so the very same pool still works.
    expect(
      await repository.incrementAttempt({ jobId: SEQUENTIAL_JOB }),
    ).toEqual({ attemptCount: 4, maxAttempts: 3 });
    expect(await attemptCount(SEQUENTIAL_JOB)).toBe(4);
  });

  it("case 5: ids carrying SQL move nothing, because they are only binds", async () => {
    const before = await allCounts();

    for (const jobId of [INJECTION_ID, `' or id is not null --`]) {
      const error = await refusal({ jobId });
      expect(error.cause).toBeInstanceOf(Error);
    }

    // If an id had been concatenated, the statement would have counted an
    // attempt on every job in the table.
    expect(await allCounts()).toEqual(before);
  });

  it("case 6: a SQL failure rolls back and leaves the same pool usable", async () => {
    const before = await attemptCount(SEQUENTIAL_JOB);

    // A real statement-level failure: the projection names a column that does
    // not exist, so PostgreSQL rejects the statement (SQLSTATE 42703) inside the
    // transaction.
    const brokenPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            if (sql.includes("public.background_jobs")) {
              return inner.query(
                sql.replace(
                  "returning attempt_count, max_attempts",
                  "returning attempt_count, no_such_column",
                ),
                params,
              );
            }
            return inner.query(sql, params);
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const error = await createJobAttemptRepository({
      getTransactionPool: () => brokenPool,
    })
      .incrementAttempt({ jobId: SEQUENTIAL_JOB })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobAttemptWriteError);
    expect((error as JobAttemptWriteError).message).not.toMatch(
      /public\.|background_jobs|no_such_column/i,
    );
    expect(((error as JobAttemptWriteError).cause as Error).message).toMatch(
      /no_such_column/,
    );
    expect(await attemptCount(SEQUENTIAL_JOB)).toBe(before);

    // Same pool, next call: works.
    expect(
      await repository.incrementAttempt({ jobId: SEQUENTIAL_JOB }),
    ).toEqual({ attemptCount: before + 1, maxAttempts: 3 });
  });

  it("case 7: a broken row shape rolls back a real UPDATE, and the pool stays usable", async () => {
    const before = await attemptCount(SEQUENTIAL_JOB);

    // The statement really runs and really moves the counter; only the ANSWER is
    // mangled. The rollback is therefore doing visible work.
    const manglingPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.background_jobs")) {
              return {
                rows: result.rows.map(() => ({
                  attempt_count: "1",
                  max_attempts: 3,
                })),
              };
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const error = await createJobAttemptRepository({
      getTransactionPool: () => manglingPool,
    })
      .incrementAttempt({ jobId: SEQUENTIAL_JOB })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobAttemptWriteError);
    // The UPDATE was undone, so the count is exactly where it was.
    expect(await attemptCount(SEQUENTIAL_JOB)).toBe(before);

    expect(
      await repository.incrementAttempt({ jobId: SEQUENTIAL_JOB }),
    ).toEqual({ attemptCount: before + 1, maxAttempts: 3 });
  });
});

describe("job attempt repository: transaction context", () => {
  it("case 8: a privileged write with NO actor, and none of the settings survives", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction the write ran in, not a reconstruction.
    const observingPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.background_jobs")) {
              observed.push(
                firstRow((await inner.query(READ_SETTINGS_SQL)).rows) as SettingsRow,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createJobAttemptRepository({
      getTransactionPool: () => observingPool,
    });

    const row = await observing.incrementAttempt({ jobId: CONTEXT_JOB });
    expect(row).toEqual({ attemptCount: 1, maxAttempts: 3 });

    expect(observed).toHaveLength(1);
    // No forged user: the worker writes this row as the system, so every actor
    // setting is empty and the mode is the explicit privileged label.
    expect(observed[0]).toEqual({
      user_id: "",
      workspace_id: "",
      role: "",
      execution_mode: "privileged",
    });

    // And immediately after COMMIT the same four settings are gone, so the
    // context of this write cannot become the context of the next one.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

describe("job attempt repository: terminal rows still only count", () => {
  it("case 9: failed, succeeded and cancelled rows all increment by id alone", async () => {
    for (const jobId of [FAILED_JOB, SUCCEEDED_JOB, CANCELED_JOB]) {
      const before = await requiresJobRow(jobId);
      expect(before.attempt_count).toBe(0);

      const row = await repository.incrementAttempt({ jobId });
      expect(row).toEqual({ attemptCount: 1, maxAttempts: before.max_attempts });

      const after = await requiresJobRow(jobId);

      // The whole row, column by column: only the counter and its stamp moved.
      // The status is preserved — a terminal or cancelled job is NOT narrowed
      // out of the statement, because the replaced function had no status
      // predicate either and the caller decides what a spent budget means.
      const moved = Object.keys(after).filter(
        (column) =>
          JSON.stringify(after[column]) !== JSON.stringify(before[column]),
      );
      expect(moved).toContain("attempt_count");
      for (const column of moved) {
        expect(["attempt_count", "updated_at"]).toContain(column);
      }
      expect(after.status).toBe(before.status);
      expect(after.error_code).toBe(before.error_code);
      expect(after.error_message).toBe(before.error_message);
      expect(after.payload).toEqual(before.payload);
      expect(after.result).toEqual(before.result);
      expect(after.credits_cost).toBe(before.credits_cost);
      expect(after.credits_transaction_id).toBe(before.credits_transaction_id);
      expect(after.thread_id).toBe(before.thread_id);
      expect(after.failed_at).toEqual(before.failed_at);
      expect(after.completed_at).toEqual(before.completed_at);
      expect(after.canceled_at).toEqual(before.canceled_at);
      expect(after.workspace_id).toBe(before.workspace_id);
      expect(after.created_by).toBe(before.created_by);
      expect(after.created_at).toEqual(before.created_at);
      expect(after.updated_at).not.toBe(before.updated_at);
    }
  });

  it("case 10: a second increment keeps moving the same row past its budget", async () => {
    // The statement has no `attempt_count < max_attempts` guard: the caller's
    // `attemptCount > maxAttempts` decision depends on the count being reported
    // honestly even after the budget is spent.
    const row = await repository.incrementAttempt({ jobId: FAILED_JOB });

    expect(row).toEqual({ attemptCount: 2, maxAttempts: 3 });
    expect(await attemptCount(FAILED_JOB)).toBe(2);
  });
});
