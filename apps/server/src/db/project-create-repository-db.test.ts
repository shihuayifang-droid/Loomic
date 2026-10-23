import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCanonicalDb, createCanonicalUser } from "../test-support/db/canonical-db.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createProjectCreateRepository,
  type CreatedProjectRow,
  type ProjectCreateRepository,
} from "./project-create-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44O: project creation as repository SQL, run on the same cases
 * against the retired supabase migration chain ("legacy") and against the
 * canonical schema ("canonical"). The legacy group also compares the result with
 * the removed database function, called as the member.
 */

const uid = (suffix: string) => `00000000-0000-0000-0000-00000044f0${suffix}`;

const USER_O = uid("01"); // team owner
const USER_A = uid("02"); // team member, creates projects
const USER_X = uid("03"); // never in the team

const USERS: readonly (readonly [string, string])[] = [
  [USER_O, "o-44o@hahart.test"],
  [USER_A, "a-44o@hahart.test"],
  [USER_X, "x-44o@hahart.test"],
];

type Fixture = {
  db: PGlite;
  repository: ProjectCreateRepository;
  teamId: string;
};

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function finishSetup(db: PGlite): Promise<Fixture> {
  const team = await db.query<{ r: string }>(
    "select public.ensure_team_workspace($1::uuid, 'HaHart Team') as r",
    [USER_O],
  );
  const teamId = firstRow(team.rows).r;
  await db.query("select public.add_team_member($1::uuid, 'member')", [USER_A]);
  const pool = createPGliteTransactionPool(db);
  return {
    db,
    teamId,
    repository: createProjectCreateRepository({ getTransactionPool: () => pool }),
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

async function rowCounts(db: PGlite): Promise<{ projects: number; canvases: number }> {
  const projects = firstRow(
    (await db.query<{ n: number }>("select count(*)::int as n from public.projects")).rows,
  ).n;
  const canvases = firstRow(
    (await db.query<{ n: number }>("select count(*)::int as n from public.canvases")).rows,
  ).n;
  return { projects, canvases };
}

function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, shapeOf(entry)]),
    );
  }
  return typeof value;
}

function describeSuite(
  label: "legacy" | "canonical",
  setup: () => Promise<Fixture>,
) {
  describe(`project create repository (${label})`, () => {
    let fx: Fixture;

    beforeAll(async () => {
      fx = await setup();
    });

    afterAll(async () => {
      await fx.db.close();
    });

    it("a member creates a project and its primary canvas", async () => {
      const before = await rowCounts(fx.db);

      const created = await fx.repository.createProjectWithCanvas({
        actorId: USER_A,
        workspaceId: fx.teamId,
        name: "First",
        slug: "first-1",
        description: "about it",
        canvasName: "Main Canvas",
      });

      expect(created.project.id).toEqual(expect.any(String));
      expect(created.project.name).toBe("First");
      expect(created.project.slug).toBe("first-1");
      expect(created.project.description).toBe("about it");
      expect(created.project.workspace_id).toBe(fx.teamId);
      expect(typeof created.project.created_at).toBe("string");
      expect(typeof created.project.updated_at).toBe("string");
      expect(created.canvas.name).toBe("Main Canvas");
      expect(created.canvas.is_primary).toBe(true);

      const after = await rowCounts(fx.db);
      expect(after).toEqual({
        projects: before.projects + 1,
        canvases: before.canvases + 1,
      });

      const project = firstRow(
        (
          await fx.db.query<{ created_by: string }>(
            "select created_by from public.projects where id = $1::uuid",
            [created.project.id],
          )
        ).rows,
      );
      expect(project.created_by).toBe(USER_A);
      const canvas = firstRow(
        (
          await fx.db.query<{
            created_by: string;
            is_primary: boolean;
            project_id: string;
          }>(
            "select created_by, is_primary, project_id from public.canvases where id = $1::uuid",
            [created.canvas.id],
          )
        ).rows,
      );
      expect(canvas.created_by).toBe(USER_A);
      expect(canvas.is_primary).toBe(true);
      expect(canvas.project_id).toBe(created.project.id);
    });

    it("a non-member is refused with 42501 and nothing is written", async () => {
      const before = await rowCounts(fx.db);

      const error = await fx.repository
        .createProjectWithCanvas({
          actorId: USER_X,
          workspaceId: fx.teamId,
          name: "Nope",
          slug: "nope-1",
          description: "",
          canvasName: "Main Canvas",
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: unknown }).code).toBe("42501");
      expect(await rowCounts(fx.db)).toEqual(before);
    });

    it("the same slug twice in one workspace is 23505 and leaves no orphan rows", async () => {
      await fx.repository.createProjectWithCanvas({
        actorId: USER_A,
        workspaceId: fx.teamId,
        name: "Dup",
        slug: "dup-1",
        description: "",
        canvasName: "Main Canvas",
      });
      const before = await rowCounts(fx.db);

      const error = await fx.repository
        .createProjectWithCanvas({
          actorId: USER_A,
          workspaceId: fx.teamId,
          name: "Dup again",
          slug: "dup-1",
          description: "",
          canvasName: "Main Canvas",
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: unknown }).code).toBe("23505");
      expect(await rowCounts(fx.db)).toEqual(before);
    });

    it("an empty description and a null description are stored as given", async () => {
      const empty = await fx.repository.createProjectWithCanvas({
        actorId: USER_A,
        workspaceId: fx.teamId,
        name: "Empty desc",
        slug: "empty-desc-1",
        description: "",
        canvasName: "Main Canvas",
      });
      const nulled = await fx.repository.createProjectWithCanvas({
        actorId: USER_A,
        workspaceId: fx.teamId,
        name: "Null desc",
        slug: "null-desc-1",
        description: null,
        canvasName: "Main Canvas",
      });

      expect(empty.project.description).toBe("");
      expect(nulled.project.description).toBeNull();

      const stored = await fx.db.query<{ slug: string; description: string | null }>(
        "select slug, description from public.projects where slug in ('empty-desc-1', 'null-desc-1') order by slug",
      );
      expect(stored.rows).toEqual([
        { slug: "empty-desc-1", description: "" },
        { slug: "null-desc-1", description: null },
      ]);
    });
  });
}

describeSuite("legacy", setupLegacy);
describeSuite("canonical", setupCanonical);

describe("project create repository: against the removed database function (legacy only)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupLegacy();
  });

  afterAll(async () => {
    await fx.db.close();
  });

  async function viaFunction(slug: string, description: string): Promise<CreatedProjectRow> {
    const result = await asUser(fx.db, USER_A, (tx) =>
      tx.query<{ j: CreatedProjectRow }>(
        "select public.create_project_with_canvas($1::uuid, $2::text, $3::text, $4::text, $5::text) as j",
        [fx.teamId, "Compare", slug, description, "Main Canvas"],
      ),
    );
    return firstRow(result.rows).j;
  }

  it("returns the same keys, types and values as the function did", async () => {
    const fromFunction = await viaFunction("compare-fn-1", "same text");
    const fromRepository = await fx.repository.createProjectWithCanvas({
      actorId: USER_A,
      workspaceId: fx.teamId,
      name: "Compare",
      slug: "compare-repo-1",
      description: "same text",
      canvasName: "Main Canvas",
    });

    expect(shapeOf(fromRepository)).toEqual(shapeOf(fromFunction));
    expect(fromRepository.project.name).toBe(fromFunction.project.name);
    expect(fromRepository.project.description).toBe(fromFunction.project.description);
    expect(fromRepository.project.workspace_id).toBe(fromFunction.project.workspace_id);
    expect(fromRepository.canvas.name).toBe(fromFunction.canvas.name);
    expect(fromRepository.canvas.is_primary).toBe(fromFunction.canvas.is_primary);
  });

  it("an empty description is stored the same way as the function stored it", async () => {
    const stored = async (id: string) =>
      firstRow(
        (
          await fx.db.query<{ description: string | null }>(
            "select description from public.projects where id = $1::uuid",
            [id],
          )
        ).rows,
      ).description;

    const fn = await viaFunction("compare-fn-2", "");
    const repo = await fx.repository.createProjectWithCanvas({
      actorId: USER_A,
      workspaceId: fx.teamId,
      name: "Compare",
      slug: "compare-repo-2",
      description: "",
      canvasName: "Main Canvas",
    });

    expect(await stored(repo.project.id)).toBe(await stored(fn.project.id));
  });
});
