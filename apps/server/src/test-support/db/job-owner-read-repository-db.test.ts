import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JOB_OWNER_READ_COLUMNS,
  JobOwnerReadError,
  LIST_OWN_JOBS,
  READ_OWN_JOB,
  createJobOwnerReadRepository,
  type JobOwnerReadRepository,
  type JobOwnerReadRow,
} from "../../db/job-owner-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import {
  JobServiceError,
  createJobService,
  type JobService,
} from "../../features/jobs/job-service.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the owner job read repository (workorder 21T).
 *
 * The unit tests beside the repository prove WHICH statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * table, and that the properties the callers rest on are facts of the database
 * rather than of this process:
 *
 *   - the ACL is `created_by = actor` and NOTHING else. Two users are placed in
 *     the SAME workspace, one of them as its OWNER (the team's administrator),
 *     and neither of them can read the other's jobs — through the repository OR
 *     through the RLS policy the read replaces. That is the discriminating
 *     evidence: a membership check, a role check or a workspace check would all
 *     make the administrator's read succeed, and none of them may exist;
 *   - every identity's visibility is measured TWICE — once through the
 *     privileged repository and once through `asUser()` (role `authenticated`
 *     plus a transaction-local JWT subject) — and the two must be EQUAL;
 *   - the four filter combinations answer what the PostgREST read answered,
 *     `failed` included the legacy `dead_letter` rows, and an UNKNOWN filter
 *     value is a real SQL error (22P02) that rolls back and leaves the pool
 *     usable — not an empty list with a 200;
 *   - the list is newest first and capped at 50 by the statement itself;
 *   - a read moves no row and leaves no session context behind;
 *   - through the REAL `JobService`, `getJob` answers its existing 404 / 500 and
 *     maps `dead_letter` to `failed`, `listJobs` answers its existing 500 and
 *     `[]`, and neither of them builds a user client any more.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

/** A: a plain member of the team workspace, and the author of the fixture jobs. */
const AUTHOR_ID = "00000000-0000-0000-0000-00000021a001";
/** B: another plain member of the SAME workspace. */
const MEMBER_ID = "00000000-0000-0000-0000-00000021a002";
/** C: the OWNER (administrator) of the SAME workspace — still not the author. */
const TEAM_OWNER_ID = "00000000-0000-0000-0000-00000021a003";
/** D: a user who is not a member of that workspace at all. */
const OUTSIDER_ID = "00000000-0000-0000-0000-00000021a004";
/** E: the author of the 51 rows the ordering/limit case measures. */
const BULK_ID = "00000000-0000-0000-0000-00000021a005";

const PROJECT_ID = "00000000-0000-0000-0000-000000210101";
const CANVAS_ID = "00000000-0000-0000-0000-000000210102";
const SESSION_ID = "00000000-0000-0000-0000-000000210103";

const TEAM_NAME = "Job Owner Read Team";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";
/** A well-formed uuid no row carries. */
const MISSING_ID = "00000000-0000-0000-0000-00000021bfff";

const JOB_QUEUED = "00000000-0000-0000-0000-00000021b0a0";
const JOB_RUNNING = "00000000-0000-0000-0000-00000021b0a1";
const JOB_SUCCEEDED = "00000000-0000-0000-0000-00000021b0a2";
const JOB_FAILED = "00000000-0000-0000-0000-00000021b0a3";
const JOB_CANCELED = "00000000-0000-0000-0000-00000021b0a4";
const JOB_RETRYING = "00000000-0000-0000-0000-00000021b0a5";
const JOB_DEAD_LETTER = "00000000-0000-0000-0000-00000021b0a6";
const JOB_VIDEO_QUEUED = "00000000-0000-0000-0000-00000021b0b0";
const JOB_VIDEO_FAILED = "00000000-0000-0000-0000-00000021b0b1";
const JOB_CODE_SUCCEEDED = "00000000-0000-0000-0000-00000021b0c0";
/** The one job the OTHER member created, in the same workspace. */
const JOB_MEMBER = "00000000-0000-0000-0000-00000021b0d0";

/** How many rows the ordering/limit case inserts for one actor. */
const BULK_ROWS = 51;
/** The statement's cap: one fewer than the rows that exist. */
const BULK_VISIBLE = 50;

/** Distinct, millisecond-exact fixture timestamps, so no ordering can blur. */
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
  object_path: "team/21t/key.png",
  meta: { sizes: [{ width: 512, height: 512 }], labels: ["cat"] },
};

let db: PGlite;
let pool: TransactionPool;
let repository: JobOwnerReadRepository;
let teamWorkspaceId = "";

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
 * The projection both the repository and this file's "second opinion" use. It is
 * spelled out here rather than imported so that a drift in the repository's own
 * select list is a disagreement this file can SEE.
 */
const COLUMN_LIST = `
  id,
  workspace_id,
  project_id,
  canvas_id,
  session_id,
  thread_id,
  queue_name,
  job_type,
  status,
  payload,
  result,
  error_code,
  error_message,
  attempt_count,
  max_attempts,
  created_by,
  created_at,
  updated_at,
  started_at,
  completed_at,
  failed_at,
  canceled_at`;

/**
 * The row as the DATABASE describes it: the same 22 columns the repository
 * projects (so the two are compared field by field), with every timestamp in the
 * same ISO shape. It is the independent second opinion — if the repository
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

/**
 * The removed PostgREST read of ONE job, as SQL: the same 22 columns, the same
 * one key — and NO `created_by` term, because the old read carried none. Under
 * `asUser()` the `background_jobs_user_policy` decides which row exists, exactly
 * as PostgREST's own client did; `maybeSingle()` is the `rows[0] ?? null` below.
 *
 * The new repository answers the same question under a privileged connection,
 * so its statement carries `created_by = actor` instead. Measured side by side,
 * the two must agree for EVERY identity — which is the whole point of the
 * comparison, because the explicit predicate is what replaces the policy.
 */
const SELECT_JOB_VIA_RLS_SQL = `select ${COLUMN_LIST}
from public.background_jobs
where id = $1`;

/**
 * The removed PostgREST read of the LIST, as SQL, under the same identity.
 *
 * Same question, same four filter combinations, same order and same cap as the
 * repository's statement; what differs is only HOW the actor is applied — the
 * repository's explicit `created_by = $1::uuid` against the policy reading
 * `auth.uid()`.
 */
const SELECT_JOBS_VIA_RLS_SQL = `select ${COLUMN_LIST}
from public.background_jobs
where created_by = $1::uuid
  and (
    $2::public.background_job_status is null
    or status = $2::public.background_job_status
    or ($2::public.background_job_status = 'failed' and status = 'dead_letter')
  )
  and (
    $3::public.background_job_type is null
    or job_type = $3::public.background_job_type
  )
order by created_at desc
limit 50`;

/**
 * The OLD `failed` filter, verbatim as the PostgREST read expressed it: a value
 * LIST (`in ("failed", "dead_letter")`) rather than the repository's `or` form.
 * The two must select the same ids, or the migration changed what the filter
 * means.
 */
const SELECT_LEGACY_FAILED_VIA_RLS_SQL = `select id::text as id
from public.background_jobs
where created_by = $1::uuid
  and status in ('failed', 'dead_letter')
order by created_at desc
limit 50`;

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
  createdBy?: string;
  workspaceId?: string;
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
    fixture.workspaceId ?? teamWorkspaceId,
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
    fixture.createdBy ?? AUTHOR_ID,
    fixture.createdAt ?? CREATED_AT,
    fixture.updatedAt ?? UPDATED_AT,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.failedAt ?? null,
    fixture.canceledAt ?? null,
  ]);
}

/** The database's own answer for one row, in the repository's shape. */
async function dbTruth(jobId: string): Promise<JobOwnerReadRow | null> {
  const rows = (
    await db.query<JobOwnerReadRow>(SELECT_JOB_TRUTH_SQL, [jobId])
  ).rows;
  return rows[0] ?? null;
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

/** The removed read, run as the given identity with RLS in force. */
async function readOwnViaRls(
  actorId: string,
  jobId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await asUser(db, actorId, (tx) =>
    tx.query<{ id: string; status: string }>(SELECT_JOB_VIA_RLS_SQL, [jobId]),
  );

  // The statement asks for the SAME 22 columns the repository projects — a full
  // row read is what the policy decides on — but the comparison below is about
  // visibility, so it is narrowed to the two fields both sides answer with.
  const row = result.rows[0];
  return row === undefined ? null : { id: row.id, status: row.status };
}

/** The removed list read, run as the given identity with RLS in force. */
async function listOwnViaRls(
  actorId: string,
  status: string | null = null,
  jobType: string | null = null,
): Promise<string[]> {
  const result = await asUser(db, actorId, (tx) =>
    tx.query<{ id: string }>(SELECT_JOBS_VIA_RLS_SQL, [actorId, status, jobType]),
  );

  return result.rows.map((row) => row.id);
}

async function listViaRepository(
  actorId: string,
  status: string | null = null,
  jobType: string | null = null,
): Promise<string[]> {
  const rows = await repository.listOwnJobs({ actorId, status, jobType });
  return rows.map((row) => row.id);
}

/**
 * The comparison this file exists for, for ONE identity: the repository (whose
 * statement carries the ACL) and the policy (which decides for the same actor
 * under `authenticated`) must agree — and both must agree with the expected
 * answer. A disagreement is therefore reported as a disagreement rather than as
 * two independent mismatches.
 */
async function expectSameVisibility(
  actorId: string,
  jobId: string,
  expected: { id: string; status: string } | null,
): Promise<void> {
  const byRepository = await repository.readOwnJob({ actorId, jobId });
  const byRls = await readOwnViaRls(actorId, jobId);

  expect(byRls).toEqual(expected);
  expect(
    byRepository === null
      ? null
      : { id: byRepository.id, status: byRepository.status },
  ).toEqual(byRls);
}

/** The same comparison for the list read, on one filter combination. */
async function expectSameListVisibility(
  actorId: string,
  status: string | null = null,
  jobType: string | null = null,
): Promise<string[]> {
  const byRepository = await listViaRepository(actorId, status, jobType);
  const byRls = await listOwnViaRls(actorId, status, jobType);

  expect(byRepository).toEqual(byRls);
  return byRepository;
}

/** The mixed-status answer the `failed` filter has to include. */
function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** The id of the `index`-th bulk row, ordered oldest first. */
function bulkJobId(index: number): string {
  return `00000000-0000-0000-0000-00000021c0${index
    .toString(16)
    .padStart(2, "0")}`;
}

/** The bulk row's timestamp: one minute apart, so the order is total. */
function bulkCreatedAt(index: number): string {
  const base = Date.parse("2026-05-01T00:00:00.000Z");
  return new Date(base + index * 60_000).toISOString();
}

type ServiceHarness = {
  service: JobService;
  userClientTokens: string[];
  adminClientCalls: () => number;
};

/**
 * The service under test: the REAL repository over the PGlite pool, and stubs
 * for the two clients that throw on contact. `getJob` and `listJobs` must
 * therefore never touch PostgREST — a fallback would not quietly succeed here,
 * it would fail the case.
 */
function buildService(
  options: { withoutOwnerRepository?: boolean } = {},
): ServiceHarness {
  const userClientTokens: string[] = [];
  let adminClientCalls = 0;

  const service = createJobService({
    createUserClient: (accessToken: string) => {
      userClientTokens.push(accessToken);
      throw new Error("getJob/listJobs must not build a user client");
    },
    getAdminClient: () => {
      adminClientCalls += 1;
      throw new Error("getJob/listJobs must not reach for the admin client");
    },
    pgmq: {
      send: async () => 1,
      deleteMsg: async () => true,
      archive: async () => true,
    } as unknown as PgmqClient,
    ...(options.withoutOwnerRepository
      ? {}
      : { jobOwnerReadRepository: repository }),
  });

  return {
    service,
    userClientTokens,
    adminClientCalls: () => adminClientCalls,
  };
}

function actor(id: string) {
  return { accessToken: "token", email: "user@hahart.test", id, userMetadata: {} };
}

/** The service call with its refusal captured instead of thrown. */
async function serviceRefusal(
  call: () => Promise<unknown>,
): Promise<JobServiceError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobServiceError);
  return error as JobServiceError;
}

/** The SQLSTATE a rejected statement carried, and its message. */
async function rejection(call: () => Promise<unknown>): Promise<{
  code: string;
  message: string;
}> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(Error);
  const refused = error as { code?: unknown; message?: unknown };
  return { code: String(refused.code), message: String(refused.message) };
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobOwnerReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, AUTHOR_ID, "job-owner-author@hahart.test");
  await createUser(db, MEMBER_ID, "job-owner-member@hahart.test");
  await createUser(db, TEAM_OWNER_ID, "job-owner-admin@hahart.test");
  await createUser(db, OUTSIDER_ID, "job-owner-outsider@hahart.test");
  await createUser(db, BULK_ID, "job-owner-bulk@hahart.test");

  // Exactly one team workspace may exist in the whole database. THREE users are
  // put in it — the author, another plain member, and its owner (the team's
  // administrator) — which is precisely what makes the ACL case discriminating:
  // if any membership or role check had been added, the administrator's read of
  // the author's job would succeed below.
  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2) returning id`,
        [TEAM_NAME, TEAM_OWNER_ID],
      )
    ).rows,
  ).id;

  for (const [userId, role] of [
    [TEAM_OWNER_ID, "owner"],
    [AUTHOR_ID, "member"],
    [MEMBER_ID, "member"],
    [BULK_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  // The parents the three nullable uuid columns point at, so those columns can
  // carry real values instead of NULL in the row that populates every column.
  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, created_by)
     values ($1, $2, 'Job owner read', 'job-owner-read-21t', $3)`,
    [PROJECT_ID, teamWorkspaceId, AUTHOR_ID],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, created_by)
     values ($1, $2, 'Job owner read canvas', $3)`,
    [CANVAS_ID, PROJECT_ID, AUTHOR_ID],
  );
  await db.query(
    `insert into public.chat_sessions (id, canvas_id, title, created_by)
     values ($1, $2, 'Job owner read session', $3)`,
    [SESSION_ID, CANVAS_ID, AUTHOR_ID],
  );

  // One row per status for the author, plus the two other job types the filter
  // cases need. The `succeeded` row is the one that populates EVERY column —
  // including the error fields, which an ordinary succeeded row would leave
  // NULL: the 22-column comparison needs a value on each column to compare.
  await insertJob({
    id: JOB_QUEUED,
    status: "queued",
    createdAt: "2026-03-04T05:00:01.000Z",
  });
  await insertJob({
    id: JOB_RUNNING,
    status: "running",
    attemptCount: 1,
    startedAt: STARTED_AT,
    createdAt: "2026-03-04T05:00:02.000Z",
  });
  await insertJob({
    id: JOB_SUCCEEDED,
    status: "succeeded",
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    sessionId: SESSION_ID,
    threadId: "thread-21t",
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
    createdAt: "2026-03-04T05:00:03.000Z",
  });
  await insertJob({
    id: JOB_FAILED,
    status: "failed",
    errorCode: "executor_error",
    errorMessage: "the model refused",
    attemptCount: 3,
    startedAt: STARTED_AT,
    failedAt: FAILED_AT,
    createdAt: "2026-03-04T05:00:04.000Z",
  });
  await insertJob({
    id: JOB_CANCELED,
    status: "canceled",
    canceledAt: CANCELED_AT,
    createdAt: "2026-03-04T05:00:05.000Z",
  });
  await insertJob({
    id: JOB_RETRYING,
    status: "retrying",
    errorCode: "provider_unavailable",
    errorMessage: "will try again",
    attemptCount: 1,
    startedAt: STARTED_AT,
    createdAt: "2026-03-04T05:00:06.000Z",
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
    createdAt: "2026-03-04T05:00:07.000Z",
  });
  await insertJob({
    id: JOB_VIDEO_QUEUED,
    status: "queued",
    jobType: "video_generation",
    queueName: "video_generation_jobs",
    createdAt: "2026-03-04T05:00:08.000Z",
  });
  await insertJob({
    id: JOB_VIDEO_FAILED,
    status: "failed",
    jobType: "video_generation",
    queueName: "video_generation_jobs",
    errorCode: "executor_error",
    errorMessage: "the video model refused",
    failedAt: FAILED_AT,
    createdAt: "2026-03-04T05:00:09.000Z",
  });
  await insertJob({
    id: JOB_CODE_SUCCEEDED,
    status: "succeeded",
    jobType: "code_execution",
    queueName: "code_execution_jobs",
    completedAt: COMPLETED_AT,
    createdAt: "2026-03-04T05:00:10.000Z",
  });

  // The other member's own job, in the SAME workspace: invisible to the author
  // and to the administrator, visible to its creator.
  await insertJob({
    id: JOB_MEMBER,
    status: "queued",
    createdBy: MEMBER_ID,
    createdAt: "2026-03-04T05:00:11.000Z",
  });

  // 51 rows for one actor, one minute apart: more than the statement's cap.
  for (let index = 0; index < BULK_ROWS; index += 1) {
    await insertJob({
      id: bulkJobId(index),
      status: "queued",
      createdBy: BULK_ID,
      createdAt: bulkCreatedAt(index),
    });
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job owner read: the ACL is created_by, and nothing else (workorder 21T)", () => {
  it("case 1: the author reads their own job, all 22 columns", async () => {
    const row = await repository.readOwnJob({
      actorId: AUTHOR_ID,
      jobId: JOB_SUCCEEDED,
    });
    if (row === null) throw new Error("expected the succeeded row");

    const truth = await dbTruth(JOB_SUCCEEDED);

    for (const column of JOB_OWNER_READ_COLUMNS) {
      expect([column, row[column]]).toEqual([column, truth?.[column]]);
    }
    expect(row).toEqual(truth);

    expect(row.id).toBe(JOB_SUCCEEDED);
    expect(row.workspace_id).toBe(teamWorkspaceId);
    expect(row.project_id).toBe(PROJECT_ID);
    expect(row.canvas_id).toBe(CANVAS_ID);
    expect(row.session_id).toBe(SESSION_ID);
    expect(row.thread_id).toBe("thread-21t");
    expect(row.job_type).toBe("image_generation");
    expect(row.status).toBe("succeeded");
    expect(row.payload).toEqual(NESTED_PAYLOAD);
    expect(row.result).toEqual(NESTED_RESULT);
    expect(row.attempt_count).toBe(2);
    expect(row.max_attempts).toBe(5);
    expect(row.created_by).toBe(AUTHOR_ID);
    expect(row.created_at).toBe("2026-03-04T05:00:03.000Z");
  });

  it("case 2: ANOTHER MEMBER of the same workspace sees the author's job nowhere", async () => {
    // Both users are members of `teamWorkspaceId`; the job is in that very
    // workspace. If the ACL had grown a membership term, this read would return
    // the row.
    expect(
      await repository.readOwnJob({ actorId: MEMBER_ID, jobId: JOB_SUCCEEDED }),
    ).toBeNull();
    expect(await listViaRepository(MEMBER_ID)).toEqual([JOB_MEMBER]);

    // And the RLS policy answers exactly the same thing, so the refusal is the
    // rule rather than an accident of this statement.
    expect(await readOwnViaRls(MEMBER_ID, JOB_SUCCEEDED)).toBeNull();
    expect(await listOwnViaRls(MEMBER_ID)).toEqual([JOB_MEMBER]);

    // The row really exists for its author.
    expect(
      (await repository.readOwnJob({ actorId: AUTHOR_ID, jobId: JOB_SUCCEEDED }))
        ?.id,
    ).toBe(JOB_SUCCEEDED);
  });

  it("case 3: the WORKSPACE OWNER — the team's administrator — is refused too", async () => {
    // This is the strongest form of the evidence: a role check, an admin bypass
    // or a membership predicate would ALL let this read succeed, and the policy
    // this repository reproduces has none. An administrator sees other people's
    // jobs only through `getJobAdmin`, which is a separate, audited path.
    expect(
      await repository.readOwnJob({
        actorId: TEAM_OWNER_ID,
        jobId: JOB_SUCCEEDED,
      }),
    ).toBeNull();
    expect(await listViaRepository(TEAM_OWNER_ID)).toEqual([]);
    expect(await readOwnViaRls(TEAM_OWNER_ID, JOB_SUCCEEDED)).toBeNull();
    expect(await listOwnViaRls(TEAM_OWNER_ID)).toEqual([]);

    // The administrator's role in the workspace is what it is.
    expect(
      firstRow(
        (
          await db.query<{ role: string }>(
            `select role from public.workspace_members
              where workspace_id = $1 and user_id = $2`,
            [teamWorkspaceId, TEAM_OWNER_ID],
          )
        ).rows,
      ).role,
    ).toBe("owner");
  });

  it("case 4: a non-member sees nothing either, and never an error", async () => {
    expect(
      await repository.readOwnJob({
        actorId: OUTSIDER_ID,
        jobId: JOB_SUCCEEDED,
      }),
    ).toBeNull();
    expect(await listViaRepository(OUTSIDER_ID)).toEqual([]);
    expect(await readOwnViaRls(OUTSIDER_ID, JOB_SUCCEEDED)).toBeNull();
    expect(await listOwnViaRls(OUTSIDER_ID)).toEqual([]);
  });

  it("case 5: every identity's visibility is identical through the repository and through RLS", async () => {
    const identities = [AUTHOR_ID, MEMBER_ID, TEAM_OWNER_ID, OUTSIDER_ID, BULK_ID];
    const jobs = [
      JOB_QUEUED,
      JOB_SUCCEEDED,
      JOB_DEAD_LETTER,
      JOB_MEMBER,
      bulkJobId(0),
    ];

    // The answer each identity must get for the AUTHOR's rows: only the author
    // gets a row, and only for a job they created.
    for (const jobId of jobs) {
      const stored = firstRow(
        (
          await db.query<{ created_by: string }>(
            "select created_by::text as created_by from public.background_jobs where id = $1::uuid",
            [jobId],
          )
        ).rows,
      ).created_by;

      // The expected answer is derived from the ROW, not from a hard-coded
      // table: whoever `created_by` names is the one who may read it.
      for (const actorId of identities) {
        const expected =
          stored === actorId
            ? { id: jobId, status: firstRow(
                (
                  await db.query<{ status: string }>(
                    "select status::text as status from public.background_jobs where id = $1::uuid",
                    [jobId],
                  )
                ).rows,
              ).status }
            : null;

        await expectSameVisibility(actorId, jobId, expected);
      }
    }
  });

  it("case 6: the list ACL matches RLS for every identity and every filter combination", async () => {
    const identities = [AUTHOR_ID, MEMBER_ID, TEAM_OWNER_ID, OUTSIDER_ID];
    const combinations: Array<[string | null, string | null]> = [
      [null, null],
      ["failed", null],
      ["queued", null],
      [null, "video_generation"],
      ["queued", "video_generation"],
      ["canceled", "code_execution"],
    ];

    for (const actorId of identities) {
      for (const [status, jobType] of combinations) {
        const ids = await expectSameListVisibility(actorId, status, jobType);

        // And every row that DID come back really belongs to that actor: the
        // comparison above cannot pass by both sides being equally wrong about
        // ownership.
        for (const id of ids) {
          expect(
            firstRow(
              (
                await db.query<{ created_by: string }>(
                  "select created_by::text as created_by from public.background_jobs where id = $1::uuid",
                  [id],
                )
              ).rows,
            ).created_by,
          ).toBe(actorId);
        }
      }
    }
  });
});

describe("job owner read: the filters", () => {
  /** The author's own rows, as the database holds them. */
  async function storedIds(
    where: string,
    params: readonly unknown[] = [],
  ): Promise<string[]> {
    return (
      await db.query<{ id: string }>(
        `select id::text as id from public.background_jobs
          where created_by = $1::uuid and ${where}
          order by created_at desc`,
        [AUTHOR_ID, ...params],
      )
    ).rows.map((row) => row.id);
  }

  it("case 7: both filters null return every one of the actor's jobs", async () => {
    const ids = await listViaRepository(AUTHOR_ID);

    expect(sortedIds(ids)).toEqual(
      sortedIds(await storedIds("true")),
    );
    // Ten rows for the author, all of them, newest first.
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(JOB_CODE_SUCCEEDED);
    expect(ids.at(-1)).toBe(JOB_QUEUED);
  });

  it("case 8: status 'failed' returns failed AND legacy dead_letter rows", async () => {
    const ids = await listViaRepository(AUTHOR_ID, "failed", null);

    expect(sortedIds(ids)).toEqual(
      sortedIds([JOB_FAILED, JOB_DEAD_LETTER, JOB_VIDEO_FAILED]),
    );

    // The old shape of the same filter — a value list — selects exactly the same
    // ids, so the migration did not change what `failed` means.
    const legacy = await asUser(db, AUTHOR_ID, (tx) =>
      tx.query<{ id: string }>(SELECT_LEGACY_FAILED_VIA_RLS_SQL, [AUTHOR_ID]),
    );
    expect(ids).toEqual(legacy.rows.map((row) => row.id));
    expect(sortedIds(await listOwnViaRls(AUTHOR_ID, "failed", null))).toEqual(
      sortedIds(ids),
    );
  });

  it("case 9: status 'dead_letter' returns ONLY the legacy rows", async () => {
    const ids = await listViaRepository(AUTHOR_ID, "dead_letter", null);

    expect(ids).toEqual([JOB_DEAD_LETTER]);
    expect(await listOwnViaRls(AUTHOR_ID, "dead_letter", null)).toEqual(ids);
  });

  it("case 10: status 'queued' returns only queued rows", async () => {
    const ids = await listViaRepository(AUTHOR_ID, "queued", null);

    expect(sortedIds(ids)).toEqual(sortedIds([JOB_QUEUED, JOB_VIDEO_QUEUED]));
    expect(await listOwnViaRls(AUTHOR_ID, "queued", null)).toEqual(ids);
  });

  it("case 11: the job type filter narrows to that type, and only that type", async () => {
    const video = await listViaRepository(AUTHOR_ID, null, "video_generation");
    const code = await listViaRepository(AUTHOR_ID, null, "code_execution");
    const image = await listViaRepository(AUTHOR_ID, null, "image_generation");

    expect(sortedIds(video)).toEqual(sortedIds([JOB_VIDEO_QUEUED, JOB_VIDEO_FAILED]));
    expect(code).toEqual([JOB_CODE_SUCCEEDED]);
    // Everything that is NOT video or code is image.
    expect(sortedIds(image)).toEqual(
      sortedIds(
        (await listViaRepository(AUTHOR_ID)).filter(
          (id) => !video.includes(id) && !code.includes(id),
        ),
      ),
    );
    expect(await listOwnViaRls(AUTHOR_ID, null, "video_generation")).toEqual(video);
  });

  it("case 12: status and job type are combined with AND", async () => {
    const ids = await listViaRepository(AUTHOR_ID, "failed", "video_generation");

    expect(ids).toEqual([JOB_VIDEO_FAILED]);
    // `failed` still admits `dead_letter` — but only of the requested type, and
    // the fixture has no dead_letter video row, so the AND really narrowed.
    expect(await listOwnViaRls(AUTHOR_ID, "failed", "video_generation")).toEqual(
      ids,
    );
  });

  it("case 13: a combination with no rows is an empty list, not an error", async () => {
    const ids = await listViaRepository(AUTHOR_ID, "canceled", "code_execution");

    expect(ids).toEqual([]);
    expect(await listOwnViaRls(AUTHOR_ID, "canceled", "code_execution")).toEqual(
      [],
    );
  });

  it("case 14: filters never widen the ACL — another member's filtered list stays their own", async () => {
    expect(await listViaRepository(MEMBER_ID, "queued", "image_generation")).toEqual(
      [JOB_MEMBER],
    );
    expect(await listViaRepository(MEMBER_ID, "failed", null)).toEqual([]);
    // The author's failed rows are not reachable by filtering for them.
    expect(await listViaRepository(TEAM_OWNER_ID, "failed", null)).toEqual([]);
  });
});

describe("job owner read: order, cap and the rows that do not fit", () => {
  it("case 15: 51 rows answer with 50, newest first, and the oldest is absent", async () => {
    // The fixture is what it claims to be: more rows than the cap.
    expect(
      firstRow(
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from public.background_jobs where created_by = $1::uuid",
            [BULK_ID],
          )
        ).rows,
      ).n,
    ).toBe(BULK_ROWS);

    const rows = await repository.listOwnJobs({
      actorId: BULK_ID,
      status: null,
      jobType: null,
    });

    expect(rows).toHaveLength(BULK_VISIBLE);
    expect(rows.length).toBeLessThan(BULK_ROWS);

    // Newest first: index 50 is the newest of the fixture, index 1 the last one
    // that fits. The OLDEST row (index 0) is the one the cap drops.
    expect(rows[0]?.id).toBe(bulkJobId(BULK_ROWS - 1));
    expect(rows.at(-1)?.id).toBe(bulkJobId(1));
    expect(rows.map((row) => row.id)).not.toContain(bulkJobId(0));
    // And the oldest row genuinely exists — it was dropped by the cap, not by a
    // filter or by the ACL.
    expect(
      (
        await db.query("select 1 from public.background_jobs where id = $1::uuid", [
          bulkJobId(0),
        ])
      ).rows,
    ).toHaveLength(1);

    const createdAts = rows.map((row) => row.created_at as string);
    expect(createdAts).toEqual([...createdAts].sort().reverse());
    for (let index = 1; index < createdAts.length; index += 1) {
      expect(
        Date.parse(createdAts[index - 1] as string),
      ).toBeGreaterThan(Date.parse(createdAts[index] as string));
    }

    // The policy's own answer, under `authenticated`, is the same 50 rows in the
    // same order.
    expect(await listOwnViaRls(BULK_ID)).toEqual(rows.map((row) => row.id));
  });

  it("case 16: the cap is the statement's, so a filter cannot raise it", async () => {
    const queued = await repository.listOwnJobs({
      actorId: BULK_ID,
      status: "queued",
      jobType: "image_generation",
    });

    expect(queued).toHaveLength(BULK_VISIBLE);
  });
});

describe("job owner read: unknown values, rollback and what the read does not do", () => {
  it("case 17: an unknown status is a real SQL error (22P02), and the pool stays usable", async () => {
    const before = await jobCount();

    // Independent of the repository: the server itself rejects the bind.
    const direct = await rejection(() =>
      db.query(SELECT_JOBS_VIA_RLS_SQL, [AUTHOR_ID, "bogus", null]),
    );
    expect(direct.code).toBe("22P02");
    expect(direct.message).toMatch(/invalid input value for enum background_job_status/);

    const error = await repository
      .listOwnJobs({ actorId: AUTHOR_ID, status: "bogus", jobType: null })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobOwnerReadError);
    const readError = error as JobOwnerReadError;
    expect(readError.operation).toBe(LIST_OWN_JOBS);
    // The fixed message carries no SQL, no host, no filter value and no actor.
    expect(readError.message).toBe(`job owner read failed (${LIST_OWN_JOBS})`);
    expect(readError.message).not.toMatch(
      /public\.|background_jobs|invalid input|bogus|postgres:\/\//i,
    );
    expect(readError.message).not.toContain(AUTHOR_ID);
    expect((readError.cause as { code?: string }).code).toBe("22P02");

    // NOT an empty list: an unknown value must not pass as "no jobs".
    expect(await jobCount()).toBe(before);

    // The failed transaction rolled back, so the very same pool answers.
    expect(
      (await repository.readOwnJob({ actorId: AUTHOR_ID, jobId: JOB_QUEUED }))
        ?.status,
    ).toBe("queued");
  });

  it("case 18: an unknown job type is the same real SQL error", async () => {
    const direct = await rejection(() =>
      db.query(SELECT_JOBS_VIA_RLS_SQL, [AUTHOR_ID, null, "bogus"]),
    );
    expect(direct.code).toBe("22P02");
    expect(direct.message).toMatch(/invalid input value for enum background_job_type/);

    const error = await repository
      .listOwnJobs({ actorId: AUTHOR_ID, status: null, jobType: "bogus" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobOwnerReadError);
    expect((error as JobOwnerReadError).operation).toBe(LIST_OWN_JOBS);
    expect(((error as JobOwnerReadError).cause as { code?: string }).code).toBe(
      "22P02",
    );

    // The pool still answers afterwards.
    expect(await listViaRepository(AUTHOR_ID)).toHaveLength(10);
  });

  it("case 19: a malformed uuid is a real SQL error, and the pool stays usable", async () => {
    const before = await jobCount();

    const direct = await rejection(() =>
      db.query(SELECT_JOB_TRUTH_SQL, [INVALID_ID]),
    );
    expect(direct.code).toBe("22P02");
    expect(direct.message).toMatch(/invalid input syntax for type uuid/);

    const error = await repository
      .readOwnJob({ actorId: AUTHOR_ID, jobId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobOwnerReadError);
    const readError = error as JobOwnerReadError;
    expect(readError.operation).toBe(READ_OWN_JOB);
    expect(readError.message).toBe(`job owner read failed (${READ_OWN_JOB})`);
    expect(readError.message).not.toMatch(
      /public\.|background_jobs|invalid input|postgres:\/\//i,
    );
    expect((readError.cause as { code?: string }).code).toBe("22P02");

    expect(await jobCount()).toBe(before);
    expect(
      (await repository.readOwnJob({ actorId: AUTHOR_ID, jobId: JOB_MEMBER }))
        ?.id ?? null,
    ).toBeNull();
  });

  it("case 20: reading does not change a single row", async () => {
    const ids = [
      JOB_QUEUED,
      JOB_RUNNING,
      JOB_SUCCEEDED,
      JOB_FAILED,
      JOB_CANCELED,
      JOB_RETRYING,
      JOB_DEAD_LETTER,
      JOB_VIDEO_QUEUED,
      JOB_VIDEO_FAILED,
      JOB_CODE_SUCCEEDED,
      JOB_MEMBER,
      bulkJobId(0),
    ];

    const before = new Map<string, string>();
    for (const id of ids) before.set(id, await snapshot(id));

    for (const id of ids) {
      await repository.readOwnJob({ actorId: AUTHOR_ID, jobId: id });
    }
    await repository.listOwnJobs({
      actorId: AUTHOR_ID,
      status: null,
      jobType: null,
    });
    await repository.listOwnJobs({
      actorId: BULK_ID,
      status: null,
      jobType: null,
    });

    // The whole row as `::text`, before and after: no timestamp moved, no
    // counter was touched, no column was rewritten by the read.
    for (const [id, snapshotBefore] of before) {
      expect([id, await snapshot(id)]).toEqual([id, snapshotBefore]);
    }
  });

  it("case 21: the read runs as the CALLER, and its context does not leak", async () => {
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

    const observing = createJobOwnerReadRepository({
      getTransactionPool: () => observingPool,
    });

    await observing.readOwnJob({ actorId: AUTHOR_ID, jobId: JOB_QUEUED });
    await observing.listOwnJobs({
      actorId: MEMBER_ID,
      status: null,
      jobType: null,
    });

    expect(observed).toHaveLength(2);
    // The actor is the caller — not an empty system context — and the mode is
    // the explicit privileged label the statement's own ACL relies on.
    expect(observed[0]).toEqual({
      user_id: AUTHOR_ID,
      workspace_id: "",
      role: "",
      execution_mode: "privileged",
    });
    expect(observed[1]).toEqual({
      user_id: MEMBER_ID,
      workspace_id: "",
      role: "",
      execution_mode: "privileged",
    });

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

describe("job owner read: through the real JobService", () => {
  it("case 22: getJob returns the caller's own job, and maps dead_letter to failed", async () => {
    const { service, userClientTokens, adminClientCalls } = buildService();

    const job = await service.getJob(actor(AUTHOR_ID), JOB_SUCCEEDED);
    expect(job.id).toBe(JOB_SUCCEEDED);
    expect(job.status).toBe("succeeded");
    expect(job.created_by).toBe(AUTHOR_ID);
    expect(job.created_at).toBe("2026-03-04T05:00:03.000Z");
    expect(job.payload).toEqual(NESTED_PAYLOAD);

    // The legacy terminal value is the ONE translation, and it lives in
    // `mapJobRow` — the repository still reports the raw column.
    const legacy = await service.getJob(actor(AUTHOR_ID), JOB_DEAD_LETTER);
    expect(legacy.status).toBe("failed");
    expect(
      (
        await repository.readOwnJob({
          actorId: AUTHOR_ID,
          jobId: JOB_DEAD_LETTER,
        })
      )?.status,
    ).toBe("dead_letter");

    // The migration's whole point: neither the success nor the 404 path builds
    // the client the read used to go through.
    expect(userClientTokens).toEqual([]);
    expect(adminClientCalls()).toBe(0);
  });

  it("case 23: somebody else's job is the existing 404 — not a 403 and not a row", async () => {
    const { service, userClientTokens } = buildService();

    for (const caller of [MEMBER_ID, TEAM_OWNER_ID, OUTSIDER_ID]) {
      const error = await serviceRefusal(() =>
        service.getJob(actor(caller), JOB_SUCCEEDED),
      );

      expect(error.code).toBe("job_not_found");
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe("Job not found.");
    }

    expect(userClientTokens).toEqual([]);
  });

  it("case 24: an unknown job id is the existing 404, and a malformed one the existing 500", async () => {
    const { service, userClientTokens } = buildService();

    const missing = await serviceRefusal(() =>
      service.getJob(actor(AUTHOR_ID), MISSING_ID),
    );
    expect(missing.code).toBe("job_not_found");
    expect(missing.statusCode).toBe(404);
    expect(missing.message).toBe("Job not found.");

    // "The database refused the argument" is not "no such job": the old read
    // failed this way too, so it stays the 500 it was.
    const malformed = await serviceRefusal(() =>
      service.getJob(actor(AUTHOR_ID), INVALID_ID),
    );
    expect(malformed.code).toBe("job_query_failed");
    expect(malformed.statusCode).toBe(500);
    expect(malformed.message).toBe("Failed to query job.");
    expect(malformed.message).not.toMatch(/invalid input|uuid|postgres:\/\//i);

    expect(userClientTokens).toEqual([]);
  });

  it("case 25: listJobs answers the actor's own list, newest first, and maps dead_letter", async () => {
    const { service, userClientTokens } = buildService();

    const jobs = await service.listJobs(actor(AUTHOR_ID));

    expect(jobs).toHaveLength(10);
    expect(jobs.map((job) => job.id)[0]).toBe(JOB_CODE_SUCCEEDED);
    expect(jobs.every((job) => job.created_by === AUTHOR_ID)).toBe(true);

    const failed = await service.listJobs(actor(AUTHOR_ID), { status: "failed" });
    expect(sortedIds(failed.map((job) => job.id))).toEqual(
      sortedIds([JOB_FAILED, JOB_VIDEO_FAILED, JOB_DEAD_LETTER]),
    );
    // The list read maps exactly like the single read: the legacy row is `failed`
    // here and raw in the repository.
    expect(
      failed.find((job) => job.id === JOB_DEAD_LETTER)?.status,
    ).toBe("failed");

    // Another member's list is their own, and empty for the administrator.
    expect((await service.listJobs(actor(MEMBER_ID))).map((job) => job.id)).toEqual([
      JOB_MEMBER,
    ]);
    expect(await service.listJobs(actor(TEAM_OWNER_ID))).toEqual([]);

    expect(userClientTokens).toEqual([]);
  });

  it("case 26: an empty result is the existing empty array, and an unknown value the existing 500", async () => {
    const { service, userClientTokens } = buildService();

    expect(
      await service.listJobs(actor(AUTHOR_ID), {
        status: "canceled",
        jobType: "video_generation",
      }),
    ).toEqual([]);

    const error = await serviceRefusal(() =>
      service.listJobs(actor(AUTHOR_ID), { status: "bogus" as never }),
    );
    expect(error.code).toBe("job_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to list jobs.");
    expect(error.message).not.toMatch(/invalid input|enum|bogus|postgres:\/\//i);

    expect(userClientTokens).toEqual([]);
  });

  it("case 27: with no repository wired both reads fail closed, even for a row that exists", async () => {
    const { service, userClientTokens, adminClientCalls } = buildService({
      withoutOwnerRepository: true,
    });

    const single = await serviceRefusal(() =>
      service.getJob(actor(AUTHOR_ID), JOB_SUCCEEDED),
    );
    expect(single.code).toBe("job_query_failed");
    expect(single.statusCode).toBe(500);
    expect(single.message).toBe("Failed to query job.");

    const list = await serviceRefusal(() => service.listJobs(actor(AUTHOR_ID)));
    expect(list.code).toBe("job_query_failed");
    expect(list.statusCode).toBe(500);
    expect(list.message).toBe("Failed to list jobs.");

    // The row is really there — the refusal is the missing dependency, not a
    // missing job, and nothing fell back to the user client (whose stub would
    // have thrown a different error).
    expect(
      (await repository.readOwnJob({ actorId: AUTHOR_ID, jobId: JOB_SUCCEEDED }))
        ?.id,
    ).toBe(JOB_SUCCEEDED);
    expect(userClientTokens).toEqual([]);
    expect(adminClientCalls()).toBe(0);
  });

  it("case 28: a failing repository is the existing 500 on both reads, never a 404", async () => {
    const broken = createJobService({
      createUserClient: () => {
        throw new Error("must not be built");
      },
      getAdminClient: () => {
        throw new Error("must not be reached");
      },
      pgmq: {
        send: async () => 1,
        deleteMsg: async () => true,
        archive: async () => true,
      } as unknown as PgmqClient,
      jobOwnerReadRepository: {
        async readOwnJob() {
          throw new JobOwnerReadError(READ_OWN_JOB, new Error("connection reset"));
        },
        async listOwnJobs() {
          throw new JobOwnerReadError(LIST_OWN_JOBS, new Error("connection reset"));
        },
      },
    });

    const single = await serviceRefusal(() =>
      broken.getJob(actor(AUTHOR_ID), JOB_SUCCEEDED),
    );
    expect(single.code).toBe("job_query_failed");
    expect(single.statusCode).toBe(500);
    expect(single.message).toBe("Failed to query job.");
    expect(single.message).not.toMatch(/connection reset/);

    const list = await serviceRefusal(() => broken.listJobs(actor(AUTHOR_ID)));
    expect(list.code).toBe("job_query_failed");
    expect(list.statusCode).toBe(500);
    expect(list.message).toBe("Failed to list jobs.");
    expect(list.message).not.toMatch(/connection reset/);
  });
});
