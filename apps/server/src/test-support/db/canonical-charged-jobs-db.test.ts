import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createChargedJobWriteRepository,
  type ChargedJobInput,
  type ChargedJobWriteRepository,
} from "../../db/charged-job-write-repository.js";
import { createNativeQueueClient } from "../../queue/native-queue-client.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createMigratedDb, createPGliteTransactionPool } from "./pglite-db.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Ticket 43V: canonical migration 0010 (refund compensation queue and
 * `create_charged_job`) on an empty database. No Supabase stubs: only
 * `apps/server/db/canonical/*.sql`.
 *
 * The comparison against the retired `supabase/migrations` chain
 * (`createMigratedDb()`) is the evidence that 0010 is the final form of that
 * chain. The only intended difference is the enqueue statement inside
 * `create_charged_job`. Only the final state is asserted here.
 */

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0010_charged_jobs.sql",
);

const TABLE = "refund_compensations";

const COMPENSATION_FUNCTIONS = [
  "record_refund_compensation",
  "claim_refund_compensations",
  "finish_refund_compensation",
] as const;
const FUNCTIONS = [...COMPENSATION_FUNCTIONS, "create_charged_job"] as const;

const OLD_ENQUEUE = `perform pgmq.send( p_queue_name, coalesce(p_message, '{}'::jsonb) || jsonb_build_object('job_id', v_job_id) );`;
const NEW_ENQUEUE = `insert into hahart_queue.messages (queue_name, message) values ( p_queue_name, coalesce(p_message, '{}'::jsonb) || jsonb_build_object('job_id', v_job_id) );`;

let db: PGlite;
let applied: string[] = [];
let repository: ChargedJobWriteRepository;
let seq = 0;

type Actor = { userId: string; workspaceId: string };

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function errorOf(run: Promise<unknown>): Promise<{ code?: unknown } | null> {
  try {
    await run;
  } catch (error) {
    return error as { code?: unknown };
  }
  return null;
}

async function newActor(balance: number): Promise<Actor> {
  seq += 1;
  const userId = `00000000-0000-0000-0000-00000043d0${String(seq).padStart(2, "0")}`;
  await createCanonicalUser(db, userId, `charged-43v-${seq}@hahart.test`);
  const workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [userId],
      )
    ).rows,
  ).id;
  await db.query("update public.credit_balances set balance = $2 where workspace_id = $1::uuid", [
    workspaceId,
    balance,
  ]);
  return { userId, workspaceId };
}

function inputFor(actor: Actor, queueName: string): ChargedJobInput {
  return {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    projectId: null,
    canvasId: null,
    sessionId: null,
    threadId: null,
    queueName,
    jobType: "image_generation",
    payload: { prompt: "a red fox" },
    clientRequestId: null,
    amount: 12,
    description: "test charge",
    usePools: false,
    chargeWorkspaceId: actor.workspaceId,
    message: { job_type: "image_generation", workspace_id: actor.workspaceId },
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql, params)).rows).n;
}

async function balanceOf(actor: Actor): Promise<number> {
  return firstRow(
    (
      await db.query<{ balance: number }>(
        "select balance from public.credit_balances where workspace_id = $1::uuid",
        [actor.workspaceId],
      )
    ).rows,
  ).balance;
}

/** A bare job row, enough to hang a compensation row on. */
async function newJob(actor: Actor): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation_jobs', 'image_generation', $2::uuid) returning id`,
        [actor.workspaceId, actor.userId],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  const pool = createPGliteTransactionPool(db);
  repository = createChargedJobWriteRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0010 charged jobs: schema", () => {
  it("applies 0010_charged_jobs.sql", () => {
    expect(applied).toContain("0010_charged_jobs.sql");
  });
});

describe("canonical 0010 charged jobs: create_charged_job", () => {
  it("creates the job, one charge row and exactly one queue message in one call", async () => {
    const actor = await newActor(100);
    const queue = "queue_43v_ok";

    const result = await repository.createChargedJob(inputFor(actor, queue));

    expect(result.row.status).toBe("queued");
    expect(result.row.created_by).toBe(actor.userId);
    expect(result.row.queue_name).toBe(queue);
    expect(await balanceOf(actor)).toBe(88);

    expect(
      await count("select count(*)::int as n from public.background_jobs where created_by = $1::uuid", [
        actor.userId,
      ]),
    ).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from public.credit_transactions where workspace_id = $1::uuid and job_id = $2::uuid",
        [actor.workspaceId, result.row.id],
      ),
    ).toBe(1);

    const messages = (
      await db.query<{ message: Record<string, unknown> }>(
        "select message from hahart_queue.messages where queue_name = $1",
        [queue],
      )
    ).rows;
    expect(messages).toHaveLength(1);
    expect(firstRow(messages).message).toEqual({
      job_type: "image_generation",
      workspace_id: actor.workspaceId,
      job_id: result.row.id,
    });
  });

  it("an insufficient balance raises P0402 and leaves no job, charge row or message", async () => {
    const actor = await newActor(5);
    const queue = "queue_43v_short";

    const error = await errorOf(repository.createChargedJob(inputFor(actor, queue)));

    expect(error?.code).toBe("P0402");
    expect(
      await count("select count(*)::int as n from public.background_jobs where created_by = $1::uuid", [
        actor.userId,
      ]),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int as n from public.credit_transactions where workspace_id = $1::uuid",
        [actor.workspaceId],
      ),
    ).toBe(0);
    expect(
      await count("select count(*)::int as n from hahart_queue.messages where queue_name = $1", [
        queue,
      ]),
    ).toBe(0);
    expect(await balanceOf(actor)).toBe(5);
  });

  it("the native queue client reads the enqueued message", async () => {
    const actor = await newActor(100);
    const queue = "queue_43v_read";
    const result = await repository.createChargedJob(inputFor(actor, queue));

    const client = createNativeQueueClient({
      async query(sql: string, params?: readonly unknown[]) {
        const r = await db.query(sql, params ? [...params] : undefined);
        return { rows: r.rows as any[] };
      },
    });
    const read = await client.read<Record<string, unknown>>(queue, 30, 5);

    expect(read).toHaveLength(1);
    expect(firstRow(read).message.job_id).toBe(result.row.id);
  });
});

describe("canonical 0010 charged jobs: refund compensation", () => {
  it("record -> claim -> finish closes the row, which is then no longer claimed", async () => {
    const actor = await newActor(0);
    const jobId = await newJob(actor);

    const id = firstRow(
      (
        await db.query<{ id: string }>(
          `select public.record_refund_compensation(
             $1::uuid, $2::uuid, $3::uuid, 7, 'refund', false, 'boom') as id`,
          [jobId, actor.workspaceId, actor.userId],
        )
      ).rows,
    ).id;
    expect(id).toBeTruthy();

    // Recorded rows are due five minutes ahead: not claimable yet.
    expect(
      (await db.query("select * from public.claim_refund_compensations(10)")).rows,
    ).toHaveLength(0);

    await db.query(
      "update public.refund_compensations set next_attempt_at = now() - interval '1 minute' where id = $1::uuid",
      [id],
    );
    const claimed = (
      await db.query<{ id: string; attempts: number; status: string }>(
        "select id, attempts, status from public.claim_refund_compensations(10)",
      )
    ).rows;
    expect(claimed).toEqual([{ id, attempts: 1, status: "pending" }]);

    const status = firstRow(
      (
        await db.query<{ status: string }>(
          "select public.finish_refund_compensation($1::uuid, true, null, null) as status",
          [id],
        )
      ).rows,
    ).status;
    expect(status).toBe("done");

    await db.query(
      "update public.refund_compensations set next_attempt_at = now() - interval '1 minute' where id = $1::uuid",
      [id],
    );
    expect(
      (await db.query("select * from public.claim_refund_compensations(10)")).rows,
    ).toHaveLength(0);
  });

  it("a second record for the same job reuses the row; finish on an unknown id raises P0002", async () => {
    const actor = await newActor(0);
    const jobId = await newJob(actor);
    const args = [jobId, actor.workspaceId, actor.userId];
    const first = firstRow(
      (
        await db.query<{ id: string }>(
          "select public.record_refund_compensation($1::uuid, $2::uuid, $3::uuid, 7, 'r', false, 'e1') as id",
          args,
        )
      ).rows,
    ).id;
    const second = firstRow(
      (
        await db.query<{ id: string }>(
          "select public.record_refund_compensation($1::uuid, $2::uuid, $3::uuid, 7, 'r', false, 'e2') as id",
          args,
        )
      ).rows,
    ).id;
    expect(second).toBe(first);
    expect(
      firstRow(
        (
          await db.query<{ last_error: string }>(
            "select last_error from public.refund_compensations where id = $1::uuid",
            [first],
          )
        ).rows,
      ).last_error,
    ).toBe("e2");

    const missing = await errorOf(
      db.query(
        "select public.finish_refund_compensation('00000000-0000-0000-0000-000000000000'::uuid, true, null, null)",
      ),
    );
    expect((missing as { code?: unknown } | null)?.code).toBe("P0002");
  });
});

describe("canonical 0010 charged jobs: final form equals the retired migration chain", () => {
  let oldDb: PGlite;

  beforeAll(async () => {
    oldDb = (await createMigratedDb()).db;
  }, 240_000);

  afterAll(async () => {
    await oldDb.close();
  });

  async function columnShapes(database: PGlite) {
    const result = await database.query(
      `select ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = $1
        order by ordinal_position`,
      [TABLE],
    );
    return result.rows;
  }

  async function constraintDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype in ('p', 'u', 'c', 'n')
        order by 1`,
      [`public.${TABLE}`],
    );
    return result.rows.map((row) => row.line);
  }

  async function foreignKeyDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select conname || ' :: ' || confdeltype::text || ' -> ' || pg_get_constraintdef(oid) as line
         from pg_constraint
        where conrelid = $1::regclass and contype = 'f'
        order by 1`,
      [`public.${TABLE}`],
    );
    return result.rows.map((row) => row.line);
  }

  async function indexDefs(database: PGlite): Promise<string[]> {
    const result = await database.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = $1
        order by indexname`,
      [TABLE],
    );
    return result.rows.map((row) => row.indexdef);
  }

  async function functionShapes(database: PGlite): Promise<string[]> {
    const result = await database.query<{ line: string }>(
      `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') returns '
              || pg_get_function_result(p.oid) || ' lang=' || l.lanname
              || ' volatility=' || p.provolatile::text
              || ' secdef=' || p.prosecdef::text
              || ' config=' || coalesce(p.proconfig::text, '') as line
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by 1`,
      [[...FUNCTIONS]],
    );
    return result.rows.map((row) => row.line);
  }

  /** Function bodies with comment lines dropped and white space collapsed. */
  async function functionBodies(
    database: PGlite,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    const result = await database.query<{ name: string; prosrc: string }>(
      `select p.proname as name, p.prosrc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
        order by 1`,
      [[...names]],
    );
    return Object.fromEntries(
      result.rows.map((row) => [
        row.name,
        row.prosrc
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      ]),
    );
  }

  it("has the same refund_compensations columns, constraints, foreign keys and indexes", async () => {
    const oldShapes = await columnShapes(oldDb);
    expect(oldShapes.length).toBeGreaterThan(0);
    expect(await columnShapes(db)).toEqual(oldShapes);

    const oldConstraints = await constraintDefs(oldDb);
    expect(oldConstraints.length).toBeGreaterThan(0);
    expect(await constraintDefs(db)).toEqual(oldConstraints);

    const oldForeignKeys = await foreignKeyDefs(oldDb);
    expect(oldForeignKeys.length).toBeGreaterThan(0);
    expect(await foreignKeyDefs(db)).toEqual(oldForeignKeys);
    expect(await indexDefs(db)).toEqual(await indexDefs(oldDb));
  });

  it("has the same function signatures, return types, language, security mode and search path", async () => {
    const oldShapes = await functionShapes(oldDb);
    expect(oldShapes).toHaveLength(FUNCTIONS.length);
    expect(await functionShapes(db)).toEqual(oldShapes);
  });

  it("has the same compensation function bodies, ignoring comments and white space", async () => {
    const oldBodies = await functionBodies(oldDb, COMPENSATION_FUNCTIONS);
    expect(Object.keys(oldBodies)).toHaveLength(COMPENSATION_FUNCTIONS.length);
    expect(await functionBodies(db, COMPENSATION_FUNCTIONS)).toEqual(oldBodies);
  });

  it("create_charged_job differs from the old body only in the enqueue statement", async () => {
    const oldBody = firstValue(await functionBodies(oldDb, ["create_charged_job"]));
    expect(oldBody).toContain(OLD_ENQUEUE);
    const expected = oldBody.replace(OLD_ENQUEUE, NEW_ENQUEUE);
    expect(firstValue(await functionBodies(db, ["create_charged_job"]))).toBe(expected);
  });

  function firstValue(bodies: Record<string, string>): string {
    const value = bodies["create_charged_job"];
    if (value === undefined) throw new Error("create_charged_job not found");
    return value;
  }
});

describe("canonical 0010 charged jobs: SQL file hygiene", () => {
  const sql = readFileSync(SQL_FILE, "utf8");
  const lower = sql.toLowerCase();

  it("is at most 500 lines", () => {
    expect(sql.split("\n").length).toBeLessThanOrEqual(500);
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
