import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  JobRefundBasisError,
  READ_REFUND_BASIS,
  createJobRefundBasisRepository,
  type JobRefundBasisRepository,
} from "../../db/job-refund-basis-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createRefundJob } from "../../features/jobs/refund-job.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the refund basis read repository (workorder 21O).
 *
 * The unit tests beside the repository prove WHICH statement is built and how
 * each answer is mapped. This file proves PostgreSQL actually parses and
 * executes it against the real table, and that the properties the refund path
 * rests on are facts of the database rather than of this process:
 *
 *   - the three projected columns come back with their real values — a charge of
 *     10, a charge of 0 and a NULL charge are three different rows, and NULL
 *     stays NULL here (the caller's `?? 0` is where it becomes a refusal);
 *   - an unknown id is `null`;
 *   - a malformed uuid is a real SQL error that rolls back and leaves the same
 *     pool usable;
 *   - the read never moves a row, and the transaction-local context of the read
 *     does not survive COMMIT;
 *   - driven through the real `createRefundJob`, a charged row refunds exactly
 *     once with the verbatim argument list and description, an uncharged (or
 *     free) row refunds nothing, and the credits rule is never reached for a
 *     row this module cannot vouch for.
 *
 * ONE MEASURED DISCREPANCY, PINNED RATHER THAN ASSUMED (see case 7): workorder
 * 21O §1 states that `background_jobs.created_by` is nullable ("historic rows").
 * In THIS schema — `supabase/migrations` replayed by `pglite-db.ts`, the schema
 * every PGlite suite in this repository runs against — it is NOT NULL, so a row
 * with a NULL creator cannot be inserted here at all. The case measures that
 * fact instead of pretending to exercise it, and the "NULL creator is reported
 * as null and is not refunded" contract is pinned at the mapping level
 * (`job-refund-basis-repository.test.ts` case 10) and at the money level
 * (`refund-job.test.ts`, the `createdBy === null` branch).
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host.
 */

const USER_ID = "00000000-0000-0000-0000-0000000021c0";
const JOB_COST_10 = "00000000-0000-0000-0000-0000000021b1";
const JOB_COST_0 = "00000000-0000-0000-0000-0000000021b2";
const JOB_COST_NULL = "00000000-0000-0000-0000-0000000021b3";
/** Never inserted: it exists so the NOT NULL probe cannot disturb another case. */
const JOB_NOT_NULL_PROBE = "00000000-0000-0000-0000-0000000021b4";
const UNKNOWN_JOB = "00000000-0000-0000-0000-0000000021bf";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

const CREATED_AT = "2026-03-05T06:07:08.901Z";
const UPDATED_AT = "2026-03-05T06:08:09.012Z";

let db: PGlite;
let pool: TransactionPool;
let repository: JobRefundBasisRepository;
let workspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/**
 * The row as the DATABASE describes it, keyed the way the repository promises to
 * key it. It is the independent second opinion: if the repository invented,
 * dropped or reordered a value, this is what disagrees.
 *
 * `workspace_id` and `created_by` are rendered `::text` so the comparison is
 * between strings, not between a uuid type and a string.
 */
const SELECT_BASIS_TRUTH_SQL = `
select
  credits_cost,
  workspace_id::text as workspace_id,
  created_by::text as created_by
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

type ColumnRow = {
  column_name: string;
  is_nullable: string;
  data_type: string;
};

/**
 * Insert through the real column list, naming every column this workorder reads
 * plus the ones the table cannot exist without. `credits_cost` is deliberately
 * passed as NULL when the fixture says so — the whole point of the three rows
 * below is that NULL, 0 and 10 are three different answers.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, queue_name, job_type, status, payload,
  attempt_count, max_attempts, created_by, created_at, updated_at, credits_cost
) values (
  $1, $2, $3, $4::public.background_job_type, $5::public.background_job_status,
  $6::jsonb, $7, $8, $9, $10, $11, $12
)
`;

async function insertJob(
  id: string,
  creditsCost: number | null,
  createdBy: string | null = USER_ID,
): Promise<void> {
  await db.query(INSERT_JOB_SQL, [
    id,
    workspaceId,
    "image_generation_jobs",
    "image_generation",
    "failed",
    JSON.stringify({ prompt: "a cat" }),
    1,
    3,
    createdBy,
    CREATED_AT,
    UPDATED_AT,
    creditsCost,
  ]);
}

async function basisTruth(jobId: string): Promise<{
  credits_cost: number | null;
  workspace_id: string;
  created_by: string | null;
} | null> {
  const rows = (
    await db.query<{
      credits_cost: number | null;
      workspace_id: string;
      created_by: string | null;
    }>(SELECT_BASIS_TRUTH_SQL, [jobId])
  ).rows;
  return rows[0] ?? null;
}

async function snapshot(jobId: string): Promise<string> {
  return firstRow(
    (await db.query<{ row_text: string }>(SELECT_JOB_SNAPSHOT_SQL, [jobId])).rows,
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

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobRefundBasisRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-refund-basis@hahart.test");
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

  // Three rows, one per legal answer of the column that decides the money.
  await insertJob(JOB_COST_10, 10);
  await insertJob(JOB_COST_0, 0);
  await insertJob(JOB_COST_NULL, null);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job refund basis read: the row PostgreSQL hands back", () => {
  it("case 1: credits_cost 10, 0 and NULL are three different rows, column by column", async () => {
    const expectations = [
      [JOB_COST_10, 10],
      [JOB_COST_0, 0],
      [JOB_COST_NULL, null],
    ] as const;

    for (const [jobId, creditsCost] of expectations) {
      const basis = await repository.readRefundBasis({ jobId });
      const truth = await basisTruth(jobId);

      expect(basis).not.toBeNull();
      expect(basis?.creditsCost).toBe(creditsCost);
      expect(basis?.workspaceId).toBe(workspaceId);
      expect(basis?.createdBy).toBe(USER_ID);
      // And against the database's own projection of the same row.
      expect(basis).toEqual({
        creditsCost: truth?.credits_cost ?? null,
        workspaceId: truth?.workspace_id,
        createdBy: truth?.created_by ?? null,
      });
    }

    // The NULL row is the one that must NOT be folded into 0: the caller's
    // `?? 0` is the single place that happens, and it happens on the caller's
    // side of the boundary.
    const nullBasis = await repository.readRefundBasis({ jobId: JOB_COST_NULL });
    expect(nullBasis?.creditsCost).toBeNull();
    expect(nullBasis?.creditsCost).not.toBe(0);
  });

  it("case 2: the basis has exactly the three promised keys, in the promised order", async () => {
    const basis = await repository.readRefundBasis({ jobId: JOB_COST_10 });

    expect(Object.keys(basis ?? {})).toEqual([
      "creditsCost",
      "workspaceId",
      "createdBy",
    ]);
    // `credits_cost` is read as a number by both drivers — not as the string a
    // `numeric` column would produce, and not as an object.
    expect(typeof basis?.creditsCost).toBe("number");
    expect(typeof basis?.workspaceId).toBe("string");
    expect(typeof basis?.createdBy).toBe("string");
  });

  it("case 3: the read does not cross rows", async () => {
    const total = await jobCount();
    const before = new Map<string, string>();
    for (const jobId of [JOB_COST_10, JOB_COST_0, JOB_COST_NULL]) {
      before.set(jobId, await snapshot(jobId));
    }

    for (const jobId of before.keys()) {
      const basis = await repository.readRefundBasis({ jobId });
      const truth = await basisTruth(jobId);

      expect(basis?.workspaceId).toBe(truth?.workspace_id);
      expect(basis?.creditsCost ?? null).toBe(truth?.credits_cost ?? null);
    }

    expect(await jobCount()).toBe(total);
  });
});

describe("job refund basis read: one row by primary key", () => {
  it("case 4: an unknown id is null, not an error", async () => {
    await expect(
      repository.readRefundBasis({ jobId: UNKNOWN_JOB }),
    ).resolves.toBeNull();
    // The table is NOT empty, so `null` here means "no such job" rather than
    // "the read returned nothing at all".
    expect(await jobCount()).toBeGreaterThan(1);
  });

  it("case 5: the read does not change the row", async () => {
    const before = new Map<string, string>();
    for (const jobId of [JOB_COST_10, JOB_COST_0, JOB_COST_NULL]) {
      before.set(jobId, await snapshot(jobId));
    }

    await Promise.all(
      [...before.keys()].map((jobId) => repository.readRefundBasis({ jobId })),
    );

    // The whole row as `::text`, before and after: no timestamp moved, no
    // counter was touched, `credits_cost` is exactly where it was. A read that
    // touched the row it is about to refund would be a defect in the money path.
    for (const [jobId, snapshotBefore] of before) {
      expect([jobId, await snapshot(jobId)]).toEqual([jobId, snapshotBefore]);
    }
  });

  it("case 6: a malformed uuid is a real SQL error, and the pool stays usable", async () => {
    const before = await jobCount();

    // Independent of the repository: the server itself rejects the bind.
    await expect(db.query(SELECT_BASIS_TRUTH_SQL, [INVALID_ID])).rejects.toThrow(
      /invalid input syntax for type uuid/,
    );

    const error = await repository
      .readRefundBasis({ jobId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobRefundBasisError);
    const basisError = error as JobRefundBasisError;
    expect(basisError.operation).toBe(READ_REFUND_BASIS);
    // The fixed message carries no SQL, no host, no job id and no amount; the
    // cause is the PostgreSQL parse failure. The worker LOGS this message, and
    // the cause is what a reader may classify.
    expect(basisError.message).toBe(
      `job refund basis read failed (${READ_REFUND_BASIS})`,
    );
    expect(basisError.message).not.toMatch(
      /public\.|background_jobs|credits_cost|invalid input|postgres:\/\//i,
    );
    expect((basisError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    expect(await jobCount()).toBe(before);

    // The failed transaction rolled back, so the very same pool answers.
    const basis = await repository.readRefundBasis({ jobId: JOB_COST_10 });
    expect(basis?.creditsCost).toBe(10);
  });

  it("case 7: created_by is NOT NULL in this schema, so the historic-NULL row is pinned elsewhere", async () => {
    const columns = (
      await db.query<ColumnRow>(
        `select column_name, is_nullable, data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'background_jobs'
            and column_name in ('credits_cost', 'workspace_id', 'created_by')`,
      )
    ).rows;
    const byName = new Map(columns.map((row) => [row.column_name, row]));

    // The two nullable columns this workorder reads, and the one that is not.
    expect(byName.get("credits_cost")?.is_nullable).toBe("YES");
    expect(byName.get("credits_cost")?.data_type).toBe("integer");
    expect(byName.get("created_by")?.is_nullable).toBe("NO");
    expect(byName.get("workspace_id")?.is_nullable).toBe("NO");

    // Measured, not assumed: the database refuses the row itself.
    const count = await jobCount();
    await expect(insertJob(JOB_NOT_NULL_PROBE, 10, null)).rejects.toThrow(
      /null value in column "created_by"/,
    );
    expect(await jobCount()).toBe(count);

    // Consequence, stated so it cannot be mistaken for an untested path: the
    // "NULL creator reads as null and is NOT refunded" contract is pinned by
    // `job-refund-basis-repository.test.ts` (explicit SQL NULL from the driver
    // becomes `createdBy: null`) and by `refund-job.test.ts` (the
    // `createdBy === null` branch calls `refundCredits` zero times). This
    // assertion is what makes that a documented fact rather than an omission:
    // if a future migration relaxes the column, this case fails and the PGlite
    // row can be added.
    expect(byName.get("created_by")?.is_nullable).toBe("NO");
  });

  it("case 8: the read's transaction context is privileged, empty, and does not leak", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction the statement ran in, not a reconstruction. (The NUMBER of
    // `set_config` statements is deliberately not pinned — that is
    // `transaction.ts`'s contract.)
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

    const observing = createJobRefundBasisRepository({
      getTransactionPool: () => observingPool,
    });

    for (const jobId of [JOB_COST_10, JOB_COST_0, JOB_COST_NULL]) {
      await expect(observing.readRefundBasis({ jobId })).resolves.not.toBeNull();
    }

    expect(observed).toHaveLength(3);
    // No forged user: this is the worker's own read, so every actor setting is
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
    const gone = firstRow(
      (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows,
    );
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

describe("job refund basis read: driven through the real refund module", () => {
  /** The refund module over the REAL repository, with a recording credits rule. */
  function buildRefund() {
    const refundCredits = vi.fn(async (_workspaceId: string, _userId: string) =>
      "tx-refund",
    );
    const log = vi.fn();
    const logError = vi.fn();
    const refundJob = createRefundJob({
      readRefundBasis: (input) => repository.readRefundBasis(input),
      creditService: { refundCredits },
      log,
      logError,
    });

    return { refundJob, refundCredits, log, logError };
  }

  it("case 9: a charged row refunds exactly once, with the verbatim arguments and log", async () => {
    const { refundJob, refundCredits, log, logError } = buildRefund();

    await expect(refundJob(JOB_COST_10, "[worker:21o]")).resolves.toBeUndefined();

    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledWith(
      workspaceId,
      USER_ID,
      10,
      JOB_COST_10,
      "Auto-refund: job failed",
    );
    // Arity pinned as well: a fifth/fourth argument added or dropped would keep
    // `toHaveBeenCalledWith` green only if it matched too.
    expect(refundCredits.mock.calls[0]).toEqual([
      workspaceId,
      USER_ID,
      10,
      JOB_COST_10,
      "Auto-refund: job failed",
    ]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `[worker:21o] Refunded 10 credits for job ${JOB_COST_10} (tx: tx-refund)`,
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it("case 10: a zero-cost row and a NULL-cost row refund nothing and log nothing", async () => {
    for (const jobId of [JOB_COST_0, JOB_COST_NULL]) {
      const { refundJob, refundCredits, log, logError } = buildRefund();

      await expect(refundJob(jobId, "[worker:21o]")).resolves.toBeUndefined();

      expect([jobId, refundCredits.mock.calls.length]).toEqual([jobId, 0]);
      expect([jobId, log.mock.calls.length]).toEqual([jobId, 0]);
      expect([jobId, logError.mock.calls.length]).toEqual([jobId, 0]);
    }
  });

  it("case 11: an unknown job id refunds nothing, logs nothing and does not reject", async () => {
    const { refundJob, refundCredits, log, logError } = buildRefund();

    await expect(refundJob(UNKNOWN_JOB, "[worker:21o]")).resolves.toBeUndefined();

    expect(refundCredits).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("case 12: a malformed job id refunds nothing, reports the read failure once, and does not reject", async () => {
    const { refundJob, refundCredits, log, logError } = buildRefund();

    await expect(refundJob(INVALID_ID, "[worker:21o]")).resolves.toBeUndefined();

    // The read now FAILS where the displaced PostgREST read answered "no row":
    // that is the one allowed difference, and it is a log line. No money moves.
    expect(refundCredits).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    const [message, error] = logError.mock.calls[0] as [string, unknown];
    expect(message).toBe(
      `[worker:21o] Failed to refund credits for job ${INVALID_ID}:`,
    );
    expect(error).toBeInstanceOf(JobRefundBasisError);
    // The logged message is the repository's fixed text: no SQL, no host, no id.
    expect((error as Error).message).toBe(
      `job refund basis read failed (${READ_REFUND_BASIS})`,
    );
  });
});
