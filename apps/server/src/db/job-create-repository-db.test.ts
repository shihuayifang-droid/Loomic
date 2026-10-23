import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SELECT_COLS } from "../features/jobs/job-service.js";
import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createJobCreateRepository,
  type JobCreateRepository,
} from "./job-create-repository.js";
import { createProjectCreateRepository } from "./project-create-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44P: job row insert and compensating delete as repository SQL, run
 * on the same cases against the retired supabase migration chain ("legacy") and
 * against the canonical schema ("canonical"). A final group holds the two
 * answers against each other.
 */

const uid = (suffix: string) => `00000000-0000-0000-0000-00000044e0${suffix}`;

const USER_A = uid("01"); // team owner, creates jobs
const USER_B = uid("02"); // another user, creates jobs too

const USERS: readonly (readonly [string, string])[] = [
  [USER_A, "a-44p@hahart.test"],
  [USER_B, "b-44p@hahart.test"],
];

const SELECT_COLUMNS = SELECT_COLS.split(",").map((column) => column.trim());

type Fixture = {
  db: PGlite;
  repository: JobCreateRepository;
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function finishSetup(db: PGlite): Promise<Fixture> {
  const team = await db.query<{ r: string }>(
    "select public.ensure_team_workspace($1::uuid, 'HaHart Team') as r",
    [USER_A],
  );
  const workspaceId = firstRow(team.rows).r;
  const pool = createPGliteTransactionPool(db);
  const created = await createProjectCreateRepository({
    getTransactionPool: () => pool,
  }).createProjectWithCanvas({
    actorId: USER_A,
    workspaceId,
    name: "Jobs project",
    slug: "jobs-44p",
    description: null,
    canvasName: "Main Canvas",
  });
  return {
    db,
    workspaceId,
    projectId: created.project.id,
    canvasId: created.canvas.id,
    repository: createJobCreateRepository({ getTransactionPool: () => pool }),
  };
}

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  for (const [id, email] of USERS) await createUser(db, id, email);
  return finishSetup(db);
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  for (const [id, email] of USERS) await createCanonicalUser(db, id, email);
  return finishSetup(db);
}

function baseInput(fx: Fixture, actorId = USER_A) {
  return {
    actorId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    canvasId: fx.canvasId,
    sessionId: null,
    threadId: "thread-44p",
    queueName: "image_generation_jobs",
    jobType: "image_generation",
    payload: { prompt: "a cat", nested: { n: 1, list: [1, 2] } },
  };
}

async function jobExists(db: PGlite, id: string): Promise<boolean> {
  const result = await db.query<{ n: number }>(
    "select count(*)::int as n from public.background_jobs where id = $1::uuid",
    [id],
  );
  return firstRow(result.rows).n === 1;
}

const results: Record<string, { keys: string[]; status: unknown }> = {};

function describeSuite(
  label: "legacy" | "canonical",
  setup: () => Promise<Fixture>,
) {
  describe(`job create repository (${label})`, () => {
    let fx: Fixture;

    beforeAll(async () => {
      fx = await setup();
    });

    afterAll(async () => {
      await fx.db.close();
    });

    it("inserts one row with exactly the SELECT_COLS keys and the written values", async () => {
      const row = await fx.repository.insertOwnJob(baseInput(fx));

      expect(Object.keys(row).sort()).toEqual([...SELECT_COLUMNS].sort());
      expect(row.id).toEqual(expect.any(String));
      expect(row.status).toBe("queued");
      expect(row.created_by).toBe(USER_A);
      expect(row.workspace_id).toBe(fx.workspaceId);
      expect(row.project_id).toBe(fx.projectId);
      expect(row.canvas_id).toBe(fx.canvasId);
      expect(row.session_id).toBeNull();
      expect(row.thread_id).toBe("thread-44p");
      expect(row.queue_name).toBe("image_generation_jobs");
      expect(row.job_type).toBe("image_generation");
      expect(row.payload).toEqual({ prompt: "a cat", nested: { n: 1, list: [1, 2] } });
      expect(row.result).toBeNull();
      expect(row.error_code).toBeNull();
      expect(row.attempt_count).toBe(0);

      expect(typeof row.created_at).toBe("string");
      expect(typeof row.updated_at).toBe("string");
      expect(Number.isNaN(new Date(row.created_at as string).getTime())).toBe(false);
      expect(Number.isNaN(new Date(row.updated_at as string).getTime())).toBe(false);
      expect(row.started_at).toBeNull();
      expect(row.completed_at).toBeNull();
      expect(row.failed_at).toBeNull();
      expect(row.canceled_at).toBeNull();

      results[label] = { keys: Object.keys(row), status: row.status };
    });

    it("stores nulls for project, canvas, session and thread when given null", async () => {
      const row = await fx.repository.insertOwnJob({
        ...baseInput(fx),
        projectId: null,
        canvasId: null,
        threadId: null,
      });

      expect(row.project_id).toBeNull();
      expect(row.canvas_id).toBeNull();
      expect(row.session_id).toBeNull();
      expect(row.thread_id).toBeNull();
    });

    it("created_by is the actor, and client_request_id is stored when given", async () => {
      const row = await fx.repository.insertOwnJob({
        ...baseInput(fx, USER_B),
        clientRequestId: "req-44p-actor-1",
      });
      expect(row.created_by).toBe(USER_B);

      const stored = firstRow(
        (
          await fx.db.query<{ created_by: string; client_request_id: string | null }>(
            "select created_by::text as created_by, client_request_id from public.background_jobs where id = $1::uuid",
            [row.id],
          )
        ).rows,
      );
      expect(stored.created_by).toBe(USER_B);
      expect(stored.client_request_id).toBe("req-44p-actor-1");
    });

    it("the same client_request_id twice for one actor is 23505", async () => {
      await fx.repository.insertOwnJob({
        ...baseInput(fx),
        clientRequestId: "req-44p-dup-1",
      });

      const error = await fx.repository
        .insertOwnJob({ ...baseInput(fx), clientRequestId: "req-44p-dup-1" })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: unknown }).code).toBe("23505");
    });

    it("deleteOwnJob removes the actor's own job and reports 1", async () => {
      const row = await fx.repository.insertOwnJob(baseInput(fx));
      const id = row.id as string;

      await expect(fx.repository.deleteOwnJob({ actorId: USER_A, jobId: id })).resolves.toBe(1);
      expect(await jobExists(fx.db, id)).toBe(false);
    });

    it("deleteOwnJob on another user's job reports 0 and the row stays", async () => {
      const row = await fx.repository.insertOwnJob(baseInput(fx, USER_A));
      const id = row.id as string;

      await expect(fx.repository.deleteOwnJob({ actorId: USER_B, jobId: id })).resolves.toBe(0);
      expect(await jobExists(fx.db, id)).toBe(true);
    });
  });
}

describeSuite("legacy", setupLegacy);
describeSuite("canonical", setupCanonical);

describe("job create repository: both databases agree", () => {
  it("returns the same keys and the same initial status", () => {
    expect(results.legacy).toBeDefined();
    expect(results.canonical).toBeDefined();
    expect(results.canonical?.keys).toEqual(results.legacy?.keys);
    expect(results.canonical?.status).toBe(results.legacy?.status);
  });
});
