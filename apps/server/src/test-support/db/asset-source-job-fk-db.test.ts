import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createMigratedDb, createUser } from "./pglite-db.js";

/**
 * GN-12: `asset_objects.source_job_id` is a hard link to `background_jobs.id`.
 *
 * Four properties, each one a different way the link can be wrong:
 *   1. a real job can be joined to the artifact it produced;
 *   2. an id that names no job is refused by the database (SQLSTATE 23503), not by
 *      application code that might forget to check;
 *   3. ON DELETE SET NULL keeps the artifact and its provenance (model, prompt) when
 *      GN-29 removes the old job row - only the link goes;
 *   4. a user upload has no job and must still insert.
 *
 * The migration itself is applied by `createMigratedDb`, so a broken constraint
 * definition fails in `beforeAll` with the migration file named in the error.
 */
const USER_A = "00000000-0000-0000-0000-00000000000a";
const BUCKET = "project-assets";

let db: PGlite;
let workspaceId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** A queued image job owned by USER_A; `background_jobs.created_by` is the owner. */
async function insertJob(): Promise<string> {
  return firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
         values ($1::uuid, 'image_generation', 'image_generation', $2::uuid)
         returning id`,
        [workspaceId, USER_A],
      )
    ).rows,
  ).id;
}

/**
 * An asset row with only the columns the table requires (`workspace_id`, `bucket`,
 * `object_path`) plus whatever provenance the caller supplies. `object_path` is
 * unique per (bucket, object_path), so it carries the row id.
 */
async function insertAsset(options: {
  sourceJobId: string | null;
  modelId?: string | null;
  prompt?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.asset_objects (
       id, workspace_id, project_id, bucket, object_path, created_by,
       source_job_id, model_id, prompt
     )
     values ($1::uuid, $2::uuid, null, $3, $4, $5::uuid, $6::uuid, $7, $8)`,
    [
      id,
      workspaceId,
      BUCKET,
      `${workspaceId}/${id}.png`,
      USER_A,
      options.sourceJobId,
      options.modelId ?? null,
      options.prompt ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  await createUser(db, USER_A, "a@hahart.test");

  workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1::uuid and type = 'personal'",
        [USER_A],
      )
    ).rows,
  ).id;
}, 120_000);

describe("GN-12: asset_objects.source_job_id is a hard link to background_jobs", () => {
  it("case 1: an artifact can be joined to the job that produced it", async () => {
    const jobId = await insertJob();
    const assetId = await insertAsset({ sourceJobId: jobId });

    const rows = (
      await db.query<{ asset_id: string; job_id: string }>(
        `select a.id::text as asset_id, j.id::text as job_id
           from public.asset_objects a
           join public.background_jobs j on j.id = a.source_job_id
          where a.id = $1::uuid`,
        [assetId],
      )
    ).rows;

    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ asset_id: assetId, job_id: jobId });
  });

  it("case 2: an artifact cannot point at a job that does not exist", async () => {
    const missingJobId = randomUUID();
    let refused = { code: "", message: "" };

    try {
      await insertAsset({ sourceJobId: missingJobId });
    } catch (error) {
      const cause = error as { code?: unknown; message?: unknown };
      refused = { code: String(cause.code), message: String(cause.message) };
    }

    expect(refused.code).toBe("23503");
    expect(refused.message).toMatch(/asset_objects_source_job_fkey/);

    // The refused row is not there either: the whole statement rolled back.
    const survivors = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.asset_objects where source_job_id = $1::uuid",
        [missingJobId],
      )
    ).rows;
    expect(firstRow(survivors).n).toBe(0);
  });

  it("case 3: deleting the job keeps the artifact and its provenance", async () => {
    const jobId = await insertJob();
    const assetId = await insertAsset({
      sourceJobId: jobId,
      modelId: "sdxl-1.0",
      prompt: "a fox in the snow",
    });

    await db.query("delete from public.background_jobs where id = $1::uuid", [jobId]);

    const row = firstRow(
      (
        await db.query<{
          source_job_id: string | null;
          model_id: string | null;
          prompt: string | null;
        }>(
          `select source_job_id::text as source_job_id, model_id, prompt
             from public.asset_objects
            where id = $1::uuid`,
          [assetId],
        )
      ).rows,
    );

    expect(row.source_job_id).toBeNull();
    expect(row.model_id).toBe("sdxl-1.0");
    expect(row.prompt).toBe("a fox in the snow");
  });

  it("case 4: user uploads carry no job", async () => {
    const assetId = await insertAsset({ sourceJobId: null });

    const row = firstRow(
      (
        await db.query<{ source_job_id: string | null }>(
          "select source_job_id::text as source_job_id from public.asset_objects where id = $1::uuid",
          [assetId],
        )
      ).rows,
    );

    expect(row.source_job_id).toBeNull();
  });
});
