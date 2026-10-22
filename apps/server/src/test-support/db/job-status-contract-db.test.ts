import type { PGlite } from "@electric-sql/pglite";
import { backgroundJobStatusSchema } from "@loomic/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createJobAdminReadRepository,
  type JobAdminReadRepository,
} from "../../db/job-admin-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import type { PgmqClient } from "../../queue/pgmq-client.js";
import { createJobService, type JobService } from "../../features/jobs/job-service.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * GN-02 (acceptance 1) / GN-30: the status contract, measured against the real
 * database and the real service.
 *
 * GN-30 fixes the statuses a client may ever see: `queued / running / retrying /
 * succeeded / failed / canceled`. The database enum additionally carries the
 * legacy `dead_letter`, which no client may ever see — such a row is read as
 * `failed`.
 *
 * Three separate facts are pinned here, so that adding a value to the database
 * enum and forgetting the mapping turns a test red instead of leaking a value:
 *
 *   1. the database enum is EXACTLY the six GN-30 states plus `dead_letter`
 *      (a new value added to the migration fails this case);
 *   2. every value stored in that enum reads back through the real
 *      `JobService.getJobAdmin` as one of the six GN-30 states, with
 *      `dead_letter` read as `failed` and every other value unchanged (a value
 *      added to the enum without a mapping fails this case, and so does a
 *      mapping that renames a public value);
 *   3. the shared `backgroundJobStatusSchema` accepts exactly those six values
 *      as public ones, with `dead_letter` the only extra value it tolerates.
 *
 * Every status name below is a literal (E-018): a table-driven case whose
 * expectations are derived from the code under test could not detect a renamed
 * or added status at all.
 *
 * The database is PGlite — in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`. One instance is migrated in `beforeAll`, the fixture is built
 * through the real signup trigger, and `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-0000000021b0";

/** One row per database enum value; ids are literals so a failure names the row. */
const JOB_IDS: Record<string, string> = {
  queued: "00000000-0000-0000-0000-0000000021b1",
  running: "00000000-0000-0000-0000-0000000021b2",
  retrying: "00000000-0000-0000-0000-0000000021b3",
  succeeded: "00000000-0000-0000-0000-0000000021b4",
  failed: "00000000-0000-0000-0000-0000000021b5",
  canceled: "00000000-0000-0000-0000-0000000021b6",
  dead_letter: "00000000-0000-0000-0000-0000000021b7",
};

/** GN-30 verbatim: the states a client may see, in the order the requirement lists them. */
const GN30_PUBLIC_STATES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "canceled",
] as const;

/** The database enum, as it is documented to be: the six above plus the legacy value. */
const DB_ENUM_VALUES = [
  "canceled",
  "dead_letter",
  "failed",
  "queued",
  "retrying",
  "running",
  "succeeded",
] as const;

const CREATED_AT = "2026-03-04T05:06:07.891Z";
const UPDATED_AT = "2026-03-04T05:07:08.892Z";

/** The enum as PostgreSQL itself renders it — not a list restated by this file. */
const SELECT_ENUM_SQL = `
select unnest(enum_range(null::public.background_job_status))::text as value
`;

/**
 * Insert one row with every column named, so nothing depends on a table default
 * and the only variable between rows is `status`.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, error_code, error_message,
  attempt_count, max_attempts, created_by,
  created_at, updated_at, started_at, completed_at, failed_at, canceled_at
) values (
  $1, $2, null, null, null, null,
  $3, $4::public.background_job_type, $5::public.background_job_status,
  $6::jsonb, null, null, null,
  0, 3, $7,
  $8, $9, null, null, null, null
)
`;

let db: PGlite;
let pool: TransactionPool;
let repository: JobAdminReadRepository;
let workspaceId = "";
/** The enum values the database reported in `beforeAll`; the fixture inserts one row per value. */
let enumValues: string[] = [];

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function insertJob(status: string): Promise<void> {
  const id = JOB_IDS[status];
  if (id === undefined) throw new Error(`no fixture id for status ${status}`);

  await db.query(INSERT_JOB_SQL, [
    id,
    workspaceId,
    "image_generation_jobs",
    "image_generation",
    status,
    "{}",
    USER_ID,
    CREATED_AT,
    UPDATED_AT,
  ]);
}

/**
 * The service under test: the REAL repository over the PGlite pool, with an
 * admin client that throws. The status a caller sees must therefore come from
 * the repository read plus `mapJobRow`, never from PostgREST.
 */
function buildService(): JobService {
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
    jobAdminReadRepository: repository,
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createJobAdminReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "job-status-contract@hahart.test");
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

  enumValues = (
    await db.query<{ value: string }>(SELECT_ENUM_SQL)
  ).rows.map((row) => row.value);

  // One row per enum value the database actually has, so the fixture cannot
  // silently fall behind a value added to the migration.
  for (const status of enumValues) {
    await insertJob(status);
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("GN-02 contract: the database status enum", () => {
  it("GN-02: the database status enum is exactly the GN-30 states plus the legacy dead_letter", async () => {
    const rows = (await db.query<{ value: string }>(SELECT_ENUM_SQL)).rows;
    const values = rows.map((row) => row.value).sort();

    // The whole enum, compared as a SET (sorted): a value added to the
    // migration, removed from it, or renamed shows up here as a difference.
    expect(values).toEqual([...DB_ENUM_VALUES]);
    expect(values).toHaveLength(7);

    // Named one by one too, so a failure says which value is wrong.
    expect(values).toContain("queued");
    expect(values).toContain("running");
    expect(values).toContain("retrying");
    expect(values).toContain("succeeded");
    expect(values).toContain("failed");
    expect(values).toContain("canceled");
    expect(values).toContain("dead_letter");

    // Every GN-30 state really is a value of the enum — the six are not merely
    // implied by "7 values, one of which is dead_letter".
    for (const state of GN30_PUBLIC_STATES) {
      expect(values).toContain(state);
    }
  });
});

describe("GN-02 contract: every stored status through the real JobService", () => {
  it("GN-02: every stored status reads as a GN-30 state through the job service", async () => {
    const service = buildService();

    // The fixture covers the enum the database reported, not a list this file
    // keeps in its own head.
    expect([...enumValues].sort()).toEqual([...DB_ENUM_VALUES]);

    const readStatuses: string[] = [];
    const publicByStored = new Map<string, string>();

    for (const stored of [...DB_ENUM_VALUES]) {
      const jobId = JOB_IDS[stored];
      if (jobId === undefined) throw new Error(`no fixture id for ${stored}`);

      const job = await service.getJobAdmin(jobId);
      readStatuses.push(job.status);
      publicByStored.set(stored, job.status);

      // 1. The caller only ever sees one of the six GN-30 states.
      expect(GN30_PUBLIC_STATES as readonly string[]).toContain(job.status);

      // 2. `dead_letter` is read as `failed`; every other stored value reads
      //    back unchanged. Both halves are literal per value (E-018), not
      //    computed from a mapping table that could drift with the code.
      const expectedPublic = stored === "dead_letter" ? "failed" : stored;
      expect([stored, job.status]).toEqual([stored, expectedPublic]);
    }

    // Named per value, independent of the loop above.
    expect(publicByStored.get("queued")).toBe("queued");
    expect(publicByStored.get("running")).toBe("running");
    expect(publicByStored.get("retrying")).toBe("retrying");
    expect(publicByStored.get("succeeded")).toBe("succeeded");
    expect(publicByStored.get("failed")).toBe("failed");
    expect(publicByStored.get("canceled")).toBe("canceled");
    expect(publicByStored.get("dead_letter")).toBe("failed");
    expect(publicByStored.size).toBe(7);

    // 3. Taken together, the rows cover ALL six GN-30 states: a mapping that
    //    collapsed two values into one, or never produced a state, is visible.
    expect([...readStatuses].sort()).toEqual([
      "canceled",
      "failed",
      "failed",
      "queued",
      "retrying",
      "running",
      "succeeded",
    ]);
    expect([...new Set(readStatuses)].sort()).toEqual([...GN30_PUBLIC_STATES].sort());
  });
});

describe("GN-02 contract: the shared public status schema", () => {
  it("GN-02: the shared schema accepts exactly the GN-30 states as public values", () => {
    // Every GN-30 state parses, and parses to ITSELF — no coercion, no
    // normalising alias.
    const parsed = GN30_PUBLIC_STATES.map((state) =>
      backgroundJobStatusSchema.parse(state),
    );
    expect(parsed).toEqual([...GN30_PUBLIC_STATES]);

    // The schema's own options, with the one legacy value removed, are the six
    // GN-30 states — so the two lists cannot drift apart.
    const publicOptions = backgroundJobStatusSchema.options.filter(
      (option) => option !== "dead_letter",
    );
    expect([...publicOptions]).toEqual([...GN30_PUBLIC_STATES]);
    expect([...publicOptions].sort()).toEqual([...GN30_PUBLIC_STATES].sort());

    // And `dead_letter` is the ONLY extra value the shared schema tolerates:
    // it is there so historical rows still parse, not so it can be published.
    const extra = backgroundJobStatusSchema.options.filter(
      (option) => !(GN30_PUBLIC_STATES as readonly string[]).includes(option),
    );
    expect([...extra]).toEqual(["dead_letter"]);

    // A value that is not in the enum at all is refused, so the schema is not
    // accepting arbitrary strings.
    expect(backgroundJobStatusSchema.safeParse("dead-letter").success).toBe(false);
    expect(backgroundJobStatusSchema.safeParse("cancelled").success).toBe(false);
    expect(backgroundJobStatusSchema.safeParse("").success).toBe(false);
  });
});
