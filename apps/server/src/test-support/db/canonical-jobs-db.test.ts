import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobAttemptRepository } from "../../db/job-attempt-repository.js";
import { createJobOwnerReadRepository } from "../../db/job-owner-read-repository.js";
import { createJobStuckReaderRepository } from "../../db/job-stuck-reader-repository.js";
import { createJobTransitionRepository } from "../../db/job-transition-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43R: canonical migration 0006 (background jobs + the asset source-job
 * foreign key that 0004 left open) on an empty database. No Supabase stubs: only
 * `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0006 is the final form of that chain.
 */

const USER_A = "00000000-0000-0000-0000-0000000000a1";
const USER_B = "00000000-0000-0000-0000-0000000000a2";

const JOB_FLOW = "aaaa0000-0000-4000-8000-0000000000a1";
const JOB_DUP_1 = "aaaa0000-0000-4000-8000-0000000000a2";
const JOB_DUP_2 = "aaaa0000-0000-4000-8000-0000000000a3";
const JOB_OTHER_USER = "aaaa0000-0000-4000-8000-0000000000a4";
const JOB_STUCK = "aaaa0000-0000-4000-8000-0000000000a5";
const JOB_FRESH = "aaaa0000-0000-4000-8000-0000000000a6";
const JOB_CASCADE = "aaaa0000-0000-4000-8000-0000000000a7";
const ASSET_1 = "bbbb0000-0000-4000-8000-0000000000a1";
const PROJECT_A = "cccc0000-0000-4000-8000-0000000000a1";

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0006_jobs.sql",
);

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];
let workspaceId = "";

type ColumnShape = {
  ordinal_position: number;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
};

async function columnShapes(database: PGlite): Promise<ColumnShape[]> {
  const result = await database.query<ColumnShape>(
    `select ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'background_jobs'
      order by ordinal_position`,
  );
  return result.rows;
}

/** Primary key, unique and check constraints by name and definition. */
async function constraintDefs(database: PGlite, table: string): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    `select conname || ' :: ' || pg_get_constraintdef(oid) as line
       from pg_constraint
      where conrelid = $1::regclass and contype in ('p', 'u', 'c')
      order by 1`,
    [table],
  );
  return result.rows.map((row) => row.line);
}

/** Foreign keys with the `on delete` action and target, as the catalogue spells them. */
async function foreignKeyDefs(database: PGlite, table: string): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    `select conname || ' :: ' || confdeltype::text || ' -> ' || pg_get_constraintdef(oid) as line
       from pg_constraint
      where conrelid = $1::regclass and contype = 'f'
      order by 1`,
    [table],
  );
  // Only the created_by target differs by design: auth.users -> hahart_auth.users.
  return result.rows.map((row) => row.line.replace("hahart_auth.users", "auth.users"));
}

async function indexDefs(database: PGlite, table: string): Promise<string[]> {
  const result = await database.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = $1
      order by indexname`,
    [table],
  );
  return result.rows.map((row) => row.indexdef);
}

async function enumValues(database: PGlite): Promise<string[]> {
  const result = await database.query<{ line: string }>(
    // Rank, not the raw enumsortorder: ADD VALUE ... BEFORE stores a fractional
    // sort key (2.5) in the old chain; only the label sequence is observable.
    `select t.typname || ' ' || (row_number() over (partition by t.typname order by e.enumsortorder))::text || ' ' || e.enumlabel as line
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname in ('background_job_status', 'background_job_type')
      order by t.typname, e.enumsortorder`,
  );
  return result.rows.map((row) => row.line);
}

async function triggerDefs(database: PGlite): Promise<string[]> {
  const result = await database.query<{ def: string }>(
    `select pg_get_triggerdef(oid) as def from pg_trigger
      where tgrelid = 'public.background_jobs'::regclass and not tgisinternal
      order by tgname`,
  );
  return result.rows.map((row) => row.def);
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function insertJob(input: {
  id: string;
  createdBy?: string;
  status?: string;
  clientRequestId?: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, queue_name, job_type, status, max_attempts, created_by, client_request_id)
     values ($1::uuid, $2::uuid, 'image_generation', 'image_generation',
             $3::public.background_job_status, 3, $4::uuid, $5)`,
    [
      input.id,
      workspaceId,
      input.status ?? "queued",
      input.createdBy ?? USER_A,
      input.clientRequestId ?? null,
    ],
  );
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);

  await createCanonicalUser(db, USER_A, "a@hahart.test");
  await createCanonicalUser(db, USER_B, "b@hahart.test");

  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_A],
      )
    ).rows,
  ).id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0006 jobs: schema", () => {
  it("applies 0006_jobs.sql", () => {
    expect(applied).toContain("0006_jobs.sql");
  });

  it("points created_by at hahart_auth.users and not at auth.users", async () => {
    const result = await db.query<{ target: string }>(
      `select confrelid::regclass::text as target
         from pg_constraint
        where conrelid = 'public.background_jobs'::regclass
          and conname = 'background_jobs_created_by_fkey'`,
    );
    expect(result.rows).toEqual([{ target: "hahart_auth.users" }]);
  });

  it("rejects a repeated (created_by, client_request_id) but allows the same id for another owner", async () => {
    await insertJob({ id: JOB_DUP_1, clientRequestId: "req-43r-dup-1" });
    await expect(
      insertJob({ id: JOB_DUP_2, clientRequestId: "req-43r-dup-1" }),
    ).rejects.toMatchObject({ code: "23505" });
    await insertJob({
      id: JOB_OTHER_USER,
      createdBy: USER_B,
      clientRequestId: "req-43r-dup-1",
    });
  });

  it("rejects a client_request_id outside 8..128 characters", async () => {
    await expect(
      insertJob({ id: JOB_DUP_2, clientRequestId: "short" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("updates updated_at through the trigger", async () => {
    await db.query("update public.background_jobs set updated_at = '2000-01-01T00:00:00Z' where id = $1", [
      JOB_DUP_1,
    ]);
    // The trigger overrides the explicit value on every update.
    const rows = await db.query<{ fresh: boolean }>(
      "select updated_at > '2001-01-01T00:00:00Z' as fresh from public.background_jobs where id = $1",
      [JOB_DUP_1],
    );
    expect(rows.rows).toEqual([{ fresh: true }]);
  });

  it("asset_objects.source_job_id references background_jobs and is set null when the job is deleted", async () => {
    await db.query(
      `insert into public.projects (id, workspace_id, name, slug, created_by)
       values ($1, $2, 'Jobs Project', 'jobs-project', $3)`,
      [PROJECT_A, workspaceId, USER_A],
    );
    await insertJob({ id: JOB_CASCADE });
    await db.query(
      `insert into public.asset_objects
         (id, workspace_id, project_id, bucket, object_path, created_by, source_job_id)
       values ($1, $2, $3, 'project-assets', 'jobs/43r.png', $4, $5)`,
      [ASSET_1, workspaceId, PROJECT_A, USER_A, JOB_CASCADE],
    );

    await expect(
      db.query("update public.asset_objects set source_job_id = $1 where id = $2", [
        "ffff0000-0000-4000-8000-0000000000ff",
        ASSET_1,
      ]),
    ).rejects.toMatchObject({ code: "23503" });

    await db.query("delete from public.background_jobs where id = $1", [JOB_CASCADE]);
    const asset = await db.query<{ source_job_id: string | null }>(
      "select source_job_id from public.asset_objects where id = $1",
      [ASSET_1],
    );
    expect(asset.rows).toEqual([{ source_job_id: null }]);
  });
});

describe("canonical 0006 jobs: repositories on the empty database", () => {
  it("transitions queued -> running -> succeeded, counts an attempt and reads it by owner", async () => {
    const transitions = createJobTransitionRepository({ getTransactionPool: () => pool });
    const attempts = createJobAttemptRepository({ getTransactionPool: () => pool });
    const reads = createJobOwnerReadRepository({ getTransactionPool: () => pool });

    await insertJob({ id: JOB_FLOW });

    expect(
      await transitions.markRunning({ jobId: JOB_FLOW, startedAt: "2030-01-01T00:00:00.000Z" }),
    ).toBe(true);

    const counted = await attempts.incrementAttempt({ jobId: JOB_FLOW });
    expect(counted).toEqual({ attemptCount: 1, maxAttempts: 3 });
    expect(await attempts.incrementAttempt({ jobId: "ffff0000-0000-4000-8000-0000000000fe" })).toBeNull();

    expect(
      await transitions.markSucceeded({
        jobId: JOB_FLOW,
        result: { ok: true },
        completedAt: "2030-01-01T00:01:00.000Z",
      }),
    ).toBe(true);
    // A finished job cannot be moved again.
    expect(
      await transitions.markFailed({
        jobId: JOB_FLOW,
        errorCode: "E43R",
        errorMessage: "late",
        failedAt: "2030-01-01T00:02:00.000Z",
      }),
    ).toBe(false);

    const row = await reads.readOwnJob({ actorId: USER_A, jobId: JOB_FLOW });
    expect(row).not.toBeNull();
    expect(row?.id).toBe(JOB_FLOW);
    expect(row?.status).toBe("succeeded");

    // Someone else's job is "no such job".
    expect(await reads.readOwnJob({ actorId: USER_B, jobId: JOB_FLOW })).toBeNull();

    const listed = await reads.listOwnJobs({ actorId: USER_A, status: "succeeded", jobType: null });
    expect(listed.map((job) => job.id)).toEqual([JOB_FLOW]);
  });

  it("the stuck reader finds a running job started before the threshold", async () => {
    const stuck = createJobStuckReaderRepository({ getTransactionPool: () => pool });

    await insertJob({ id: JOB_STUCK, status: "running" });
    await db.query("update public.background_jobs set started_at = now() - interval '2 hours' where id = $1", [
      JOB_STUCK,
    ]);
    await insertJob({ id: JOB_FRESH, status: "running" });
    await db.query("update public.background_jobs set started_at = now() where id = $1", [JOB_FRESH]);

    const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rows = await stuck.listRunningStartedBefore({ before, limit: 100 });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(JOB_STUCK);
    expect(ids).not.toContain(JOB_FRESH);
    expect(firstRow(rows.filter((row) => row.id === JOB_STUCK))).toMatchObject({
      jobType: "image_generation",
      maxAttempts: 3,
    });
  });
});

describe("canonical 0006 jobs: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  it("has the same background_jobs columns (position, name, type, nullability, default)", async () => {
    const oldShapes = await columnShapes(oldDb);
    expect(oldShapes.length).toBeGreaterThan(0);
    expect(await columnShapes(db)).toEqual(oldShapes);
  });

  it("has the same background_jobs primary key, unique and check constraints", async () => {
    const oldDefs = await constraintDefs(oldDb, "public.background_jobs");
    expect(oldDefs.length).toBeGreaterThan(0);
    expect(await constraintDefs(db, "public.background_jobs")).toEqual(oldDefs);
  });

  it("has the same background_jobs foreign keys and on delete actions", async () => {
    const oldDefs = await foreignKeyDefs(oldDb, "public.background_jobs");
    expect(oldDefs.length).toBeGreaterThan(0);
    expect(await foreignKeyDefs(db, "public.background_jobs")).toEqual(oldDefs);
  });

  it("has the same background_jobs indexes and updated_at trigger", async () => {
    const oldIndexes = await indexDefs(oldDb, "background_jobs");
    expect(oldIndexes.length).toBeGreaterThan(0);
    expect(await indexDefs(db, "background_jobs")).toEqual(oldIndexes);

    const oldTriggers = await triggerDefs(oldDb);
    expect(oldTriggers.length).toBeGreaterThan(0);
    expect(await triggerDefs(db)).toEqual(oldTriggers);
  });

  it("has the same enum values in the same order", async () => {
    const oldValues = await enumValues(oldDb);
    expect(oldValues.length).toBeGreaterThan(0);
    expect(await enumValues(db)).toEqual(oldValues);
  });

  it("has the same asset_objects foreign keys, constraints and indexes now that the job key exists", async () => {
    const oldForeign = await foreignKeyDefs(oldDb, "public.asset_objects");
    expect(oldForeign.some((line) => line.includes("background_jobs"))).toBe(true);
    expect(await foreignKeyDefs(db, "public.asset_objects")).toEqual(oldForeign);

    expect(await constraintDefs(db, "public.asset_objects")).toEqual(
      await constraintDefs(oldDb, "public.asset_objects"),
    );
    expect(await indexDefs(db, "asset_objects")).toEqual(await indexDefs(oldDb, "asset_objects"));
  });
});

describe("canonical 0006 jobs: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const lower = sql.toLowerCase();

  it("is at most 400 lines", () => {
    expect(sql.split("\n").length).toBeLessThanOrEqual(400);
  });

  it("carries no Supabase-only constructs", () => {
    const withoutOwnSchema = lower.replaceAll("hahart_auth.", "");
    for (const banned of [
      "auth.",
      "storage.",
      "pgmq",
      "auth.uid",
      "row level security",
      "create policy",
      "grant ",
      "anon",
      "authenticated",
      "service_role",
    ]) {
      expect(withoutOwnSchema.includes(banned), banned).toBe(false);
    }
  });
});
