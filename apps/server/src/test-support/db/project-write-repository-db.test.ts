import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ARCHIVE_OWN_PROJECT,
  SET_OWN_PROJECT_THUMBNAIL,
  UPDATE_OWN_PROJECT,
  ProjectWriteError,
  createProjectWriteRepository,
  type ProjectWriteRepository,
} from "../../db/project-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the project WRITE repository (workorder 21AA),
 * measured against `projects_update_owner`.
 *
 * The point of this file is NOT "the statements run". It is that a privileged
 * connection bypasses row level security, so each statement's OWN predicate is the
 * whole authorisation rule — and the only honest way to check a rule like that is to
 * have a second identity try to break it and then look at the DATA.
 *
 * Every identity is therefore measured three ways:
 *
 *   1. through the repository (privileged, the ACL is the statement);
 *   2. through `asUser()` — the SAME domain intent replayed as the pre-migration
 *      PostgREST write, i.e. `update … where id = $1` with no predicate of its own,
 *      so the POLICY decides;
 *   3. against the stored row, which is what both answers are supposed to describe.
 *
 * Two of those agreeing on "nothing changed" is what makes this a migration rather
 * than a new permission; a disagreement would be exactly the silent ACL fork
 * workorder 21V warns about.
 *
 * PGlite runs in-process: no server, no socket, no `DATABASE_URL`, no host. One
 * instance is migrated in `beforeAll`, identities are created through the real
 * signup trigger, and `afterAll` closes it.
 */

const AUTHOR_ID = "00000000-0000-0000-0000-0000000000c1";
const ADMIN_ID = "00000000-0000-0000-0000-0000000000c2";
const OWNER_ID = "00000000-0000-0000-0000-0000000000c3";
const MEMBER_ID = "00000000-0000-0000-0000-0000000000c4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000c5";
/** A project author who holds NO membership row in the project's workspace. */
const FORMER_MEMBER_ID = "00000000-0000-0000-0000-0000000000c6";

const AUTHOR_PROJECT = "aaaa0000-0000-4000-8000-000000000001";
const ARCHIVED_PROJECT = "aaaa0000-0000-4000-8000-000000000002";
const ADMIN_PROJECT = "aaaa0000-0000-4000-8000-000000000003";
const MEMBER_PROJECT = "aaaa0000-0000-4000-8000-000000000004";
const OUTSIDER_PROJECT = "aaaa0000-0000-4000-8000-000000000005";
const FORMER_PROJECT = "aaaa0000-0000-4000-8000-000000000006";
const PERSONAL_PROJECT = "aaaa0000-0000-4000-8000-000000000007";

const BRAND_KIT_ONE = "cccc0000-0000-4000-8000-000000000001";
const BRAND_KIT_TWO = "cccc0000-0000-4000-8000-000000000002";

/** Frozen fixture timestamps: a write that touches a row must move off these. */
const AUTHOR_CREATED_AT = "2026-01-10T08:00:00.000Z";
const AUTHOR_UPDATED_AT = "2026-02-11T09:30:00.000Z";
const ARCHIVED_AT = "2026-01-09T00:00:00.000Z";

const ALL_PROJECTS = [
  AUTHOR_PROJECT,
  ARCHIVED_PROJECT,
  ADMIN_PROJECT,
  MEMBER_PROJECT,
  OUTSIDER_PROJECT,
  FORMER_PROJECT,
  PERSONAL_PROJECT,
];

/** A project the ADMIN may read (its author is a team member) but must not write. */
const ARCHIVE_TARGET_FOR_ADMIN = MEMBER_PROJECT;
/** Likewise: the outsider owns it, the admin only reads it. */
const THUMBNAIL_TARGET_FOR_ADMIN = OUTSIDER_PROJECT;

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";
/** A well-formed uuid no row uses: "no such project" has to be a zero count. */
const UNKNOWN_PROJECT = "aaaa0000-0000-4000-8000-0000000000ff";
/** A bind that would be injection if it were ever concatenated into the statement. */
const INJECTION_ID = "' or '1'='1";

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  thumbnail_path: string | null;
  brand_kit_id: string | null;
};

/** Every column of one project, normalised to strings so two snapshots can be compared. */
type ProjectSnapshot = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_by: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  thumbnail_path: string | null;
  brand_kit_id: string | null;
};

let db: PGlite;
let pool: TransactionPool;
let repository: ProjectWriteRepository;

let teamWorkspaceId = "";
let authorPersonalWorkspaceId = "";

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function snapshotOf(row: ProjectRow): ProjectSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    created_by: row.created_by,
    archived_at: isoOf(row.archived_at),
    created_at: isoOf(row.created_at) ?? "",
    updated_at: isoOf(row.updated_at) ?? "",
    thumbnail_path: row.thumbnail_path,
    brand_kit_id: row.brand_kit_id,
  };
}

async function projectSnapshot(projectId: string): Promise<ProjectSnapshot> {
  const rows = (
    await db.query<ProjectRow>(
      `select id, workspace_id, name, slug, description, created_by, archived_at,
              created_at, updated_at, thumbnail_path, brand_kit_id
         from public.projects where id = $1`,
      [projectId],
    )
  ).rows;

  const row = rows[0];
  if (row === undefined) throw new Error(`no project ${projectId}`);

  return snapshotOf(row);
}

async function allProjectSnapshots(): Promise<ProjectSnapshot[]> {
  const rows = (
    await db.query<ProjectRow>(
      `select id, workspace_id, name, slug, description, created_by, archived_at,
              created_at, updated_at, thumbnail_path, brand_kit_id
         from public.projects order by id`,
    )
  ).rows;

  return rows.map(snapshotOf);
}

/**
 * Replay the pre-migration PostgREST write under `asUser()`: the statement carries
 * ONLY the id, so the policy is the entire authorisation. The row count is the
 * answer the old client would have received.
 */
async function asUserUpdate(
  userId: string,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ id: string }>(sql, [...params]);
    return result.rows.length;
  });
}

const POSTGREST_ARCHIVE_SQL =
  "update public.projects set archived_at = now() where id = $1 returning id";
const POSTGREST_THUMBNAIL_SQL =
  "update public.projects set thumbnail_path = $2 where id = $1 returning id";
const POSTGREST_RENAME_SQL =
  "update public.projects set name = $2 where id = $1 returning id";

async function firstRow<T>(rows: readonly T[]): Promise<T> {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function personalWorkspaceIdOf(userId: string): Promise<string> {
  return (
    await firstRow(
      (
        await db.query<{ id: string }>(
          `select id from public.workspaces
            where owner_user_id = $1 and type = 'personal'`,
          [userId],
        )
      ).rows,
    )
  ).id;
}

async function insertProject(options: {
  id: string;
  workspaceId: string;
  name: string;
  createdBy: string;
  updatedAt: string;
  archivedAt?: string | null;
  thumbnailPath?: string | null;
  brandKitId?: string | null;
}): Promise<void> {
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at, thumbnail_path, brand_kit_id
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      options.id,
      options.workspaceId,
      options.name,
      options.id,
      `description of ${options.name}`,
      options.createdBy,
      options.archivedAt ?? null,
      AUTHOR_CREATED_AT,
      options.updatedAt,
      options.thumbnailPath ?? null,
      options.brandKitId ?? null,
    ],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createProjectWriteRepository({ getTransactionPool: () => pool });

  // Real signup path for every identity: the auth.users trigger builds profile,
  // personal workspace and the owner membership.
  await createUser(db, AUTHOR_ID, "project-write-author@hahart.test");
  await createUser(db, ADMIN_ID, "project-write-admin@hahart.test");
  await createUser(db, OWNER_ID, "project-write-owner@hahart.test");
  await createUser(db, MEMBER_ID, "project-write-member@hahart.test");
  await createUser(db, OUTSIDER_ID, "project-write-outsider@hahart.test");
  await createUser(db, FORMER_MEMBER_ID, "project-write-former@hahart.test");

  authorPersonalWorkspaceId = await personalWorkspaceIdOf(AUTHOR_ID);

  teamWorkspaceId = (
    await firstRow(
      (
        await db.query<{ id: string }>(
          `insert into public.workspaces (type, name, owner_user_id)
           values ('team', 'HaHart Team', $1)
           returning id`,
          [OWNER_ID],
        )
      ).rows,
    )
  ).id;

  // AUTHOR is an ordinary member, ADMIN an admin, OWNER the owner. OUTSIDER holds no
  // membership row at all, yet still owns a project in the team workspace — so "not
  // a member" is proven by the SQL rather than by the absence of data. FORMER_MEMBER
  // is the same shape from the other side: a project author with no membership.
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

  await db.query(
    `insert into public.brand_kits (id, user_id, name)
     values ($1, $2, 'Kit One'), ($3, $2, 'Kit Two')`,
    [BRAND_KIT_ONE, AUTHOR_ID, BRAND_KIT_TWO],
  );

  await insertProject({
    id: AUTHOR_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Author active",
    createdBy: AUTHOR_ID,
    updatedAt: AUTHOR_UPDATED_AT,
    brandKitId: BRAND_KIT_ONE,
  });
  await insertProject({
    id: ARCHIVED_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Already archived",
    createdBy: AUTHOR_ID,
    updatedAt: AUTHOR_UPDATED_AT,
    archivedAt: ARCHIVED_AT,
    thumbnailPath: "legacy/thumbnail.webp",
  });
  await insertProject({
    id: ADMIN_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Admin own",
    createdBy: ADMIN_ID,
    updatedAt: AUTHOR_UPDATED_AT,
  });
  await insertProject({
    id: MEMBER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Member own",
    createdBy: MEMBER_ID,
    updatedAt: AUTHOR_UPDATED_AT,
  });
  await insertProject({
    id: OUTSIDER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Outsider own",
    createdBy: OUTSIDER_ID,
    updatedAt: AUTHOR_UPDATED_AT,
  });
  await insertProject({
    id: FORMER_PROJECT,
    workspaceId: teamWorkspaceId,
    name: "Former member own",
    createdBy: FORMER_MEMBER_ID,
    updatedAt: AUTHOR_UPDATED_AT,
  });
  await insertProject({
    id: PERSONAL_PROJECT,
    workspaceId: authorPersonalWorkspaceId,
    name: "Personal",
    createdBy: AUTHOR_ID,
    updatedAt: AUTHOR_UPDATED_AT,
  });
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// 1. The author: the three writes actually write, and move exactly their column.
// ---------------------------------------------------------------------------
describe("project write repository: the author writes their own project", () => {
  it("case 1: archive sets archived_at and leaves every other column byte-identical", async () => {
    const before = await projectSnapshot(AUTHOR_PROJECT);

    await expect(
      repository.archiveOwnProject({
        actorId: AUTHOR_ID,
        projectId: AUTHOR_PROJECT,
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(AUTHOR_PROJECT);

    // The frozen fixture value is gone: the statement's now() replaced it.
    expect(after.archived_at).not.toBeNull();
    expect(after.archived_at).not.toBe(ARCHIVED_AT);
    // Everything the removed PostgREST update did not name is untouched.
    expect({ ...after, archived_at: null, updated_at: "" }).toEqual({
      ...before,
      archived_at: null,
      updated_at: "",
    });
  });

  it("case 2: the archive timestamp is a real moment, not the fixture's", async () => {
    const stored = await projectSnapshot(AUTHOR_PROJECT);

    expect(Number.isNaN(Date.parse(stored.archived_at ?? ""))).toBe(false);
    // The trigger moved `updated_at` as well, which is what the old update did too.
    expect(stored.updated_at).not.toBe(AUTHOR_UPDATED_AT);
  });

  it("case 3: re-archiving an ALREADY archived project is still one row, so no archive filter was added", async () => {
    const before = await projectSnapshot(ARCHIVED_PROJECT);
    expect(before.archived_at).toBe(ARCHIVED_AT);

    // `projects_update_owner` has no `archived_at` term. A self-added
    // `archived_at is null` would answer zero here — this is the case that fails if
    // one ever appears.
    await expect(
      repository.archiveOwnProject({
        actorId: AUTHOR_ID,
        projectId: ARCHIVED_PROJECT,
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(ARCHIVED_PROJECT);
    expect(after.archived_at).not.toBe(ARCHIVED_AT);
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
  });

  it("case 4: setOwnProjectThumbnail writes the path and nothing else", async () => {
    const before = await projectSnapshot(ADMIN_PROJECT);
    const path = `${teamWorkspaceId}/${ADMIN_PROJECT}/thumbnail.png`;

    // ADMIN is the author of this one, so the write is the one that MUST succeed —
    // and it is the same identity that is refused on somebody else's project below.
    await expect(
      repository.setOwnProjectThumbnail({
        actorId: ADMIN_ID,
        projectId: ADMIN_PROJECT,
        thumbnailPath: path,
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(ADMIN_PROJECT);
    expect(after.thumbnail_path).toBe(path);
    expect({ ...after, thumbnail_path: before.thumbnail_path, updated_at: "" }).toEqual({
      ...before,
      updated_at: "",
    });
  });

  it("case 5: a name-only patch moves the name and leaves the brand kit bound", async () => {
    const before = await projectSnapshot(PERSONAL_PROJECT);

    await expect(
      repository.updateOwnProject({
        actorId: AUTHOR_ID,
        projectId: PERSONAL_PROJECT,
        patch: { name: "Renamed by the author" },
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(PERSONAL_PROJECT);
    expect(after.name).toBe("Renamed by the author");
    expect(after.brand_kit_id).toBe(before.brand_kit_id);
    expect(after.slug).toBe(before.slug);
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
  });

  it("case 6: an explicit null brand_kit_id clears the binding, and the name stays", async () => {
    const before = await projectSnapshot(AUTHOR_PROJECT);
    expect(before.brand_kit_id).toBe(BRAND_KIT_ONE);

    await expect(
      repository.updateOwnProject({
        actorId: AUTHOR_ID,
        projectId: AUTHOR_PROJECT,
        patch: { brand_kit_id: null },
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(AUTHOR_PROJECT);
    expect(after.brand_kit_id).toBeNull();
    expect(after.name).toBe(before.name);
  });

  it("case 7: both keys at once move both columns in ONE statement", async () => {
    // Case 6 cleared the binding, so this one sets it again together with the name:
    // one statement, two columns, both flags true.
    await expect(
      repository.updateOwnProject({
        actorId: AUTHOR_ID,
        projectId: AUTHOR_PROJECT,
        patch: { name: "Renamed and re-bound", brand_kit_id: BRAND_KIT_TWO },
      }),
    ).resolves.toEqual({ updated: 1 });

    const after = await projectSnapshot(AUTHOR_PROJECT);
    expect(after.name).toBe("Renamed and re-bound");
    expect(after.brand_kit_id).toBe(BRAND_KIT_TWO);
    // The author is still the author: nothing here rewrote ownership.
    expect(after.created_by).toBe(AUTHOR_ID);
  });

  it("case 7b: an author cannot reach somebody else's project even with a well-formed patch", async () => {
    const before = await projectSnapshot(MEMBER_PROJECT);

    await expect(
      repository.updateOwnProject({
        actorId: AUTHOR_ID,
        projectId: MEMBER_PROJECT,
        patch: { name: "Not mine" },
      }),
    ).resolves.toEqual({ updated: 0 });

    expect(await projectSnapshot(MEMBER_PROJECT)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Three-way agreement with the policy, per identity.
// ---------------------------------------------------------------------------
describe("project write repository: repository and policy answer the same thing", () => {
  it("case 8: the author's archive is one row BOTH through the repository and through the policy", async () => {
    const stored = await projectSnapshot(AUTHOR_PROJECT);
    expect(stored.archived_at).not.toBeNull();

    // Replay the pre-migration write under RLS: it carries only the id.
    const viaPolicy = await asUserUpdate(AUTHOR_ID, POSTGREST_ARCHIVE_SQL, [
      AUTHOR_PROJECT,
    ]);
    // Replay the repository's intent: one row either way.
    const viaRepository = await repository.archiveOwnProject({
      actorId: AUTHOR_ID,
      projectId: AUTHOR_PROJECT,
    });

    expect(viaPolicy).toBe(1);
    expect(viaRepository.updated).toBe(1);
    expect((await projectSnapshot(AUTHOR_PROJECT)).archived_at).not.toBeNull();
  });

  it("case 9: the admin can READ the author's project but neither path writes it", async () => {
    const before = await projectSnapshot(ARCHIVE_TARGET_FOR_ADMIN);
    const readable = (
      await asUser(db, ADMIN_ID, async (tx) =>
        tx.query<{ id: string }>("select id from public.projects where id = $1", [
          ARCHIVE_TARGET_FOR_ADMIN,
        ]),
      )
    ).rows;
    // The admin really can see it: the refusal below is about WRITING.
    expect(readable.map((row) => row.id)).toEqual([ARCHIVE_TARGET_FOR_ADMIN]);

    const viaRepository = await repository.archiveOwnProject({
      actorId: ADMIN_ID,
      projectId: ARCHIVE_TARGET_FOR_ADMIN,
    });
    const viaPolicy = await asUserUpdate(ADMIN_ID, POSTGREST_ARCHIVE_SQL, [
      ARCHIVE_TARGET_FOR_ADMIN,
    ]);

    expect(viaRepository.updated).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await projectSnapshot(ARCHIVE_TARGET_FOR_ADMIN)).toEqual(before);
  });

  it("case 10: the admin's thumbnail and rename writes touch nothing either, column by column", async () => {
    const before = await projectSnapshot(THUMBNAIL_TARGET_FOR_ADMIN);

    const thumbnail = await repository.setOwnProjectThumbnail({
      actorId: ADMIN_ID,
      projectId: THUMBNAIL_TARGET_FOR_ADMIN,
      thumbnailPath: "admin/attempt.webp",
    });
    const rename = await repository.updateOwnProject({
      actorId: ADMIN_ID,
      projectId: THUMBNAIL_TARGET_FOR_ADMIN,
      patch: { name: "Admin was here" },
    });
    const viaPolicy = await asUserUpdate(ADMIN_ID, POSTGREST_RENAME_SQL, [
      THUMBNAIL_TARGET_FOR_ADMIN,
      "Admin was here",
    ]);

    expect(thumbnail.updated).toBe(0);
    expect(rename.updated).toBe(0);
    expect(viaPolicy).toBe(0);
    // Not one column moved, `updated_at` included: the rows were never touched.
    expect(await projectSnapshot(THUMBNAIL_TARGET_FOR_ADMIN)).toEqual(before);
  });

  it("case 11: an ordinary member who is not the author writes nothing either", async () => {
    const before = await projectSnapshot(OUTSIDER_PROJECT);

    const archive = await repository.archiveOwnProject({
      actorId: MEMBER_ID,
      projectId: OUTSIDER_PROJECT,
    });
    const thumbnail = await repository.setOwnProjectThumbnail({
      actorId: MEMBER_ID,
      projectId: OUTSIDER_PROJECT,
      thumbnailPath: "member/attempt.webp",
    });
    const rename = await repository.updateOwnProject({
      actorId: MEMBER_ID,
      projectId: OUTSIDER_PROJECT,
      patch: { name: "Member was here" },
    });
    const viaPolicy = await asUserUpdate(MEMBER_ID, POSTGREST_ARCHIVE_SQL, [
      OUTSIDER_PROJECT,
    ]);

    expect([archive.updated, thumbnail.updated, rename.updated, viaPolicy]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(await projectSnapshot(OUTSIDER_PROJECT)).toEqual(before);
  });

  it("case 12: an outsider — the author of the row but NOT a member — writes nothing", async () => {
    const before = await projectSnapshot(OUTSIDER_PROJECT);

    const viaRepository = await repository.archiveOwnProject({
      actorId: OUTSIDER_ID,
      projectId: OUTSIDER_PROJECT,
    });
    const viaPolicy = await asUserUpdate(OUTSIDER_ID, POSTGREST_ARCHIVE_SQL, [
      OUTSIDER_PROJECT,
    ]);

    // `created_by = auth.uid()` is true and the membership half is false, which is
    // exactly the conjunct this case exists to prove.
    expect(viaRepository.updated).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await projectSnapshot(OUTSIDER_PROJECT)).toEqual(before);
  });

  it("case 13: a project author whose membership was removed writes nothing", async () => {
    const before = await projectSnapshot(FORMER_PROJECT);

    const viaRepository = await repository.archiveOwnProject({
      actorId: FORMER_MEMBER_ID,
      projectId: FORMER_PROJECT,
    });
    const viaPolicy = await asUserUpdate(
      FORMER_MEMBER_ID,
      POSTGREST_ARCHIVE_SQL,
      [FORMER_PROJECT],
    );

    expect(viaRepository.updated).toBe(0);
    expect(viaPolicy).toBe(0);
    expect(await projectSnapshot(FORMER_PROJECT)).toEqual(before);
  });

  it("case 14: an unknown project id is a zero count, not a throw", async () => {
    const before = await allProjectSnapshots();

    const archive = await repository.archiveOwnProject({
      actorId: AUTHOR_ID,
      projectId: UNKNOWN_PROJECT,
    });
    const thumbnail = await repository.setOwnProjectThumbnail({
      actorId: AUTHOR_ID,
      projectId: UNKNOWN_PROJECT,
      thumbnailPath: "nowhere/thumbnail.webp",
    });
    const rename = await repository.updateOwnProject({
      actorId: AUTHOR_ID,
      projectId: UNKNOWN_PROJECT,
      patch: { name: "Nowhere" },
    });

    expect([archive.updated, thumbnail.updated, rename.updated]).toEqual([0, 0, 0]);
    expect(await allProjectSnapshots()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. Bad binds: a real SQL error, and not one row moves.
// ---------------------------------------------------------------------------
describe("project write repository: bad binds change nothing", () => {
  it("case 15: a malformed uuid is 22P02 on every write, wrapped, and no row moves", async () => {
    const before = await allProjectSnapshots();

    const calls: Array<[string, () => Promise<unknown>]> = [
      [
        ARCHIVE_OWN_PROJECT,
        () =>
          repository.archiveOwnProject({
            actorId: INVALID_ID,
            projectId: AUTHOR_PROJECT,
          }),
      ],
      [
        SET_OWN_PROJECT_THUMBNAIL,
        () =>
          repository.setOwnProjectThumbnail({
            actorId: AUTHOR_ID,
            projectId: INVALID_ID,
            thumbnailPath: "x.webp",
          }),
      ],
      [
        UPDATE_OWN_PROJECT,
        () =>
          repository.updateOwnProject({
            actorId: AUTHOR_ID,
            projectId: INVALID_ID,
            patch: { name: "x" },
          }),
      ],
    ];

    for (const [operation, call] of calls) {
      const error = await call().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(ProjectWriteError);
      expect((error as ProjectWriteError).operation).toBe(operation);
      expect(((error as ProjectWriteError).cause as { code?: string }).code).toBe(
        "22P02",
      );
      expect((error as ProjectWriteError).message).not.toMatch(
        /public\.|created_by|postgres:\/\//i,
      );
    }

    expect(await allProjectSnapshots()).toEqual(before);
  });

  it("case 16: an injection-shaped id and actor are DATA, so PostgreSQL rejects them as uuids and nothing moves", async () => {
    const before = await allProjectSnapshots();

    for (const call of [
      () =>
        repository.archiveOwnProject({
          actorId: AUTHOR_ID,
          projectId: INJECTION_ID,
        }),
      () =>
        repository.archiveOwnProject({
          actorId: INJECTION_ID,
          projectId: AUTHOR_PROJECT,
        }),
      () =>
        repository.updateOwnProject({
          actorId: INJECTION_ID,
          projectId: AUTHOR_PROJECT,
          patch: { name: "pwned" },
        }),
    ]) {
      // The quote never becomes SQL: it is a bind parameter, so it fails the uuid
      // cast rather than parsing. 22P02 here is the proof that the value was data.
      const error = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ProjectWriteError);
      expect(((error as ProjectWriteError).cause as { code?: string }).code).toBe(
        "22P02",
      );
    }

    expect(await allProjectSnapshots()).toEqual(before);
  });

  it("case 17: an injection-shaped TEXT value is stored verbatim as data, and the table survives", async () => {
    const hostile = "'; drop table public.projects; --";
    const before = await projectSnapshot(AUTHOR_PROJECT);

    await expect(
      repository.setOwnProjectThumbnail({
        actorId: AUTHOR_ID,
        projectId: AUTHOR_PROJECT,
        thumbnailPath: hostile,
      }),
    ).resolves.toEqual({ updated: 1 });

    // Round-trips byte for byte: the text bind is a value, not a fragment.
    const after = await projectSnapshot(AUTHOR_PROJECT);
    expect(after.thumbnail_path).toBe(hostile);
    // …and every other column — and the table itself — is still there, which it
    // would not be after a drop.
    expect({
      ...after,
      thumbnail_path: before.thumbnail_path,
      updated_at: before.updated_at,
    }).toEqual(before);
    expect(await allProjectSnapshots()).toHaveLength(ALL_PROJECTS.length);
  });

  it("case 18: the pool is usable again after a failed write (the transaction rolled back)", async () => {
    const error = await repository
      .archiveOwnProject({ actorId: AUTHOR_ID, projectId: INVALID_ID })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ProjectWriteError);

    // A real write still works on the same pool: the rollback released the session
    // cleanly and no transaction was left open.
    await expect(
      repository.updateOwnProject({
        actorId: AUTHOR_ID,
        projectId: PERSONAL_PROJECT,
        patch: { name: "Still writable" },
      }),
    ).resolves.toEqual({ updated: 1 });

    expect((await projectSnapshot(PERSONAL_PROJECT)).name).toBe("Still writable");
  });
});

