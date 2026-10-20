import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JobStuckReaderError,
  LIST_RUNNING_STARTED_BEFORE,
  MAX_STUCK_READ_LIMIT,
  createJobStuckReaderRepository,
  type JobStuckReaderRepository,
} from "../../db/job-stuck-reader-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the stuck running job reader (workorder 36I, GN-31).
 *
 * The unit tests beside the reaper prove what the pass DECIDES. This file proves
 * PostgreSQL actually parses and executes the read behind it, and that the three
 * properties the reaper rests on are facts of the database rather than of this
 * process:
 *
 *   - the POPULATION is exactly `status = 'running'` with a `started_at` strictly
 *     before the threshold: a queued row, a succeeded row, a running row that
 *     started recently, and a running row that never started are all absent. Any
 *     of them reaching the reaper would mean a job that is not stuck is failed and
 *     refunded;
 *   - the ORDER is `started_at` ascending and the LIMIT is honoured: the reaper
 *     works the oldest overruns first and one pass stays a bounded scan;
 *   - the ARGUMENTS are refused through this module's own error class. A `limit`
 *     outside 1..500 or a `before` that is not a timestamp is a caller bug, and it
 *     must not be silently clamped into "read everything" or "read nothing".
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-0000000036f1";

/** Every row in this file is an image job: the only type the enum has today. */
const JOB_TYPE = "image_generation";
const QUEUE = "image_generation";

/** The threshold the two happy-path cases read with: ten minutes ago. */
const THRESHOLD_SECONDS = 600;

/**
 * Case 1 population. Ages are relative to the database clock, so no case depends
 * on when the suite happens to run.
 */
const OLD_RUNNING = "00000000-0000-0000-0000-000000003601";
const OLD_QUEUED = "00000000-0000-0000-0000-000000003602";
const OLD_SUCCEEDED = "00000000-0000-0000-0000-000000003603";
const RECENT_RUNNING = "00000000-0000-0000-0000-000000003604";
const NEVER_STARTED_RUNNING = "00000000-0000-0000-0000-000000003605";

/**
 * Case 2 population. All three are OLDER than the case 1 rows, so a limited
 * ascending read of them cannot be confused with the case 1 fixture.
 */
const OLDER_RUNNING_A = "00000000-0000-0000-0000-000000003611";
const OLDER_RUNNING_B = "00000000-0000-0000-0000-000000003612";
const OLDER_RUNNING_C = "00000000-0000-0000-0000-000000003613";

let db: PGlite;
let pool: TransactionPool;
let repository: JobStuckReaderRepository;
let workspaceId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** A job row owned by USER_ID; `started_at` is backdated by the database clock. */
async function createJob(input: {
  id: string;
  status: string;
  startedSecondsAgo?: number;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by)
     values ($1::uuid, $2::uuid, $3, $4::public.background_job_type,
             $5::public.background_job_status, 3, $6::uuid)`,
    [input.id, workspaceId, QUEUE, JOB_TYPE, input.status, USER_ID],
  );

  if (input.startedSecondsAgo !== undefined) {
    await db.query(
      `update public.background_jobs
          set started_at = now() - make_interval(secs => $2::double precision)
        where id = $1::uuid`,
      [input.id, input.startedSecondsAgo],
    );
  }
}

/**
 * An ISO instant that many seconds before the DATABASE's `now()`, so the
 * threshold and the backdated rows are measured on the same clock.
 */
async function thresholdIso(secondsAgo: number): Promise<string> {
  const row = firstRow(
    (
      await db.query<{ ms: unknown }>(
        `select (extract(epoch from now() - make_interval(secs => $1::double precision)) * 1000)::bigint as ms`,
        [secondsAgo],
      )
    ).rows,
  );

  return new Date(Number(row.ms)).toISOString();
}

/** The read call, with its arguments named once. */
function list(before: string, limit: number) {
  return repository.listRunningStartedBefore({ before, limit });
}

/** A refused read, with the module's own error captured instead of thrown. */
async function refusal(call: () => Promise<unknown>): Promise<JobStuckReaderError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobStuckReaderError);
  const readerError = error as JobStuckReaderError;
  expect(readerError.operation).toBe(LIST_RUNNING_STARTED_BEFORE);
  expect(readerError.message).toBe(
    `job stuck reader read failed (${LIST_RUNNING_STARTED_BEFORE})`,
  );
  return readerError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobStuckReaderRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-stuck-reader@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).id;

  // Case 1: one row per answer the population must distinguish.
  await createJob({ id: OLD_RUNNING, status: "running", startedSecondsAgo: 3600 });
  await createJob({ id: OLD_QUEUED, status: "queued", startedSecondsAgo: 3600 });
  await createJob({ id: OLD_SUCCEEDED, status: "succeeded", startedSecondsAgo: 3600 });
  await createJob({ id: RECENT_RUNNING, status: "running", startedSecondsAgo: 60 });
  await createJob({ id: NEVER_STARTED_RUNNING, status: "running" });

  // Case 2: three running rows, all older than anything above.
  await createJob({ id: OLDER_RUNNING_A, status: "running", startedSecondsAgo: 7200 });
  await createJob({ id: OLDER_RUNNING_B, status: "running", startedSecondsAgo: 5400 });
  await createJob({ id: OLDER_RUNNING_C, status: "running", startedSecondsAgo: 4500 });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("GN-31: the stuck reader returns exactly the jobs the reaper may retire", () => {
  it("case 1: only running jobs that started before the threshold", async () => {
    const rows = await list(await thresholdIso(THRESHOLD_SECONDS), 100);

    // The old running row is the ONLY row this read may return from the case 1
    // fixture: queued, succeeded, a recent running row and a running row that
    // never started are all outside the population.
    const caseOneIds = rows
      .map((row) => row.id)
      .filter((id) => id === OLD_RUNNING || id === OLD_QUEUED || id === OLD_SUCCEEDED || id === RECENT_RUNNING || id === NEVER_STARTED_RUNNING);

    expect(caseOneIds).toEqual([OLD_RUNNING]);

    const row = firstRow(rows.filter((candidate) => candidate.id === OLD_RUNNING));

    // The four columns the reaper's decision reads, reported verbatim.
    expect(row.jobType).toBe(JOB_TYPE);
    expect(row.maxAttempts).toBe(3);
    expect(new Date(row.startedAt).toISOString()).toBe(row.startedAt);

    const ageSeconds = (Date.now() - new Date(row.startedAt).getTime()) / 1000;
    expect(ageSeconds).toBeGreaterThan(3500);
    expect(ageSeconds).toBeLessThan(3700);
  });

  it("case 2: ordered by started_at ascending, and the limit is honoured", async () => {
    const before = await thresholdIso(THRESHOLD_SECONDS);
    const rows = await list(before, 3);

    // Oldest first: A (7200s) -> B (5400s) -> C (4500s). Those three are also the
    // three oldest running rows in the fixture, so a limit of 3 selects exactly
    // them and the case 1 row cannot slip in.
    expect(rows.map((row) => row.id)).toEqual([
      OLDER_RUNNING_A,
      OLDER_RUNNING_B,
      OLDER_RUNNING_C,
    ]);

    const ordered = await list(before, MAX_STUCK_READ_LIMIT);
    const runningIds = ordered
      .map((row) => row.id)
      .filter((id) => id === OLDER_RUNNING_A || id === OLDER_RUNNING_B || id === OLDER_RUNNING_C);

    expect(runningIds).toEqual([OLDER_RUNNING_A, OLDER_RUNNING_B, OLDER_RUNNING_C]);
    expect(ordered.length).toBeGreaterThanOrEqual(4);

    const limited = await list(before, 1);
    expect(limited.map((row) => row.id)).toEqual([OLDER_RUNNING_A]);
  });

  it("case 3: a limit outside 1..500 or an unreadable threshold is refused", async () => {
    const before = await thresholdIso(THRESHOLD_SECONDS);

    await refusal(() => list(before, 0));
    await refusal(() => list(before, MAX_STUCK_READ_LIMIT + 1));
    await refusal(() => list(before, -1));
    await refusal(() => list("not-a-timestamp", 100));
    await refusal(() => list("", 100));
  });
});
