import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CANCEL_OWN_JOB,
  JOB_OWNER_WRITE_COLUMNS,
  JobOwnerWriteError,
  createJobOwnerWriteRepository,
  type JobOwnerWriteRepository,
  type JobOwnerWriteRow,
} from "../../db/job-owner-write-repository.js";
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
 * Real-SQL integration for the owner job write repository (workorder 21U).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves PostgreSQL actually parses and executes it against the real table, and
 * that the properties the callers rest on are facts of the database rather than
 * of this process:
 *
 *   - the SIX statuses answer what the guard says: `queued` and `running` are
 *     cancelled and answer the whole row, while `retrying` (deliberately NOT
 *     cancellable), `succeeded`, `failed` and `canceled` answer `null` and leave
 *     the row untouched COLUMN BY COLUMN — including `updated_at`, which only the
 *     trigger may move;
 *   - the ACL is `created_by = actor` and NOTHING else. Three identities are
 *     placed in the SAME workspace as the job's author — another plain member,
 *     and the workspace's OWNER (the team's administrator) — and none of them
 *     can cancel the author's job, through the repository OR through the RLS
 *     policy the write replaces. A membership check, a role check or an admin
 *     bypass would all make one of those succeed, and none of them may exist;
 *   - every identity's answer is measured TWICE — once through the privileged
 *     repository and once through `asUser()` (role `authenticated` plus a
 *     transaction-local JWT subject) running the statement the PostgREST write
 *     used to run — and the two "how many rows changed" answers must be EQUAL,
 *     for all six statuses and all four identities;
 *   - `updated_at` is the trigger's, and the cancel stamp lands exactly as
 *     passed;
 *   - two cancels racing for the same row produce exactly ONE row;
 *   - a malformed uuid is a real SQL error (22P02) that rolls back and leaves the
 *     same pool usable;
 *   - the write runs as the CALLER and leaves no session context behind;
 *   - through the REAL `JobService`, `cancelJob` answers its existing row, its
 *     existing 404 and its existing 500, touches no PGMQ message and builds no
 *     client at all.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

/** A: a plain member of the team workspace, and the author of the fixture jobs. */
const AUTHOR_ID = "00000000-0000-0000-0000-00000021d001";
/** B: another plain member of the SAME workspace. */
const MEMBER_ID = "00000000-0000-0000-0000-00000021d002";
/** C: the OWNER (administrator) of the SAME workspace — still not the author. */
const TEAM_OWNER_ID = "00000000-0000-0000-0000-00000021d003";
/** D: a user who is not a member of that workspace at all. */
const OUTSIDER_ID = "00000000-0000-0000-0000-00000021d004";

const PROJECT_ID = "00000000-0000-0000-0000-00000021d101";
const CANVAS_ID = "00000000-0000-0000-0000-00000021d102";

const TEAM_NAME = "Job Owner Write Team";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";
/** A well-formed uuid no row carries. */
const MISSING_ID = "00000000-0000-0000-0000-00000021dfff";

/** The instant the service stamps; the trigger is what moves `updated_at`. */
const CANCELED_AT = "2026-10-16T00:00:00.000Z";
/** A fixture timestamp safely in the past, so the trigger's `now()` is later. */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-02T00:00:00.000Z";
const STARTED_AT = "2026-01-01T00:10:00.000Z";

/** The six statuses the matrix measures, in the order the answer changes. */
const CANCELABLE = ["queued", "running"] as const;
const NOT_CANCELABLE = ["retrying", "succeeded", "failed", "canceled"] as const;
const ALL_STATUSES = [...CANCELABLE, ...NOT_CANCELABLE];

/**
 * The statement the OLD write ran: the same two columns, the same status guard,
 * the same `maybeSingle()` row — and NO `created_by` term, because the old write
 * carried none. Under `asUser()` the `background_jobs_user_policy` decides which
 * row exists, exactly as PostgREST's own client did.
 *
 * The new repository answers the same question under a privileged connection, so
 * its statement carries `created_by = actor` instead. Measured side by side, the
 * two must agree for every identity and every status — which is the whole point
 * of the comparison, because the explicit predicate is what replaces the policy.
 */
const CANCEL_JOB_VIA_RLS_SQL = `
update public.background_jobs
   set status = 'canceled', canceled_at = $2::timestamptz
 where id = $1 and status in ('queued', 'running')
`;

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
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at,
  to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at,
  to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as completed_at,
  to_char(failed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as failed_at,
  to_char(canceled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as canceled_at,
  credits_cost,
  credits_transaction_id::text as credits_transaction_id
from public.background_jobs
where id = $1::uuid
`;

/**
 * The same 22 columns the repository projects, PLUS the two credits columns the
 * cancel is not allowed to touch. The repository never returns them — they are
 * here so "a cancel is not a refund" is measured on the row itself.
 */
type JobTruthRow = JobOwnerWriteRow & {
  credits_cost: number | null;
  credits_transaction_id: string | null;
};

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
  status: string;
  createdBy?: string;
  workspaceId?: string;
  projectId?: string | null;
  canvasId?: string | null;
  result?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  canceledAt?: string | null;
  creditsCost?: number | null;
  creditsTransactionId?: string | null;
};

/**
 * Insert through the real column list — all 22 of them the repository projects,
 * named — so a fixture can place a value (or an explicit NULL) on any column the
 * statement returns. Nothing is left to a table default here: a default would
 * make "the repository returned what the fixture wrote" unprovable for that
 * column. The two credits columns are written too, because "a cancel does not
 * move the money" has to be measured on a row that HAS a charge.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, error_code, error_message,
  attempt_count, max_attempts, created_by,
  created_at, updated_at, started_at, completed_at, failed_at, canceled_at,
  credits_cost, credits_transaction_id
) values (
  $1, $2, $3, $4, $5, $6,
  $7, $8::public.background_job_type, $9::public.background_job_status,
  $10::jsonb, $11::jsonb, $12, $13,
  $14, $15, $16,
  $17, $18, $19, $20, $21, $22,
  $23, $24
)
`;

let db: PGlite;
let pool: TransactionPool;
let repository: JobOwnerWriteRepository;
let teamWorkspaceId = "";

/** Deterministic fresh uuids, so destructive cases never share a row. */
let idCounter = 0;
function nextJobId(): string {
  idCounter += 1;
  return `00000000-0000-0000-0000-00000021f${String(idCounter).padStart(3, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function insertJob(id: string, fixture: JobFixture): Promise<string> {
  await db.query(INSERT_JOB_SQL, [
    id,
    fixture.workspaceId ?? teamWorkspaceId,
    fixture.projectId === undefined ? PROJECT_ID : fixture.projectId,
    fixture.canvasId === undefined ? CANVAS_ID : fixture.canvasId,
    null,
    null,
    "image_generation_jobs",
    "image_generation",
    fixture.status,
    JSON.stringify({ prompt: "a cancelled idea" }),
    fixture.result === undefined ? null : JSON.stringify(fixture.result),
    fixture.errorCode ?? null,
    fixture.errorMessage ?? null,
    fixture.attemptCount ?? 0,
    3,
    fixture.createdBy ?? AUTHOR_ID,
    CREATED_AT,
    UPDATED_AT,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.failedAt ?? null,
    fixture.canceledAt ?? null,
    fixture.creditsCost === undefined ? 7 : fixture.creditsCost,
    fixture.creditsTransactionId === undefined
      ? "00000000-0000-0000-0000-00000021e001"
      : fixture.creditsTransactionId,
  ]);
  return id;
}

/** Fixture rows for the matrix and the comparison, one per (status, owner). */
async function seedJob(fixture: JobFixture): Promise<string> {
  return insertJob(nextJobId(), fixture);
}

/** The database's own answer for one row, in the repository's shape. */
async function dbTruth(jobId: string): Promise<JobTruthRow | null> {
  const rows = (
    await db.query<JobTruthRow>(SELECT_JOB_TRUTH_SQL, [jobId])
  ).rows;
  return rows[0] ?? null;
}

async function requiresTruth(jobId: string): Promise<JobTruthRow> {
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
 * The columns that differ between two readings of the same row. `updated_at` is
 * expected in the list for a row the trigger stamped; nothing else may be.
 */
function movedColumns(
  before: JobTruthRow,
  after: JobTruthRow,
): string[] {
  return [...JOB_OWNER_WRITE_COLUMNS].filter(
    (column) =>
      JSON.stringify(before[column]) !== JSON.stringify(after[column]),
  );
}

/** How many rows the OLD statement changed for this identity — the RLS answer. */
async function cancelViaRls(actorId: string, jobId: string): Promise<number> {
  const result = await asUser(db, actorId, (tx) =>
    tx.query(CANCEL_JOB_VIA_RLS_SQL, [jobId, CANCELED_AT]),
  );

  return result.affectedRows ?? 0;
}

/** How many rows the REPOSITORY changed for this identity — 0 or 1. */
async function cancelViaRepository(
  actorId: string,
  jobId: string,
): Promise<{ rows: number; row: JobOwnerWriteRow | null }> {
  const row = await repository.cancelOwnJob({
    actorId,
    jobId,
    canceledAt: CANCELED_AT,
  });

  return { rows: row === null ? 0 : 1, row };
}

/**
 * "Is this status cancellable by this identity?" — derived from the ROW, not
 * from a hard-coded table: whoever `created_by` names, and only for a status the
 * guard admits.
 */
function expectedRows(createdBy: string, actorId: string, status: string): number {
  const cancellable = (CANCELABLE as readonly string[]).includes(status);
  return createdBy === actorId && cancellable ? 1 : 0;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobOwnerWriteRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, AUTHOR_ID, "job-owner-write-author@hahart.test");
  await createUser(db, MEMBER_ID, "job-owner-write-member@hahart.test");
  await createUser(db, TEAM_OWNER_ID, "job-owner-write-admin@hahart.test");
  await createUser(db, OUTSIDER_ID, "job-owner-write-outsider@hahart.test");

  // Exactly one team workspace may exist in the whole database. THREE users are
  // put in it — the author, another plain member, and its owner (the team's
  // administrator) — which is precisely what makes the ACL cases discriminating.
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
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  // The parents the two nullable uuid columns point at, so those columns can
  // carry real values instead of NULL in the rows the matrix reads back.
  await db.query(
    `insert into public.projects (id, workspace_id, name, slug, created_by)
     values ($1, $2, 'Job owner write', 'job-owner-write-21u', $3)`,
    [PROJECT_ID, teamWorkspaceId, AUTHOR_ID],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, created_by)
     values ($1, $2, 'Job owner write canvas', $3)`,
    [CANVAS_ID, PROJECT_ID, AUTHOR_ID],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job owner write: the six statuses and the row each one leaves (work order 21U)", () => {
  it("case 1: a queued job is cancelled, and the whole row comes back", async () => {
    const jobId = await seedJob({ status: "queued" });
    const before = await requiresTruth(jobId);

    const row = await repository.cancelOwnJob({
      actorId: AUTHOR_ID,
      jobId,
      canceledAt: CANCELED_AT,
    });

    if (row === null) throw new Error("expected the queued row to be cancelled");

    // All 22 columns, field by field, against the database's own answer.
    const stored = await requiresTruth(jobId);
    for (const column of JOB_OWNER_WRITE_COLUMNS) {
      expect([column, row[column]]).toEqual([column, stored[column]]);
    }
    expect(Object.keys(row)).toEqual([...JOB_OWNER_WRITE_COLUMNS]);

    expect(row.id).toBe(jobId);
    expect(row.status).toBe("canceled");
    expect(row.created_by).toBe(AUTHOR_ID);
    expect(row.workspace_id).toBe(teamWorkspaceId);
    expect(row.project_id).toBe(PROJECT_ID);
    expect(row.canvas_id).toBe(CANVAS_ID);
    expect(row.payload).toEqual({ prompt: "a cancelled idea" });

    // The stamp is the value the CALLER passed, not a clock read here.
    expect(row.canceled_at).toBe(CANCELED_AT);
    expect(stored.canceled_at).toBe(CANCELED_AT);
    expect(before.canceled_at).toBeNull();

    // `updated_at` is the TRIGGER's, and it moved: the statement does not write
    // it, so if it changed at all it changed because the row was really updated.
    expect(row.updated_at).not.toBe(UPDATED_AT);
    expect(Date.parse(row.updated_at)).toBeGreaterThan(Date.parse(UPDATED_AT));
  });

  it("case 2: a running job is cancelled the same way, and its start stamp is preserved", async () => {
    const jobId = await seedJob({
      status: "running",
      attemptCount: 1,
      startedAt: STARTED_AT,
    });

    const row = await repository.cancelOwnJob({
      actorId: AUTHOR_ID,
      jobId,
      canceledAt: CANCELED_AT,
    });

    if (row === null) throw new Error("expected the running row to be cancelled");
    expect(row.status).toBe("canceled");
    expect(row.canceled_at).toBe(CANCELED_AT);
    expect(row.started_at).toBe(STARTED_AT);
    expect(row.attempt_count).toBe(1);
    expect(row.max_attempts).toBe(3);
  });

  it("case 3: retrying is NOT cancellable — null, and the row does not move at all", async () => {
    // `retrying` is the interesting one: the job is alive and was charged, and
    // the guard is exactly queued/running (21H0 case 13 pins the same fact for
    // the statement the write replaces). Adding it here would be a product
    // decision, not a migration.
    const jobId = await seedJob({
      status: "retrying",
      errorCode: "provider_unavailable",
      errorMessage: "will try again",
      attemptCount: 1,
      startedAt: STARTED_AT,
    });
    const before = await requiresTruth(jobId);
    const beforeSnapshot = await snapshot(jobId);

    await expect(
      repository.cancelOwnJob({ actorId: AUTHOR_ID, jobId, canceledAt: CANCELED_AT }),
    ).resolves.toBeNull();

    const after = await requiresTruth(jobId);
    expect(after.status).toBe("retrying");
    expect(after.canceled_at).toBeNull();
    // NOTHING moved — not even the trigger's `updated_at`, because no row was
    // updated at all.
    expect(movedColumns(before, after)).toEqual([]);
    expect(await snapshot(jobId)).toBe(beforeSnapshot);
  });

  for (const status of ["succeeded", "failed", "canceled"] as const) {
    it(`case ${status === "succeeded" ? 4 : status === "failed" ? 5 : 6}: a ${status} job is refused, and the row does not move`, async () => {
      const jobId = await seedJob({
        status,
        result: status === "succeeded" ? { object_path: "team/21u/key.png" } : null,
        errorCode: status === "failed" ? "executor_error" : null,
        errorMessage: status === "failed" ? "the model refused" : null,
        completedAt: status === "succeeded" ? "2026-01-01T01:00:00.000Z" : null,
        failedAt: status === "failed" ? "2026-01-01T01:00:00.000Z" : null,
        canceledAt: status === "canceled" ? "2026-01-05T00:00:00.000Z" : null,
      });
      const before = await requiresTruth(jobId);
      const beforeSnapshot = await snapshot(jobId);

      await expect(
        repository.cancelOwnJob({
          actorId: AUTHOR_ID,
          jobId,
          canceledAt: CANCELED_AT,
        }),
      ).resolves.toBeNull();

      const after = await requiresTruth(jobId);
      expect(after.status).toBe(status);
      expect(movedColumns(before, after)).toEqual([]);
      expect(await snapshot(jobId)).toBe(beforeSnapshot);
      // A terminal row keeps whatever it carried, including a previous cancel.
      expect(after.canceled_at).toBe(before.canceled_at);
      expect(after.result).toEqual(before.result);
    });
  }

  it("case 7: an unknown id answers null, writes nothing and commits", async () => {
    const before = await jobCount();

    await expect(
      repository.cancelOwnJob({
        actorId: AUTHOR_ID,
        jobId: MISSING_ID,
        canceledAt: CANCELED_AT,
      }),
    ).resolves.toBeNull();

    expect(await jobCount()).toBe(before);
    // The pool still answers afterwards: a zero-row UPDATE is not an error and
    // does not leave the transaction open.
    expect(
      (
        await repository.cancelOwnJob({
          actorId: AUTHOR_ID,
          jobId: await seedJob({ status: "queued" }),
          canceledAt: CANCELED_AT,
        })
      )?.status,
    ).toBe("canceled");
  });

  it("case 8: exactly three columns move — status, canceled_at and the trigger's updated_at", async () => {
    const jobId = await seedJob({ status: "queued", attemptCount: 2 });
    const before = await requiresTruth(jobId);

    await repository.cancelOwnJob({ actorId: AUTHOR_ID, jobId, canceledAt: CANCELED_AT });

    const after = await requiresTruth(jobId);
    expect(movedColumns(before, after).sort()).toEqual([
      "canceled_at",
      "status",
      "updated_at",
    ]);

    // The money and the payload are untouched: a cancel is not a refund and not
    // a rewrite of what the job was asked to do.
    expect(after.credits_cost).toBe(7);
    expect(after.credits_transaction_id).toBe(
      "00000000-0000-0000-0000-00000021e001",
    );
    expect(after.payload).toEqual({ prompt: "a cancelled idea" });
    expect(after.attempt_count).toBe(2);
    expect(after.created_at).toBe(CREATED_AT);
    expect(after.project_id).toBe(PROJECT_ID);
  });
});

describe("job owner write: the ACL is created_by, and the policy agrees", () => {
  it("case 9: ANOTHER MEMBER of the same workspace cannot cancel the author's job", async () => {
    // Both users are members of `teamWorkspaceId`; the job is in that very
    // workspace. If the ACL had grown a membership term, this write would
    // succeed — and the job would be cancelled by somebody who never asked for
    // it.
    const jobId = await seedJob({ status: "queued", createdBy: AUTHOR_ID });
    const beforeSnapshot = await snapshot(jobId);

    await expect(
      repository.cancelOwnJob({ actorId: MEMBER_ID, jobId, canceledAt: CANCELED_AT }),
    ).resolves.toBeNull();

    expect((await requiresTruth(jobId)).status).toBe("queued");
    expect((await requiresTruth(jobId)).canceled_at).toBeNull();
    expect(await snapshot(jobId)).toBe(beforeSnapshot);

    // And the policy answers exactly the same thing, so the refusal is the rule
    // rather than an accident of this statement.
    const rls = await seedJob({ status: "queued", createdBy: AUTHOR_ID });
    expect(await cancelViaRls(MEMBER_ID, rls)).toBe(0);
    expect((await requiresTruth(rls)).status).toBe("queued");

    // The row really is cancellable by its author, so the refusals above are the
    // ACL and not a statement that could never match anything.
    expect(
      (
        await repository.cancelOwnJob({
          actorId: AUTHOR_ID,
          jobId,
          canceledAt: CANCELED_AT,
        })
      )?.status,
    ).toBe("canceled");
  });

  it("case 10: the WORKSPACE OWNER — the team's administrator — is refused too", async () => {
    // This is the strongest form of the evidence: a role check, an admin bypass
    // or a membership predicate would ALL let this write succeed, and the policy
    // this repository reproduces has none. An administrator acts on other
    // people's jobs only through the worker's own guarded transitions.
    const jobId = await seedJob({ status: "queued", createdBy: AUTHOR_ID });
    const beforeSnapshot = await snapshot(jobId);

    await expect(
      repository.cancelOwnJob({
        actorId: TEAM_OWNER_ID,
        jobId,
        canceledAt: CANCELED_AT,
      }),
    ).resolves.toBeNull();

    expect(await snapshot(jobId)).toBe(beforeSnapshot);
    expect(await cancelViaRls(TEAM_OWNER_ID, await seedJob({ status: "queued" }))).toBe(0);

    // The administrator's role in the workspace is what it is — the refusal is
    // not because the fixture forgot to make them a member.
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

  it("case 11: a non-member is refused as well, and never an error", async () => {
    const jobId = await seedJob({ status: "running", createdBy: AUTHOR_ID });
    const beforeSnapshot = await snapshot(jobId);

    await expect(
      repository.cancelOwnJob({ actorId: OUTSIDER_ID, jobId, canceledAt: CANCELED_AT }),
    ).resolves.toBeNull();

    expect(await snapshot(jobId)).toBe(beforeSnapshot);
    expect(await cancelViaRls(OUTSIDER_ID, await seedJob({ status: "running" }))).toBe(0);
  });

  it("case 12: the repository and RLS answer the SAME row count for every status and identity", async () => {
    const identities = [AUTHOR_ID, MEMBER_ID, TEAM_OWNER_ID, OUTSIDER_ID];
    const createdByValues = [AUTHOR_ID, MEMBER_ID];

    // Each cell is measured on TWO fresh rows in the same state: one the OLD
    // statement runs against under `authenticated`, one the repository writes.
    // Comparing them is what makes "the explicit predicate replaces the policy"
    // a measurement instead of a claim — and both must also equal the answer the
    // guard implies.
    for (const createdBy of createdByValues) {
      for (const status of ALL_STATUSES) {
        for (const actorId of identities) {
          const rlsJob = await seedJob({ status, createdBy });
          const repoJob = await seedJob({ status, createdBy });
          const rlsBefore = await requiresTruth(rlsJob);
          const repoBefore = await requiresTruth(repoJob);

          const rlsRows = await cancelViaRls(actorId, rlsJob);
          const { rows: repoRows, row } = await cancelViaRepository(
            actorId,
            repoJob,
          );

          const expected = expectedRows(createdBy, actorId, status);

          // The 对照: "how many rows changed" must be equal on both sides, and
          // equal to what the guard says.
          expect([actorId, status, repoRows]).toEqual([
            actorId,
            status,
            rlsRows,
          ]);
          expect([actorId, status, repoRows]).toEqual([
            actorId,
            status,
            expected,
          ]);

          // And the two rows ended in the SAME shape: the same columns moved,
          // the same status, the same stamp. Only `updated_at` may differ
          // between them, and only because the trigger read the clock twice.
          const rlsAfter = await requiresTruth(rlsJob);
          const repoAfter = await requiresTruth(repoJob);
          expect(movedColumns(rlsBefore, rlsAfter).sort()).toEqual(
            movedColumns(repoBefore, repoAfter).sort(),
          );
          expect(repoAfter.status).toBe(rlsAfter.status);
          expect(repoAfter.canceled_at).toBe(rlsAfter.canceled_at);
          expect(repoAfter.created_by).toBe(rlsAfter.created_by);
          expect(repoAfter.status).toBe(
            expected === 1 ? "canceled" : status,
          );

          // The repository's own answer is the row it wrote, and nothing else.
          if (expected === 1) {
            expect(row?.id).toBe(repoJob);
            expect(row?.canceled_at).toBe(CANCELED_AT);
          } else {
            expect(row).toBeNull();
          }
        }
      }
    }
  });
});

describe("job owner write: concurrency, refusals and the context it runs in", () => {
  it("case 13: two CONCURRENT cancels of the same row — exactly one gets it", async () => {
    const jobId = await seedJob({ status: "queued" });

    // Two logical connections to the same database, each opening its own
    // transaction: the race the route can actually lose (a double click, or a
    // retry). The guard is what makes the second answer `null` instead of
    // writing a second cancel stamp.
    const first = createJobOwnerWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });
    const second = createJobOwnerWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    const results = await Promise.all([
      first.cancelOwnJob({ actorId: AUTHOR_ID, jobId, canceledAt: CANCELED_AT }),
      second.cancelOwnJob({ actorId: AUTHOR_ID, jobId, canceledAt: CANCELED_AT }),
    ]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect((await requiresTruth(jobId)).status).toBe("canceled");

    // A later delivery can never cancel it a second time either.
    await expect(
      repository.cancelOwnJob({ actorId: AUTHOR_ID, jobId, canceledAt: CANCELED_AT }),
    ).resolves.toBeNull();
  });

  it("case 14: a malformed uuid is a real SQL error, rolls back, and the pool stays usable", async () => {
    const before = await jobCount();

    // Independent of the repository: the server itself rejects the bind.
    const direct = await db
      .query(SELECT_JOB_TRUTH_SQL, [INVALID_ID])
      .catch((reason: unknown) => reason);
    expect((direct as { code?: string }).code).toBe("22P02");
    expect(String((direct as { message?: string }).message)).toMatch(
      /invalid input syntax for type uuid/,
    );

    const error = await repository
      .cancelOwnJob({ actorId: AUTHOR_ID, jobId: INVALID_ID, canceledAt: CANCELED_AT })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobOwnerWriteError);
    const writeError = error as JobOwnerWriteError;
    expect(writeError.operation).toBe(CANCEL_OWN_JOB);
    // The fixed message carries no SQL, no host, no id and no value.
    expect(writeError.message).toBe(`job owner write failed (${CANCEL_OWN_JOB})`);
    expect(writeError.message).not.toMatch(
      /public\.|background_jobs|invalid input|uuid|postgres:\/\//i,
    );
    expect(writeError.message).not.toContain(AUTHOR_ID);
    expect((writeError.cause as { code?: string }).code).toBe("22P02");

    // Nothing was written, and the failed transaction rolled back — so the very
    // same pool answers the next write.
    expect(await jobCount()).toBe(before);
    expect(
      (
        await repository.cancelOwnJob({
          actorId: AUTHOR_ID,
          jobId: await seedJob({ status: "queued" }),
          canceledAt: CANCELED_AT,
        })
      )?.status,
    ).toBe("canceled");
  });

  it("case 15: the write runs as the CALLER, and its context does not leak", async () => {
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

    const observing = createJobOwnerWriteRepository({
      getTransactionPool: () => observingPool,
    });

    await observing.cancelOwnJob({
      actorId: AUTHOR_ID,
      jobId: await seedJob({ status: "queued" }),
      canceledAt: CANCELED_AT,
    });
    await observing.cancelOwnJob({
      actorId: MEMBER_ID,
      jobId: await seedJob({ status: "queued" }),
      canceledAt: CANCELED_AT,
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
    // context of this write cannot become the context of the next statement.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

type ServiceHarness = {
  service: JobService;
  userClientTokens: string[];
  messageLifecycle: string[];
  adminClientCalls: () => number;
};

/**
 * The service under test: the REAL repository over the PGlite pool, and stubs
 * for the two clients that THROW on contact. `cancelJob` must therefore never
 * touch PostgREST — a fallback would not quietly succeed here, it would fail the
 * case.
 */
function buildService(
  options: { withoutOwnerWriteRepository?: boolean } = {},
): ServiceHarness {
  const userClientTokens: string[] = [];
  const messageLifecycle: string[] = [];
  let adminClientCalls = 0;

  const service = createJobService({
    createUserClient: (accessToken: string) => {
      userClientTokens.push(accessToken);
      throw new Error("cancelJob must not build a user client");
    },
    getAdminClient: () => {
      adminClientCalls += 1;
      throw new Error("cancelJob must not reach for the admin client");
    },
    pgmq: {
      send: async (queue: string) => {
        messageLifecycle.push(`send:${queue}`);
        return 1;
      },
      deleteMsg: async (queue: string, msgId: number) => {
        messageLifecycle.push(`deleteMsg:${queue}:${msgId}`);
        return true;
      },
      archive: async (queue: string, msgId: number) => {
        messageLifecycle.push(`archive:${queue}:${msgId}`);
        return true;
      },
    } as unknown as PgmqClient,
    ...(options.withoutOwnerWriteRepository
      ? {}
      : { jobOwnerWriteRepository: repository }),
  });

  return {
    service,
    userClientTokens,
    messageLifecycle,
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

describe("job owner write: through the real JobService", () => {
  it("case 16: cancelJob returns the caller's own cancelled job, and builds no client at all", async () => {
    const jobId = await seedJob({ status: "queued", createdBy: AUTHOR_ID });
    const { service, userClientTokens, messageLifecycle, adminClientCalls } =
      buildService();

    const job = await service.cancelJob(actor(AUTHOR_ID), jobId);

    expect(job.id).toBe(jobId);
    expect(job.status).toBe("canceled");
    expect(job.created_by).toBe(AUTHOR_ID);
    expect(job.workspace_id).toBe(teamWorkspaceId);

    // The stamp is the SERVICE's clock, not the repository's: the method builds
    // it and passes it down, exactly as the removed update built its patch. What
    // it stamped is what the row holds.
    expect(job.canceled_at).toEqual(expect.any(String));
    expect(Date.parse(job.canceled_at as string)).toBeGreaterThan(
      Date.parse(CREATED_AT),
    );
    expect((await requiresTruth(jobId)).canceled_at).toBe(job.canceled_at);

    // The migration's whole point: the write reaches no client, and no queue
    // message is consumed — the worker's own guard drops it (GN-32 territory).
    expect(userClientTokens).toEqual([]);
    expect(messageLifecycle).toEqual([]);
    expect(adminClientCalls()).toBe(0);
  });

  it("case 17: somebody else's job — and a status the guard refuses — are the existing 404, not a 403", async () => {
    const { service, userClientTokens } = buildService();

    const otherMembersJob = await seedJob({
      status: "queued",
      createdBy: MEMBER_ID,
    });
    const retrying = await seedJob({ status: "retrying", createdBy: AUTHOR_ID });

    for (const [caller, jobId] of [
      [AUTHOR_ID, otherMembersJob],
      [TEAM_OWNER_ID, otherMembersJob],
      [OUTSIDER_ID, otherMembersJob],
      [AUTHOR_ID, retrying],
      [AUTHOR_ID, MISSING_ID],
    ] as const) {
      const error = await serviceRefusal(() =>
        service.cancelJob(actor(caller), jobId),
      );

      expect(error.code).toBe("job_not_found");
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe("Job not found or already completed.");
    }

    // Neither row moved, and nothing ever reached the client.
    expect((await requiresTruth(otherMembersJob)).status).toBe("queued");
    expect((await requiresTruth(retrying)).status).toBe("retrying");
    expect(userClientTokens).toEqual([]);
  });

  it("case 18: with no repository wired — or with a failing one — cancelJob fails closed", async () => {
    const { service, userClientTokens, adminClientCalls } = buildService({
      withoutOwnerWriteRepository: true,
    });
    const jobId = await seedJob({ status: "queued", createdBy: AUTHOR_ID });

    const missing = await serviceRefusal(() =>
      service.cancelJob(actor(AUTHOR_ID), jobId),
    );
    expect(missing.code).toBe("job_cancel_failed");
    expect(missing.statusCode).toBe(500);
    expect(missing.message).toBe("Failed to cancel job.");

    // The row is really cancellable — the refusal is the missing dependency, not
    // a missing job — and nothing fell back to the client.
    expect((await requiresTruth(jobId)).status).toBe("queued");
    expect(userClientTokens).toEqual([]);
    expect(adminClientCalls()).toBe(0);

    // A repository that THROWS is the same 500 with the same fixed message; the
    // driver's own text never reaches it.
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
      jobOwnerWriteRepository: {
        async cancelOwnJob() {
          throw new JobOwnerWriteError(
            CANCEL_OWN_JOB,
            new Error("connection reset by peer"),
          );
        },
      },
    });

    const failed = await serviceRefusal(() =>
      broken.cancelJob(actor(AUTHOR_ID), jobId),
    );
    expect(failed.code).toBe("job_cancel_failed");
    expect(failed.statusCode).toBe(500);
    expect(failed.message).toBe("Failed to cancel job.");
    expect(failed.message).not.toMatch(/connection reset|background_jobs|public\./i);
  });

  it("case 19: a malformed job id is the existing 500, never a 404", async () => {
    const { service, userClientTokens } = buildService();

    // "The database refused the argument" is not "no such job": the old write
    // failed this way too, so it keeps the 500 `job_cancel_failed` it published.
    const error = await serviceRefusal(() =>
      service.cancelJob(actor(AUTHOR_ID), INVALID_ID),
    );

    expect(error.code).toBe("job_cancel_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to cancel job.");
    expect(error.message).not.toMatch(/invalid input|uuid|postgres:\/\//i);
    expect(userClientTokens).toEqual([]);
  });
});
