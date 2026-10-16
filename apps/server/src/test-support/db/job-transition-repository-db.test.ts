import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JobTransitionError,
  MARK_FAILED,
  MARK_RETRYING,
  MARK_RUNNING,
  MARK_SUCCEEDED,
  createJobTransitionRepository,
  type JobTransitionRepository,
} from "../../db/job-transition-repository.js";
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
 * Real-SQL integration for the job status transition repository (workorder 21M).
 *
 * The unit tests beside the repository prove WHICH statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * table, and that the properties the worker's refund path rests on are facts of
 * the database rather than of this process:
 *
 *   - the 4x6 matrix: every one of the four transitions against every one of the
 *     six live statuses. Each accepted cell reports `true` and moves exactly the
 *     columns that transition owns; each refused cell reports `false` and leaves
 *     the row identical column by column.
 *   - `markFailed`'s answer is the refund's only authorisation, so two calls
 *     racing for the same row must produce exactly one `true`.
 *   - `markRetrying` never writes `failed_at`: a retry is not a terminal failure.
 *   - the timestamps land as the CALLER passed them, milliseconds included, and
 *     `result` round-trips as the same JSON document.
 *   - a rejected statement rolls back and leaves the same pool usable, and no
 *     session setting outlives the transaction.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-000000000e00";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * every row in the table. This case exists to prove it does not.
 */
const INJECTION_ID = "' or '1'='1";

/** The canonical form `JobService` produces, milliseconds included. */
const RUNNING_AT = "2026-10-16T01:02:03.456Z";
const RETRYING_AT = "2026-10-16T02:03:04.567Z";
const COMPLETED_AT = "2026-10-16T03:04:05.678Z";
const FAILED_AT = "2026-10-16T04:05:06.789Z";

const FAILED_CODE = "executor_error";
const FAILED_MESSAGE = "the provider was down";

/** The document `markSucceeded` has to round-trip unchanged. */
const RESULT_DOCUMENT = {
  url: "oss://bucket/key.png",
  images: ["a.png", "b.png"],
  meta: { width: 512, nested: [{ depth: "deep" }, { depth: "deeper" }] },
  nothing: null,
};

const METHODS = [
  MARK_RUNNING,
  MARK_RETRYING,
  MARK_SUCCEEDED,
  MARK_FAILED,
] as const;

/** The six live statuses of the matrix (`dead_letter` gets its own case). */
const MATRIX_STATUSES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
] as const;

type Method = (typeof METHODS)[number];
type MatrixStatus = (typeof MATRIX_STATUSES)[number];

/**
 * The matrix, stated once: which statuses each transition is allowed to move.
 * This is the SAME table the SQL text carries — written here independently, from
 * the product rules rather than from the statements — so a statement that
 * quietly changed its guard fails a cell instead of agreeing with itself.
 */
const ACCEPTED: Record<Method, readonly string[]> = {
  [MARK_RUNNING]: ["queued", "retrying"],
  [MARK_RETRYING]: ["running"],
  [MARK_SUCCEEDED]: ["running"],
  [MARK_FAILED]: ["queued", "running", "retrying"],
};

/** The status each transition writes when it is accepted. */
const TARGET: Record<Method, string> = {
  [MARK_RUNNING]: "running",
  [MARK_RETRYING]: "retrying",
  [MARK_SUCCEEDED]: "succeeded",
  [MARK_FAILED]: "failed",
};

/**
 * The columns each accepted transition owns, plus the trigger's own stamp. The
 * BEFORE UPDATE trigger writes `updated_at`; naming it here is what keeps
 * "which columns moved" an exact list rather than a lower bound.
 */
const OWNED_COLUMNS: Record<Method, readonly string[]> = {
  [MARK_RUNNING]: ["started_at", "status", "updated_at"],
  [MARK_RETRYING]: ["error_code", "error_message", "status", "updated_at"],
  [MARK_SUCCEEDED]: ["completed_at", "result", "status", "updated_at"],
  [MARK_FAILED]: [
    "error_code",
    "error_message",
    "failed_at",
    "status",
    "updated_at",
  ],
};

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

/** The whole row, with every timestamp and the jsonb result cast to text. */
const SELECT_JOB_SQL = `
select id, workspace_id, project_id, canvas_id, session_id, thread_id,
       queue_name, job_type, status::text as status,
       payload::text as payload, result::text as result,
       error_code, error_message, attempt_count, max_attempts,
       credits_cost, credits_transaction_id, created_by,
       created_at::text as created_at, started_at::text as started_at,
       completed_at::text as completed_at, failed_at::text as failed_at,
       canceled_at::text as canceled_at, updated_at::text as updated_at
  from public.background_jobs
 where id = $1
`;

type JobRecord = Record<string, unknown> & {
  id: string;
  status: string;
  payload: string;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  canceled_at: string | null;
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
let repository: JobTransitionRepository;
let workspaceId = "";

const matrixIds = new Map<string, string>();
let deadLetterJob = "";
let raceJob = "";
let raceLoser = "";
let statementRaceJob = "";
let emptyTextJob = "";
let rollbackJob = "";
let contextJob = "";
let injectionJob = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** A deterministic uuid per fixture slot: all digits are valid hex. */
let idCounter = 0;
function nextJobId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-${String(idCounter).padStart(12, "0")}`;
}

function matrixKey(method: string, status: string): string {
  return `${method}:${status}`;
}

async function jobRow(jobId: string): Promise<JobRecord | null> {
  const rows = (await db.query<JobRecord>(SELECT_JOB_SQL, [jobId])).rows;
  return rows[0] ?? null;
}

async function requiresJobRow(jobId: string): Promise<JobRecord> {
  const row = await jobRow(jobId);
  if (row === null) throw new Error(`job ${jobId} is missing`);
  return row;
}

/** The whole row as one comparable value, for "nothing moved" assertions. */
async function snapshot(jobId: string): Promise<string> {
  return JSON.stringify(await requiresJobRow(jobId));
}

/** Which columns differ between two reads of the same row, sorted. */
function movedColumns(before: JobRecord, after: JobRecord): string[] {
  return Object.keys(after)
    .filter(
      (column) => JSON.stringify(after[column]) !== JSON.stringify(before[column]),
    )
    .sort();
}

/**
 * One timestamp column as the ISO string the caller passed.
 *
 * `to_char` is used rather than the driver's `Date`: the point of the assertion
 * is the value the COLUMN holds, and a text form can be compared byte for byte
 * against the argument, milliseconds included.
 */
async function utcIso(
  jobId: string,
  column: "started_at" | "completed_at" | "failed_at",
): Promise<string | null> {
  const rows = (
    await db.query<{ value: string | null }>(
      `select to_char(${column} at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as value
         from public.background_jobs
        where id = $1`,
      [jobId],
    )
  ).rows;

  return firstRow(rows).value;
}

/** Every row's status, for "the table did not move" assertions. */
async function allStates(): Promise<Array<Record<string, unknown>>> {
  return (
    await db.query<Record<string, unknown>>(
      `select id, status::text as status, error_code, attempt_count,
              started_at::text as started_at, failed_at::text as failed_at
         from public.background_jobs order by id`,
    )
  ).rows;
}

/**
 * One fixture row per matrix cell, carrying every column the four transitions
 * could damage — so a refusal has something to leave exactly as it was, and an
 * acceptance has something to prove it did not touch.
 */
async function createJob(input: {
  id: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by,
        payload, attempt_count, thread_id)
     values ($1, $2, 'image_generation', 'image_generation',
             $3::public.background_job_status, 3, $4, $5::jsonb, 2, 'thread-21m')`,
    [
      input.id,
      workspaceId,
      input.status,
      USER_ID,
      JSON.stringify({ prompt: "keep-me" }),
    ],
  );

  if (input.errorCode !== undefined) {
    await db.query(
      `update public.background_jobs
          set error_code = $2, error_message = $3
        where id = $1`,
      [input.id, input.errorCode, input.errorMessage ?? "fixture row"],
    );
  }

  // The stamps a terminal row already carries. A transition that is refused must
  // not replace them, and one that is accepted must not clear them either.
  if (input.status === "running") {
    await db.query(
      "update public.background_jobs set started_at = now() where id = $1",
      [input.id],
    );
  }
  if (input.status === "succeeded") {
    await db.query(
      `update public.background_jobs
          set result = $2::jsonb, completed_at = now()
        where id = $1`,
      [input.id, JSON.stringify({ url: "already-done" })],
    );
  }
  if (input.status === "failed") {
    await db.query(
      "update public.background_jobs set failed_at = now() where id = $1",
      [input.id],
    );
  }
  if (input.status === "canceled") {
    await db.query(
      "update public.background_jobs set canceled_at = now() where id = $1",
      [input.id],
    );
  }
}

/** The four calls, each with the arguments the matrix uses. */
function callTransition(
  method: Method,
  jobId: string,
  overrides: { result?: Record<string, unknown> } = {},
): Promise<boolean> {
  switch (method) {
    case MARK_RUNNING:
      return repository.markRunning({ jobId, startedAt: RUNNING_AT });
    case MARK_RETRYING:
      return repository.markRetrying({
        jobId,
        errorCode: FAILED_CODE,
        errorMessage: FAILED_MESSAGE,
      });
    case MARK_SUCCEEDED:
      return repository.markSucceeded({
        jobId,
        result: overrides.result ?? RESULT_DOCUMENT,
        completedAt: COMPLETED_AT,
      });
    case MARK_FAILED:
      return repository.markFailed({
        jobId,
        errorCode: FAILED_CODE,
        errorMessage: FAILED_MESSAGE,
        failedAt: FAILED_AT,
      });
  }
}

/** The repository call, with the refusal captured instead of thrown. */
async function refusal(
  call: () => Promise<unknown>,
  operation: Method,
): Promise<JobTransitionError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobTransitionError);
  const transitionError = error as JobTransitionError;
  expect(transitionError.operation).toBe(operation);
  expect(transitionError.message).toBe(
    `job status transition failed (${operation})`,
  );
  return transitionError;
}

/**
 * A pool that records the statements the repository issues and runs them through
 * the real connection, so a case can re-execute the EXACT statement the module
 * builds (never a copy kept in this file).
 */
function recordingPool(): { pool: TransactionPool; statements: string[] } {
  const statements: string[] = [];

  return {
    pool: {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            if (sql.includes("public.background_jobs")) statements.push(sql);
            return inner.query(sql, params);
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    },
    statements,
  };
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobTransitionRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-transition@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).id;

  // One fresh row per matrix cell: no cell may observe another cell's write.
  for (const method of METHODS) {
    for (const status of MATRIX_STATUSES) {
      const id = nextJobId();
      matrixIds.set(matrixKey(method, status), id);
      await createJob({
        id,
        status,
        // A row that came back from a failed attempt carries its code; the
        // transition that starts it again must not erase it.
        ...(status === "retrying"
          ? { errorCode: "previous_attempt", errorMessage: "first attempt failed" }
          : {}),
        ...(status === "failed"
          ? { errorCode: "earlier_failure", errorMessage: "terminal row" }
          : {}),
        ...(status === "canceled"
          ? { errorCode: "canceled_by_user", errorMessage: "cancelled by its owner" }
          : {}),
      });
    }
  }

  deadLetterJob = nextJobId();
  await createJob({ id: deadLetterJob, status: "dead_letter" });

  raceJob = nextJobId();
  raceLoser = nextJobId();
  statementRaceJob = nextJobId();
  emptyTextJob = nextJobId();
  rollbackJob = nextJobId();
  contextJob = nextJobId();
  injectionJob = nextJobId();

  await createJob({
    id: raceLoser,
    status: "failed",
    errorCode: "already_terminal",
    errorMessage: "an earlier writer got here first",
  });
  await createJob({ id: raceJob, status: "queued" });
  await createJob({ id: statementRaceJob, status: "queued" });
  await createJob({ id: emptyTextJob, status: "running" });
  await createJob({ id: rollbackJob, status: "queued" });
  await createJob({ id: contextJob, status: "queued" });
  await createJob({ id: injectionJob, status: "queued" });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job transitions: the 4x6 status matrix", () => {
  for (const method of METHODS) {
    it(`case ${METHODS.indexOf(method) + 1}: ${method} moves exactly the statuses it owns, cell by cell`, async () => {
      for (const status of MATRIX_STATUSES) {
        const jobId = matrixIds.get(matrixKey(method, status));
        if (jobId === undefined) throw new Error(`no fixture for ${method}/${status}`);

        const before = await requiresJobRow(jobId);
        const beforeSnapshot = JSON.stringify(before);
        expect({ status, observed: before.status }).toEqual({
          status,
          observed: status,
        });

        const accepted = ACCEPTED[method].includes(status);
        const changed = await callTransition(method, jobId);

        // The cell's answer, with the status in the failure output.
        expect({ status, changed }).toEqual({ status, changed: accepted });

        const after = await requiresJobRow(jobId);

        if (!accepted) {
          // A refusal is the predicate, not a partial write: the row is exactly
          // where it was, every column of it.
          expect({ status, row: JSON.stringify(after) }).toEqual({
            status,
            row: beforeSnapshot,
          });
          expect({ status, observed: after.status }).toEqual({
            status,
            observed: status,
          });
          continue;
        }

        // An acceptance moves the transition's own columns and nothing else.
        // `movedColumns` is the exact list, so every other column of the row —
        // the stamps this transition does not own included — is proven untouched
        // by this one assertion; the named ones below state the intent.
        expect({ status, moved: movedColumns(before, after) }).toEqual({
          status,
          moved: [...OWNED_COLUMNS[method]].sort(),
        });
        expect({ status, observed: after.status }).toEqual({
          status,
          observed: TARGET[method],
        });

        // The columns no transition of this module may ever move.
        expect({ status, canceled_at: after.canceled_at }).toEqual({
          status,
          canceled_at: before.canceled_at,
        });
        expect({ status, payload: after.payload }).toEqual({
          status,
          payload: before.payload,
        });
        expect({ status, attempt_count: after.attempt_count }).toEqual({
          status,
          attempt_count: before.attempt_count,
        });

        if (method === MARK_RUNNING) {
          // Starting a job must not CLEAR the code of the failure it is
          // retrying, and it must not touch a failure stamp.
          expect({ status, error_code: after.error_code }).toEqual({
            status,
            error_code: before.error_code,
          });
          expect({ status, failed_at: after.failed_at }).toEqual({
            status,
            failed_at: before.failed_at,
          });
          expect({ status, completed_at: after.completed_at }).toEqual({
            status,
            completed_at: before.completed_at,
          });
        }
        if (method === MARK_RETRYING) {
          // GN-30: a retry is not a terminal failure, so the failure stamp stays
          // exactly as it was (NULL for a job that has never failed).
          expect({ status, failed_at_is_null: after.failed_at === null }).toEqual({
            status,
            failed_at_is_null: true,
          });
        }
        if (method === MARK_SUCCEEDED) {
          // Compared as PARSED JSON, not as text: the column is jsonb, so
          // PostgreSQL is free to reorder keys and respace the document.
          const stored = after.result;
          expect({ status, result: stored === null ? null : JSON.parse(stored) }).toEqual(
            { status, result: RESULT_DOCUMENT },
          );
          expect({ status, failed_at: after.failed_at }).toEqual({
            status,
            failed_at: before.failed_at,
          });
        }
        if (method === MARK_FAILED) {
          expect({ status, failed_at_set: after.failed_at !== null }).toEqual({
            status,
            failed_at_set: true,
          });
          expect({ status, completed_at: after.completed_at }).toEqual({
            status,
            completed_at: before.completed_at,
          });
        }
      }
    });
  }

  it("case 5: the legacy dead_letter status is not startable, not retryable, not successful and not failed", async () => {
    // `dead_letter` is a historical terminal value the worker no longer writes,
    // but rows carry it. No transition may move one: it is over.
    for (const method of METHODS) {
      const before = await snapshot(deadLetterJob);

      await expect(callTransition(method, deadLetterJob)).resolves.toBe(false);

      expect({ method, row: await snapshot(deadLetterJob) }).toEqual({
        method,
        row: before,
      });
    }
  });
});

describe("job transitions: what the caller passed is what the row holds", () => {
  it("case 6: the timestamps land as passed, milliseconds included", async () => {
    const startedId = nextJobId();
    const failedId = nextJobId();
    const completedId = nextJobId();
    const retriedId = nextJobId();
    await createJob({ id: startedId, status: "retrying" });
    await createJob({ id: failedId, status: "running" });
    await createJob({ id: completedId, status: "running" });
    await createJob({ id: retriedId, status: "running" });

    await expect(callTransition(MARK_RUNNING, startedId)).resolves.toBe(true);
    await expect(callTransition(MARK_FAILED, failedId)).resolves.toBe(true);
    await expect(callTransition(MARK_SUCCEEDED, completedId)).resolves.toBe(true);
    await expect(callTransition(MARK_RETRYING, retriedId)).resolves.toBe(true);

    // Each value was passed by the caller, not stamped by the database: the
    // application clock is unchanged by this migration. `to_char` compares the
    // stored instants byte for byte, so a rounded, truncated or re-stamped value
    // fails here.
    expect(await utcIso(startedId, "started_at")).toBe(RUNNING_AT);
    expect(await utcIso(failedId, "failed_at")).toBe(FAILED_AT);
    expect(await utcIso(completedId, "completed_at")).toBe(COMPLETED_AT);
    // `markRetrying` writes no stamp at all, so this row has none from the CALL.
    expect(await utcIso(retriedId, "failed_at")).toBeNull();
    // Three different instants, three different columns — none of them `now()`.
    expect(
      new Set([
        await utcIso(startedId, "started_at"),
        await utcIso(failedId, "failed_at"),
        await utcIso(completedId, "completed_at"),
      ]).size,
    ).toBe(3);
  });

  it("case 7: a nested result document — arrays included — round-trips deep equal", async () => {
    const jobId = nextJobId();
    await createJob({ id: jobId, status: "running" });

    await expect(
      callTransition(MARK_SUCCEEDED, jobId, { result: RESULT_DOCUMENT }),
    ).resolves.toBe(true);

    const stored = (await requiresJobRow(jobId)).result;
    expect(stored).not.toBeNull();
    expect(JSON.parse(String(stored))).toEqual(RESULT_DOCUMENT);
    // The array really is an array, not a PostgreSQL array literal read back as
    // a string — the 2026-10-15 incident in one assertion.
    expect(Array.isArray(JSON.parse(String(stored)).images)).toBe(true);
  });

  it("case 8: an empty error message is stored as an empty string, not as NULL", async () => {
    await expect(
      repository.markRetrying({
        jobId: emptyTextJob,
        errorCode: "",
        errorMessage: "",
      }),
    ).resolves.toBe(true);

    const after = await requiresJobRow(emptyTextJob);
    expect(after.error_code).toBe("");
    expect(after.error_message).toBe("");
    expect(after.error_code).not.toBeNull();
  });
});

describe("job transitions: the guard is the refund's authority", () => {
  it("case 9: two concurrent markFailed calls for the same row — exactly one is true", async () => {
    // Two logical connections to the same database, each opening its own
    // transaction: the race the worker can actually lose. `markFailed`'s answer
    // is the ONLY thing that authorises a refund, so two `true`s here would pay
    // the same charge twice.
    const first = createJobTransitionRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });
    const second = createJobTransitionRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    const results = await Promise.all([
      first.markFailed({
        jobId: raceJob,
        errorCode: "race_first",
        errorMessage: "the first writer",
        failedAt: FAILED_AT,
      }),
      second.markFailed({
        jobId: raceJob,
        errorCode: "race_second",
        errorMessage: "the second writer",
        failedAt: FAILED_AT,
      }),
    ]);

    expect(results.filter((changed) => changed)).toHaveLength(1);

    // The row carries the WINNER's values: the loser wrote nothing at all.
    const winner = results[0] ? "race_first" : "race_second";
    const after = await requiresJobRow(raceJob);
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe(winner);
    expect(await utcIso(raceJob, "failed_at")).toBe(FAILED_AT);

    // And the row can never be failed a second time by a later delivery.
    await expect(
      repository.markFailed({
        jobId: raceJob,
        errorCode: "late_delivery",
        errorMessage: "too late",
        failedAt: FAILED_AT,
      }),
    ).resolves.toBe(false);
    expect((await requiresJobRow(raceJob)).error_code).toBe(winner);
  });

  it("case 10: the statement itself answers one row exactly once when executed repeatedly", async () => {
    const recording = recordingPool();
    const observed = createJobTransitionRepository({
      getTransactionPool: () => recording.pool,
    });

    // One real call first: this captures the statement the repository builds and
    // proves it is the statement PostgreSQL accepts.
    await expect(
      observed.markFailed({
        jobId: statementRaceJob,
        errorCode: FAILED_CODE,
        errorMessage: FAILED_MESSAGE,
        failedAt: FAILED_AT,
      }),
    ).resolves.toBe(true);
    expect(recording.statements).toHaveLength(1);
    const sql = recording.statements[0]!;

    // Put the row back and fire the SAME statement four times. The guard, not
    // this process, decides: exactly one execution may return a row.
    await db.query(
      `update public.background_jobs
          set status = 'queued', error_code = null, error_message = null,
              failed_at = null
        where id = $1`,
      [statementRaceJob],
    );

    const executed = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.query(sql, [
          statementRaceJob,
          FAILED_CODE,
          FAILED_MESSAGE,
          FAILED_AT,
        ]),
      ),
    );

    const changed = executed.filter((result) => result.rows.length > 0);
    expect(changed).toHaveLength(1);
    expect(executed.map((result) => result.rows.length).sort()).toEqual([
      0, 0, 0, 1,
    ]);
    expect((await requiresJobRow(statementRaceJob)).status).toBe("failed");
  });

  it("case 11: a row that is already terminal is refused untouched", async () => {
    const before = await snapshot(raceLoser);

    await expect(
      repository.markFailed({
        jobId: raceLoser,
        errorCode: "second_refund",
        errorMessage: "would be a double refund",
        failedAt: FAILED_AT,
      }),
    ).resolves.toBe(false);

    expect(await snapshot(raceLoser)).toBe(before);
    expect((await requiresJobRow(raceLoser)).error_code).toBe("already_terminal");
  });

  it("case 12: an unknown job id is false, not an error", async () => {
    const missing = nextJobId();

    await expect(callTransition(MARK_FAILED, missing)).resolves.toBe(false);
    await expect(callTransition(MARK_RUNNING, missing)).resolves.toBe(false);
    await expect(jobRow(missing)).resolves.toBeNull();
  });
});

describe("job transitions: refusals leave the pool usable", () => {
  it("case 13: a malformed uuid is a real SQL error on all four, and nothing moves", async () => {
    const before = await allStates();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.background_jobs where id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const errors = [
      await refusal(
        () => repository.markRunning({ jobId: INVALID_ID, startedAt: RUNNING_AT }),
        MARK_RUNNING,
      ),
      await refusal(
        () =>
          repository.markRetrying({
            jobId: INVALID_ID,
            errorCode: FAILED_CODE,
            errorMessage: FAILED_MESSAGE,
          }),
        MARK_RETRYING,
      ),
      await refusal(
        () =>
          repository.markSucceeded({
            jobId: INVALID_ID,
            result: RESULT_DOCUMENT,
            completedAt: COMPLETED_AT,
          }),
        MARK_SUCCEEDED,
      ),
      await refusal(
        () =>
          repository.markFailed({
            jobId: INVALID_ID,
            errorCode: FAILED_CODE,
            errorMessage: FAILED_MESSAGE,
            failedAt: FAILED_AT,
          }),
        MARK_FAILED,
      ),
    ];

    for (const transitionError of errors) {
      // The fixed message carries no SQL, no host and no existence answer.
      expect(transitionError.message).not.toMatch(
        /public\.|background_jobs|invalid input|postgres:\/\//i,
      );
      // The cause is the PostgreSQL parse failure, not a zero-row or shape answer.
      expect((transitionError.cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    expect(await allStates()).toEqual(before);

    // All four failed transactions rolled back, so the very same pool works.
    await expect(callTransition(MARK_RUNNING, rollbackJob)).resolves.toBe(true);
  });

  it("case 14: ids carrying SQL move nothing, because they are only binds", async () => {
    const before = await allStates();

    for (const jobId of [INJECTION_ID, `' or id is not null --`]) {
      const errors = [
        await refusal(
          () => repository.markRunning({ jobId, startedAt: RUNNING_AT }),
          MARK_RUNNING,
        ),
        await refusal(
          () =>
            repository.markFailed({
              jobId,
              errorCode: FAILED_CODE,
              errorMessage: FAILED_MESSAGE,
              failedAt: FAILED_AT,
            }),
          MARK_FAILED,
        ),
      ];
      for (const transitionError of errors) {
        expect(transitionError.cause).toBeInstanceOf(Error);
      }
    }

    // If an id had been concatenated, the last statement would have failed every
    // job in the table.
    expect(await allStates()).toEqual(before);
  });

  it("case 15: a broken statement rolls back and leaves the same pool usable", async () => {
    const jobId = injectionJob;
    const before = await snapshot(jobId);

    // A real statement-level failure: the projection names a column that does
    // not exist, so PostgreSQL rejects the statement (SQLSTATE 42703) inside the
    // transaction — AFTER the UPDATE itself has run, which is what makes the
    // rollback visible work.
    const brokenPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            if (sql.includes("public.background_jobs")) {
              return inner.query(
                sql.replace("returning id", "returning id, no_such_column"),
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

    const error = await createJobTransitionRepository({
      getTransactionPool: () => brokenPool,
    })
      .markRunning({ jobId, startedAt: RUNNING_AT })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobTransitionError);
    expect((error as JobTransitionError).message).not.toMatch(
      /public\.|background_jobs|no_such_column/i,
    );
    expect(((error as JobTransitionError).cause as Error).message).toMatch(
      /no_such_column/,
    );

    // The UPDATE was undone: the row is exactly where it was.
    expect(await snapshot(jobId)).toBe(before);
    expect((await requiresJobRow(jobId)).status).toBe("queued");

    // Same pool, next call: works.
    await expect(
      repository.markRunning({ jobId, startedAt: RUNNING_AT }),
    ).resolves.toBe(true);
    expect((await requiresJobRow(jobId)).status).toBe("running");
  });
});

describe("job transitions: transaction context", () => {
  it("case 16: privileged writes with NO actor, and no setting survives", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction the statement ran in, not a reconstruction.
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

    const observing = createJobTransitionRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.markRunning({ jobId: contextJob, startedAt: RUNNING_AT }),
    ).resolves.toBe(true);
    await expect(
      observing.markRetrying({
        jobId: contextJob,
        errorCode: FAILED_CODE,
        errorMessage: FAILED_MESSAGE,
      }),
    ).resolves.toBe(true);

    expect(observed).toHaveLength(2);
    // No forged user: this is the worker writing its own job rows, so every
    // actor setting is empty and the mode is the explicit privileged label.
    for (const settings of observed) {
      expect(settings).toEqual({
        user_id: "",
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone, so the
    // context of one transition cannot become the context of the next.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});
