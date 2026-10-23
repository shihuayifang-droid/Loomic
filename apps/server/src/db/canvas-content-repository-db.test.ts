import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createCanonicalDb,
  createCanonicalUser,
} from "../test-support/db/canonical-db.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../test-support/db/pglite-db.js";
import {
  createCanvasContentRepository,
  type CanvasContentRepository,
} from "./canvas-content-repository.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Workorder 44T: canvas content read / conditional write as repository SQL, run
 * on the same cases against the retired migration chain ("legacy") and against
 * the canonical schema ("canonical"). The legacy group additionally compares the
 * repository with the old row-level-security policies, row count for row count,
 * for every identity x canvas combination.
 */

const uid = (suffix: string) => `00000000-0000-0000-0000-00000044e0${suffix}`;

const AUTHOR = uid("01"); // plain member, authors the project of canvas A
const MEMBER = uid("02"); // plain member, authors the project of canvas M
const ADMIN = uid("03"); // workspace admin
const OWNER = uid("04"); // workspace owner
const OUTSIDER = uid("05"); // never a member

const USERS: readonly (readonly [string, string])[] = [
  [AUTHOR, "author-44t@hahart.test"],
  [MEMBER, "member-44t@hahart.test"],
  [ADMIN, "admin-44t@hahart.test"],
  [OWNER, "owner-44t@hahart.test"],
  [OUTSIDER, "outsider-44t@hahart.test"],
];

const IDENTITIES: readonly (readonly [string, string])[] = [
  ["author", AUTHOR],
  ["member", MEMBER],
  ["admin", ADMIN],
  ["owner", OWNER],
  ["outsider", OUTSIDER],
];

const PROJECT_A = "44e00000-0000-4000-8000-000000000001";
const PROJECT_M = "44e00000-0000-4000-8000-000000000002";
const PROJECT_ARCHIVED = "44e00000-0000-4000-8000-000000000003";
const PROJECT_OUTSIDER = "44e00000-0000-4000-8000-000000000004";

const CANVAS_A = "44e10000-0000-4000-8000-000000000001";
const CANVAS_M = "44e10000-0000-4000-8000-000000000002";
const CANVAS_ARCHIVED = "44e10000-0000-4000-8000-000000000003";
const CANVAS_OUTSIDER = "44e10000-0000-4000-8000-000000000004";
const CANVAS_MISSING = "44e10000-0000-4000-8000-00000000000f";

const CANVASES: readonly (readonly [string, string])[] = [
  ["author's", CANVAS_A],
  ["member's", CANVAS_M],
  ["archived (author's)", CANVAS_ARCHIVED],
  ["outsider's", CANVAS_OUTSIDER],
  ["missing", CANVAS_MISSING],
];

const INITIAL_VERSION = 4;
const INITIAL_CONTENT = { elements: [{ id: "el-1", type: "rectangle" }], appState: {} };

type Fixture = {
  db: PGlite;
  repository: CanvasContentRepository;
  workspaceId: string;
};

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function seed(db: PGlite): Promise<Fixture> {
  const workspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', 'HaHart 44T Team', $1)
         returning id`,
        [OWNER],
      )
    ).rows,
  ).id;

  for (const [userId, role] of [
    [AUTHOR, "member"],
    [MEMBER, "member"],
    [ADMIN, "admin"],
    [OWNER, "owner"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)
       on conflict (workspace_id, user_id) do update set role = excluded.role`,
      [workspaceId, userId, role],
    );
  }

  const projects: readonly (readonly [string, string, string, string | null])[] = [
    [PROJECT_A, "proj-a", AUTHOR, null],
    [PROJECT_M, "proj-m", MEMBER, null],
    [PROJECT_ARCHIVED, "proj-archived", AUTHOR, "2026-01-09T00:00:00.000Z"],
    [PROJECT_OUTSIDER, "proj-outsider", OUTSIDER, null],
  ];
  for (const [id, slug, createdBy, archivedAt] of projects) {
    await db.query(
      `insert into public.projects (id, workspace_id, name, slug, created_by, archived_at)
       values ($1, $2, $3, $3, $4, $5)`,
      [id, workspaceId, slug, createdBy, archivedAt],
    );
  }

  const canvases: readonly (readonly [string, string, string, string])[] = [
    [CANVAS_A, PROJECT_A, "Canvas A", AUTHOR],
    [CANVAS_M, PROJECT_M, "Canvas M", MEMBER],
    [CANVAS_ARCHIVED, PROJECT_ARCHIVED, "Canvas Archived", AUTHOR],
    [CANVAS_OUTSIDER, PROJECT_OUTSIDER, "Canvas Outsider", OUTSIDER],
  ];
  for (const [id, projectId, name, createdBy] of canvases) {
    await db.query(
      `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
       values ($1, $2, $3, true, $4, $5::jsonb, $6)`,
      [id, projectId, name, createdBy, JSON.stringify(INITIAL_CONTENT), INITIAL_VERSION],
    );
  }

  const pool = createPGliteTransactionPool(db);
  return {
    db,
    workspaceId,
    repository: createCanvasContentRepository({ getTransactionPool: () => pool }),
  };
}

async function setupLegacy(): Promise<Fixture> {
  const { db } = await createMigratedDb();
  for (const [id, email] of USERS) await createUser(db, id, email);
  return seed(db);
}

async function setupCanonical(): Promise<Fixture> {
  const { db } = await createCanonicalDb();
  for (const [id, email] of USERS) await createCanonicalUser(db, id, email);
  return seed(db);
}

async function stored(
  db: PGlite,
  canvasId: string,
): Promise<{ content: unknown; version: number }> {
  return firstRow(
    (
      await db.query<{ content: unknown; version: number }>(
        "select content, version from public.canvases where id = $1::uuid",
        [canvasId],
      )
    ).rows,
  );
}

function describeSuite(label: "legacy" | "canonical", setup: () => Promise<Fixture>) {
  describe(`canvas content repository (${label})`, () => {
    let fx: Fixture;

    beforeAll(async () => {
      fx = await setup();
    });

    afterAll(async () => {
      await fx.db.close();
    });

    it("the author reads their own canvas as a whole row", async () => {
      const row = await fx.repository.readCanvasRow({ actorId: AUTHOR, canvasId: CANVAS_A });

      expect(row).toEqual({
        id: CANVAS_A,
        name: "Canvas A",
        project_id: PROJECT_A,
        content: INITIAL_CONTENT,
        version: INITIAL_VERSION,
      });
      expect(Object.keys(row ?? {}).sort()).toEqual([
        "content",
        "id",
        "name",
        "project_id",
        "version",
      ]);
    });

    it("an ordinary member cannot read another member's canvas", async () => {
      await expect(
        fx.repository.readCanvasRow({ actorId: MEMBER, canvasId: CANVAS_A }),
      ).resolves.toBeNull();
      await expect(
        fx.repository.readCanvasRow({ actorId: AUTHOR, canvasId: CANVAS_M }),
      ).resolves.toBeNull();
    });

    it("an admin and an owner can read somebody else's canvas", async () => {
      for (const actorId of [ADMIN, OWNER]) {
        const row = await fx.repository.readCanvasRow({ actorId, canvasId: CANVAS_A });
        expect(row?.id).toBe(CANVAS_A);
        expect(row?.version).toBe(INITIAL_VERSION);
      }
    });

    it("a non-member cannot read, not even a canvas of a project they authored", async () => {
      await expect(
        fx.repository.readCanvasRow({ actorId: OUTSIDER, canvasId: CANVAS_A }),
      ).resolves.toBeNull();
      await expect(
        fx.repository.readCanvasRow({ actorId: OUTSIDER, canvasId: CANVAS_OUTSIDER }),
      ).resolves.toBeNull();
    });

    it("a canvas that does not exist reads as null", async () => {
      await expect(
        fx.repository.readCanvasRow({ actorId: AUTHOR, canvasId: CANVAS_MISSING }),
      ).resolves.toBeNull();
    });

    it("the author still reads the canvas of an archived project", async () => {
      const row = await fx.repository.readCanvasRow({
        actorId: AUTHOR,
        canvasId: CANVAS_ARCHIVED,
      });

      expect(row?.id).toBe(CANVAS_ARCHIVED);
      expect(row?.project_id).toBe(PROJECT_ARCHIVED);
    });

    it("the author writes when the version matches and gets version + 1", async () => {
      const content = { elements: [{ id: "el-2", type: "ellipse" }], appState: { zoom: 2 } };

      const result = await fx.repository.writeIfUnchanged({
        actorId: AUTHOR,
        canvasId: CANVAS_A,
        content,
        expectedVersion: INITIAL_VERSION,
      });

      expect(result).toEqual({ version: INITIAL_VERSION + 1 });
      expect(await stored(fx.db, CANVAS_A)).toEqual({
        content,
        version: INITIAL_VERSION + 1,
      });
    });

    it("a stale version answers null and leaves the content alone", async () => {
      const before = await stored(fx.db, CANVAS_A);

      const result = await fx.repository.writeIfUnchanged({
        actorId: AUTHOR,
        canvasId: CANVAS_A,
        content: { elements: [], appState: { stale: true } },
        expectedVersion: INITIAL_VERSION,
      });

      expect(result).toBeNull();
      expect(await stored(fx.db, CANVAS_A)).toEqual(before);
    });

    it("an admin cannot write somebody else's canvas", async () => {
      const before = await stored(fx.db, CANVAS_M);

      for (const actorId of [ADMIN, OWNER]) {
        await expect(
          fx.repository.writeIfUnchanged({
            actorId,
            canvasId: CANVAS_M,
            content: { elements: [], appState: { by: "admin" } },
            expectedVersion: before.version,
          }),
        ).resolves.toBeNull();
      }

      expect(await stored(fx.db, CANVAS_M)).toEqual(before);
    });

    it("a member who is not the author cannot write, and neither can a non-member", async () => {
      const before = await stored(fx.db, CANVAS_M);

      for (const actorId of [AUTHOR, OUTSIDER]) {
        await expect(
          fx.repository.writeIfUnchanged({
            actorId,
            canvasId: CANVAS_M,
            content: { elements: [], appState: { by: "other" } },
            expectedVersion: before.version,
          }),
        ).resolves.toBeNull();
      }
      await expect(
        fx.repository.writeIfUnchanged({
          actorId: OUTSIDER,
          canvasId: CANVAS_OUTSIDER,
          content: { elements: [] },
          expectedVersion: INITIAL_VERSION,
        }),
      ).resolves.toBeNull();

      expect(await stored(fx.db, CANVAS_M)).toEqual(before);
    });

    it("a canvas that does not exist writes as null", async () => {
      await expect(
        fx.repository.writeIfUnchanged({
          actorId: AUTHOR,
          canvasId: CANVAS_MISSING,
          content: {},
          expectedVersion: 0,
        }),
      ).resolves.toBeNull();
    });
  });
}

class RollbackWith<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

/** Run `fn` as the user inside a transaction that is always rolled back. */
async function rolledBack<T>(
  db: PGlite,
  userId: string,
  fn: (tx: Parameters<Parameters<typeof asUser>[2]>[0]) => Promise<T>,
): Promise<T> {
  try {
    await asUser(db, userId, async (tx) => {
      throw new RollbackWith(await fn(tx));
    });
  } catch (error) {
    if (error instanceof RollbackWith) return error.value as T;
    throw error;
  }
  throw new Error("transaction did not roll back");
}

describeSuite("legacy", setupLegacy);
describeSuite("canonical", setupCanonical);

describe("canvas content repository vs the old RLS policies (legacy)", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupLegacy();
  });

  afterAll(async () => {
    await fx.db.close();
  });

  it("read: every identity x canvas sees the same row count as the policy", async () => {
    let compared = 0;

    for (const [identityLabel, actorId] of IDENTITIES) {
      for (const [canvasLabel, canvasId] of CANVASES) {
        const rlsRows = await rolledBack(fx.db, actorId, async (tx) => {
          const result = await tx.query(
            "select id, content, version from public.canvases where id = $1::uuid",
            [canvasId],
          );
          return result.rows.length;
        });
        const row = await fx.repository.readCanvasRow({ actorId, canvasId });
        const repositoryRows = row === null ? 0 : 1;

        expect([identityLabel, canvasLabel, repositoryRows]).toEqual([
          identityLabel,
          canvasLabel,
          rlsRows,
        ]);
        compared += 1;
      }
    }

    expect(compared).toBe(IDENTITIES.length * CANVASES.length);
  });

  it("write: every identity x canvas updates the same row count as the policy", async () => {
    let compared = 0;
    let anyWrote = false;
    let anyRefused = false;

    for (const [identityLabel, actorId] of IDENTITIES) {
      for (const [canvasLabel, canvasId] of CANVASES) {
        const current = (await fx.db.query<{ version: number }>(
          "select version from public.canvases where id = $1::uuid",
          [canvasId],
        )).rows[0];
        const expectedVersion = current?.version ?? 0;

        const rlsRows = await rolledBack(fx.db, actorId, async (tx) => {
          const result = await tx.query(
            `update public.canvases
                set content = $2::jsonb, version = $3::int + 1
              where id = $1::uuid and version = $3::int
          returning id`,
            [canvasId, JSON.stringify({ elements: [], appState: { by: identityLabel } }), expectedVersion],
          );
          return result.rows.length;
        });

        const written = await fx.repository.writeIfUnchanged({
          actorId,
          canvasId,
          content: { elements: [], appState: { by: identityLabel } },
          expectedVersion,
        });
        const repositoryRows = written === null ? 0 : 1;

        expect([identityLabel, canvasLabel, repositoryRows]).toEqual([
          identityLabel,
          canvasLabel,
          rlsRows,
        ]);
        if (repositoryRows === 1) anyWrote = true;
        else anyRefused = true;
        compared += 1;
      }
    }

    expect(compared).toBe(IDENTITIES.length * CANVASES.length);
    // The comparison is not vacuous: some cells write, some are refused.
    expect(anyWrote).toBe(true);
    expect(anyRefused).toBe(true);
  });
});
