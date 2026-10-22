import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJobConcurrencyRepository } from "../../db/job-concurrency-repository.js";
import { TierGuardError, createTierGuard } from "../../features/credits/tier-guard.js";
import { createMigratedDb, createPGliteTransactionPool, createUser } from "./pglite-db.js";

/**
 * GN-20 acceptance (workorder 39R): the REAL `createTierGuard` over the REAL
 * repository and a real database. A member who already holds 4 unfinished jobs is
 * refused with "并发已满（4/4），请等待当前任务完成"; a member holding 3 is let through.
 */

const MEMBER = "00000000-0000-0000-0000-000000039c01";

let db: PGlite;
let workspaceId = "";
let guard: ReturnType<typeof createTierGuard>;

const INSERT_JOB_SQL = `
insert into public.background_jobs (
  id, workspace_id, queue_name, job_type, status, created_by
) values (
  $1::uuid, $2::uuid, 'member_concurrency_jobs',
  'image_generation'::public.background_job_type,
  'queued'::public.background_job_status, $3::uuid
)
`;

function jobId(n: number): string {
  return `00000000-0000-0000-0000-000000039d${String(n).padStart(2, "0")}`;
}

async function queueJob(n: number): Promise<void> {
  await db.query(INSERT_JOB_SQL, [jobId(n), workspaceId, MEMBER]);
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  const pool = createPGliteTransactionPool(db);
  guard = createTierGuard({
    jobConcurrencyRepository: createJobConcurrencyRepository({
      getTransactionPool: () => pool,
    }),
  });

  await createUser(db, MEMBER, "member-concurrency@hahart.test");
  const row = (
    await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
      [MEMBER],
    )
  ).rows[0];
  if (row === undefined) throw new Error("expected a personal workspace");
  workspaceId = row.id;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("member concurrency flow: GN-20", () => {
  it("GN-20: a member holding 3 queued jobs may submit a fourth", async () => {
    for (const n of [1, 2, 3]) await queueJob(n);

    await expect(
      guard.checkConcurrency(workspaceId, "free", MEMBER),
    ).resolves.toBeUndefined();
  });

  it("GN-20: a member holding 4 queued jobs is refused with 并发已满（4/4）", async () => {
    await queueJob(4);

    const error = await guard
      .checkConcurrency(workspaceId, "free", MEMBER)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TierGuardError);
    expect((error as TierGuardError).code).toBe("concurrency_limit");
    expect((error as TierGuardError).statusCode).toBe(429);
    expect((error as TierGuardError).message).toBe(
      "并发已满（4/4），请等待当前任务完成",
    );
  });
});