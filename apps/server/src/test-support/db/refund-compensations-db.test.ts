import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * BL-41 (4): the refund compensation queue, migration
 * `20261022000002_hahart_refund_compensations.sql`.
 *
 * A failed refund is recorded once per job, retried every five minutes and
 * exhausted on the twelfth failure. Time is simulated by rewriting
 * `next_attempt_at` / `attempts` through the privileged connection; nothing here
 * sleeps.
 */

const OWNER = "00000000-0000-0000-0000-000000039a01";
const OTHER = "00000000-0000-0000-0000-000000039a02";
const REFUND_TX = "00000000-0000-0000-0000-000000039f01";

let db: PGlite;
let workspaceId: string;

type Row = {
  id: string;
  attempts: number;
  status: string;
  last_error: string | null;
  refund_transaction_id: string | null;
};

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function insertJob(): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [workspaceId, OWNER],
      )
    ).rows,
  ).id;
}

async function record(jobId: string, error: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `select public.record_refund_compensation(
           $1::uuid, $2::uuid, $3::uuid, 7, 'refund', false, $4::text
         ) as id`,
        [jobId, workspaceId, OWNER, error],
      )
    ).rows,
  ).id;
}

async function claim(limit: number): Promise<Row[]> {
  return (
    await db.query<Row>(
      "select id, attempts, status, last_error, refund_transaction_id from public.claim_refund_compensations($1::integer)",
      [limit],
    )
  ).rows;
}

async function finish(
  id: string,
  ok: boolean,
  tx: string | null,
  error: string | null,
): Promise<string> {
  return firstRow(
    (
      await db.query<{ status: string }>(
        "select public.finish_refund_compensation($1::uuid, $2::boolean, $3::uuid, $4::text) as status",
        [id, ok, tx, error],
      )
    ).rows,
  ).status;
}

async function rowOf(id: string): Promise<Row> {
  return firstRow(
    (
      await db.query<Row>(
        "select id, attempts, status, last_error, refund_transaction_id from public.refund_compensations where id = $1::uuid",
        [id],
      )
    ).rows,
  );
}

/** Pretend time passed: the row is due now. */
async function makeDue(id: string, attempts?: number): Promise<void> {
  await db.query(
    `update public.refund_compensations
        set next_attempt_at = now() - interval '1 minute',
            attempts = coalesce($2::integer, attempts)
      where id = $1::uuid`,
    [id, attempts ?? null],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  await createUser(db, OWNER, `${OWNER}@hahart.test`);
  await createUser(db, OTHER, `${OTHER}@hahart.test`);
  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [OWNER],
      )
    ).rows,
  ).id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("BL-41: the refund compensation queue", () => {
  it("BL-41: a failed refund is recorded once per job", async () => {
    const jobId = await insertJob();

    const first = await record(jobId, "first failure");
    const second = await record(jobId, "second failure");

    expect(second).toBe(first);

    const count = firstRow(
      (
        await db.query<{ n: number }>(
          "select count(*)::int as n from public.refund_compensations where job_id = $1::uuid",
          [jobId],
        )
      ).rows,
    ).n;
    expect(count).toBe(1);

    const row = await rowOf(first);
    expect(row.last_error).toBe("second failure");
    expect(row.status).toBe("pending");

    const minutesAhead = firstRow(
      (
        await db.query<{ minutes: number }>(
          `select extract(epoch from (next_attempt_at - now())) / 60 as minutes
             from public.refund_compensations where id = $1::uuid`,
          [first],
        )
      ).rows,
    ).minutes;
    expect(Number(minutesAhead)).toBeGreaterThan(4.5);
    expect(Number(minutesAhead)).toBeLessThanOrEqual(5);
  });

  it("BL-41: nothing is due before five minutes", async () => {
    const jobId = await insertJob();
    const id = await record(jobId, "boom");

    const claimed = (await claim(10)).filter((row) => row.id === id);

    expect(claimed).toHaveLength(0);
  });

  it("BL-41: a due row is claimed once and pushed five minutes", async () => {
    const jobId = await insertJob();
    const id = await record(jobId, "boom");
    await makeDue(id);

    const claimed = (await claim(10)).filter((row) => row.id === id);
    expect(claimed).toHaveLength(1);
    expect(firstRow(claimed).attempts).toBe(1);

    const again = (await claim(10)).filter((row) => row.id === id);
    expect(again).toHaveLength(0);

    expect((await rowOf(id)).attempts).toBe(1);
  });

  it("BL-41: success closes the row", async () => {
    const jobId = await insertJob();
    const id = await record(jobId, "boom");
    await makeDue(id);
    await claim(10);

    await expect(finish(id, true, REFUND_TX, null)).resolves.toBe("done");

    const row = await rowOf(id);
    expect(row.status).toBe("done");
    expect(row.refund_transaction_id).toBe(REFUND_TX);

    await makeDue(id);
    expect((await claim(10)).filter((r) => r.id === id)).toHaveLength(0);
  });

  it("BL-41: the twelfth failure exhausts the row", async () => {
    const exhaustedJob = await insertJob();
    const exhaustedId = await record(exhaustedJob, "boom");
    await makeDue(exhaustedId, 11);

    const claimed = (await claim(10)).filter((row) => row.id === exhaustedId);
    expect(firstRow(claimed).attempts).toBe(12);
    await expect(finish(exhaustedId, false, null, "boom")).resolves.toBe("exhausted");
    expect((await rowOf(exhaustedId)).status).toBe("exhausted");
    expect((await rowOf(exhaustedId)).last_error).toBe("boom");

    const pendingJob = await insertJob();
    const pendingId = await record(pendingJob, "boom");
    await makeDue(pendingId, 4);
    const claimedAgain = (await claim(10)).filter((row) => row.id === pendingId);
    expect(firstRow(claimedAgain).attempts).toBe(5);
    await expect(finish(pendingId, false, null, "still failing")).resolves.toBe("pending");
    expect((await rowOf(pendingId)).last_error).toBe("still failing");
  });

  it("BL-41: an exhausted row is not reopened by a new failure", async () => {
    const jobId = await insertJob();
    const id = await record(jobId, "boom");
    await makeDue(id, 11);
    await claim(10);
    await finish(id, false, null, "boom");
    expect((await rowOf(id)).status).toBe("exhausted");

    const again = await record(jobId, "late failure");

    expect(again).toBe(id);
    const row = await rowOf(id);
    expect(row.status).toBe("exhausted");
    expect(row.last_error).toBe("boom");
  });

  it("BL-41: a non positive amount is refused", async () => {
    const jobId = await insertJob();

    let code = "";
    try {
      await db.query(
        `select public.record_refund_compensation(
           $1::uuid, $2::uuid, $3::uuid, 0, 'refund', false, 'x'
         )`,
        [jobId, workspaceId, OWNER],
      );
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }

    expect(code).toBe("22023");
  });

  it("security: a signed-in user cannot call the functions or read the table", async () => {
    const jobId = await insertJob();
    const id = await record(jobId, "boom");

    const calls = [
      `select public.record_refund_compensation('${jobId}'::uuid, '${workspaceId}'::uuid, '${OWNER}'::uuid, 7, 'x', false, 'e')`,
      "select * from public.claim_refund_compensations(10)",
      `select public.finish_refund_compensation('${id}'::uuid, true, null, null)`,
    ];

    for (const sql of calls) {
      let code = "";
      await asUser(db, OWNER, async (tx) => {
        try {
          await tx.exec(sql);
        } catch (error) {
          code = String((error as { code?: unknown }).code);
        }
      });
      expect(code).toBe("42501");
    }

    let tableCode = "";
    let visible = 0;
    await asUser(db, OWNER, async (tx) => {
      try {
        visible = (await tx.query("select id from public.refund_compensations")).rows.length;
      } catch (error) {
        tableCode = String((error as { code?: unknown }).code);
      }
    });
    expect(tableCode === "42501" || visible === 0).toBe(true);
  });
});
