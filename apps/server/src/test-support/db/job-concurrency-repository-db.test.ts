import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COUNT_ACTIVE_JOBS,
  JobConcurrencyError,
  createJobConcurrencyRepository,
  type JobConcurrencyRepository,
} from "../../db/job-concurrency-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the job concurrency counter (workorder 21J).
 *
 * The unit tests beside the repository prove WHICH statement is built — one
 * SELECT, one table, one bind parameter, the three statuses written into the
 * statement text, no status parameter. This file proves PostgreSQL actually
 * parses and executes that statement against the real
 * `public.background_job_status` enum column, and that the plan rule's facts are
 * facts of the database rather than of this process:
 *
 *   - the same workspace holding one row of each of the six enum statuses plus a
 *     legacy `dead_letter` row counts 3, not 7: `queued`, `running` and
 *     `retrying` hold a slot, `succeeded`, `failed`, `canceled` and `dead_letter`
 *     do not;
 *   - another workspace's rows are not counted, and a workspace with no jobs is 0
 *     rather than an error;
 *   - the answer is a JavaScript number, which the `::int` cast is what makes
 *     possible: the uncast `count(*)` is `bigint` in the database itself;
 *   - a malformed uuid is a real SQL error that rolls back and leaves the same
 *     pool usable, and counting never moves a row;
 *   - the transaction-local context of the count does not survive COMMIT;
 *   - moving a row between statuses moves the count, one status at a time.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the workspaces come from the real signup trigger, and `afterAll`
 * closes it.
 */

const USER_A = "00000000-0000-0000-0000-0000000a1001";
const USER_B = "00000000-0000-0000-0000-0000000a1002";
const USER_C = "00000000-0000-0000-0000-0000000a1003";
const USER_D = "00000000-0000-0000-0000-0000000a1004";

/** Job ids, one per status, so a case can name the row it is talking about. */
const JOB_QUEUED = "00000000-0000-0000-0000-0000000a1a01";
const JOB_RUNNING = "00000000-0000-0000-0000-0000000a1a02";
const JOB_RETRYING = "00000000-0000-0000-0000-0000000a1a03";
const JOB_SUCCEEDED = "00000000-0000-0000-0000-0000000a1a04";
const JOB_FAILED = "00000000-0000-0000-0000-0000000a1a05";
const JOB_CANCELED = "00000000-0000-0000-0000-0000000a1a06";
const JOB_DEAD_LETTER = "00000000-0000-0000-0000-0000000a1a07";

const JOB_OTHER_QUEUED = "00000000-0000-0000-0000-0000000a1b01";
const JOB_OTHER_RUNNING = "00000000-0000-0000-0000-0000000a1b02";
const JOB_OTHER_SUCCEEDED = "00000000-0000-0000-0000-0000000a1b03";

const JOB_DYNAMIC_1 = "00000000-0000-0000-0000-0000000a1d01";
const JOB_DYNAMIC_2 = "00000000-0000-0000-0000-0000000a1d02";

/** The six values of `public.background_job_status` that a job can be created in. */
const STATUS_ROWS = [
  [JOB_QUEUED, "queued"],
  [JOB_RUNNING, "running"],
  [JOB_RETRYING, "retrying"],
  [JOB_SUCCEEDED, "succeeded"],
  [JOB_FAILED, "failed"],
  [JOB_CANCELED, "canceled"],
] as const;

/** The statuses that hold a concurrency slot, named independently of the module. */
const ACTIVE_STATUSES = ["queued", "running", "retrying"] as const;

/** The statuses that hold no slot. `dead_letter` is the legacy terminal one. */
const INACTIVE_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
] as const;

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_WORKSPACE = "not-a-uuid";

/** A well-formed uuid that names no workspace at all. */
const UNKNOWN_WORKSPACE = "00000000-0000-0000-0000-0000000a10ff";

/** The workspace the last describe group moves rows through. */
let dynamicWorkspaceId = "";

/** A workspace that exists on purpose and holds no job at all. */
let emptyWorkspaceId = "";

/**
 * Insert through the real column list the test cares about: the workspace, the
 * enum status and the creator. Everything else is left to the table's own
 * defaults, so the count is decided by the status column and nothing else.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, queue_name, job_type, status, created_by
) values (
  $1, $2, 'job_concurrency_jobs',
  'image_generation'::public.background_job_type,
  $3::public.background_job_status, $4
)
`;

const COUNT_BY_STATUS_SQL = `
select status::text as status, count(*)::int as n
from public.background_jobs
where workspace_id = $1::uuid
group by status
`;

const COUNT_ALL_SQL = `
select count(*)::int as n from public.background_jobs
`;

/** The whole row as one comparable value, for "nothing moved" assertions. */
const SNAPSHOT_SQL = `
select j::text as row_text
from public.background_jobs as j
where j.workspace_id = $1::uuid
order by j.id
`;

/**
 * The independent proof that the cast in the statement is load-bearing: the
 * database's OWN type for `count(*)` is `bigint`, and `pg` hands `bigint` back
 * as a string (PGlite parses it to a number while it fits a safe integer, so
 * this fact cannot be observed through the driver's return value here).
 */
const COUNT_TYPES_SQL = `
select
  pg_typeof(count(*))::text as uncast_type,
  pg_typeof(count(*)::int)::text as cast_type
from public.background_jobs
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

type StatusCountRow = { status: string; n: number };

let db: PGlite;
let pool: TransactionPool;
let repository: JobConcurrencyRepository;
let workspaceA = "";
let workspaceB = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function insertJob(
  id: string,
  workspaceId: string,
  status: string,
  createdBy: string,
): Promise<void> {
  await db.query(INSERT_JOB_SQL, [id, workspaceId, status, createdBy]);
}

/** The database's own answer, per status: the second opinion this suite compares against. */
async function countsByStatus(
  workspaceId: string,
): Promise<Map<string, number>> {
  const rows = (
    await db.query<StatusCountRow>(COUNT_BY_STATUS_SQL, [workspaceId])
  ).rows;

  return new Map(rows.map((row) => [row.status, row.n]));
}

/** Rows holding a slot, summed from the per-status breakdown, not from the SQL under test. */
async function truthActiveCount(workspaceId: string): Promise<number> {
  const byStatus = await countsByStatus(workspaceId);

  return ACTIVE_STATUSES.reduce(
    (total, status) => total + (byStatus.get(status) ?? 0),
    0,
  );
}

async function jobCount(): Promise<number> {
  return firstRow((await db.query<{ n: number }>(COUNT_ALL_SQL)).rows).n;
}

async function snapshot(workspaceId: string): Promise<string[]> {
  return (await db.query<{ row_text: string }>(SNAPSHOT_SQL, [workspaceId])).rows.map(
    (row) => row.row_text,
  );
}

async function personalWorkspace(userId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `select id
           from public.workspaces
          where owner_user_id = $1
            and type = 'personal'`,
        [userId],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobConcurrencyRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds each profile and its personal workspace.
  await createUser(db, USER_A, "job-concurrency-a@hahart.test");
  await createUser(db, USER_B, "job-concurrency-b@hahart.test");
  await createUser(db, USER_C, "job-concurrency-c@hahart.test");
  await createUser(db, USER_D, "job-concurrency-d@hahart.test");

  workspaceA = await personalWorkspace(USER_A);
  workspaceB = await personalWorkspace(USER_B);
  dynamicWorkspaceId = await personalWorkspace(USER_D);

  // The workspace that must count zero while the table is demonstrably not empty.
  emptyWorkspaceId = await personalWorkspace(USER_C);

  // Workspace A: one row per enum status, plus the legacy terminal `dead_letter`
  // row. Three of the seven hold a slot.
  for (const [jobId, status] of STATUS_ROWS) {
    await insertJob(jobId, workspaceA, status, USER_A);
  }
  await insertJob(JOB_DEAD_LETTER, workspaceA, "dead_letter", USER_A);

  // Workspace B: two rows that hold a slot and one that does not, so "another
  // workspace is counted on its own" and "this workspace's totals do not leak"
  // are both measurable.
  await insertJob(JOB_OTHER_QUEUED, workspaceB, "queued", USER_B);
  await insertJob(JOB_OTHER_RUNNING, workspaceB, "running", USER_B);
  await insertJob(JOB_OTHER_SUCCEEDED, workspaceB, "succeeded", USER_B);

  // Workspace D (the dynamic one) starts empty on purpose; the last describe
  // group moves rows through it.
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("job concurrency count: which statuses PostgreSQL counts", () => {
  it("case 1: the fixture really holds one row per status, and the table is shared", async () => {
    const byStatus = await countsByStatus(workspaceA);

    for (const [jobId, status] of STATUS_ROWS) {
      // Every row is present, under the status it was inserted with...
      expect([jobId, byStatus.get(status)]).toEqual([jobId, 1]);
    }
    // ...including the legacy terminal one.
    expect(byStatus.get("dead_letter")).toBe(1);
    expect([...byStatus.keys()].sort()).toEqual(
      [...ACTIVE_STATUSES, ...INACTIVE_STATUSES].sort(),
    );
    // Seven rows in A, three in B, and the table as a whole is bigger than both.
    expect(
      await firstRow(
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from public.background_jobs where workspace_id = $1::uuid",
            [workspaceA],
          )
        ).rows,
      ).n,
    ).toBe(7);
    expect(await jobCount()).toBe(10);
  });

  it("case 2: a workspace with all seven statuses counts 3, and dead_letter is not one of them", async () => {
    const counted = await repository.countActiveJobs({
      workspaceId: workspaceA,
    });

    expect(counted).toBe(3);
    // The same number, summed from the per-status breakdown rather than from the
    // statement under test: three of the seven rows hold a slot.
    expect(counted).toBe(await truthActiveCount(workspaceA));
    // The `dead_letter` row is really there and really contributes nothing.
    const byStatus = await countsByStatus(workspaceA);
    expect(byStatus.get("dead_letter")).toBe(1);
    expect(counted).toBeLessThan(7);
  });

  it("case 3: each inactive status contributes exactly zero", async () => {
    const baseline = await repository.countActiveJobs({ workspaceId: workspaceA });
    const before = await db.query<{ n: number }>(COUNT_ALL_SQL);

    for (const status of INACTIVE_STATUSES) {
      // Remove the half of the argument that could be wrong: the row exists, and
      // the count does not move because of it. Measured by inserting a SECOND row
      // with that status and requiring the answer to stay put.
      const probeId = `00000000-0000-0000-0000-0000000a1cc${INACTIVE_STATUSES.indexOf(status)}`;
      await insertJob(probeId, workspaceA, status, USER_A);

      const after = await repository.countActiveJobs({ workspaceId: workspaceA });

      expect([status, after]).toEqual([status, baseline]);

      await db.query("delete from public.background_jobs where id = $1::uuid", [
        probeId,
      ]);
    }

    // The probes were really written and really removed: the fixture is back.
    const afterCleanup = await repository.countActiveJobs({
      workspaceId: workspaceA,
    });
    expect(afterCleanup).toBe(baseline);
    expect((await db.query<{ n: number }>(COUNT_ALL_SQL)).rows[0]?.n).toBe(
      before.rows[0]?.n,
    );
  });

  it("case 4: another workspace's rows are not counted", async () => {
    const countedA = await repository.countActiveJobs({ workspaceId: workspaceA });
    const countedB = await repository.countActiveJobs({ workspaceId: workspaceB });

    // B holds two rows that hold a slot and one that does not.
    expect(countedB).toBe(2);
    expect(countedB).toBe(await truthActiveCount(workspaceB));
    // A is unchanged by B's rows, and neither count is the table-wide number.
    expect(countedA).toBe(3);
    expect(countedA + countedB).toBeLessThan(await jobCount());
    expect(countedA).not.toBe(await truthActiveCount(workspaceB));
  });

  it("case 5: an empty workspace counts 0, not an error", async () => {
    const counted = await repository.countActiveJobs({
      workspaceId: emptyWorkspaceId,
    });

    expect(counted).toBe(0);
    // Zero here means "this workspace has no active job", not "the table is
    // empty": other workspaces demonstrably hold rows.
    expect(await jobCount()).toBeGreaterThan(0);
  });

  it("case 6: a workspace id that names no row counts 0", async () => {
    // `count(*)` answers one row for a workspace that does not exist too. The
    // plan rule wants "this workspace is under its limit", not a 404.
    await expect(
      repository.countActiveJobs({ workspaceId: UNKNOWN_WORKSPACE }),
    ).resolves.toBe(0);
  });
});

describe("job concurrency count: the answer is a JavaScript number", () => {
  it("case 7: the count is a number, and the cast is what makes it one", async () => {
    const counted = await repository.countActiveJobs({ workspaceId: workspaceA });

    expect(typeof counted).toBe("number");
    expect(Number.isInteger(counted)).toBe(true);
    expect(counted).toBe(3);

    // The database's own answer, independent of the repository: `count(*)` is
    // `bigint`, which `pg` hands back as a string, and `count(*)::int` is
    // `integer`, which it hands back as a number. This is the fact the cast in
    // the statement exists for — stated at the type level, because PGlite parses
    // a small `bigint` to a number and would hide it in the return value.
    const types = firstRow(
      (await db.query<{ uncast_type: string; cast_type: string }>(COUNT_TYPES_SQL))
        .rows,
    );
    expect(types).toEqual({ uncast_type: "bigint", cast_type: "integer" });
  });

  it("case 8: zero is a number too, not the string \"0\"", async () => {
    const counted = await repository.countActiveJobs({
      workspaceId: emptyWorkspaceId,
    });

    expect(typeof counted).toBe("number");
    expect(counted).toBe(0);
    expect(counted === 0).toBe(true);
  });
});

describe("job concurrency count: it rolls back, leaves nothing behind, moves nothing", () => {
  it("case 9: a malformed uuid is a real SQL error, and the pool stays usable", async () => {
    const before = await jobCount();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query(COUNT_BY_STATUS_SQL, [INVALID_WORKSPACE]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await repository
      .countActiveJobs({ workspaceId: INVALID_WORKSPACE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(JobConcurrencyError);
    const countError = error as JobConcurrencyError;
    expect(countError.operation).toBe(COUNT_ACTIVE_JOBS);
    // The fixed message carries no SQL, no host and no workspace id; the cause is
    // the PostgreSQL parse failure. This matters because `TierGuard` logs this
    // failure class.
    expect(countError.message).toBe(
      `job concurrency count failed (${COUNT_ACTIVE_JOBS})`,
    );
    expect(countError.message).not.toMatch(
      /public\.|background_jobs|invalid input|postgres:\/\//i,
    );
    expect((countError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    expect(await jobCount()).toBe(before);

    // The failed transaction rolled back, so the very same pool answers.
    await expect(
      repository.countActiveJobs({ workspaceId: workspaceA }),
    ).resolves.toBe(3);
  });

  it("case 10: counting does not change a single row", async () => {
    const snapshotsA = await snapshot(workspaceA);
    const snapshotsB = await snapshot(workspaceB);
    expect(snapshotsA).toHaveLength(7);
    expect(snapshotsB).toHaveLength(3);

    await Promise.all([
      repository.countActiveJobs({ workspaceId: workspaceA }),
      repository.countActiveJobs({ workspaceId: workspaceB }),
      repository.countActiveJobs({ workspaceId: emptyWorkspaceId }),
    ]);

    // The whole row as `::text`, before and after: no status moved, no timestamp
    // was touched, no counter was rewritten by the count.
    expect(await snapshot(workspaceA)).toEqual(snapshotsA);
    expect(await snapshot(workspaceB)).toEqual(snapshotsB);
  });

  it("case 11: the count's transaction context is privileged, empty, and does not leak", async () => {
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

    const observing = createJobConcurrencyRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.countActiveJobs({ workspaceId: workspaceA }),
    ).resolves.toBe(3);
    await expect(
      observing.countActiveJobs({ workspaceId: workspaceB }),
    ).resolves.toBe(2);

    expect(observed).toHaveLength(2);
    // No forged user: this is the server's own count, so every actor setting is
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
    // context of this count cannot become the context of the next statement.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});

describe("job concurrency count: moving a row between statuses moves the count", () => {
  it("case 12: a slot is taken when a job starts holding one, and released when it stops", async () => {
    const count = () =>
      repository.countActiveJobs({ workspaceId: dynamicWorkspaceId });

    expect(await count()).toBe(0);

    await insertJob(JOB_DYNAMIC_1, dynamicWorkspaceId, "queued", USER_D);
    expect(await count()).toBe(1);

    await insertJob(JOB_DYNAMIC_2, dynamicWorkspaceId, "retrying", USER_D);
    expect(await count()).toBe(2);
    expect(await count()).toBe(await truthActiveCount(dynamicWorkspaceId));

    // A retry that finally succeeded releases the slot it held.
    await db.query(
      `update public.background_jobs
          set status = 'succeeded'::public.background_job_status
        where id = $1::uuid`,
      [JOB_DYNAMIC_2],
    );
    expect(await count()).toBe(1);

    // And the legacy terminal status releases the last one.
    await db.query(
      `update public.background_jobs
          set status = 'dead_letter'::public.background_job_status
        where id = $1::uuid`,
      [JOB_DYNAMIC_1],
    );
    expect(await count()).toBe(0);

    // The rows are still there: they left the count, they were not deleted.
    const byStatus = await countsByStatus(dynamicWorkspaceId);
    expect(byStatus.get("succeeded")).toBe(1);
    expect(byStatus.get("dead_letter")).toBe(1);
    expect(byStatus.size).toBe(2);
  });
});
