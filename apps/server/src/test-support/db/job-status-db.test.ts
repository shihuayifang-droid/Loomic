import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createMigratedDb, createUser } from "./pglite-db.js";

/**
 * 工单31B T0: the migration COUNT is no longer pinned here. It is pinned once, in
 * the audit baseline (`sql.migrations` / `sql.migrationsActive`), and case 5 only
 * asserts that every file in the directory was applied. Same helper and same
 * shape as `rls-baseline.test.ts` — the directory is the source of truth, this
 * file must not have to change when a migration is added.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

const USER_A = "00000000-0000-0000-0000-00000000000a";

let db: PGlite;
let applied: string[] = [];
let workspaceId = "";
let jobId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  await createUser(db, USER_A, "a@hahart.test");

  workspaceId = firstRow(
    (await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [USER_A],
    )).rows,
  ).id;

  jobId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
       values ($1, 'image_generation', 'image_generation', $2) returning id`,
      [workspaceId, USER_A],
    )).rows,
  ).id;
}, 120_000);

describe("job status enum gains retrying", () => {
  it("case 1: the enum reads queued,running,retrying,succeeded,failed,canceled,dead_letter", async () => {
    const labels = firstRow(
      (await db.query<{ labels: string }>(
        `select string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
           from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'background_job_status'`,
      )).rows,
    ).labels;

    expect(labels).toBe(
      "queued,running,retrying,succeeded,failed,canceled,dead_letter",
    );
  });

  it("case 2: a job row can be moved to retrying and read back", async () => {
    const updated = await db.query<{ id: string }>(
      "update public.background_jobs set status = 'retrying' where id = $1 returning id",
      [jobId],
    );
    expect(updated.rows.length).toBe(1);

    const status = firstRow(
      (await db.query<{ status: string }>(
        "select status::text as status from public.background_jobs where id = $1",
        [jobId],
      )).rows,
    ).status;

    expect(status).toBe("retrying");
  });

  it("case 3: increment_job_attempt returns the new count for an existing job", async () => {
    const rows = (
      await db.query<{ attempt_count: number; max_attempts: number }>(
        "select * from public.increment_job_attempt($1)",
        [jobId],
      )
    ).rows;

    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ attempt_count: 1, max_attempts: 3 });
  });

  it("case 4: increment_job_attempt returns no rows for an unknown job id", async () => {
    const rows = (
      await db.query("select * from public.increment_job_attempt($1)", [randomUUID()])
    ).rows;

    expect(rows.length).toBe(0);
  });

  it("case 5: all migrations still load", () => {
    // 31B: total is pinned by the audit baseline (sql.migrations); here only "every file applied"
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    expect(applied.length).toBe(files.length);
  });
});
