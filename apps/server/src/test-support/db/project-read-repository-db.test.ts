import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIND_READABLE_PROJECT,
  LIST_OWN_PROJECTS,
  LIST_READABLE_PRIMARY_CANVASES,
  ProjectReadError,
  createProjectReadRepository,
  type ProjectReadRepository,
} from "../../db/project-read-repository.js";
import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the project read repository (workorder 20B,
 * ADR-0001 migration step 2b).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statement enforces the ACL on a real PostgreSQL parser and planner:
 * the membership join, the author/admin/owner clause, the archived filter, the
 * workspace pinning of the list, `any($3::uuid[])` binding and the rollback
 * path.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database owner, which BYPASSES RLS
 * — that is exactly why every judge below reads through the repository and never
 * through `asUser`: the old policies are not the evidence, the SQL is.
 *
 * One instance is migrated in `beforeAll`, the fixture is built on real tables,
 * and `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000c1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000c2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000c3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000c4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000c5";

const ACTIVE_PROJECT = "aaaa0000-0000-4000-8000-000000000001";
const OLDER_PROJECT = "aaaa0000-0000-4000-8000-000000000002";
const ADMIN_PROJECT = "aaaa0000-0000-4000-8000-000000000003";
const MEMBER_PROJECT = "aaaa0000-0000-4000-8000-000000000004";
const ARCHIVED_PROJECT = "aaaa0000-0000-4000-8000-000000000005";
const OUTSIDER_PROJECT = "aaaa0000-0000-4000-8000-000000000006";
const PERSONAL_PROJECT = "aaaa0000-0000-4000-8000-000000000007";

const ACTIVE_PRIMARY_CANVAS = "bbbb0000-0000-4000-8000-000000000001";
const ACTIVE_SECONDARY_CANVAS = "bbbb0000-0000-4000-8000-000000000002";
const OLDER_PRIMARY_CANVAS = "bbbb0000-0000-4000-8000-000000000003";
const MEMBER_PRIMARY_CANVAS = "bbbb0000-0000-4000-8000-000000000004";
const ARCHIVED_PRIMARY_CANVAS = "bbbb0000-0000-4000-8000-000000000005";

const TEAM_NAME = "HaHart Team";
const ACTIVE_THUMBNAIL = "thumbnail/active.webp";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  workspace_id: string;
  thumbnail_path: string | null;
  archived_at: Date | null;
};

let db: PGlite;
let pool: TransactionPool;
let repository: ProjectReadRepository;

/** Counts `connect()` calls, so "no SQL for an empty id set" is observable. */
let connectAttempts = 0;

let teamWorkspaceId = "";
let authorPersonalWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

function sortedIds(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

async function projectRows(ids: readonly string[]): Promise<ProjectRow[]> {
  const result = await db.query<ProjectRow>(
    `select id, name, slug, description, workspace_id, thumbnail_path, archived_at
       from public.projects
      where id = any($1::uuid[])`,
    [[...ids]],
  );

  return [...result.rows].sort((left, right) => left.id.localeCompare(right.id));
}

async function personalWorkspaceIdOf(userId: string): Promise<string> {
  return firstRow(
    (await db.query<{ id: string }>(
      `select id
         from public.workspaces
        where owner_user_id = $1
          and type = 'personal'`,
      [userId],
    )).rows,
  ).id;
}

async function insertProject(options: {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string;
  updatedAt: string;
  archivedAt?: string;
  thumbnailPath?: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at, thumbnail_path
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      options.id,
      options.workspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      options.archivedAt ?? null,
      "2026-01-01T00:00:00.000Z",
      options.updatedAt,
      options.thumbnailPath ?? null,
    ],
  );
}

async function insertCanvas(options: {
  id: string;
  projectId: string;
  name: string;
  isPrimary: boolean;
}): Promise<void> {
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by)
     values ($1, $2, $3, $4, $5)`,
    [options.id, options.projectId, options.name, options.isPrimary, AUTHOR_ID],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // Real signup path for every identity: the auth.users trigger builds profile,
  // personal workspace and the owner membership.
  await createUser(db, AUTHOR_ID, "author@hahart.test");
  await createUser(db, ADMIN_ID, "admin@hahart.test");
  await createUser(db, OWNER_ID, "owner@hahart.test");
  await createUser(db, MEMBER_ID, "member@hahart.test");
  await createUser(db, OUTSIDER_ID, "outsider@hahart.test");

  authorPersonalWorkspaceId = await personalWorkspaceIdOf(AUTHOR_ID);

  teamWorkspaceId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.workspaces (type, name, owner_user_id)
       values ('team', $1, $2)
       returning id`,
      [TEAM_NAME, OWNER_ID],
    )).rows,
  ).id;

  // AUTHOR is an ordinary member, ADMIN an admin, OWNER the owner. OUTSIDER is a
  // complete user with no team membership at all — and still gets a project row
  // in the team workspace below, so "not a member" is proven by the SQL rather
  // than by the absence of data.
  for (const [userId, role] of [
    [AUTHOR_ID, "member"],
    [ADMIN_ID, "admin"],
    [OWNER_ID, "owner"],
    [MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  await insertProject({
    id: ACTIVE_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Active",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-01-03T00:00:00.000Z",
    thumbnailPath: ACTIVE_THUMBNAIL,
  });
  await insertProject({
    id: OLDER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Older",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await insertProject({
    id: ADMIN_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Admin own",
    createdBy: ADMIN_ID,
    updatedAt: "2026-01-05T00:00:00.000Z",
  });
  await insertProject({
    id: MEMBER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Member own",
    createdBy: MEMBER_ID,
    updatedAt: "2026-01-04T00:00:00.000Z",
  });
  await insertProject({
    id: ARCHIVED_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Archived",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-01-09T00:00:00.000Z",
    archivedAt: ARCHIVED_AT,
  });
  await insertProject({
    id: OUTSIDER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Outsider own",
    createdBy: OUTSIDER_ID,
    updatedAt: "2026-01-07T00:00:00.000Z",
  });
  await insertProject({
    id: PERSONAL_PROJECT,
    workspaceId: authorPersonalWorkspaceId,
    name: "Personal",
    createdBy: AUTHOR_ID,
    updatedAt: "2026-01-08T00:00:00.000Z",
  });

  await insertCanvas({
    id: ACTIVE_PRIMARY_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Main Canvas",
    isPrimary: true,
  });
  await insertCanvas({
    id: ACTIVE_SECONDARY_CANVAS,
    projectId: ACTIVE_PROJECT,
    name: "Second Canvas",
    isPrimary: false,
  });
  await insertCanvas({
    id: OLDER_PRIMARY_CANVAS,
    projectId: OLDER_PROJECT,
    name: "Main Canvas",
    isPrimary: true,
  });
  await insertCanvas({
    id: MEMBER_PRIMARY_CANVAS,
    projectId: MEMBER_PROJECT,
    name: "Main Canvas",
    isPrimary: true,
  });
  await insertCanvas({
    id: ARCHIVED_PRIMARY_CANVAS,
    projectId: ARCHIVED_PROJECT,
    name: "Main Canvas",
    isPrimary: true,
  });

  const pglitePool = createPGliteTransactionPool(db);
  connectAttempts = 0;
  pool = {
    async connect() {
      connectAttempts += 1;
      return pglitePool.connect();
    },
  };
  repository = createProjectReadRepository({ getTransactionPool: () => pool });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("project-read-repository: PGlite real SQL ACL", () => {
  it("case 1: the author reads an active project of their own, mapped from real columns", async () => {
    const project = await repository.findReadableProject({
      actorId: AUTHOR_ID,
      projectId: ACTIVE_PROJECT,
    });

    expect(project).toEqual({
      id: ACTIVE_PROJECT,
      name: "Active",
      slug: ACTIVE_PROJECT,
      description: "description of Active",
      workspace_id: teamWorkspaceId,
      brand_kit_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
    });

    // The uuid really is the uuid PostgreSQL stored, not a formatted copy.
    const stored = firstRow(await projectRows([ACTIVE_PROJECT]));
    expect(stored.workspace_id).toBe(project?.workspace_id);
    expect(stored.thumbnail_path).toBe(ACTIVE_THUMBNAIL);
  });

  it("case 2: admin and owner read someone else's project, an ordinary member and a non-member do not", async () => {
    const asAdmin = await repository.findReadableProject({
      actorId: ADMIN_ID,
      projectId: ACTIVE_PROJECT,
    });
    const asOwner = await repository.findReadableProject({
      actorId: OWNER_ID,
      projectId: ACTIVE_PROJECT,
    });
    expect(asAdmin?.id).toBe(ACTIVE_PROJECT);
    expect(asOwner?.id).toBe(ACTIVE_PROJECT);
    // Reading someone else's project never changes the DTO into a team view.
    expect(asAdmin?.workspace_id).toBe(teamWorkspaceId);

    // A plain member is not the author: nothing, not even a redacted row.
    await expect(
      repository.findReadableProject({
        actorId: MEMBER_ID,
        projectId: ACTIVE_PROJECT,
      }),
    ).resolves.toBeNull();

    // The outsider owns a row in this very workspace and is still refused.
    expect(firstRow(await projectRows([OUTSIDER_PROJECT])).id).toBe(
      OUTSIDER_PROJECT,
    );
    await expect(
      repository.findReadableProject({
        actorId: OUTSIDER_ID,
        projectId: OUTSIDER_PROJECT,
      }),
    ).resolves.toBeNull();

    // The same member reading their own project is allowed.
    expect(
      (
        await repository.findReadableProject({
          actorId: MEMBER_ID,
          projectId: MEMBER_PROJECT,
        })
      )?.id,
    ).toBe(MEMBER_PROJECT);
  });

  it("case 3: an archived project is invisible by id for the author and for an admin", async () => {
    // The row is really there and really archived: the answer comes from the
    // predicate, not from missing data.
    const stored = firstRow(await projectRows([ARCHIVED_PROJECT]));
    expect(stored.archived_at).not.toBeNull();

    await expect(
      repository.findReadableProject({
        actorId: AUTHOR_ID,
        projectId: ARCHIVED_PROJECT,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.findReadableProject({
        actorId: ADMIN_ID,
        projectId: ARCHIVED_PROJECT,
      }),
    ).resolves.toBeNull();
  });

  it("case 4: the own-project list is author + workspace scoped, archive-free and newest first", async () => {
    const projects = await repository.listOwnProjects({
      actorId: AUTHOR_ID,
      workspaceId: teamWorkspaceId,
    });

    expect(projects.map((project) => project.id)).toEqual([
      ACTIVE_PROJECT,
      OLDER_PROJECT,
    ]);
    expect(projects.map((project) => project.updated_at)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    expect(projects[0]?.thumbnail_path).toBe(ACTIVE_THUMBNAIL);
    expect(projects[0]?.workspace_id).toBe(teamWorkspaceId);

    // Archived, other people's and other workspaces' projects stay out.
    const returned = projects.map((project) => project.id);
    for (const excluded of [
      ARCHIVED_PROJECT,
      ADMIN_PROJECT,
      MEMBER_PROJECT,
      OUTSIDER_PROJECT,
      PERSONAL_PROJECT,
    ]) {
      expect(returned).not.toContain(excluded);
    }
  });

  it("case 5: an admin's and an owner's list stay own-only", async () => {
    const asAdmin = await repository.listOwnProjects({
      actorId: ADMIN_ID,
      workspaceId: teamWorkspaceId,
    });
    expect(asAdmin.map((project) => project.id)).toEqual([ADMIN_PROJECT]);

    // The owner can read every project of this workspace by id (case 2) and owns
    // none of them, so the list is empty rather than team-wide.
    await expect(
      repository.listOwnProjects({
        actorId: OWNER_ID,
        workspaceId: teamWorkspaceId,
      }),
    ).resolves.toEqual([]);
  });

  it("case 6: a non-member's list is empty although they authored a row in that workspace", async () => {
    await expect(
      repository.listOwnProjects({
        actorId: OUTSIDER_ID,
        workspaceId: teamWorkspaceId,
      }),
    ).resolves.toEqual([]);

    const asMember = await repository.listOwnProjects({
      actorId: MEMBER_ID,
      workspaceId: teamWorkspaceId,
    });
    expect(asMember.map((project) => project.id)).toEqual([MEMBER_PROJECT]);
  });

  it("case 7: the requested project set bounds the canvas read, and only primary canvases come back", async () => {
    const both = await repository.listReadablePrimaryCanvases({
      actorId: AUTHOR_ID,
      workspaceId: teamWorkspaceId,
      projectIds: [ACTIVE_PROJECT, OLDER_PROJECT],
    });
    expect(sortedIds(both)).toEqual([ACTIVE_PRIMARY_CANVAS, OLDER_PRIMARY_CANVAS]);
    // The non-primary canvas of an otherwise-requested project is not returned.
    expect(sortedIds(both)).not.toContain(ACTIVE_SECONDARY_CANVAS);
    expect(both[0]?.is_primary).toBe(true);

    const onlyActive = await repository.listReadablePrimaryCanvases({
      actorId: AUTHOR_ID,
      workspaceId: teamWorkspaceId,
      projectIds: [ACTIVE_PROJECT],
    });
    expect(sortedIds(onlyActive)).toEqual([ACTIVE_PRIMARY_CANVAS]);
  });

  it("case 8: the canvas read re-applies the ACL instead of trusting the ids it was handed", async () => {
    // Another member's project: the author is a member but neither its author nor
    // an admin/owner there.
    await expect(
      repository.listReadablePrimaryCanvases({
        actorId: AUTHOR_ID,
        workspaceId: teamWorkspaceId,
        projectIds: [MEMBER_PROJECT],
      }),
    ).resolves.toEqual([]);

    // Archived, even when the id is requested explicitly.
    await expect(
      repository.listReadablePrimaryCanvases({
        actorId: AUTHOR_ID,
        workspaceId: teamWorkspaceId,
        projectIds: [ARCHIVED_PROJECT],
      }),
    ).resolves.toEqual([]);

    // A plain member cannot reach the author's project through the canvas read
    // either, and a non-member reaches nothing at all.
    await expect(
      repository.listReadablePrimaryCanvases({
        actorId: MEMBER_ID,
        workspaceId: teamWorkspaceId,
        projectIds: [ACTIVE_PROJECT],
      }),
    ).resolves.toEqual([]);
    await expect(
      repository.listReadablePrimaryCanvases({
        actorId: OUTSIDER_ID,
        workspaceId: teamWorkspaceId,
        projectIds: [OUTSIDER_PROJECT, ACTIVE_PROJECT],
      }),
    ).resolves.toEqual([]);

    // An admin holds the same widening the by-id read gives them, which is why
    // the service only ever passes the ids of the caller's own list.
    const asAdmin = await repository.listReadablePrimaryCanvases({
      actorId: ADMIN_ID,
      workspaceId: teamWorkspaceId,
      projectIds: [ACTIVE_PROJECT, MEMBER_PROJECT],
    });
    expect(sortedIds(asAdmin)).toEqual([
      ACTIVE_PRIMARY_CANVAS,
      MEMBER_PRIMARY_CANVAS,
    ]);
  });

  it("case 9: an empty id set answers [] without opening a connection", async () => {
    connectAttempts = 0;

    const canvases = await repository.listReadablePrimaryCanvases({
      actorId: AUTHOR_ID,
      workspaceId: teamWorkspaceId,
      projectIds: [],
    });

    expect(canvases).toEqual([]);
    expect(connectAttempts).toBe(0);

    // The counter really does observe a read: this one has to open one.
    await repository.findReadableProject({
      actorId: AUTHOR_ID,
      projectId: ACTIVE_PROJECT,
    });
    expect(connectAttempts).toBe(1);
  });

  it("case 10: the list and the canvas read are pinned to the workspace they were asked for", async () => {
    const personal = await repository.listOwnProjects({
      actorId: AUTHOR_ID,
      workspaceId: authorPersonalWorkspaceId,
    });
    expect(personal.map((project) => project.id)).toEqual([PERSONAL_PROJECT]);

    // The team project is not reachable through the personal workspace, and the
    // personal project is not reachable through the team workspace (case 4).
    await expect(
      repository.listReadablePrimaryCanvases({
        actorId: AUTHOR_ID,
        workspaceId: authorPersonalWorkspaceId,
        projectIds: [ACTIVE_PROJECT],
      }),
    ).resolves.toEqual([]);
  });

  it("case 11: an illegal uuid is a real SQL error, then the same pool still reads", async () => {
    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.projects where id = $1", [INVALID_ID]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const detailError = await repository
      .findReadableProject({ actorId: AUTHOR_ID, projectId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(detailError).toBeInstanceOf(ProjectReadError);
    const readError = detailError as ProjectReadError;
    expect(readError.operation).toBe(FIND_READABLE_PROJECT);
    expect(readError.message).toBe(
      `project read failed (${FIND_READABLE_PROJECT})`,
    );
    expect(readError.message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect((readError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // The canvas read reports its own operation for the same class of failure.
    const canvasError = await repository
      .listReadablePrimaryCanvases({
        actorId: AUTHOR_ID,
        workspaceId: teamWorkspaceId,
        projectIds: [INVALID_ID],
      })
      .catch((reason: unknown) => reason);
    expect(canvasError).toBeInstanceOf(ProjectReadError);
    expect((canvasError as ProjectReadError).operation).toBe(
      LIST_READABLE_PRIMARY_CANVASES,
    );

    // A workspace that is not a uuid fails the list the same way.
    const listError = await repository
      .listOwnProjects({ actorId: AUTHOR_ID, workspaceId: INVALID_ID })
      .catch((reason: unknown) => reason);
    expect(listError).toBeInstanceOf(ProjectReadError);
    expect((listError as ProjectReadError).operation).toBe(LIST_OWN_PROJECTS);

    // ROLLBACK plus release left the connection usable for the next read.
    const project = await repository.findReadableProject({
      actorId: AUTHOR_ID,
      projectId: ACTIVE_PROJECT,
    });
    expect(project?.id).toBe(ACTIVE_PROJECT);
  });

  it("case 12: the repository runs its reads in a privileged transaction that still names the actor", async () => {
    const rows = await withPrivilegedTransaction(
      pool,
      { userId: AUTHOR_ID },
      async (client) =>
        (
          await client.query(
            `select
               current_setting('app.user_id', true) as user_id,
               current_setting('app.execution_mode', true) as execution_mode`,
          )
        ).rows,
    );

    expect(rows[0]).toEqual({
      user_id: AUTHOR_ID,
      execution_mode: "privileged",
    });
  });
});
