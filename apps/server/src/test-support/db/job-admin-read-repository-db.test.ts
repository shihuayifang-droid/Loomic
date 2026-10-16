import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JOB_ADMIN_READ_COLUMNS,
  JobAdminReadError,
  READ_JOB,
  createJobAdminReadRepository,
  type JobAdminReadRepository,
  type JobAdminReadRow,
} from "../../db/job-admin-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import {
  JobServiceError,
  createJobService,
  type JobService,
} from "../../features/jobs/job-service.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the admin job read repository (workorder 21I).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves PostgreSQL actually parses and executes it against the real table, and
 * that the properties the callers rest on are facts of the database rather than
 * of this process:
 *
 *   - every one of the 22 columns comes back from the row, keyed by column name,
 *     with the six timestamps normalised to ISO strings whose instant is the
 *     database's own millisecond value;
 *   - a nullable column that holds SQL NULL reads as `null`, and the required
 *     timestamps are never null;
 *   - `jsonb` arrives already parsed, nested objects and arrays included;
 *   - a legacy `dead_letter` row is returned as `dead_letter` here and read as
 *     `failed` by `JobService`, which keeps `mapJobRow` the only mapping point;
 *   - an unknown id is `null`, a malformed uuid is a real SQL error that rolls
 *     back and leaves the same pool usable, and the read never moves a row;
 *   - the transaction-local context of the read does not survive COMMIT;
 *   - with no repository wired the service fails closed instead of reaching for
 *     the admin client it used to read through.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-0000000021f0";
const PROJECT_ID = "00000000-0000-0000-0000-000000002101";
const CANVAS_ID = "00000000-0000-0000-0000-000000002102";
const SESSION_ID = "00000000-0000-0000-0000-000000002103";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

const JOB_QUEUED = "00000000-0000-0000-0000-0000000021a0";
const JOB_RUNNING = "00000000-0000-0000-0000-0000000021a1";
const JOB_SUCCEEDED = "00000000-0000-0000-0000-0000000021a2";
const JOB_FAILED = "00000000-0000-0000-0000-0000000021a3";
const JOB_CANCELED = "00000000-0000-0000-0000-0000000021a4";
const JOB_RETRYING = "00000000-0000-0000-0000-0000000021a5";
const JOB_DEAD_LETTER = "00000000-0000-0000-0000-0000000021a6";

/** The six values of `public.background_job_status`. */
const STATUS_ROWS = [
  [JOB_QUEUED, "queued"],
  [JOB_RUNNING, "running"],
  [JOB_SUCCEEDED, "succeeded"],
  [JOB_FAILED, "failed"],
  [JOB_CANCELED, "canceled"],
  [JOB_RETRYING, "retrying"],
] as const;

/** Millisecond-exact fixture timestamps, so no rounding can blur a comparison. */
const CREATED_AT = "2026-03-04T05:06:07.891Z";
const UPDATED_AT = "2026-03-04T05:07:08.892Z";
const STARTED_AT = "2026-03-04T05:06:10.111Z";
const COMPLETED_AT = "2026-03-04T05:06:20.222Z";
const FAILED_AT = "2026-03-04T05:06:30.333Z";
const CANCELED_AT = "2026-03-04T05:06:40.444Z";

/**
 * The jsonb the `succeeded` row carries: a nested object with arrays inside it,
 * so "the drivers parse jsonb and this module passes it through" is measured on
 * something a naive flattener would damage.
 */
const NESTED_PAYLOAD = {
  prompt: "a cat riding a bicycle",
  nested: { steps: [1, 2, { depth: "deep" }], flags: [true, false, null] },
  list: ["x", { y: "z" }],
};

const NESTED_RESULT = {
  object_path: "ws-personal/21i/key.png",
  meta: { sizes: [{ width: 512, height: 512 }], labels: ["cat"] },
};

let db: PGlite;
let pool: TransactionPool;
let repository: JobAdminReadRepository;
let workspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** `timestamptz` rendered as the ISO string the HTTP contract publishes. */
function iso(column: string): string {
  return (
    `to_char(${column} at time zone 'UTC', ` +
    `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`
  );
}

/**
 * The row as the DATABASE describes it: the same 22 columns the repository
 * projects (so the two are compared field by field), with every timestamp in
 * the same ISO shape. It is the independent second opinion — if the repository
 * invented, dropped or reordered a value, this is what disagrees.
 */
const SELECT_JOB_TRUTH_SQL = `
select
  id::text as id,
  workspace_id::text as workspace_id,
  project_id::text as project_id,
  canvas_id::text as canvas_id,
  session_id::text as session_id,
  thread_id,
  queue_name,
  job_type::text as job_type,
  status::text as status,
  payload,
  result,
  error_code,
  error_message,
  attempt_count,
  max_attempts,
  created_by::text as created_by,
  ${iso("created_at")},
  ${iso("updated_at")},
  ${iso("started_at")},
  ${iso("completed_at")},
  ${iso("failed_at")},
  ${iso("canceled_at")}
from public.background_jobs
where id = $1::uuid
`;

/** The whole row as one comparable value, for "nothing moved" assertions. */
const SELECT_JOB_SNAPSHOT_SQL = `
select j::text as row_text
from public.background_jobs as j
where j.id = $1::uuid
`;

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

/** What the fixture may say per row; everything omitted is an explicit NULL. */
type JobFixture = {
  id: string;
  status: string;
  projectId?: string;
  canvasId?: string;
  sessionId?: string;
  threadId?: string;
  queueName?: string;
  jobType?: string;
  payload?: unknown;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  attemptCount?: number;
  maxAttempts?: number;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  canceledAt?: string;
};

/**
 * Insert through the real column list — all 22 of them, named — so a fixture can
 * place a value (or an explicit NULL) on any column the repository projects.
 * Nothing is left to a table default here: a default would make "the repository
 * read what the fixture wrote" unprovable for that column.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, error_code, error_message,
  attempt_count, max_attempts, created_by,
  created_at, updated_at, started_at, completed_at, failed_at, canceled_at
) values (
  $1, $2, $3, $4, $5, $6,
  $7, $8::public.background_job_type, $9::public.background_job_status,
  $10::jsonb, $11::jsonb, $12, $13,
  $14, $15, $16,
  $17, $18, $19, $20, $21, $22
)
`;

async function insertJob(fixture: JobFixture): Promise<void> {
  await db.query(INSERT_JOB_SQL, [
    fixture.id,
    workspaceId,
    fixture.projectId ?? null,
    fixture.canvasId ?? null,
    fixture.sessionId ?? null,
    fixture.threadId ?? null,
    fixture.queueName ?? "image_generation_jobs",
    fixture.jobType ?? "image_generation",
    fixture.status,
    JSON.stringify(fixture.payload ?? {}),
    fixture.result === undefined ? null : JSON.stringify(fixture.result),
    fixture.errorCode ?? null,
    fixture.errorMessage ?? null,
    fixture.attemptCount ?? 0,
    fixture.maxAttempts ?? 3,
    USER_ID,
    fixture.createdAt ?? CREATED_AT,
    fixture.updatedAt ?? UPDATED_AT,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.failedAt ?? null,
    fixture.canceledAt ?? null,
  ]);
}

/** The database's own answer for one row, in the repository's shape. */
async function dbTruth(jobId: string): Promise<JobAdminReadRow | null> {
  const rows = (
    await db.query<JobAdminReadRow>(SELECT_JOB_TRUTH_SQL, [jobId])
  ).rows;
  return rows[0] ?? null;
}

async function requiresTruth(jobId: string): Promise<JobAdminReadRow> {
  const row = await dbTruth(jobId);
  if (row === null) throw new Error(`job ${jobId} is missing`);
  return row;
}

async function snapshot(jobId: string): Promise<string> {
  return firstRow(
    (await db.query<{ row_text: string }>(SELECT_JOB_SNAPSHOT_SQL, [jobId]))
      .rows,
  ).row_text;
}

async function jobCount(): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.background_jobs",
      )
    ).rows,
  ).n;
}

/**
 * The service under test: the REAL repository over the PGlite pool, and an admin
 * client that throws. `getJobAdmin` must therefore never touch PostgREST — a
 * fallback would not quietly succeed here, it would fail the case.
 */
function buildService(
  options: { withoutReadRepository?: boolean } = {},
): JobService {
  return createJobService({
    createUserClient: () => {
      throw new Error("getJobAdmin must not build a user client");
    },
    getAdminClient: () => {
      throw new Error("getJobAdmin must not reach for the admin client");
    },
    pgmq: {
      send: async () => 1,
      deleteMsg: async () => true,
      archive: async () => true,
    } as unknown as PgmqClient,
    ...(options.withoutReadRepository
      ? {}
      : { jobAdminReadRepository: repository }),
  });
}

/** The service call with its refusal captured instead of thrown. */
async function serviceRefusal(
  call: () => Promise<unknown>,
): Promise<JobServiceError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobServiceError);
  return error as JobServiceError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobAdminReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-admin-read@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `select id
           from public.workspaces
          where owner_user_id = $1
            and type = 'personal'`,
        [USER_ID],
      )
    ).rows,
  ).id;

  // The parents the three nullable uuid columns point at, so those columns can
  // carry real values instead of NULL in the row that populates every column.
  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, created_by)
     values ($1, $2, 'Job admin read', 'job-admin-read-21i', $3)`,
    [PROJECT_ID, workspaceId, USER_ID],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, created_by)
     values ($1, $2, 'Job admin read canvas', $3)`,
    [CANVAS_ID, PROJECT_ID, USER_ID],
  );
  await db.query(
    `insert into public.chat_sessions (id, canvas_id, title, created_by)
     values ($1, $2, 'Job admin read session', $3)`,
    [SESSION_ID, CANVAS_ID, USER_ID],
  );

  // One row per status. The `succeeded` row is the one that populates EVERY
  // column — including the error fields, which an ordinary succeeded row would
  // leave NULL: the 22-column comparison needs a value on each column to compare.
  await insertJob({ id: JOB_QUEUED, status: "queued", attemptCount: 0 });
  await insertJob({
    id: JOB_RUNNING,
    status: "running",
    attemptCount: 1,
    startedAt: STARTED_AT,
  });
  await insertJob({
    id: JOB_SUCCEEDED,
    status: "succeeded",
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    sessionId: SESSION_ID,
    threadId: "thread-21i",
    payload: NESTED_PAYLOAD,
    result: NESTED_RESULT,
    errorCode: "retried_once",
    errorMessage: "the first attempt timed out",
    attemptCount: 2,
    maxAttempts: 5,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    failedAt: FAILED_AT,
    canceledAt: CANCELED_AT,
  });
  await insertJob({
    id: JOB_FAILED,
    status: "failed",
    errorCode: "executor_error",
    errorMessage: "the model refused",
    attemptCount: 3,
    startedAt: STARTED_AT,
    failedAt: FAILED_AT,
  });
  await insertJob({
    id: JOB_CANCELED,
    status: "canceled",
    canceledAt: CANCELED_AT,
  });
  await insertJob({
    id: JOB_RETRYING,
    status: "retrying",
    errorCode: "provider_unavailable",
    errorMessage: "will try again",
    attemptCount: 1,
    startedAt: STARTED_AT,
  });
  // A legacy terminal row: the worker never writes `dead_letter` any more, but
  // historical rows still carry it.
  await insertJob({
    id: JOB_DEAD_LETTER,
    status: "dead_letter",
    errorCode: "executor_error",
    errorMessage: "legacy terminal row",
    attemptCount: 3,
    startedAt: STARTED_AT,
    failedAt: FAILED_AT,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job admin read: the row PostgreSQL hands back", () => {
  it("case 1: each of the six statuses reads back its own status", async () => {
    for (const [jobId, status] of STATUS_ROWS) {
      const row = await repository.readJob({ jobId });

      expect(row?.id).toBe(jobId);
      expect(row?.status).toBe(status);
    }
  });

  it("case 2: a legacy dead_letter row is returned AS dead_letter here", async () => {
    const row = await repository.readJob({ jobId: JOB_DEAD_LETTER });

    // The translation to `failed` belongs to `JobService.mapJobRow` and stays
    // there: moving it into the repository would let `getJob` and `listJobs`
    // drift away from `getJobAdmin`.
    expect(row?.status).toBe("dead_letter");
    expect((await requiresTruth(JOB_DEAD_LETTER)).status).toBe("dead_letter");
  });

  it("case 3: all 22 columns are read from the row, one by one", async () => {
    const row = await repository.readJob({ jobId: JOB_SUCCEEDED });
    if (row === null) throw new Error("expected the succeeded row");

    const truth = await requiresTruth(JOB_SUCCEEDED);

    // Column by column against the database's own projection of the same row.
    for (const column of JOB_ADMIN_READ_COLUMNS) {
      expect([column, row[column]]).toEqual([column, truth[column]]);
    }
    expect(row).toEqual(truth);

    // And the values themselves, named, so a silently reordered projection
    // cannot pass by matching a row that moved with it.
    expect(row.id).toBe(JOB_SUCCEEDED);
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.project_id).toBe(PROJECT_ID);
    expect(row.canvas_id).toBe(CANVAS_ID);
    expect(row.session_id).toBe(SESSION_ID);
    expect(row.thread_id).toBe("thread-21i");
    expect(row.queue_name).toBe("image_generation_jobs");
    expect(row.job_type).toBe("image_generation");
    expect(row.status).toBe("succeeded");
    expect(row.payload).toEqual(NESTED_PAYLOAD);
    expect(row.result).toEqual(NESTED_RESULT);
    expect(row.error_code).toBe("retried_once");
    expect(row.error_message).toBe("the first attempt timed out");
    expect(row.attempt_count).toBe(2);
    expect(row.max_attempts).toBe(5);
    expect(row.created_by).toBe(USER_ID);
    expect(row.created_at).toBe(CREATED_AT);
    expect(row.updated_at).toBe(UPDATED_AT);
    expect(row.started_at).toBe(STARTED_AT);
    expect(row.completed_at).toBe(COMPLETED_AT);
    expect(row.failed_at).toBe(FAILED_AT);
    expect(row.canceled_at).toBe(CANCELED_AT);
  });

  it("case 4: jsonb nested objects and arrays come back as they were stored", async () => {
    const row = await repository.readJob({ jobId: JOB_SUCCEEDED });
    const truth = await requiresTruth(JOB_SUCCEEDED);

    expect(row?.payload).toEqual(NESTED_PAYLOAD);
    expect(row?.result).toEqual(NESTED_RESULT);
    expect(row?.payload).toEqual(truth.payload);
    // Deep, not shallow: the array inside the nested object is still an array of
    // the same length, with the same object inside it.
    const payload = row?.payload as typeof NESTED_PAYLOAD;
    expect(Array.isArray(payload.nested.steps)).toBe(true);
    expect(payload.nested.steps).toHaveLength(3);
    expect(payload.nested.steps[2]).toEqual({ depth: "deep" });
    expect(payload.list[1]).toEqual({ y: "z" });
  });

  it("case 5: a NULL column is null, and the required timestamps never are", async () => {
    const row = await repository.readJob({ jobId: JOB_QUEUED });
    if (row === null) throw new Error("expected the queued row");

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

    // The two required timestamps are present on every row, NULL or not.
    expect(row.created_at).toBe(CREATED_AT);
    expect(row.updated_at).toBe(UPDATED_AT);
    // `attempt_count` is 0 here — a count, not a missing value.
    expect(row.attempt_count).toBe(0);
  });

  it("case 6: timestamps are ISO strings whose instant is the database's", async () => {
    const row = await repository.readJob({ jobId: JOB_SUCCEEDED });
    if (row === null) throw new Error("expected the succeeded row");

    for (const [column, expected] of [
      ["created_at", CREATED_AT],
      ["updated_at", UPDATED_AT],
      ["started_at", STARTED_AT],
      ["completed_at", COMPLETED_AT],
      ["failed_at", FAILED_AT],
      ["canceled_at", CANCELED_AT],
    ] as const) {
      const value = row[column];

      expect(typeof value).toBe("string");
      expect(value).toBe(expected);
      // Same millisecond as the database's own rendering of the same column —
      // and the same instant as the fixture literal.
      expect(new Date(value as string).getTime()).toBe(Date.parse(expected));
      expect(value).toBe((await requiresTruth(JOB_SUCCEEDED))[column]);
    }
  });
});

describe("job admin read: one row by primary key", () => {
  it("case 7: an unknown id is null, not an error", async () => {
    await expect(
      repository.readJob({ jobId: "00000000-0000-0000-0000-0000000021ff" }),
    ).resolves.toBeNull();
    // The table is NOT empty, so `null` here means "no such job" rather than
    // "the read returned nothing at all".
    expect(await jobCount()).toBeGreaterThan(1);
  });

  it("case 8: the read does not cross rows", async () => {
    const total = await jobCount();
    const others = await Promise.all(
      STATUS_ROWS.map(([jobId]) => snapshot(jobId)),
    );

    for (const [jobId, status] of STATUS_ROWS) {
      const row = await repository.readJob({ jobId });

      // Exactly the requested row: not a sibling, not a mix, not the newest one.
      expect(row?.id).toBe(jobId);
      expect(row?.status).toBe(status);
      expect(Object.keys(row ?? {})).toEqual([...JOB_ADMIN_READ_COLUMNS]);
    }

    expect(await jobCount()).toBe(total);
    expect(
      await Promise.all(STATUS_ROWS.map(([jobId]) => snapshot(jobId))),
    ).toEqual(others);
  });
});

describe("job admin read: the read rolls back, leaves nothing behind, moves nothing", () => {
  it("case 9: a malformed uuid is a real SQL error, and the pool stays usable", async () => {
    const before = await jobCount();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query(SELECT_JOB_TRUTH_SQL, [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await repository
      .readJob({ jobId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobAdminReadError);
    const readError = error as JobAdminReadError;
    expect(readError.operation).toBe(READ_JOB);
    // The fixed message carries no SQL, no host, no job id and no existence
    // answer; the cause is the PostgreSQL parse failure.
    expect(readError.message).toBe(`job admin read failed (${READ_JOB})`);
    expect(readError.message).not.toMatch(
      /public\.|background_jobs|invalid input|postgres:\/\//i,
    );
    expect((readError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    expect(await jobCount()).toBe(before);

    // The failed transaction rolled back, so the very same pool answers.
    const row = await repository.readJob({ jobId: JOB_RUNNING });
    expect(row?.status).toBe("running");
  });

  it("case 10: reading does not change the row", async () => {
    const before = new Map<string, string>();
    for (const [jobId] of STATUS_ROWS) before.set(jobId, await snapshot(jobId));
    before.set(JOB_DEAD_LETTER, await snapshot(JOB_DEAD_LETTER));

    await Promise.all(
      [...before.keys()].map((jobId) => repository.readJob({ jobId })),
    );

    // The whole row as `::text`, before and after: no timestamp moved, no
    // counter was touched, no column was rewritten by the read.
    for (const [jobId, snapshotBefore] of before) {
      expect([jobId, await snapshot(jobId)]).toEqual([jobId, snapshotBefore]);
    }
  });

  it("case 11: the read's transaction context is privileged, empty, and does not leak", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction the statement ran in, not a reconstruction.
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.background_jobs")) {
              observed.push(
                firstRow(
                  (await inner.query(READ_SETTINGS_SQL)).rows,
                ) as SettingsRow,
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

    const observing = createJobAdminReadRepository({
      getTransactionPool: () => observingPool,
    });

    for (const [jobId] of STATUS_ROWS) {
      await expect(observing.readJob({ jobId })).resolves.not.toBeNull();
    }

    expect(observed).toHaveLength(STATUS_ROWS.length);
    // No forged user: this is the server's own read, so every actor setting is
    // empty and the mode is the explicit privileged label.
    for (const settings of observed) {
      expect(settings).toEqual({
        user_id: "",
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone, so the
    // context of this read cannot become the context of the next statement.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

describe("job admin read: through the real JobService", () => {
  it("case 12: every status reaches the caller unchanged", async () => {
    const service = buildService();

    for (const [jobId, status] of STATUS_ROWS) {
      const job = await service.getJobAdmin(jobId);

      expect(job.id).toBe(jobId);
      expect(job.status).toBe(status);
    }
  });

  it("case 13: a legacy dead_letter row is read as failed by the service", async () => {
    const service = buildService();

    const job = await service.getJobAdmin(JOB_DEAD_LETTER);

    expect(job.status).toBe("failed");
    // The repository still reports the raw value: the mapping happened once, in
    // `mapJobRow`.
    expect((await repository.readJob({ jobId: JOB_DEAD_LETTER }))?.status).toBe(
      "dead_letter",
    );
  });

  it("case 14: an unknown id is the service's existing 404", async () => {
    const service = buildService();

    const error = await serviceRefusal(() =>
      service.getJobAdmin("00000000-0000-0000-0000-0000000021ff"),
    );

    expect(error.code).toBe("job_not_found");
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Job not found.");
  });

  it("case 15: a malformed uuid stays a 500, and carries no driver text", async () => {
    const service = buildService();

    const error = await serviceRefusal(() => service.getJobAdmin(INVALID_ID));

    // The old PostgREST read failed this way too, so it is NOT turned into a 404
    // here: "the database refused the argument" is not "no such job".
    expect(error.code).toBe("job_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query job.");
    expect(error.message).not.toMatch(/invalid input|uuid|postgres:\/\//i);
  });

  it("case 16: with no repository wired the service fails closed, even for a row that exists", async () => {
    const service = buildService({ withoutReadRepository: true });

    const error = await serviceRefusal(() => service.getJobAdmin(JOB_SUCCEEDED));

    expect(error.code).toBe("job_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query job.");

    // The row is really there — the refusal is the missing dependency, not a
    // missing job, and nothing fell back to the admin client (whose stub would
    // have thrown a different error).
    await expect(repository.readJob({ jobId: JOB_SUCCEEDED })).resolves.not.toBeNull();
  });

  it("case 17: neither the success nor the failure path touches the admin client", async () => {
    // The stub throws on contact, so the assertions below can only pass while
    // `getJobAdmin` stays off PostgREST entirely.
    const service = buildService();

    await expect(service.getJobAdmin(JOB_QUEUED)).resolves.toMatchObject({
      id: JOB_QUEUED,
      status: "queued",
    });
    await expect(
      serviceRefusal(() => service.getJobAdmin(INVALID_ID)),
    ).resolves.toBeInstanceOf(JobServiceError);
  });
});
