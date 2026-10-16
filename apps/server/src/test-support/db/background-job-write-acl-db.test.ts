import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * Real-SQL baseline for the BACKGROUND JOB WRITE path (workorder 21H0).
 *
 * The job write path (create / cancel / queue compensation) is still served by
 * the PostgREST statements in `features/jobs/job-service.ts`; it is NOT yet a
 * `pg` repository. Before it can be moved, the behaviour it relies on has to be
 * pinned as facts a later workorder cannot quietly redefine. This file is that
 * baseline and NOTHING else: no production code, no SQL, no migration, no
 * policy and no repository is added or changed, so the counters published by
 * `scripts/audit-supabase-dependencies.mjs` must stay identical.
 *
 * Every statement below is the production statement shape mirrored verbatim as
 * SQL and run against the full migration chain loaded by `createMigratedDb()`.
 * Nothing is mocked: where the answer matters, PostgreSQL decides and the case
 * asserts what it actually answered.
 *
 * Identities are chosen to match the client the production code would use:
 *
 *   - `asUser(...)` = the CALLER's client (`createUserClient`), so RLS applies:
 *     createJob's authorization reads, its insert, the compensation delete and
 *     cancelJob all run through it;
 *   - `asPrivileged(...)` = `service_role`, i.e. the ADMIN client
 *     (`getAdminClient`) the worker's guarded status transitions use. RLS is
 *     bypassed there on purpose, which is exactly why the `status in (...)`
 *     guard has to be pinned: it is the ONLY protection on that path.
 *
 * Two shapes of "denied" exist and they are NOT the same thing:
 *
 *   - an INSERT refused by a WITH CHECK raises SQLSTATE 42501;
 *   - an UPDATE or DELETE filtered out by its USING clause is NOT an error at
 *     all: it reports zero affected rows and the row survives untouched. Those
 *     cases assert the row count and the stored row instead of pretending an
 *     error was raised.
 *
 * The two facts worth stating up front, because most cases below measure them:
 *
 *   1. the caller-facing policy is still the 2026-03 one and it reads
 *      `created_by` ONLY - the 2026-09 team-workspace migration rewrote
 *      projects, canvases, chat and workspace_settings but deliberately left
 *      `background_jobs` alone. Workspace membership is therefore NOT a gate,
 *      and neither is ownership of the referenced project/canvas;
 *   2. `credit_transactions.job_id` references `background_jobs(id)` with NO
 *      ON DELETE action, so the compensation delete in createJob cannot remove
 *      a job that already carries a charge.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** The migration that creates the table, its defaults and its two policies. */
const JOB_TABLE_MIGRATION = "20260325200000_background_jobs.sql";
/** The migration whose FK makes a charged job undeletable. */
const CREDITS_MIGRATION = "20260331200000_credits_system.sql";
/** The later policy rewrite that deliberately does NOT touch background_jobs. */
const TEAM_RLS_MIGRATION = "20260929000001_hahart_team_workspace_private_rls.sql";

const OWNER_ID = "00000000-0000-0000-0000-00000000a001";
const OTHER_ID = "00000000-0000-0000-0000-00000000b001";
const STRANGER_ID = "00000000-0000-0000-0000-00000000c001";

const TEAM_NAME = "Background Job Write Team";

const PROJECT_OWNER = "a1010000-0000-4000-8000-000000000001";
const PROJECT_OWNER_ALT = "a1010000-0000-4000-8000-000000000002";
const PROJECT_OTHER = "a1010000-0000-4000-8000-000000000003";

const CANVAS_OWNER = "b1010000-0000-4000-8000-000000000001";
const CANVAS_OWNER_ALT = "b1010000-0000-4000-8000-000000000002";
const CANVAS_OTHER = "b1010000-0000-4000-8000-000000000003";

const MISSING_UUID = "f1010000-0000-4000-8000-00000000000f";
const MISSING_UUID_2 = "f1010000-0000-4000-8000-00000000000e";

const IMAGE_QUEUE = "image_generation_jobs";

/**
 * The createJob insert, column for column: `project_id` arrives already
 * resolved by the service (from the canvas, or from its own project read),
 * `session_id` is written as null when the caller passed none, and `status`,
 * `attempt_count` and `max_attempts` are left to the table's defaults.
 */
const INSERT_JOB = `insert into public.background_jobs
    (workspace_id, project_id, canvas_id, session_id, thread_id, queue_name,
     job_type, payload, created_by)
  values ($1, $2, $3, null, $4, $5, $6::public.background_job_type,
          $7::jsonb, $8)
  returning id, status::text as status, attempt_count, max_attempts`;

/** The cancelJob statement: guarded by its WHERE, and it writes two columns. */
const CANCEL_JOB = `update public.background_jobs
   set status = 'canceled', canceled_at = $2::timestamptz
 where id = $1 and status in ('queued', 'running')`;

/** The compensation delete: by id alone, with no status and no owner predicate. */
const DELETE_JOB = "delete from public.background_jobs where id = $1";

/** markRunning's guard, as the worker (admin client) issues it. */
const MARK_RUNNING = `update public.background_jobs
   set status = 'running', started_at = $2::timestamptz
 where id = $1 and status in ('queued', 'retrying')`;

/** markSucceeded's guard. */
const MARK_SUCCEEDED = `update public.background_jobs
   set status = 'succeeded', result = $2::jsonb, completed_at = $3::timestamptz
 where id = $1 and status in ('running')`;

const SELECT_JOB = "select * from public.background_jobs where id = $1";

type JobRow = Record<string, unknown> & {
  id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  canceled_at: string | null;
  created_by: string;
  workspace_id: string;
  project_id: string | null;
  canvas_id: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  credits_cost: number | null;
  credits_transaction_id: string | null;
  queue_name: string;
  job_type: string;
  updated_at: string;
};

type Denial = { code: string; message: string; severity: string };

let db: PGlite;
let applied: string[] = [];
let ownerWorkspaceId = "";
let otherWorkspaceId = "";
let teamWorkspaceId = "";

/** Deterministic fresh uuids, so destructive cases never share a row. */
let idCounter = 0;
function nextUuid(group: string): string {
  idCounter += 1;
  return `${group}-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** Run `statement` and return the SQLSTATE/message it was denied with. */
async function denial(statement: () => Promise<unknown>): Promise<Denial> {
  try {
    await statement();
  } catch (error) {
    const refused = error as { code?: unknown; message?: unknown; severity?: unknown };
    return {
      code: String(refused.code),
      message: String(refused.message),
      severity: String(refused.severity),
    };
  }
  throw new Error("expected the statement to be denied, but it succeeded");
}

/** The exact shape a policy refusal has: 42501, never a missing GRANT. */
function expectRlsDenial(result: Denial): void {
  expect(result.code).toBe("42501");
  expect(result.severity).toBe("ERROR");
  expect(result.message).toBe(
    'new row violates row-level security policy for table "background_jobs"',
  );
  expect(result.message).not.toMatch(/permission denied/);
  expect(result.message).not.toMatch(/foreign key/);
}

/**
 * The admin client's identity: `service_role` carries BYPASSRLS in the Supabase
 * stub, so these statements are decided by their own WHERE clause alone.
 */
async function asPrivileged<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("set local role service_role");
    return fn(tx);
  });
}

/** Seeded as the database owner, so the fixture itself is never blocked by RLS. */
async function seedJob(input: {
  id?: string;
  workspaceId?: string;
  projectId?: string | null;
  canvasId?: string | null;
  status?: string;
  createdBy?: string;
  canceledAt?: string | null;
  creditsCost?: number | null;
}): Promise<string> {
  const id = input.id ?? nextUuid("e1010000");
  await db.query(
    `insert into public.background_jobs
       (id, workspace_id, project_id, canvas_id, queue_name, job_type, status,
        created_by, canceled_at, credits_cost)
     values ($1, $2, $3, $4, $5, 'image_generation',
             $6::public.background_job_status, $7, $8::timestamptz, $9)`,
    [
      id,
      input.workspaceId ?? ownerWorkspaceId,
      input.projectId ?? null,
      input.canvasId ?? null,
      IMAGE_QUEUE,
      input.status ?? "queued",
      input.createdBy ?? OWNER_ID,
      input.canceledAt ?? null,
      input.creditsCost ?? null,
    ],
  );
  return id;
}

async function jobRow(id: string): Promise<JobRow | null> {
  const rows = (await db.query<JobRow>(SELECT_JOB, [id])).rows;
  return rows[0] ?? null;
}

async function requiresJobRow(id: string): Promise<JobRow> {
  const row = await jobRow(id);
  if (row === null) throw new Error(`job ${id} is missing`);
  return row;
}

async function jobStatus(id: string): Promise<string | null> {
  const rows = (
    await db.query<{ status: string }>(
      "select status::text as status from public.background_jobs where id = $1",
      [id],
    )
  ).rows;
  return rows[0]?.status ?? null;
}

async function jobCount(): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>("select count(*)::int as n from public.background_jobs"))
      .rows,
  ).n;
}

/**
 * The caller's own insert, with the refusal captured instead of thrown.
 *
 * `id` is never sent, exactly like the service's insert: the primary key is the
 * server default, so the row's id is whatever RETURNING reported. Refusals
 * therefore return an empty id and are asserted through the row count.
 */
async function insertAs(
  userId: string | null,
  input: {
    workspaceId?: string;
    projectId?: string | null;
    canvasId?: string | null;
    createdBy?: string | null;
    jobType?: string;
    queueName?: string;
    threadId?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<{
  id: string;
  affectedRows: number;
  rows: Array<{ id: string; status: string; attempt_count: number; max_attempts: number }>;
}> {
  const result = await asUser(db, userId, (tx) =>
    tx.query<{ id: string; status: string; attempt_count: number; max_attempts: number }>(
      INSERT_JOB,
      [
        input.workspaceId ?? ownerWorkspaceId,
        input.projectId ?? null,
        input.canvasId ?? null,
        input.threadId ?? null,
        input.queueName ?? IMAGE_QUEUE,
        input.jobType ?? "image_generation",
        JSON.stringify(input.payload ?? { prompt: "baseline" }),
        input.createdBy === undefined ? userId : input.createdBy,
      ],
    ),
  );
  return {
    id: result.rows[0]?.id ?? "",
    affectedRows: result.affectedRows ?? 0,
    rows: result.rows,
  };
}

/** The cancelJob statement, run as the given identity. */
async function cancelAs(
  userId: string,
  jobId: string,
  canceledAt = "2026-10-16T00:00:00.000Z",
): Promise<number> {
  const result = await asUser(db, userId, (tx) =>
    tx.query(CANCEL_JOB, [jobId, canceledAt]),
  );
  return result.affectedRows ?? 0;
}

/** The compensation delete, run as the given identity. */
async function deleteAs(userId: string, jobId: string): Promise<number> {
  const result = await asUser(db, userId, (tx) => tx.query(DELETE_JOB, [jobId]));
  return result.affectedRows ?? 0;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  await createUser(db, OWNER_ID, "job-write-owner@hahart.test");
  await createUser(db, OTHER_ID, "job-write-other@hahart.test");
  await createUser(db, STRANGER_ID, "job-write-stranger@hahart.test");

  const personalWorkspace = async (userId: string): Promise<string> =>
    firstRow(
      (
        await db.query<{ id: string }>(
          "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
          [userId],
        )
      ).rows,
    ).id;

  ownerWorkspaceId = await personalWorkspace(OWNER_ID);
  otherWorkspaceId = await personalWorkspace(OTHER_ID);

  // Exactly one team workspace may exist in the whole database.
  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2) returning id`,
        [TEAM_NAME, OTHER_ID],
      )
    ).rows,
  ).id;

  for (const [userId, role] of [
    [OTHER_ID, "owner"],
    [OWNER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  const insertProject = async (id: string, slug: string, createdBy: string) =>
    db.query(
      `insert into public.projects
         (id, workspace_id, name, slug, description, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [id, teamWorkspaceId, `project ${slug}`, slug, `description of ${slug}`, createdBy],
    );

  const insertCanvas = async (id: string, projectId: string, createdBy: string) =>
    db.query(
      `insert into public.canvases
         (id, project_id, name, is_primary, created_by, content, version)
       values ($1, $2, $3, false, $4, '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
      [id, projectId, `canvas ${id}`, createdBy],
    );

  await insertProject(PROJECT_OWNER, "job-write-owner", OWNER_ID);
  await insertProject(PROJECT_OWNER_ALT, "job-write-owner-alt", OWNER_ID);
  await insertProject(PROJECT_OTHER, "job-write-other", OTHER_ID);

  await insertCanvas(CANVAS_OWNER, PROJECT_OWNER, OWNER_ID);
  await insertCanvas(CANVAS_OWNER_ALT, PROJECT_OWNER_ALT, OWNER_ID);
  await insertCanvas(CANVAS_OTHER, PROJECT_OTHER, OTHER_ID);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("background job write ACL: the schema the baseline is measured against", () => {
  it("case 1: the whole migration chain loads, and the team-wide policy rewrite leaves background_jobs alone", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

    // Not a subset: every migration on disk really ran, in filename order.
    expect(applied).toEqual(files.sort());
    expect(applied).toContain(JOB_TABLE_MIGRATION);
    expect(applied).toContain(CREDITS_MIGRATION);
    expect(applied).toContain(TEAM_RLS_MIGRATION);

    // 2026-09 rewrote the policies of projects, canvases, chat and
    // workspace_settings. background_jobs is not in that file, which is why the
    // 2026-03 policy set measured below is still the one in force.
    const teamMigration = readFileSync(
      join(MIGRATIONS_DIR, TEAM_RLS_MIGRATION),
      "utf8",
    );
    expect(teamMigration).not.toMatch(/background_jobs/);
  });

  it("case 2: exactly two policies guard the table - the creator's own rows and the service role", async () => {
    const policies = await db.query<{
      policyname: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      with_check: string | null;
    }>(
      `select policyname, cmd, roles, qual, with_check
         from pg_policies
        where schemaname = 'public' and tablename = 'background_jobs'
        order by policyname`,
    );

    expect(policies.rows).toHaveLength(2);
    const byName = new Map(policies.rows.map((row) => [row.policyname, row]));

    const user = byName.get("background_jobs_user_policy");
    expect(user?.cmd).toBe("ALL");
    expect(user?.roles).toEqual(["public"]);
    // One expression, `auth.uid() = created_by`, and NO separate WITH CHECK -
    // so for INSERT the USING expression is reused as the check.
    expect(user?.qual).toBe("(auth.uid() = created_by)");
    expect(user?.with_check).toBeNull();

    // And it reads nothing else: no membership, no workspace, no project.
    expect(user?.qual).not.toMatch(/workspace_members|is_workspace_member|projects|canvases/);

    const service = byName.get("background_jobs_service_role");
    expect(service?.cmd).toBe("ALL");
    expect(service?.roles).toEqual(["service_role"]);
    expect(service?.qual).toBe("true");
    expect(service?.with_check).toBe("true");

    const table = firstRow(
      (
        await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `select relrowsecurity, relforcerowsecurity
             from pg_class where oid = 'public.background_jobs'::regclass`,
        )
      ).rows,
    );
    expect(table.relrowsecurity).toBe(true);
    expect(table.relforcerowsecurity).toBe(false);
  });

  it("case 3: the server defaults and the updated_at trigger the whole write path relies on", async () => {
    const columns = await db.query<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select column_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'background_jobs'`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

    // createJob never sends status/attempt_count/max_attempts/payload: every one
    // of these is a server default, so a job is born `queued` with a full budget.
    expect(byName.get("status")?.column_default).toContain("queued");
    expect(byName.get("status")?.is_nullable).toBe("NO");
    expect(byName.get("attempt_count")?.column_default).toBe("0");
    expect(byName.get("max_attempts")?.column_default).toBe("3");
    expect(byName.get("payload")?.column_default).toContain("'{}'");
    expect(byName.get("id")?.column_default).toContain("gen_random_uuid()");
    // The columns createJob DOES send are the ones constrained to be present.
    for (const column of ["workspace_id", "queue_name", "job_type", "created_by"]) {
      expect(byName.get(column)?.is_nullable).toBe("NO");
    }
    // Result/error/cancel stamps start empty; the credit columns are added by
    // the credits migration and are nullable (withBilling fills them after).
    for (const column of ["result", "canceled_at", "credits_cost", "credits_transaction_id"]) {
      expect(byName.get(column)?.is_nullable).toBe("YES");
    }

    const trigger = firstRow(
      (
        await db.query<{ d: string }>(
          `select pg_get_triggerdef(t.oid) as d
             from pg_trigger t
            where t.tgrelid = 'public.background_jobs'::regclass and not t.tgisinternal`,
        )
      ).rows,
    ).d;
    expect(trigger).toContain("BEFORE UPDATE ON public.background_jobs");
    expect(trigger).toContain("FOR EACH ROW");
  });

  it("case 4: the foreign keys - parents may vanish, but a CHARGED job cannot be deleted", async () => {
    const constraints = await db.query<{
      conname: string;
      column_name: string;
      confdeltype: string;
      contype: string;
    }>(
      `select c.conname, a.attname as column_name, c.confdeltype, c.contype
         from pg_constraint c
         join unnest(c.conkey) as k(attnum) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'public.background_jobs'::regclass
          and c.contype in ('f', 'p')`,
    );
    const deleteAction = new Map(
      constraints.rows.map((row) => [row.column_name, row.confdeltype]),
    );

    // 'a' = NO ACTION, 'n' = SET NULL.
    expect(deleteAction.get("workspace_id")).toBe("a");
    expect(deleteAction.get("created_by")).toBe("a");
    // Deleting a project or a canvas does not take the job with it: the job
    // survives with a null link, which is what the worker's asset ownership
    // reads.
    expect(deleteAction.get("project_id")).toBe("n");
    expect(deleteAction.get("canvas_id")).toBe("n");
    expect(deleteAction.get("session_id")).toBe("n");

    // The charge ledger points at the job with NO ON DELETE action, so the
    // compensation delete in createJob cannot remove an already-charged job.
    const ledger = firstRow(
      (
        await db.query<{ confdeltype: string }>(
          `select c.confdeltype
             from pg_constraint c
             join unnest(c.conkey) as k(attnum) on true
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
            where c.conrelid = 'public.credit_transactions'::regclass
              and c.contype = 'f' and a.attname = 'job_id'`,
        )
      ).rows,
    );
    expect(ledger.confdeltype).toBe("a");
  });
});

describe("background job write ACL: what the caller's own client may insert", () => {
  it("case 5: the creator inserts a job for their own project and canvas, and the defaults land", async () => {
    const inserted = await insertAs(OWNER_ID, {
      workspaceId: teamWorkspaceId,
      projectId: PROJECT_OWNER,
      canvasId: CANVAS_OWNER,
      threadId: "thread-21h0",
    });

    expect(inserted.affectedRows).toBe(1);
    // RETURNING proves the row landed for the workspace the caller asked for,
    // with the server's own defaults already applied.
    expect(inserted.rows).toEqual([
      {
        id: inserted.id,
        status: "queued",
        attempt_count: 0,
        max_attempts: 3,
      },
    ]);
    expect(inserted.id).not.toBe("");

    const id = inserted.id;
    const stored = await requiresJobRow(id);
    expect(stored.status).toBe("queued");
    expect(stored.attempt_count).toBe(0);
    expect(stored.max_attempts).toBe(3);
    expect(stored.payload).toEqual({ prompt: "baseline" });
    expect(stored.result).toBeNull();
    expect(stored.canceled_at).toBeNull();
    expect(stored.credits_cost).toBeNull();
    expect(stored.credits_transaction_id).toBeNull();
    expect(stored.created_by).toBe(OWNER_ID);
    expect(stored.project_id).toBe(PROJECT_OWNER);
    expect(stored.canvas_id).toBe(CANVAS_OWNER);
    expect(stored.queue_name).toBe(IMAGE_QUEUE);

    // And the creator can read their own row back through the same client.
    const readBack = await asUser(db, OWNER_ID, (tx) =>
      tx.query<{ id: string }>("select id from public.background_jobs where id = $1", [id]),
    );
    expect(readBack.rows).toEqual([{ id }]);

    // While another user cannot see it at all: the SELECT half of the same
    // policy is `created_by`, not the workspace.
    const asOther = await asUser(db, OTHER_ID, (tx) =>
      tx.query<{ id: string }>("select id from public.background_jobs where id = $1", [id]),
    );
    expect(asOther.rows).toEqual([]);
  });

  it("case 6: a forged creator, an anonymous caller and a missing created_by are all refused", async () => {
    const before = await jobCount();

    // Someone else's created_by: the WITH CHECK half of the user policy.
    const forgedDenial = await denial(() => insertAs(OWNER_ID, { createdBy: OTHER_ID }));
    expectRlsDenial(forgedDenial);
    expect(await jobCount()).toBe(before);

    // No identity at all (the `anon` client): auth.uid() is null.
    const anonDenial = await denial(() => insertAs(null, { createdBy: OWNER_ID }));
    expectRlsDenial(anonDenial);
    expect(await jobCount()).toBe(before);

    // created_by is NOT NULL, and the policy expression cannot be true for it.
    // The refusal below is the POLICY, not the column constraint: the check
    // runs before the NOT NULL is ever reached (case 15 measures the same
    // order for UPDATE).
    const orphanDenial = await denial(() => insertAs(OWNER_ID, { createdBy: null }));
    expectRlsDenial(orphanDenial);
    expect(await jobCount()).toBe(before);
  });

  it("case 7: neither the workspace nor the referenced project/canvas has to belong to the caller", async () => {
    // The policy reads created_by ONLY, so the database does not ask whether the
    // caller may reach the workspace it is writing into...
    const intoOtherWorkspace = await insertAs(OWNER_ID, {
      workspaceId: otherWorkspaceId,
    });
    expect(intoOtherWorkspace.affectedRows).toBe(1);
    const foreignWorkspaceJob = intoOtherWorkspace.id;
    expect((await requiresJobRow(foreignWorkspaceJob)).workspace_id).toBe(
      otherWorkspaceId,
    );
    // ...and the workspace's own owner still cannot see it: the row is real, but
    // invisible to the person whose workspace it claims to be in.
    const asWorkspaceOwner = await asUser(db, OTHER_ID, (tx) =>
      tx.query<{ id: string }>("select id from public.background_jobs where id = $1", [
        foreignWorkspaceJob,
      ]),
    );
    expect(asWorkspaceOwner.rows).toEqual([]);

    // The same holds for the parents: another member's project and canvas are
    // accepted in the job's own columns, because no read of projects/canvases
    // happens inside the policy.
    const intoOtherParents = await insertAs(OWNER_ID, {
      workspaceId: teamWorkspaceId,
      projectId: PROJECT_OTHER,
      canvasId: CANVAS_OTHER,
    });
    expect(intoOtherParents.affectedRows).toBe(1);
    const stored = await requiresJobRow(intoOtherParents.id);
    expect(stored.project_id).toBe(PROJECT_OTHER);
    expect(stored.canvas_id).toBe(CANVAS_OTHER);
  });

  it("case 8: a canvas that belongs to a DIFFERENT project is accepted by the database", async () => {
    // createJob refuses this pairing with 400 "Canvas and project do not match."
    // The database has no such rule: the two columns are independent FKs, so
    // this check exists ONLY in the service layer.
    const mismatched = await insertAs(OWNER_ID, {
      workspaceId: teamWorkspaceId,
      projectId: PROJECT_OWNER,
      canvasId: CANVAS_OWNER_ALT,
    });

    expect(mismatched.affectedRows).toBe(1);
    const stored = await requiresJobRow(mismatched.id);
    expect(stored.project_id).toBe(PROJECT_OWNER);
    expect(stored.canvas_id).toBe(CANVAS_OWNER_ALT);

    // Measured, not assumed: the canvas really does live in another project.
    const canvas = firstRow(
      (
        await db.query<{ project_id: string }>(
          "select project_id from public.canvases where id = $1",
          [CANVAS_OWNER_ALT],
        )
      ).rows,
    );
    expect(canvas.project_id).toBe(PROJECT_OWNER_ALT);
    expect(canvas.project_id).not.toBe(stored.project_id);
  });

  it("case 9: only a parent that does not exist at all is caught, by the foreign key", async () => {
    const before = await jobCount();

    const projectDenial = await denial(() =>
      insertAs(OWNER_ID, { projectId: MISSING_UUID }),
    );
    expect(projectDenial.code).toBe("23503");
    expect(projectDenial.message).toMatch(/violates foreign key constraint/);
    expect(projectDenial.message).not.toMatch(/row-level security/);
    expect(await jobCount()).toBe(before);

    const canvasDenial = await denial(() =>
      insertAs(OWNER_ID, { canvasId: MISSING_UUID_2 }),
    );
    expect(canvasDenial.code).toBe("23503");
    expect(await jobCount()).toBe(before);
  });

  it("case 10: the job type is guarded by its enum, the queue name by nothing at all", async () => {
    const before = await jobCount();

    // job_type is an enum column: an unknown type is refused by the parser.
    const typeDenial = await denial(() =>
      insertAs(OWNER_ID, { jobType: "video_upscale" }),
    );
    expect(typeDenial.code).toBe("22P02");
    expect(typeDenial.message).toMatch(/invalid input value for enum/);
    expect(await jobCount()).toBe(before);

    // queue_name is free text with no CHECK and no link to job_type, so the
    // queue topology (job-registry.ts) is an application fact only: a job routed
    // to the wrong queue is accepted by the database.
    const queueAccepted = await insertAs(OWNER_ID, {
      jobType: "image_generation",
      queueName: "video_generation_jobs",
    });
    expect(queueAccepted.affectedRows).toBe(1);
    const stored = await requiresJobRow(queueAccepted.id);
    expect(stored.queue_name).toBe("video_generation_jobs");
    expect(stored.job_type).toBe("image_generation");
  });
});

describe("background job write ACL: the state machine lives in the WHERE clause", () => {
  it("case 11: the guards are the only protection - the creator may move a row anywhere", async () => {
    const id = await seedJob({ createdBy: OWNER_ID, status: "queued" });

    // No trigger and no constraint validates the transition: queued -> succeeded
    // in one statement is accepted, because the state machine is expressed by
    // the service's `.in("status", ...)` filters and nowhere else.
    const jumped = await asUser(db, OWNER_ID, (tx) =>
      tx.query(
        "update public.background_jobs set status = 'succeeded' where id = $1",
        [id],
      ),
    );
    expect(jumped.affectedRows ?? 0).toBe(1);
    expect(await jobStatus(id)).toBe("succeeded");

    // The table also has no enum value for a status the worker never writes.
    const badStatus = await denial(() =>
      db.query("update public.background_jobs set status = 'paused' where id = $1", [id]),
    );
    expect(badStatus.code).toBe("22P02");
    expect(badStatus.message).toMatch(/invalid input value for enum/);
  });

  it("case 12: a queued or running job is cancelled, and only status/canceled_at/updated_at move", async () => {
    for (const status of ["queued", "running"]) {
      const id = await seedJob({ status, creditsCost: 7 });
      const before = await requiresJobRow(id);
      await db.query(
        "update public.background_jobs set credits_transaction_id = $2, result = $3::jsonb where id = $1",
        [id, nextUuid("c1010000"), JSON.stringify({ keep: "me" })],
      );
      const charged = await requiresJobRow(id);

      expect(await cancelAs(OWNER_ID, id)).toBe(1);

      const after = await requiresJobRow(id);
      expect(after.status).toBe("canceled");
      expect(after.canceled_at).not.toBeNull();

      // The guard writes two columns and the trigger stamps updated_at. Nothing
      // else moves: no refund column, no delete, no archive.
      const moved = Object.keys(after).filter(
        (column) => JSON.stringify(after[column]) !== JSON.stringify(charged[column]),
      );
      expect(moved).toContain("status");
      for (const column of moved) {
        expect(["status", "canceled_at", "updated_at"]).toContain(column);
      }
      expect(after.credits_cost).toBe(7);
      expect(after.credits_transaction_id).toBe(charged.credits_transaction_id);
      expect(after.result).toEqual({ keep: "me" });
      expect(after.attempt_count).toBe(before.attempt_count);
      expect(after.created_by).toBe(OWNER_ID);
      expect(await jobRow(id)).not.toBeNull();
    }
  });

  it("case 13: every other status - and an unknown id - cancels zero rows and changes nothing", async () => {
    // `retrying` is the interesting one: the job is alive and was charged, and
    // the service's guard list is exactly queued/running, so cancel reports 404
    // for a job the worker is still going to retry.
    for (const status of [
      "retrying",
      "succeeded",
      "failed",
      "canceled",
      "dead_letter",
    ]) {
      const id = await seedJob({ status, canceledAt: null });
      const before = await requiresJobRow(id);

      expect(await cancelAs(OWNER_ID, id)).toBe(0);

      const after = await requiresJobRow(id);
      expect(after.status).toBe(before.status);
      expect(after.canceled_at).toEqual(before.canceled_at);
      expect(after.updated_at).toEqual(before.updated_at);
    }

    expect(await cancelAs(OWNER_ID, MISSING_UUID)).toBe(0);

    // A zero-row UPDATE is not an error and does not abort the transaction: the
    // next statement on the same connection still runs.
    const alive = await seedJob({ status: "queued" });
    expect(await cancelAs(OWNER_ID, alive)).toBe(1);
    expect(await jobStatus(alive)).toBe("canceled");
  });

  it("case 14: cancelling someone else's job is a silent zero rows, not an error", async () => {
    const id = await seedJob({ createdBy: OTHER_ID, status: "queued" });

    // The USING clause filters the row out, so there is no SQLSTATE to catch:
    // the service sees "no row" and answers 404, which leaks nothing about the
    // other user's job.
    expect(await cancelAs(OWNER_ID, id)).toBe(0);
    expect(await jobStatus(id)).toBe("queued");

    // The owner of the row still cancels it.
    expect(await cancelAs(OTHER_ID, id)).toBe(1);
    expect(await jobStatus(id)).toBe("canceled");
  });

  it("case 15: a job cannot be handed to another user, because USING doubles as WITH CHECK", async () => {
    const id = await seedJob({ createdBy: OWNER_ID, status: "queued" });

    const handover = await denial(() =>
      asUser(db, OWNER_ID, (tx) =>
        tx.query("update public.background_jobs set created_by = $2 where id = $1", [
          id,
          OTHER_ID,
        ]),
      ),
    );
    expect(handover.code).toBe("42501");
    expect(handover.severity).toBe("ERROR");
    expect(handover.message).toBe(
      'new row violates row-level security policy for table "background_jobs"',
    );

    // The row is untouched and still belongs to its creator.
    expect((await requiresJobRow(id)).created_by).toBe(OWNER_ID);

    // Setting created_by to null is refused by the SAME expression, not by the
    // NOT NULL constraint: the policy check runs first, so a caller cannot tell
    // the two apart from the outside.
    const toNull = await denial(() =>
      asUser(db, OWNER_ID, (tx) =>
        tx.query("update public.background_jobs set created_by = null where id = $1", [id]),
      ),
    );
    expect(toNull.code).toBe("42501");
    expect(toNull.severity).toBe("ERROR");
    expect(toNull.message).toBe(
      'new row violates row-level security policy for table "background_jobs"',
    );
    expect(toNull.message).not.toMatch(/null value in column/);
    expect((await requiresJobRow(id)).created_by).toBe(OWNER_ID);
  });

  it("case 16: a late worker cannot rewrite a cancelled row, and markRunning cannot revive it", async () => {
    const canceled = await seedJob({ status: "canceled", canceledAt: "2026-01-01T00:00:00.000Z" });
    const running = await seedJob({ status: "running" });

    // These run as the ADMIN client (service_role), where RLS is bypassed: the
    // guard in the statement is the entire protection.
    const succeeded = await asPrivileged((tx) =>
      tx.query(MARK_SUCCEEDED, [canceled, JSON.stringify({ url: "x" }), "2026-10-16T00:00:00.000Z"]),
    );
    expect(succeeded.affectedRows ?? 0).toBe(0);
    const after = await requiresJobRow(canceled);
    expect(after.status).toBe("canceled");
    expect(after.result).toBeNull();
    expect(after.completed_at).toBeNull();

    const restarted = await asPrivileged((tx) =>
      tx.query(MARK_RUNNING, [canceled, "2026-10-16T00:00:00.000Z"]),
    );
    expect(restarted.affectedRows ?? 0).toBe(0);
    expect(await jobStatus(canceled)).toBe("canceled");

    // `running` is not startable either: markRunning's guard list is exactly
    // queued/retrying, so a second worker cannot re-claim a job mid-run.
    const started = await asPrivileged((tx) =>
      tx.query(MARK_RUNNING, [running, "2026-10-16T00:00:00.000Z"]),
    );
    expect(started.affectedRows ?? 0).toBe(0);
    expect(await jobStatus(running)).toBe("running");

    // A queued job IS startable, so the zero rows above are the guard and not a
    // statement that could never match anything.
    const queued = await seedJob({ status: "queued" });
    const queuedStarted = await asPrivileged((tx) =>
      tx.query(MARK_RUNNING, [queued, "2026-10-16T00:00:00.000Z"]),
    );
    expect(queuedStarted.affectedRows ?? 0).toBe(1);
    expect(await jobStatus(queued)).toBe("running");
  });
});

describe("background job write ACL: the compensation delete", () => {
  it("case 17: the creator's own compensation delete removes the row at any status", async () => {
    for (const status of ["queued", "running"]) {
      const id = await seedJob({ status });
      expect(await deleteAs(OWNER_ID, id)).toBe(1);
      expect(await jobRow(id)).toBeNull();
    }

    // The statement is by id alone: no status predicate, no owner predicate of
    // its own beyond RLS, and no soft delete.
    expect(await deleteAs(OWNER_ID, MISSING_UUID)).toBe(0);
  });

  it("case 18: another user's job cannot be compensated away - zero rows, row survives", async () => {
    const id = await seedJob({ createdBy: OTHER_ID, status: "queued" });

    // Silent: no SQLSTATE, so the service's compensation path cannot tell this
    // apart from success - the orphan row stays exactly where it was.
    expect(await deleteAs(OWNER_ID, id)).toBe(0);
    const survived = await requiresJobRow(id);
    expect(survived.id).toBe(id);
    expect(survived.created_by).toBe(OTHER_ID);
  });

  it("case 19: a job that already carries a charge cannot be deleted at all", async () => {
    const id = await seedJob({ createdBy: OWNER_ID, status: "queued", creditsCost: 7 });
    await db.query(
      `insert into public.credit_transactions
         (workspace_id, user_id, transaction_type, amount, balance_after, job_id, description)
       values ($1, $2, 'generation_deduct', 7, 93, $3, 'background job baseline')`,
      [ownerWorkspaceId, OWNER_ID, id],
    );

    // credit_transactions.job_id has no ON DELETE action, so the delete is
    // refused outright. This is the concrete failure the compensation path can
    // hit: the job row survives, and the caller only sees "Failed to enqueue
    // job." while the row is still there.
    const refused = await denial(() => deleteAs(OWNER_ID, id));
    expect(refused.code).toBe("23503");
    expect(refused.message).toMatch(/violates foreign key constraint/);
    expect(refused.message).toMatch(/credit_transactions/);

    expect(await jobRow(id)).not.toBeNull();

    // The charge still points at the surviving job.
    const ledger = firstRow(
      (
        await db.query<{ job_id: string }>(
          "select job_id from public.credit_transactions where job_id = $1",
          [id],
        )
      ).rows,
    );
    expect(ledger.job_id).toBe(id);

    // Removing the ledger row by hand is what would unblock it - recorded here
    // so the risk is visible rather than assumed.
    await db.query("delete from public.credit_transactions where job_id = $1", [id]);
    expect(await deleteAs(OWNER_ID, id)).toBe(1);
    expect(await jobRow(id)).toBeNull();
  });

  it("case 20: deleting the project or the canvas detaches the job instead of removing it", async () => {
    const project = nextUuid("a2010000");
    const canvas = nextUuid("b2010000");
    await db.query(
      `insert into public.projects (id, workspace_id, name, slug, created_by)
       values ($1, $2, $3, $4, $5)`,
      [project, teamWorkspaceId, "doomed project", project, OWNER_ID],
    );
    await db.query(
      `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
       values ($1, $2, 'doomed canvas', false, $3, '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
      [canvas, project, OWNER_ID],
    );
    const id = await seedJob({
      projectId: project,
      canvasId: canvas,
      workspaceId: teamWorkspaceId,
    });

    await db.query("delete from public.projects where id = $1", [project]);

    const detached = await requiresJobRow(id);
    expect(detached.project_id).toBeNull();
    expect(detached.canvas_id).toBeNull();
    expect(detached.status).toBe("queued");
  });
});

describe("background job write ACL: refusal shape and transaction recovery", () => {
  it("case 21: a refused insert aborts only its transaction, and the same connection recovers", async () => {
    const before = await jobCount();

    await db.exec("begin");
    try {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [OWNER_ID]);

      const refused = await denial(() =>
        db.query(INSERT_JOB, [
          ownerWorkspaceId,
          null,
          null,
          null,
          IMAGE_QUEUE,
          "image_generation",
          JSON.stringify({ prompt: "aborted" }),
          OTHER_ID,
        ]),
      );
      expectRlsDenial(refused);

      // The failure really did abort the block: the next statement is refused
      // with 25P02 instead of running.
      const aborted = await denial(() => db.query("select 1 as one"));
      expect(aborted.code).toBe("25P02");
      expect(aborted.message).toMatch(/current transaction is aborted/);
    } finally {
      await db.exec("rollback");
    }

    // Same connection (PGlite has exactly one session): querying works again,
    // the refused write left nothing behind, and the identity is gone with the
    // transaction.
    expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
    expect(await jobCount()).toBe(before);

    const identity = firstRow(
      (
        await db.query<{ role: string; uid: string | null }>(
          "select current_user as role, auth.uid() as uid",
        )
      ).rows,
    );
    expect(identity.role).not.toBe("authenticated");
    expect(identity.uid).toBeNull();

    // And a legal write still lands, on that same connection.
    const allowed = await insertAs(OWNER_ID, { workspaceId: teamWorkspaceId });
    expect(allowed.affectedRows).toBe(1);
    expect(await jobStatus(allowed.id)).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Workorder 21V: `createJob` no longer authorizes its two reads through the
// caller's client, so the RLS policies those reads relied on are not what
// authorises a job any more — `CanvasReadRepository.findReadableCanvasProjectLink`
// is. The two cases below measure the REAL repository against the REAL schema and
// hold its answer against the policy's answer on the very same rows: the
// statement is the ACL now, and any difference between the two would be a silent
// authorization change on the job write path.
//
// Why the archived case is here at all: the two obvious repositories
// (`findReadableCanvasContent`, `findReadableProject`) DO filter `archived_at`,
// and reaching for one of them would refuse every generation submitted from an
// archived project's canvas. The method this workorder uses deliberately has no
// such filter, matching the policy verbatim — and that is a fact about SQL, so it
// is measured here rather than asserted in prose.
//
// The two imports below are appended HERE instead of joining the import block at
// the top of this file on purpose: this file's contract for this workorder is
// append-only, because everything above it is a baseline that must not move a
// single line. `createPGliteTransactionPool` is the adapter the sibling
// repository-db tests use to run a repository's real SQL on this in-process
// database.
// ---------------------------------------------------------------------------

import { createCanvasReadRepository } from "../../db/canvas-read-repository.js";
import { createPGliteTransactionPool } from "./pglite-db.js";

describe("background job write ACL: the canvas link read createJob authorizes through now (工单21V)", () => {
  const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

  /** The repository the service is wired with, on this same real database. */
  function canvasRepository() {
    return createCanvasReadRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });
  }

  it("case 22: a canvas of an ARCHIVED project still authorizes a job, and the link agrees with the policy", async () => {
    const project = nextUuid("a3010000");
    const canvas = nextUuid("b3010000");

    await db.query(
      `insert into public.projects
         (id, workspace_id, name, slug, description, created_by, archived_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7,
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [
        project,
        teamWorkspaceId,
        "archived job project",
        "archived-job-project",
        "archived on purpose",
        OWNER_ID,
        ARCHIVED_AT,
      ],
    );
    await db.query(
      `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
       values ($1, $2, 'canvas of an archived project', false, $3,
               '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
      [canvas, project, OWNER_ID],
    );

    // Guard against a vacuous pass: the project really is archived, so a
    // statement carrying an `archived_at` filter would answer null below.
    const archived = firstRow(
      (
        await db.query<{ archived_at: string | null }>(
          "select archived_at from public.projects where id = $1",
          [project],
        )
      ).rows,
    );
    expect(archived.archived_at).not.toBeNull();

    // The repository's statement: no archived filter, so the link resolves.
    const link = await canvasRepository().findReadableCanvasProjectLink({
      actorId: OWNER_ID,
      canvasId: canvas,
    });
    expect(link).toEqual({
      project_id: project,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });

    // The read the service used to perform through the caller's client — the
    // `canvases` policy. Both answers must be the same row.
    const viaPolicy = await asUser(db, OWNER_ID, (tx) =>
      tx.query<{ project_id: string }>(
        "select project_id from public.canvases where id = $1",
        [canvas],
      ),
    );
    expect(viaPolicy.rows.map((row) => row.project_id)).toEqual([project]);
    expect(link?.project_id).toBe(project);

    // And the job really can be created with the project that read resolved: the
    // insert itself never looked at projects, so an archived parent changes
    // nothing about it.
    const inserted = await insertAs(OWNER_ID, {
      workspaceId: teamWorkspaceId,
      projectId: project,
      canvasId: canvas,
    });
    expect(inserted.affectedRows).toBe(1);
    const stored = await requiresJobRow(inserted.id);
    expect(stored.project_id).toBe(project);
    expect(stored.canvas_id).toBe(canvas);
    expect(stored.status).toBe("queued");
  });

  it("case 23: a plain member gets NO link for another author's canvas, and the policy refuses it the same way", async () => {
    // The fixture makes OWNER a `member` of the team workspace while OTHER is its
    // `owner` and the author of PROJECT_OTHER — so the only thing denying the read
    // below is the author/admin/owner clause of `can_read_project`.
    const membership = firstRow(
      (
        await db.query<{ role: string }>(
          `select role from public.workspace_members
            where workspace_id = $1 and user_id = $2`,
          [teamWorkspaceId, OWNER_ID],
        )
      ).rows,
    );
    expect(membership.role).toBe("member");

    const link = await canvasRepository().findReadableCanvasProjectLink({
      actorId: OWNER_ID,
      canvasId: CANVAS_OTHER,
    });
    expect(link).toBeNull();

    const viaPolicy = await asUser(db, OWNER_ID, (tx) =>
      tx.query<{ project_id: string }>(
        "select project_id from public.canvases where id = $1",
        [CANVAS_OTHER],
      ),
    );
    expect(viaPolicy.rows).toEqual([]);

    // The author is admitted through the same statement, so the null above is the
    // ACL and not a query that could never match anything.
    expect(
      await canvasRepository().findReadableCanvasProjectLink({
        actorId: OTHER_ID,
        canvasId: CANVAS_OTHER,
      }),
    ).toEqual({
      project_id: PROJECT_OTHER,
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
    });
  });
});
