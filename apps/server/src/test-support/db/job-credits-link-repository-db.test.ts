import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLAIM_UNLINKED_CHARGE,
  CREDITS_LINK_REFUNDED_ERROR_CODE,
  CREDITS_LINK_REFUNDED_MESSAGE,
  CREDITS_REFUND_PENDING_ERROR_CODE,
  CREDITS_REFUND_PENDING_MESSAGE,
  JobCreditsLinkError,
  LINK_CREDITS,
  MARK_CHARGE_REFUNDED,
  createJobCreditsLinkRepository,
  type JobCreditsLinkRepository,
} from "../../db/job-credits-link-repository.js";
import { createJobBillingGateRepository } from "../../db/job-billing-gate-repository.js";
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
 * Real-SQL integration for the job credits link repository (workorder 21H2).
 *
 * The unit tests beside the repository prove WHICH statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * table, and that the properties the compensation path rests on are facts of the
 * database rather than of this process:
 *
 *   - `linkCredits` writes the cost and the transaction onto a job that has not
 *     started and has not been billed, and onto NOTHING else. Every other
 *     combination answers `false` and leaves the row identical column by column.
 *   - `linkCredits` and the worker's 21H1 timeout claim
 *     (`failUnbilledIfOverdue`) are mutually exclusive in BOTH orders: whichever
 *     runs first, the other answers `false`. That is what keeps the money off a
 *     job that was already failed as unbilled.
 *   - `claimUnlinkedCharge` moves only the two not-yet-started states to
 *     `failed`; a `canceled` job keeps saying `canceled` (and keeps its
 *     `canceled_at`), a terminal row keeps its own status and `failed_at`. Only
 *     the `credits_refund_pending` code is written, and claiming is one-shot.
 *   - `markChargeRefunded` confirms exactly the state the claim wrote and nothing
 *     else, so a second pass cannot refund again.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-000000000f00";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * every row in the table. This case exists to prove it does not.
 */
const INJECTION_ID = "' or '1'='1";

const LINK_QUEUED_JOB = "00000000-0000-0000-0000-000000000f01";
const LINK_RETRYING_JOB = "00000000-0000-0000-0000-000000000f02";
const LINK_CANCELED_JOB = "00000000-0000-0000-0000-000000000f03";
const LINK_FAILED_JOB = "00000000-0000-0000-0000-000000000f04";
const LINK_RUNNING_JOB = "00000000-0000-0000-0000-000000000f05";
const LINK_SUCCEEDED_JOB = "00000000-0000-0000-0000-000000000f06";
const LINK_BILLED_JOB = "00000000-0000-0000-0000-000000000f07";
const LINK_FREE_JOB = "00000000-0000-0000-0000-000000000f08";
const LINK_TWICE_JOB = "00000000-0000-0000-0000-000000000f09";
const LINK_BEFORE_GATE_JOB = "00000000-0000-0000-0000-000000000f0a";
const GATE_BEFORE_LINK_JOB = "00000000-0000-0000-0000-000000000f0b";
const LINK_FREE_BEFORE_GATE_JOB = "00000000-0000-0000-0000-000000000f0c";
const LINK_ROLLBACK_JOB = "00000000-0000-0000-0000-000000000f0d";
const LINK_UNKNOWN_JOB = "00000000-0000-0000-0000-000000000f0e";
const LINK_AFTER_CLAIM_JOB = "00000000-0000-0000-0000-000000000f0f";
const LINK_AFTER_MARK_JOB = "00000000-0000-0000-0000-000000000f10";

const CLAIM_QUEUED_JOB = "00000000-0000-0000-0000-000000000f11";
const CLAIM_RETRYING_JOB = "00000000-0000-0000-0000-000000000f12";
const CLAIM_CANCELED_JOB = "00000000-0000-0000-0000-000000000f13";
const CLAIM_FAILED_JOB = "00000000-0000-0000-0000-000000000f14";
const CLAIM_DEAD_LETTER_JOB = "00000000-0000-0000-0000-000000000f15";
const CLAIM_BILLED_JOB = "00000000-0000-0000-0000-000000000f16";
const CLAIM_FREE_JOB = "00000000-0000-0000-0000-000000000f17";
const CLAIM_RUNNING_JOB = "00000000-0000-0000-0000-000000000f18";
const CLAIM_SUCCEEDED_JOB = "00000000-0000-0000-0000-000000000f19";
const CLAIM_TWICE_JOB = "00000000-0000-0000-0000-000000000f1a";
const CLAIM_PENDING_JOB = "00000000-0000-0000-0000-000000000f1b";
const CLAIM_REFUNDED_JOB = "00000000-0000-0000-0000-000000000f1c";
const CLAIM_ROLLBACK_JOB = "00000000-0000-0000-0000-000000000f1d";
const CLAIM_UNKNOWN_JOB = "00000000-0000-0000-0000-000000000f1e";

const MARK_PENDING_JOB = "00000000-0000-0000-0000-000000000f21";
const MARK_NOT_PENDING_JOB = "00000000-0000-0000-0000-000000000f22";
const MARK_PAID_JOB = "00000000-0000-0000-0000-000000000f23";
const MARK_TWICE_JOB = "00000000-0000-0000-0000-000000000f24";
const MARK_AFTER_CLAIM_JOB = "00000000-0000-0000-0000-000000000f25";
const MARK_UNKNOWN_JOB = "00000000-0000-0000-0000-000000000f27";

const CONTEXT_LINK_JOB = "00000000-0000-0000-0000-000000000f30";
const CONTEXT_CLAIM_JOB = "00000000-0000-0000-0000-000000000f31";
const CONTEXT_MARK_JOB = "00000000-0000-0000-0000-000000000f32";

/** The confirm window the 21H1 gate cases use. */
const TIMEOUT_SECONDS = 600;
const ANCIENT_SECONDS = 3600;

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
  credits_cost: number | null;
  credits_transaction_id: string | null;
  error_code: string | null;
  error_message: string | null;
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
let repository: JobCreditsLinkRepository;
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

/** Which columns differ between two reads of the same row, sorted. */
function movedColumns(before: JobRecord, after: JobRecord): string[] {
  return Object.keys(after)
    .filter(
      (column) => JSON.stringify(after[column]) !== JSON.stringify(before[column]),
    )
    .sort();
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
  creditsCost?: number;
  transactionId?: string;
  errorCode?: string;
  errorMessage?: string;
  ageSeconds?: number;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by)
     values ($1, $2, 'image_generation', 'image_generation',
             $3::public.background_job_status, 3, $4)`,
    [input.id, workspaceId, input.status ?? "queued", USER_ID],
  );

  if (input.creditsCost !== undefined) {
    await db.query(
      "update public.background_jobs set credits_cost = $2 where id = $1",
      [input.id, input.creditsCost],
    );
  }

  if (input.transactionId !== undefined) {
    await db.query(
      "update public.background_jobs set credits_transaction_id = $2 where id = $1",
      [input.id, input.transactionId],
    );
  }

  if (input.errorCode !== undefined) {
    await db.query(
      `update public.background_jobs
          set error_code = $2, error_message = $3
        where id = $1`,
      [input.id, input.errorCode, input.errorMessage ?? "fixture row"],
    );
  }

  // The 21H1 gate measures its window from `created_at`, so the fixture moves it
  // rather than this process pretending a clock. Every snapshot below is taken
  // AFTER this backdating.
  if (input.ageSeconds !== undefined) {
    await db.query(
      `update public.background_jobs
          set created_at = now() - make_interval(secs => $2::double precision)
        where id = $1`,
      [input.id, input.ageSeconds],
    );
  }
}

/** The link call, with its arguments named once. */
function link(jobId: string, creditsCost = 10, transactionId: string | null = null) {
  return repository.linkCredits({ jobId, creditsCost, transactionId });
}

/** The claim call, with its arguments named once. */
function claim(jobId: string) {
  return repository.claimUnlinkedCharge({ jobId });
}

/** The mark call, with its arguments named once. */
function mark(jobId: string) {
  return repository.markChargeRefunded({ jobId });
}

/** The repository call, with the refusal captured instead of thrown. */
async function refusal(
  call: () => Promise<unknown>,
  operation:
    | typeof LINK_CREDITS
    | typeof CLAIM_UNLINKED_CHARGE
    | typeof MARK_CHARGE_REFUNDED,
): Promise<JobCreditsLinkError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(JobCreditsLinkError);
  const linkError = error as JobCreditsLinkError;
  expect(linkError.operation).toBe(operation);
  expect(linkError.message).toBe(`job credits link failed (${operation})`);
  return linkError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobCreditsLinkRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-credits-link@hahart.test");
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_ID],
      )
    ).rows,
  ).id;

  // Link fixture: one row per status the predicate distinguishes.
  await createJob({ id: LINK_QUEUED_JOB });
  await createJob({ id: LINK_RETRYING_JOB, status: "retrying" });
  await createJob({
    id: LINK_CANCELED_JOB,
    status: "canceled",
    errorCode: "canceled_by_user",
    errorMessage: "cancelled by its owner",
  });
  await createJob({
    id: LINK_FAILED_JOB,
    status: "failed",
    errorCode: "executor_error",
    errorMessage: "terminal row",
  });
  await createJob({ id: LINK_RUNNING_JOB, status: "running" });
  await createJob({ id: LINK_SUCCEEDED_JOB, status: "succeeded" });
  await createJob({ id: LINK_BILLED_JOB, creditsCost: 10 });
  await createJob({ id: LINK_FREE_JOB });
  await createJob({ id: LINK_TWICE_JOB });
  await createJob({ id: LINK_BEFORE_GATE_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: GATE_BEFORE_LINK_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: LINK_FREE_BEFORE_GATE_JOB, ageSeconds: ANCIENT_SECONDS });
  await createJob({ id: LINK_ROLLBACK_JOB });
  await createJob({ id: LINK_AFTER_CLAIM_JOB });
  await createJob({ id: LINK_AFTER_MARK_JOB });

  // Claim fixture.
  await createJob({ id: CLAIM_QUEUED_JOB });
  await createJob({ id: CLAIM_RETRYING_JOB, status: "retrying" });
  await createJob({
    id: CLAIM_CANCELED_JOB,
    status: "canceled",
    errorCode: "canceled_by_user",
    errorMessage: "cancelled by its owner",
  });
  await createJob({
    id: CLAIM_FAILED_JOB,
    status: "failed",
    errorCode: "executor_error",
    errorMessage: "terminal row",
  });
  await createJob({
    id: CLAIM_DEAD_LETTER_JOB,
    status: "dead_letter",
    errorCode: "executor_error",
    errorMessage: "legacy terminal row",
  });
  await createJob({ id: CLAIM_BILLED_JOB, creditsCost: 10 });
  await createJob({ id: CLAIM_FREE_JOB, creditsCost: 0 });
  await createJob({ id: CLAIM_RUNNING_JOB, status: "running" });
  await createJob({ id: CLAIM_SUCCEEDED_JOB, status: "succeeded" });
  await createJob({ id: CLAIM_TWICE_JOB });
  await createJob({
    id: CLAIM_PENDING_JOB,
    errorCode: CREDITS_REFUND_PENDING_ERROR_CODE,
  });
  await createJob({
    id: CLAIM_REFUNDED_JOB,
    errorCode: CREDITS_LINK_REFUNDED_ERROR_CODE,
  });
  await createJob({ id: CLAIM_ROLLBACK_JOB });

  // Mark fixture.
  await createJob({
    id: MARK_PENDING_JOB,
    status: "failed",
    errorCode: CREDITS_REFUND_PENDING_ERROR_CODE,
  });
  await createJob({ id: MARK_NOT_PENDING_JOB });
  await createJob({
    id: MARK_PAID_JOB,
    creditsCost: 10,
    errorCode: CREDITS_REFUND_PENDING_ERROR_CODE,
  });
  await createJob({
    id: MARK_TWICE_JOB,
    status: "failed",
    errorCode: CREDITS_REFUND_PENDING_ERROR_CODE,
  });
  await createJob({ id: MARK_AFTER_CLAIM_JOB });

  // Context fixture.
  await createJob({ id: CONTEXT_LINK_JOB });
  await createJob({ id: CONTEXT_CLAIM_JOB });
  await createJob({
    id: CONTEXT_MARK_JOB,
    status: "failed",
    errorCode: CREDITS_REFUND_PENDING_ERROR_CODE,
  });

  // Rows a refusal must leave completely alone carry the state-machine columns
  // these writes could damage, so the comparison below has something to compare.
  await db.query(
    `update public.background_jobs
        set payload = $2::jsonb, result = $3::jsonb,
            credits_transaction_id = $4, attempt_count = 2,
            thread_id = 'thread-21h2', started_at = now(),
            failed_at = now(), canceled_at = now()
      where id = $1`,
    [
      LINK_RUNNING_JOB,
      JSON.stringify({ prompt: "keep-me" }),
      JSON.stringify({ url: "x" }),
      randomUUID(),
    ],
  );
  await db.query(
    `update public.background_jobs
        set result = $2::jsonb, completed_at = now(), attempt_count = 1
      where id = $1`,
    [LINK_SUCCEEDED_JOB, JSON.stringify({ url: "done" })],
  );
  await db.query(
    `update public.background_jobs
        set canceled_at = now(), failed_at = now()
      where id = $1`,
    [LINK_CANCELED_JOB],
  );
  await db.query(
    `update public.background_jobs
        set credits_transaction_id = $2, attempt_count = 3
      where id = $1`,
    [LINK_BILLED_JOB, randomUUID()],
  );
  await db.query(
    `update public.background_jobs
        set canceled_at = now(), failed_at = now()
      where id = $1`,
    [CLAIM_CANCELED_JOB],
  );
  await db.query(
    `update public.background_jobs
        set failed_at = now(), attempt_count = 2
      where id = $1`,
    [CLAIM_FAILED_JOB],
  );
  await db.query(
    `update public.background_jobs
        set failed_at = now(), attempt_count = 3
      where id = $1`,
    [CLAIM_DEAD_LETTER_JOB],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job credits link: the charge lands on an unstarted, unbilled job", () => {
  it("case 1: a queued, unbilled job takes the cost AND the transaction", async () => {
    const before = await requiresJobRow(LINK_QUEUED_JOB);
    expect(before.status).toBe("queued");
    expect(before.credits_cost).toBeNull();
    expect(before.credits_transaction_id).toBeNull();

    const transactionId = randomUUID();
    await expect(link(LINK_QUEUED_JOB, 10, transactionId)).resolves.toBe(true);

    const after = await requiresJobRow(LINK_QUEUED_JOB);
    expect(after.credits_cost).toBe(10);
    expect(after.credits_transaction_id).toBe(transactionId);

    // Column by column: the write owns three columns and nothing else. In
    // particular the status did NOT move — recording what a job cost is not a
    // state transition.
    expect(movedColumns(before, after)).toEqual([
      "credits_cost",
      "credits_transaction_id",
      "updated_at",
    ]);
    expect(after.status).toBe("queued");
    expect(after.error_code).toBeNull();
    expect(after.failed_at).toBeNull();
  });

  it("case 2: a retrying job is billed too, because it has not started again yet", async () => {
    const transactionId = randomUUID();

    await expect(link(LINK_RETRYING_JOB, 7, transactionId)).resolves.toBe(true);

    const after = await requiresJobRow(LINK_RETRYING_JOB);
    expect(after.credits_cost).toBe(7);
    expect(after.credits_transaction_id).toBe(transactionId);
    expect(after.status).toBe("retrying");
  });

  it("case 3: the free path can record (0, null), and that is a confirmation", async () => {
    // Workorder 21H1: a free job writes `0` with no transaction so the worker's
    // gate can tell it apart from a job nobody billed. If this write were
    // refused, every free generation would be failed as `billing_not_confirmed`.
    const before = await requiresJobRow(LINK_FREE_JOB);

    await expect(link(LINK_FREE_JOB, 0, null)).resolves.toBe(true);

    const after = await requiresJobRow(LINK_FREE_JOB);
    expect(after.credits_cost).toBe(0);
    expect(after.credits_transaction_id).toBeNull();
    expect(movedColumns(before, after)).toEqual(["credits_cost", "updated_at"]);
  });

  it("case 4: canceled, failed, running and succeeded rows are all refused untouched", async () => {
    const refused: Array<[string, string]> = [
      [LINK_CANCELED_JOB, "canceled"],
      [LINK_FAILED_JOB, "failed"],
      [LINK_RUNNING_JOB, "running"],
      [LINK_SUCCEEDED_JOB, "succeeded"],
    ];

    for (const [jobId, status] of refused) {
      const before = await snapshot(jobId);

      await expect(link(jobId, 10, randomUUID())).resolves.toBe(false);

      // The refusal is the predicate, not a partial write: the row is exactly
      // where it was, including the columns this write would have set. Only
      // `credits_cost` is checked by name — one refused row carries a link from
      // the fixture on purpose, and the snapshot above is what proves it stayed.
      expect(await snapshot(jobId)).toBe(before);
      const after = await requiresJobRow(jobId);
      expect(after.status).toBe(status);
      expect(after.credits_cost).toBeNull();
    }
  });

  it("case 5: a job that was already billed is refused, and its charge is not overwritten", async () => {
    const before = await requiresJobRow(LINK_BILLED_JOB);
    expect(before.credits_cost).toBe(10);
    const billedTransaction = before.credits_transaction_id;
    expect(billedTransaction).not.toBeNull();

    await expect(link(LINK_BILLED_JOB, 99, randomUUID())).resolves.toBe(false);

    const after = await requiresJobRow(LINK_BILLED_JOB);
    expect(after.credits_cost).toBe(10);
    expect(after.credits_transaction_id).toBe(billedTransaction);
  });

  it("case 6: linking is one-shot — the second call changes nothing", async () => {
    const first = randomUUID();
    await expect(link(LINK_TWICE_JOB, 5, first)).resolves.toBe(true);
    const billed = await snapshot(LINK_TWICE_JOB);

    await expect(link(LINK_TWICE_JOB, 500, randomUUID())).resolves.toBe(false);

    expect(await snapshot(LINK_TWICE_JOB)).toBe(billed);
    expect((await requiresJobRow(LINK_TWICE_JOB)).credits_cost).toBe(5);
    expect((await requiresJobRow(LINK_TWICE_JOB)).credits_transaction_id).toBe(
      first,
    );
  });

  it("case 7: an unknown job id is false, not an error", async () => {
    const missing = randomUUID();

    await expect(link(missing, 10, null)).resolves.toBe(false);
    await expect(jobRow(missing)).resolves.toBeNull();
  });

  it("case 8: a job whose charge is already being compensated can no longer be linked", async () => {
    // The claim moves a queued job to `failed`, which breaks the link's status
    // predicate — so the money cannot be recorded on a job whose refund is
    // already being paid out. The mark leaves the row in the same state, which
    // is what makes the two steps compose.
    await expect(claim(LINK_AFTER_CLAIM_JOB)).resolves.toBe(true);
    await expect(claim(LINK_AFTER_MARK_JOB)).resolves.toBe(true);
    await expect(mark(LINK_AFTER_MARK_JOB)).resolves.toBe(true);

    for (const jobId of [LINK_AFTER_CLAIM_JOB, LINK_AFTER_MARK_JOB]) {
      const before = await snapshot(jobId);

      await expect(link(jobId, 10, randomUUID())).resolves.toBe(false);

      expect(await snapshot(jobId)).toBe(before);
      expect((await requiresJobRow(jobId)).credits_cost).toBeNull();
    }
    expect((await requiresJobRow(LINK_AFTER_MARK_JOB)).error_code).toBe(
      CREDITS_LINK_REFUNDED_ERROR_CODE,
    );
  });
});

describe("job credits link: exclusive with the 21H1 billing gate, in both orders", () => {
  const gate = () =>
    createJobBillingGateRepository({ getTransactionPool: () => pool });

  it("case 9: link first — the gate can no longer fail the job as unbilled", async () => {
    // The order the charge normally takes: the money is recorded while the
    // worker is still deciding. The gate's `credits_cost is null` predicate is
    // what makes the two statements mutually exclusive.
    await expect(link(LINK_BEFORE_GATE_JOB, 10, randomUUID())).resolves.toBe(
      true,
    );

    await expect(
      gate().failUnbilledIfOverdue({
        jobId: LINK_BEFORE_GATE_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      }),
    ).resolves.toBe(false);

    const after = await requiresJobRow(LINK_BEFORE_GATE_JOB);
    expect(after.status).toBe("queued");
    expect(after.credits_cost).toBe(10);
    expect(after.error_code).toBeNull();
  });

  it("case 10: gate first — the link is refused, so no money lands on a job that was failed as unbilled", async () => {
    await expect(
      gate().failUnbilledIfOverdue({
        jobId: GATE_BEFORE_LINK_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      }),
    ).resolves.toBe(true);

    const before = await snapshot(GATE_BEFORE_LINK_JOB);

    // Without the `status in ('queued','retrying')` half of the predicate this
    // write would succeed and the charge would sit on a terminally failed job
    // that nobody refunds (workorder 21H2 §6).
    await expect(link(GATE_BEFORE_LINK_JOB, 10, randomUUID())).resolves.toBe(
      false,
    );

    const after = await requiresJobRow(GATE_BEFORE_LINK_JOB);
    expect(await snapshot(GATE_BEFORE_LINK_JOB)).toBe(before);
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe("billing_not_confirmed");
    expect(after.credits_cost).toBeNull();
  });

  it("case 11: recording the free (0, null) confirmation also stops the gate", async () => {
    await expect(link(LINK_FREE_BEFORE_GATE_JOB, 0, null)).resolves.toBe(true);

    await expect(
      gate().failUnbilledIfOverdue({
        jobId: LINK_FREE_BEFORE_GATE_JOB,
        timeoutSeconds: TIMEOUT_SECONDS,
      }),
    ).resolves.toBe(false);

    const after = await requiresJobRow(LINK_FREE_BEFORE_GATE_JOB);
    expect(after.credits_cost).toBe(0);
    expect(after.status).toBe("queued");
  });
});

describe("job credits link: the claim takes ownership exactly once", () => {
  it("case 12: a queued, unbilled job becomes failed with the pending marker", async () => {
    const before = await requiresJobRow(CLAIM_QUEUED_JOB);
    expect(before.status).toBe("queued");
    expect(before.credits_cost).toBeNull();
    expect(before.failed_at).toBeNull();

    await expect(claim(CLAIM_QUEUED_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(CLAIM_QUEUED_JOB);
    expect(after.status).toBe("failed");
    expect(after.failed_at).not.toBeNull();
    expect(after.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
    expect(after.error_message).toBe(CREDITS_REFUND_PENDING_MESSAGE);

    // Exactly five columns moved, and the cost is still NULL: this job was never
    // billed, which is what makes this module the only possible refund owner.
    expect(movedColumns(before, after)).toEqual([
      "error_code",
      "error_message",
      "failed_at",
      "status",
      "updated_at",
    ]);
    expect(after.credits_cost).toBeNull();
    expect(after.credits_transaction_id).toBeNull();
    expect(after.attempt_count).toBe(before.attempt_count);
    expect(after.canceled_at).toBeNull();
  });

  it("case 13: a retrying, unbilled job is claimable too", async () => {
    await expect(claim(CLAIM_RETRYING_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(CLAIM_RETRYING_JOB);
    expect(after.status).toBe("failed");
    expect(after.failed_at).not.toBeNull();
    expect(after.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
  });

  it("case 14: a canceled job stays canceled — only the marker is written", async () => {
    // The user's own cancellation is not rewritten by a compensation pass. The
    // CASE keeps both the status and the timestamp; the claim only adds the
    // "a refund is owed" code the compensation path reads.
    const before = await requiresJobRow(CLAIM_CANCELED_JOB);
    expect(before.status).toBe("canceled");
    expect(before.canceled_at).not.toBeNull();

    await expect(claim(CLAIM_CANCELED_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(CLAIM_CANCELED_JOB);
    expect(after.status).toBe("canceled");
    expect(after.canceled_at).toBe(before.canceled_at);
    expect(after.failed_at).toBe(before.failed_at);
    expect(after.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
    expect(movedColumns(before, after)).toEqual([
      "error_code",
      "error_message",
      "updated_at",
    ]);
  });

  it("case 15: a terminal row keeps its own status and failed_at, and only the code is replaced", async () => {
    const before = await requiresJobRow(CLAIM_FAILED_JOB);
    expect(before.status).toBe("failed");
    expect(before.error_code).toBe("executor_error");
    expect(before.failed_at).not.toBeNull();

    await expect(claim(CLAIM_FAILED_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(CLAIM_FAILED_JOB);
    expect(after.status).toBe("failed");
    expect(after.failed_at).toBe(before.failed_at);
    expect(after.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
    expect(movedColumns(before, after)).toEqual([
      "error_code",
      "error_message",
      "updated_at",
    ]);
  });

  it("case 16: a legacy dead_letter row is claimable and keeps its status", async () => {
    // `dead_letter` is a legacy terminal value the worker no longer writes, but
    // historical rows still carry it and their charge can be just as unlinked.
    const before = await requiresJobRow(CLAIM_DEAD_LETTER_JOB);

    await expect(claim(CLAIM_DEAD_LETTER_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(CLAIM_DEAD_LETTER_JOB);
    expect(after.status).toBe("dead_letter");
    expect(after.failed_at).toBe(before.failed_at);
    expect(after.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
  });

  it("case 17: a billed job — cost 0 included — can never be claimed", async () => {
    // `credits_cost is null` is the ownership rule. A billed job belongs to the
    // worker's refund path, and claiming it here would refund a second time.
    for (const jobId of [CLAIM_BILLED_JOB, CLAIM_FREE_JOB]) {
      const before = await snapshot(jobId);

      await expect(claim(jobId)).resolves.toBe(false);

      expect(await snapshot(jobId)).toBe(before);
    }
    expect((await requiresJobRow(CLAIM_FREE_JOB)).credits_cost).toBe(0);
  });

  it("case 18: running and succeeded rows are refused untouched", async () => {
    for (const jobId of [CLAIM_RUNNING_JOB, CLAIM_SUCCEEDED_JOB]) {
      const before = await snapshot(jobId);

      await expect(claim(jobId)).resolves.toBe(false);

      expect(await snapshot(jobId)).toBe(before);
    }
    expect((await requiresJobRow(CLAIM_RUNNING_JOB)).status).toBe("running");
    expect((await requiresJobRow(CLAIM_SUCCEEDED_JOB)).status).toBe("succeeded");
  });

  it("case 19: claiming is one-shot — the second call is false", async () => {
    await expect(claim(CLAIM_TWICE_JOB)).resolves.toBe(true);
    const claimed = await snapshot(CLAIM_TWICE_JOB);

    await expect(claim(CLAIM_TWICE_JOB)).resolves.toBe(false);

    expect(await snapshot(CLAIM_TWICE_JOB)).toBe(claimed);
  });

  it("case 20: an already-pending or already-refunded row is not claimed again", async () => {
    // Both markers stop the claim, which is what makes the refund one-shot for
    // a compensation pass that runs more than once.
    for (const [jobId, marker] of [
      [CLAIM_PENDING_JOB, CREDITS_REFUND_PENDING_ERROR_CODE],
      [CLAIM_REFUNDED_JOB, CREDITS_LINK_REFUNDED_ERROR_CODE],
    ] as const) {
      const before = await snapshot(jobId);

      await expect(claim(jobId)).resolves.toBe(false);

      expect(await snapshot(jobId)).toBe(before);
      expect((await requiresJobRow(jobId)).error_code).toBe(marker);
    }
  });

  it("case 21: an unknown job id is false, not an error", async () => {
    await expect(claim(randomUUID())).resolves.toBe(false);
    await expect(jobRow(CLAIM_UNKNOWN_JOB)).resolves.toBeNull();
  });
});

describe("job credits link: the mark confirms a refund exactly once", () => {
  it("case 22: a pending job is marked refunded, and nothing else moves", async () => {
    const before = await requiresJobRow(MARK_PENDING_JOB);
    expect(before.error_code).toBe(CREDITS_REFUND_PENDING_ERROR_CODE);
    expect(before.status).toBe("failed");

    await expect(mark(MARK_PENDING_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(MARK_PENDING_JOB);
    expect(after.error_code).toBe(CREDITS_LINK_REFUNDED_ERROR_CODE);
    expect(after.error_message).toBe(CREDITS_LINK_REFUNDED_MESSAGE);
    expect(movedColumns(before, after)).toEqual([
      "error_code",
      "error_message",
      "updated_at",
    ]);
    // The status and the timestamps the claim wrote are left exactly as they
    // were: this statement confirms a refund, it does not move the job.
    expect(after.status).toBe("failed");
    expect(after.failed_at).toBe(before.failed_at);
    expect(after.credits_cost).toBeNull();
  });

  it("case 23: a job that was never claimed is refused untouched", async () => {
    const before = await snapshot(MARK_NOT_PENDING_JOB);

    await expect(mark(MARK_NOT_PENDING_JOB)).resolves.toBe(false);

    expect(await snapshot(MARK_NOT_PENDING_JOB)).toBe(before);
    expect((await requiresJobRow(MARK_NOT_PENDING_JOB)).error_code).toBeNull();
  });

  it("case 24: a pending marker on a BILLED job is refused", async () => {
    // `credits_cost is null` in the predicate: the worker owns the refund of a
    // billed job, so this statement must not confirm a refund that never
    // happened here.
    const before = await snapshot(MARK_PAID_JOB);

    await expect(mark(MARK_PAID_JOB)).resolves.toBe(false);

    expect(await snapshot(MARK_PAID_JOB)).toBe(before);
    expect((await requiresJobRow(MARK_PAID_JOB)).credits_cost).toBe(10);
  });

  it("case 25: marking is one-shot — the second call is false", async () => {
    await expect(mark(MARK_TWICE_JOB)).resolves.toBe(true);
    const refunded = await snapshot(MARK_TWICE_JOB);

    await expect(mark(MARK_TWICE_JOB)).resolves.toBe(false);

    expect(await snapshot(MARK_TWICE_JOB)).toBe(refunded);
  });

  it("case 26: claim then mark, and then neither can happen again", async () => {
    // The whole compensation sequence as the caller runs it: take ownership,
    // then confirm. A third pass — the background compensator of T-40 — finds
    // nothing to claim and nothing to confirm.
    await expect(claim(MARK_AFTER_CLAIM_JOB)).resolves.toBe(true);
    await expect(mark(MARK_AFTER_CLAIM_JOB)).resolves.toBe(true);

    const after = await requiresJobRow(MARK_AFTER_CLAIM_JOB);
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe(CREDITS_LINK_REFUNDED_ERROR_CODE);
    expect(after.credits_cost).toBeNull();

    await expect(claim(MARK_AFTER_CLAIM_JOB)).resolves.toBe(false);
    await expect(mark(MARK_AFTER_CLAIM_JOB)).resolves.toBe(false);
  });

  it("case 27: an unknown job id is false, not an error", async () => {
    await expect(mark(randomUUID())).resolves.toBe(false);
    await expect(jobRow(MARK_UNKNOWN_JOB)).resolves.toBeNull();
  });
});

describe("job credits link: refusals leave the pool usable", () => {
  it("case 28: a malformed uuid is a real SQL error on all three methods", async () => {
    const before = await allStates();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.background_jobs where id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const errors = [
      await refusal(() => link(INVALID_ID, 10, null), LINK_CREDITS),
      await refusal(() => claim(INVALID_ID), CLAIM_UNLINKED_CHARGE),
      await refusal(() => mark(INVALID_ID), MARK_CHARGE_REFUNDED),
    ];

    for (const linkError of errors) {
      // The fixed message carries no SQL, no host and no existence answer.
      expect(linkError.message).not.toMatch(
        /public\.|background_jobs|invalid input|postgres:\/\//i,
      );
      // The cause is the PostgreSQL parse failure, not a zero-row or shape answer.
      expect((linkError.cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    expect(await allStates()).toEqual(before);

    // All three failed transactions rolled back, so the very same pool works.
    await expect(link(CLAIM_UNKNOWN_JOB, 3, null)).resolves.toBe(false);
    await expect(claim(LINK_UNKNOWN_JOB)).resolves.toBe(false);
  });

  it("case 29: ids carrying SQL claim nothing, because they are only binds", async () => {
    // If an id had been concatenated into any of the writes, this statement
    // would have rewritten every row in the table.
    const before = await allStates();

    for (const jobId of [INJECTION_ID, `' or id is not null --`]) {
      const errors = [
        await refusal(() => link(jobId, 10, null), LINK_CREDITS),
        await refusal(() => claim(jobId), CLAIM_UNLINKED_CHARGE),
        await refusal(() => mark(jobId), MARK_CHARGE_REFUNDED),
      ];
      for (const linkError of errors) {
        expect(linkError.cause).toBeInstanceOf(Error);
      }
    }

    expect(await allStates()).toEqual(before);
  });

  it("case 30: a broken write statement rolls back and leaves the same pool usable", async () => {
    const before = await snapshot(LINK_ROLLBACK_JOB);

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

    const error = await createJobCreditsLinkRepository({
      getTransactionPool: () => brokenPool,
    })
      .linkCredits({ jobId: LINK_ROLLBACK_JOB, creditsCost: 10, transactionId: null })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobCreditsLinkError);
    expect((error as JobCreditsLinkError).message).not.toMatch(
      /public\.|background_jobs|no_such_column/i,
    );
    expect(((error as JobCreditsLinkError).cause as Error).message).toMatch(
      /no_such_column/,
    );

    // The UPDATE was undone: the row is exactly where it was.
    expect(await snapshot(LINK_ROLLBACK_JOB)).toBe(before);
    expect((await requiresJobRow(LINK_ROLLBACK_JOB)).credits_cost).toBeNull();

    // Same pool, next call: works.
    await expect(link(LINK_ROLLBACK_JOB, 4, null)).resolves.toBe(true);
    expect((await requiresJobRow(LINK_ROLLBACK_JOB)).credits_cost).toBe(4);

    // And the claim's own rollback path is the same statement shape.
    const claimBefore = await requiresJobRow(CLAIM_ROLLBACK_JOB);
    expect(claimBefore.status).toBe("queued");
    await expect(claim(CLAIM_ROLLBACK_JOB)).resolves.toBe(true);
    expect((await requiresJobRow(CLAIM_ROLLBACK_JOB)).status).toBe("failed");
  });
});

describe("job credits link: transaction context", () => {
  it("case 31: privileged writes with NO actor, and no setting survives", async () => {
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

    const observing = createJobCreditsLinkRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.linkCredits({
        jobId: CONTEXT_LINK_JOB,
        creditsCost: 2,
        transactionId: null,
      }),
    ).resolves.toBe(true);
    await expect(
      observing.claimUnlinkedCharge({ jobId: CONTEXT_CLAIM_JOB }),
    ).resolves.toBe(true);
    await expect(
      observing.markChargeRefunded({ jobId: CONTEXT_MARK_JOB }),
    ).resolves.toBe(true);

    expect(observed).toHaveLength(3);
    // No forged user: this is the server's own bookkeeping, so every actor
    // setting is empty and the mode is the explicit privileged label.
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
