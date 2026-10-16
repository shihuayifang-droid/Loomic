import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BILLING_NOT_CONFIRMED_ERROR_CODE,
  BILLING_NOT_CONFIRMED_MESSAGE,
  FAIL_UNBILLED_IF_OVERDUE,
  JobBillingGateError,
  READ_BILLING_GATE,
  createJobBillingGateRepository,
  type JobBillingGateRepository,
} from "../../db/job-billing-gate-repository.js";
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
 * Real-SQL integration for the job billing gate repository (workorder 21H1).
 *
 * The unit tests beside the repository prove WHICH statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * table, and that the two properties the gate rests on are facts of the database
 * rather than of this process:
 *
 *   - the READ reports the row honestly — `credits_cost` NULL versus 0 versus a
 *     charge are three different answers, the status comes back verbatim for
 *     every state the caller must pass through, and the overdue decision is made
 *     from `created_at` and the database clock;
 *   - the WRITE's predicate is the whole rule: only a `queued`/`retrying`,
 *     still-unbilled, overdue row can be claimed, and once it is claimed the row
 *     carries the terminal billing failure and NOTHING else moved. Every other
 *     combination answers `false` and leaves the row identical column by column.
 *     The case that models a charge landing between the read and the write is the
 *     one that matters: it is the race this statement exists to lose safely.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-000000000e01";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would claim
 * every overdue unbilled job in the table. This case exists to prove it does not.
 */
const INJECTION_ID = "' or '1'='1";

const READ_UNBILLED_JOB = "00000000-0000-0000-0000-000000000e11";
const READ_OVERDUE_JOB = "00000000-0000-0000-0000-000000000e12";
const READ_FREE_JOB = "00000000-0000-0000-0000-000000000e13";
const READ_PAID_JOB = "00000000-0000-0000-0000-000000000e14";
const READ_RETRYING_JOB = "00000000-0000-0000-0000-000000000e15";
const READ_RUNNING_JOB = "00000000-0000-0000-0000-000000000e16";
const READ_SUCCEEDED_JOB = "00000000-0000-0000-0000-000000000e17";
const READ_FAILED_JOB = "00000000-0000-0000-0000-000000000e18";
const READ_CANCELED_JOB = "00000000-0000-0000-0000-000000000e19";
const READ_WINDOW_JOB = "00000000-0000-0000-0000-000000000e1a";

const WRITE_OK_JOB = "00000000-0000-0000-0000-000000000e21";
const WRITE_RETRYING_JOB = "00000000-0000-0000-0000-000000000e22";
const WRITE_PAID_JOB = "00000000-0000-0000-0000-000000000e23";
const WRITE_FREE_JOB = "00000000-0000-0000-0000-000000000e24";
const WRITE_FRESH_JOB = "00000000-0000-0000-0000-000000000e25";
const WRITE_RUNNING_JOB = "00000000-0000-0000-0000-000000000e26";
const WRITE_CANCELED_JOB = "00000000-0000-0000-0000-000000000e27";
const WRITE_SUCCEEDED_JOB = "00000000-0000-0000-0000-000000000e28";
const WRITE_FAILED_JOB = "00000000-0000-0000-0000-000000000e29";
const WRITE_RACE_JOB = "00000000-0000-0000-0000-000000000e2a";
const WRITE_CONTEXT_JOB = "00000000-0000-0000-0000-000000000e2b";
const WRITE_TWICE_JOB = "00000000-0000-0000-0000-000000000e2c";
const WRITE_ROLLBACK_JOB = "00000000-0000-0000-0000-000000000e2d";
const WRITE_AFTER_ERROR_JOB = "00000000-0000-0000-0000-000000000e2e";

/** The confirm window every case below uses. */
const TIMEOUT_SECONDS = 600;

/** Comfortably beyond the window, and comfortably inside it. */
const ANCIENT_SECONDS = 3600;
const FRESH_SECONDS = 30;

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
  credits_cost: number | null;
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
let repository: JobBillingGateRepository;
let workspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/**
 * The whole row, with every timestamp cast to text.
 *
 * The casts are deliberate: `Date` objects from the driver compare by identity,
 * so a "this column moved" assertion built on them can pass without anything
 * having moved. Text is the representation this file can actually compare.
 */
const SELECT_JOB_SQL = `
select id, workspace_id, project_id, canvas_id, session_id, thread_id,
       queue_name, job_type, status::text as status, payload, result,
       error_code, error_message, attempt_count, max_attempts,
       credits_cost, credits_transaction_id, created_by,
       created_at::text as created_at, started_at::text as started_at,
       completed_at::text as completed_at, failed_at::text as failed_at,
       canceled_at::text as canceled_at, updated_at::text as updated_at
  from public.background_jobs
 where id = $1
`;

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

/** Every row's billing state, for "the table did not move" assertions. */
async function allStates(): Promise<Array<Record<string, unknown>>> {
  return (
    await db.query<Record<string, unknown>>(
      `select id, status::text as status, credits_cost, error_code,
              credits_transaction_id, attempt_count
         from public.background_jobs order by id`,
    )
  ).rows;
}

async function createJob(input: {
  id: string;
  status?: string;
  creditsCost?: number | null;
  ageSeconds?: number;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by)
     values ($1, $2, 'image_generation', 'image_generation',
             $3::public.background_job_status, 3, $4)`,
    [input.id, workspaceId, input.status ?? "queued", USER_ID],
  );

  if (input.creditsCost !== undefined && input.creditsCost !== null) {
    await db.query(
      "update public.background_jobs set credits_cost = $2 where id = $1",
      [input.id, input.creditsCost],
    );
  }

  // The window is measured from `created_at`, so the fixture moves it rather
  // than this process pretending a clock. The trigger above stamps `updated_at`
  // as well; every snapshot below is taken AFTER this backdating.
  if (input.ageSeconds !== undefined) {
    await db.query(
      `update public.background_jobs
          set created_at = now() - make_interval(secs => $2::double precision)
        where id = $1`,
      [input.id, input.ageSeconds],
    );
  }
}

/** The read call, with its arguments named once. */
function read(jobId: string, timeoutSeconds = TIMEOUT_SECONDS) {
  return repository.readBillingGate({ jobId, timeoutSeconds });
}

/** The write call, with its arguments named once. */
function fail(jobId: string, timeoutSeconds = TIMEOUT_SECONDS) {
  return repository.failUnbilledIfOverdue({ jobId, timeoutSeconds });
}

/** The repository call, with the refusal captured instead of thrown. */
async function refusal(
  call: () => Promise<unknown>,
  operation: typeof READ_BILLING_GATE | typeof FAIL_UNBILLED_IF_OVERDUE,
): Promise<JobBillingGateError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobBillingGateError);
  const gateError = error as JobBillingGateError;
  expect(gateError.operation).toBe(operation);
  expect(gateError.message).toBe(`job billing gate failed (${operation})`);
  return gateError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobBillingGateRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-billing-gate@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).id;

  // Read fixture: one row per combination the caller's matrix distinguishes.
  await createJob({ id: READ_UNBILLED_JOB, ageSeconds: FRESH_SECONDS });
  await createJob({ id: READ_OVERDUE_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: READ_FREE_JOB, creditsCost: 0, ageSeconds: FRESH_SECONDS });
  await createJob({ id: READ_PAID_JOB, creditsCost: 10, ageSeconds: FRESH_SECONDS });
  await createJob({
    id: READ_RETRYING_JOB,
    status: "retrying",
    ageSeconds: FRESH_SECONDS,
  });
  await createJob({ id: READ_RUNNING_JOB, status: "running" });
  await createJob({ id: READ_SUCCEEDED_JOB, status: "succeeded" });
  await createJob({ id: READ_FAILED_JOB, status: "failed" });
  await createJob({ id: READ_CANCELED_JOB, status: "canceled" });
  await createJob({ id: READ_WINDOW_JOB, ageSeconds: 900 });

  // Write fixture: the claimable rows, the refusals, and the race.
  await createJob({ id: WRITE_OK_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({
    id: WRITE_RETRYING_JOB,
    status: "retrying",
    ageSeconds: ANCIENT_SECONDS,
  });
  await createJob({ id: WRITE_PAID_JOB, creditsCost: 10, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_FREE_JOB, creditsCost: 0, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_FRESH_JOB, ageSeconds: FRESH_SECONDS });
  await createJob({ id: WRITE_RUNNING_JOB, status: "running", ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_CANCELED_JOB, status: "canceled", ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_SUCCEEDED_JOB, status: "succeeded", ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_FAILED_JOB, status: "failed", ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_RACE_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_CONTEXT_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_TWICE_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_ROLLBACK_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: WRITE_AFTER_ERROR_JOB, ageSeconds: ANCIENT_SECONDS });

  // Rows a refusal must leave completely alone carry the state-machine columns
  // this write could damage, so the comparison below has something to compare.
  await db.query(
    `update public.background_jobs
        set payload = $2::jsonb, result = $3::jsonb,
            error_code = 'executor_error', error_message = 'terminal row, do not touch',
            credits_transaction_id = $4, attempt_count = 2,
            thread_id = 'thread-21h1', started_at = now(),
            completed_at = now(), failed_at = now()
      where id = $1`,
    [
      WRITE_RUNNING_JOB,
      JSON.stringify({ prompt: "keep-me" }),
      JSON.stringify({ url: "x" }),
      randomUUID(),
    ],
  );
  await db.query(
    `update public.background_jobs
        set result = $2::jsonb, completed_at = now(), attempt_count = 1
      where id = $1`,
    [WRITE_SUCCEEDED_JOB, JSON.stringify({ url: "done" })],
  );
  await db.query(
    `update public.background_jobs
        set canceled_at = now(), error_code = 'canceled_by_user'
      where id = $1`,
    [WRITE_CANCELED_JOB],
  );
  await db.query(
    `update public.background_jobs
        set credits_transaction_id = $2, attempt_count = 3
      where id = $1`,
    [WRITE_PAID_JOB, randomUUID()],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job billing gate: the read reports the row honestly", () => {
  it("case 1: an unbilled queued job is null cost and NOT overdue inside the window", async () => {
    await expect(read(READ_UNBILLED_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: false,
    });
  });

  it("case 2: past the window the same row is overdue, with the cost still null", async () => {
    // This is the pair the gate is built on: NULL means "nothing recorded", and
    // only the age decides whether that is still tolerable or terminal.
    await expect(read(READ_OVERDUE_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: true,
    });
  });

  it("case 3: a free job (cost 0) is a confirmation, not a missing value", async () => {
    // 0 must be distinguishable from NULL: workorder 21H1 T3 writes it on the
    // free and billing-disabled paths precisely so those jobs stop looking
    // unbilled. If this answer ever collapsed to null, the gate would fail every
    // free job after the window.
    await expect(read(READ_FREE_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: 0,
      overdue: false,
    });
    expect((await requiresJobRow(READ_FREE_JOB)).credits_cost).toBe(0);
  });

  it("case 4: a charged job reports the amount it was charged", async () => {
    await expect(read(READ_PAID_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: 10,
      overdue: false,
    });
  });

  it("case 5: the window is a bound argument, and the decision uses the database clock", async () => {
    // The row is 900s old. Two calls, two different windows, two honest answers
    // — and the row itself never changes, so nothing here is a cached verdict.
    const before = await snapshot(READ_WINDOW_JOB);

    await expect(read(READ_WINDOW_JOB, 600)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: true,
    });
    await expect(read(READ_WINDOW_JOB, 3600)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: false,
    });

    expect(await snapshot(READ_WINDOW_JOB)).toBe(before);
  });

  it("case 6: every status the caller must pass through is reported verbatim", async () => {
    // The repository does NOT decide which statuses the gate applies to: the
    // caller's matrix does, and it needs the real status to do it. A read that
    // flattened these into one value would silently disable the pass-through arm.
    const answers: Array<[string, string, boolean]> = [
      [READ_RETRYING_JOB, "retrying", false],
      [READ_RUNNING_JOB, "running", false],
      [READ_SUCCEEDED_JOB, "succeeded", false],
      [READ_FAILED_JOB, "failed", false],
      [READ_CANCELED_JOB, "canceled", false],
    ];

    for (const [jobId, status, overdue] of answers) {
      await expect(read(jobId)).resolves.toEqual({
        status,
        // The fixture leaves them all unbilled, which is what makes the status
        // — not the cost — the thing that decides.
        creditsCost: null,
        overdue,
      });
    }
  });

  it("case 7: an unknown job id is null, and a read never writes", async () => {
    const before = await allStates();

    await expect(read(randomUUID())).resolves.toBeNull();

    // A read is a read: not one column of not one row moved.
    expect(await allStates()).toEqual(before);
  });

  it("case 8: a read leaves the row it read byte-for-byte identical", async () => {
    for (const jobId of [READ_UNBILLED_JOB, READ_OVERDUE_JOB, READ_PAID_JOB]) {
      const before = await snapshot(jobId);
      await read(jobId);
      expect(await snapshot(jobId)).toBe(before);
    }
  });
});

describe("job billing gate: the write claims exactly one shape of row", () => {
  it("case 9: a queued, unbilled, overdue row is claimed and carries only the failure", async () => {
    const before = await requiresJobRow(WRITE_OK_JOB);
    expect(before.status).toBe("queued");
    expect(before.credits_cost).toBeNull();
    expect(before.failed_at).toBeNull();

    await expect(fail(WRITE_OK_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(WRITE_OK_JOB);
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe(BILLING_NOT_CONFIRMED_ERROR_CODE);
    expect(after.error_message).toBe(BILLING_NOT_CONFIRMED_MESSAGE);
    expect(after.failed_at).not.toBeNull();
    expect(after.updated_at).not.toBe(before.updated_at);

    // Column by column: nothing else moved. In particular the attempt counter is
    // untouched (a gate refusal is not an attempt — see the caller's matrix), and
    // `credits_cost` is still NULL, which is what makes the job's own record say
    // "this was never billed" instead of implying a charge of zero.
    const moved = Object.keys(after).filter(
      (column) =>
        JSON.stringify(after[column]) !== JSON.stringify(before[column]),
    );
    expect(moved.sort()).toEqual(
      ["error_code", "error_message", "failed_at", "status", "updated_at"].sort(),
    );
    expect(after.credits_cost).toBeNull();
    expect(after.credits_transaction_id).toBeNull();
    expect(after.attempt_count).toBe(before.attempt_count);
    expect(after.max_attempts).toBe(before.max_attempts);
    expect(after.payload).toEqual(before.payload);
    expect(after.result).toEqual(before.result);
    expect(after.started_at).toEqual(before.started_at);
    expect(after.completed_at).toEqual(before.completed_at);
    expect(after.canceled_at).toEqual(before.canceled_at);
    expect(after.created_at).toEqual(before.created_at);
  });

  it("case 10: a retrying, unbilled, overdue row is claimable too", async () => {
    // `retrying` is not `running`: nothing is executing, so a job whose billing
    // never landed is still claimable. Excluding it would leave it deferring
    // forever.
    await expect(fail(WRITE_RETRYING_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(WRITE_RETRYING_JOB);
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe(BILLING_NOT_CONFIRMED_ERROR_CODE);
  });

  it("case 11: a charged row is refused, and the refusal writes nothing", async () => {
    const before = await snapshot(WRITE_PAID_JOB);

    await expect(fail(WRITE_PAID_JOB)).resolves.toBe(false);

    // The money landed: rewriting this row into a billing failure would destroy
    // the record of a charge that really happened.
    expect(await snapshot(WRITE_PAID_JOB)).toBe(before);
    expect(await jobRow(WRITE_PAID_JOB)).not.toBeNull();
    expect((await requiresJobRow(WRITE_PAID_JOB)).credits_cost).toBe(10);
  });

  it("case 12: cost 0 is billed, so the free path is not failed", async () => {
    // `credits_cost is null` is the predicate, and 0 is not null: this is the
    // case that proves the free path (T3) is protected by the gate rather than
    // tripped over by it.
    const before = await snapshot(WRITE_FREE_JOB);

    await expect(fail(WRITE_FREE_JOB)).resolves.toBe(false);

    expect(await snapshot(WRITE_FREE_JOB)).toBe(before);
  });

  it("case 13: a row still inside the window is refused", async () => {
    const before = await snapshot(WRITE_FRESH_JOB);

    await expect(fail(WRITE_FRESH_JOB)).resolves.toBe(false);

    expect(await snapshot(WRITE_FRESH_JOB)).toBe(before);
    expect((await requiresJobRow(WRITE_FRESH_JOB)).status).toBe("queued");
  });

  it("case 14: running, canceled, succeeded and failed rows are all refused", async () => {
    const before = await allStates();

    for (const jobId of [
      WRITE_RUNNING_JOB,
      WRITE_CANCELED_JOB,
      WRITE_SUCCEEDED_JOB,
      WRITE_FAILED_JOB,
    ]) {
      const rowBefore = await snapshot(jobId);
      await expect(fail(jobId)).resolves.toBe(false);
      expect(await snapshot(jobId)).toBe(rowBefore);
    }

    // A running job is being executed; a terminal one is somebody else's answer.
    // In particular a canceled job keeps `canceled` (and its own error code), and
    // a running job keeps its started_at and its payload.
    expect((await requiresJobRow(WRITE_RUNNING_JOB)).status).toBe("running");
    expect((await requiresJobRow(WRITE_RUNNING_JOB)).error_code).toBe(
      "executor_error",
    );
    expect((await requiresJobRow(WRITE_CANCELED_JOB)).status).toBe("canceled");
    expect((await requiresJobRow(WRITE_CANCELED_JOB)).error_code).toBe(
      "canceled_by_user",
    );
    expect((await requiresJobRow(WRITE_SUCCEEDED_JOB)).status).toBe("succeeded");
    expect((await requiresJobRow(WRITE_FAILED_JOB)).status).toBe("failed");
    expect(await allStates()).toEqual(before);
  });

  it("case 15: a charge landing between the read and the write wins the race", async () => {
    // The exact sequence the gate exists for: the worker reads "unbilled and
    // overdue", and the charge completes before the worker acts on it. The write
    // is one statement whose whole rule is in its predicate, so it re-checks
    // `credits_cost is null` at write time and answers false.
    await expect(read(WRITE_RACE_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: true,
    });

    // The charge lands (setCreditsInfo's effect, as SQL).
    const transactionId = randomUUID();
    await db.query(
      `update public.background_jobs
          set credits_cost = 7, credits_transaction_id = $2
        where id = $1`,
      [WRITE_RACE_JOB, transactionId],
    );
    const before = await snapshot(WRITE_RACE_JOB);

    await expect(fail(WRITE_RACE_JOB)).resolves.toBe(false);

    // The paid job survives intact: a read-then-write implementation would have
    // overwritten this charge with a billing failure.
    expect(await snapshot(WRITE_RACE_JOB)).toBe(before);
    const after = await requiresJobRow(WRITE_RACE_JOB);
    expect(after.status).toBe("queued");
    expect(after.credits_cost).toBe(7);
    expect(after.credits_transaction_id).toBe(transactionId);
    expect(after.error_code).toBeNull();
  });

  it("case 16: claiming is one-shot — a second call on the same row is false", async () => {
    // Two deliveries of the same message must not both act. The first call moves
    // the row to `failed`; the second one finds the status predicate broken and
    // answers false, so nothing is written twice.
    await expect(fail(WRITE_TWICE_JOB)).resolves.toBe(true);
    const claimed = await snapshot(WRITE_TWICE_JOB);

    await expect(fail(WRITE_TWICE_JOB)).resolves.toBe(false);

    expect(await snapshot(WRITE_TWICE_JOB)).toBe(claimed);
  });

  it("case 17: a job that does not exist is false, not an error", async () => {
    // Zero rows is a legal answer for an unknown id in both directions: the
    // caller's original flow already archives the message on a missing row.
    const missing = randomUUID();

    await expect(fail(missing)).resolves.toBe(false);
    await expect(read(missing)).resolves.toBeNull();
    expect(await jobRow(missing)).toBeNull();
  });
});

describe("job billing gate: refusals leave the pool usable", () => {
  it("case 18: a malformed uuid is a real SQL error on both methods", async () => {
    const before = await allStates();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.background_jobs where id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const readError = await refusal(() => read(INVALID_ID), READ_BILLING_GATE);
    const writeError = await refusal(
      () => fail(INVALID_ID),
      FAIL_UNBILLED_IF_OVERDUE,
    );

    for (const gateError of [readError, writeError]) {
      // The fixed message carries no SQL, no host and no existence answer.
      expect(gateError.message).not.toMatch(
        /public\.|background_jobs|invalid input|postgres:\/\//i,
      );
      // The cause is the PostgreSQL parse failure, not a zero-row or shape answer.
      expect((gateError.cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    expect(await allStates()).toEqual(before);

    // Both failed transactions rolled back, so the very same pool still works.
    await expect(read(READ_UNBILLED_JOB)).resolves.toEqual({
      status: "queued",
      creditsCost: null,
      overdue: false,
    });
    await expect(fail(WRITE_AFTER_ERROR_JOB)).resolves.toBe(true);
  });

  it("case 19: ids carrying SQL claim nothing, because they are only binds", async () => {
    // If an id had been concatenated into the write, this statement would have
    // failed every overdue unbilled job in the table.
    const before = await allStates();

    for (const jobId of [INJECTION_ID, `' or id is not null --`]) {
      const gateError = await refusal(
        () => fail(jobId),
        FAIL_UNBILLED_IF_OVERDUE,
      );
      expect(gateError.cause).toBeInstanceOf(Error);
    }

    expect(await allStates()).toEqual(before);
  });

  it("case 20: a broken write statement rolls back and leaves the same pool usable", async () => {
    const before = await snapshot(WRITE_ROLLBACK_JOB);

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

    const error = await createJobBillingGateRepository({
      getTransactionPool: () => brokenPool,
    })
      .failUnbilledIfOverdue({
        jobId: WRITE_ROLLBACK_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobBillingGateError);
    expect((error as JobBillingGateError).message).not.toMatch(
      /public\.|background_jobs|no_such_column/i,
    );
    expect(((error as JobBillingGateError).cause as Error).message).toMatch(
      /no_such_column/,
    );

    // The UPDATE was undone: the row is exactly where it was.
    expect(await snapshot(WRITE_ROLLBACK_JOB)).toBe(before);
    expect((await requiresJobRow(WRITE_ROLLBACK_JOB)).status).toBe("queued");

    // Same pool, next call: works.
    await expect(fail(WRITE_ROLLBACK_JOB)).resolves.toBe(true);
    expect((await requiresJobRow(WRITE_ROLLBACK_JOB)).status).toBe("failed");
  });
});

describe("job billing gate: transaction context", () => {
  it("case 21: privileged reads and writes with NO actor, and no setting survives", async () => {
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

    const observing = createJobBillingGateRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.readBillingGate({
        jobId: READ_PAID_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      }),
    ).resolves.toEqual({ status: "queued", creditsCost: 10, overdue: false });
    await expect(
      observing.failUnbilledIfOverdue({
        jobId: WRITE_CONTEXT_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      }),
    ).resolves.toBe(true);

    expect(observed).toHaveLength(2);
    // No forged user: the worker reads and writes this row as the system, so
    // every actor setting is empty and the mode is the explicit privileged label.
    for (const settings of observed) {
      expect(settings).toEqual({
        user_id: "",
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone, so the
    // context of this statement cannot become the context of the next one.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});
