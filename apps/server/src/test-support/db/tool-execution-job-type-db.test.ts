import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDb, createUser } from "./pglite-db.js";

/**
 * The database half of `tool_execution`: the enum value and its queue.
 *
 * Two facts are pinned against the real migrated schema, so that editing the
 * migration (or dropping it) turns a case red instead of leaking a job type the
 * worker cannot poll:
 *
 *   1. `public.background_job_type` really has the value `tool_execution`;
 *   2. a row may be written with `job_type = 'tool_execution'` on
 *      `queue_name = 'tool_execution_jobs'` — i.e. the type is not merely in the
 *      enum, the product column accepts it.
 *
 * `pgmq` in the test database is the test double from
 * `src/test-support/db/supabase-stubs.sql`: `pgmq.create` is a no-op and
 * `pgmq.send` records the message in `pgmq.test_sent` and returns one id. The
 * send case therefore asserts the double's actual behaviour — the call succeeds
 * and the message lands on the queue named `tool_execution_jobs` — and the
 * returned id is checked to be exactly one.
 *
 * The database is PGlite — in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`. One instance is migrated in `beforeAll`, the fixture is built
 * through the real signup trigger, and `afterAll` closes it.
 */

const USER_ID = "00000000-0000-0000-0000-0000000030b0";
const JOB_ID = "00000000-0000-0000-0000-0000000030b1";

const CREATED_AT = "2026-04-05T06:07:08.901Z";
const UPDATED_AT = "2026-04-05T06:08:09.902Z";

const QUEUE = "tool_execution_jobs";

/** The enum as PostgreSQL itself renders it — not a list restated by this file. */
const SELECT_ENUM_SQL = `
select unnest(enum_range(null::public.background_job_type))::text as value
`;

/**
 * One row with every column named, so nothing depends on a table default and
 * the only variable is the job type / queue pair.
 */
const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, project_id, canvas_id, session_id, thread_id,
  queue_name, job_type, status, payload, result, error_code, error_message,
  attempt_count, max_attempts, created_by,
  created_at, updated_at, started_at, completed_at, failed_at, canceled_at
) values (
  $1, $2, null, null, null, null,
  $3, $4::public.background_job_type, 'queued',
  '{"tool_id":"remove_background"}'::jsonb, null, null, null,
  0, 3, $5,
  $6, $7, null, null, null, null
)
`;

let db: PGlite;
let workspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Real signup path: the trigger builds the profile and the personal workspace.
  await createUser(db, USER_ID, "tool-execution-type@hahart.test");
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
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("tool_execution: the database job type enum", () => {
  it("the enum has the tool_execution value", async () => {
    const values = (
      await db.query<{ value: string }>(SELECT_ENUM_SQL)
    ).rows.map((row) => row.value);

    expect(values).toContain("tool_execution");

    // The earlier values survive the new migration.
    expect(values).toContain("image_generation");
    expect(values).toContain("video_generation");
  });
});

describe("tool_execution: writing a job row", () => {
  it("a job of type tool_execution on its own queue inserts and reads back", async () => {
    await db.query(INSERT_JOB_SQL, [
      JOB_ID,
      workspaceId,
      QUEUE,
      "tool_execution",
      USER_ID,
      CREATED_AT,
      UPDATED_AT,
    ]);

    const row = firstRow(
      (
        await db.query<{
          queue_name: string;
          job_type: string;
          status: string;
          payload: { tool_id?: string };
        }>(
          `select queue_name, job_type::text as job_type, status::text as status, payload
             from public.background_jobs
            where id = $1`,
          [JOB_ID],
        )
      ).rows,
    );

    expect(row.queue_name).toBe(QUEUE);
    expect(row.job_type).toBe("tool_execution");
    expect(row.status).toBe("queued");
    expect(row.payload.tool_id).toBe("remove_background");
  });
});

describe("tool_execution: the pgmq test double", () => {
  it("pgmq.create on the queue does not fail", async () => {
    // Stub: `create function pgmq.create(queue_name text) returns void language
    // sql as $$ select $$`. Asserted for behaviour, not for a side effect.
    await expect(
      db.query(`select pgmq.create('${QUEUE}')`),
    ).resolves.toBeDefined();
  });

  it("pgmq.send accepts a message on the tool_execution queue", async () => {
    const sent = await db.query<{ msg_id: string }>(
      `select pgmq.send('${QUEUE}', '{}'::jsonb)::text as msg_id`,
    );

    // The double returns exactly one id, as the real extension does.
    expect(sent.rows).toHaveLength(1);
    expect(firstRow(sent.rows).msg_id).toBe("1");

    // And it recorded the message against this queue, not another one.
    const recorded = await db.query<{ queue_name: string }>(
      `select queue_name from pgmq.test_sent where queue_name = $1`,
      [QUEUE],
    );
    expect(recorded.rows).toHaveLength(1);
    expect(firstRow(recorded.rows).queue_name).toBe(QUEUE);
  });
});
