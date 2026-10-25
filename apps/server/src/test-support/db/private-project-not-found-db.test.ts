// QA-12 / PJ-07: "another team member cannot even tell a private project exists".
//
// The repository-level ACL is already pinned next door
// (`project-read-repository-db.test.ts`): an ordinary member reading someone
// else's project gets `null`. What was NOT pinned is the answer the SERVICE layer
// gives, which is what a caller actually sees. The point of this file is the
// comparison, not the null:
//
//   B reading A's real private project  ==  B reading a uuid nobody ever created
//
// identical in `code`, `statusCode` and `message`, so the route cannot be used to
// enumerate ids. The positive control (A reading her own project) is what keeps
// the comparison honest: if the ACL answered "not found" for everybody, the two
// sides would still be equal and prove nothing.
//
// Real PostgreSQL (PGlite, in-process), real migrations, the real repository and
// the real `createProjectService`. Only the dependencies `getProject` never
// touches are doubles.
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProjectReadRepository,
  type ProjectReadRepository,
} from "../../db/project-read-repository.js";
import type { ProjectWriteRepository } from "../../db/project-write-repository.js";
import type { ViewerService } from "../../features/bootstrap/ensure-user-foundation.js";
import {
  ProjectServiceError,
  createProjectService,
  type ProjectService,
} from "../../features/projects/project-service.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

const OWNER_ID = "00000000-0000-0000-0000-0000000000d1";
const AUTHOR_ID = "00000000-0000-0000-0000-0000000000d2";
const OTHER_MEMBER_ID = "00000000-0000-0000-0000-0000000000d3";

const TEAM_NAME = "HaHart Team";
const PRIVATE_PROJECT = "cccc0000-0000-4000-8000-000000000001";
const PRIVATE_PROJECT_NAME = "Author private";

let db: PGlite;
let teamWorkspaceId = "";
let service: ProjectService;

function user(id: string): AuthenticatedUser {
  return {
    accessToken: `token-for-${id}`,
    email: `${id}@hahart.test`,
    id,
    userMetadata: {},
  };
}

const AUTHOR = user(AUTHOR_ID);
const OTHER_MEMBER = user(OTHER_MEMBER_ID);

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** The three fields the answer is made of; the comparison is over these alone. */
function answerOf(error: unknown) {
  if (!(error instanceof ProjectServiceError)) {
    throw new Error(
      `expected a ProjectServiceError, got ${String(error)}`,
    );
  }

  return {
    code: error.code,
    statusCode: error.statusCode,
    message: error.message,
  };
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  // The real signup path: the auth.users trigger builds profile, personal
  // workspace and the owner membership.
  await createUser(db, OWNER_ID, "owner@hahart.test");
  await createUser(db, AUTHOR_ID, "author@hahart.test");
  await createUser(db, OTHER_MEMBER_ID, "other@hahart.test");

  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2)
         returning id`,
        [TEAM_NAME, OWNER_ID],
      )
    ).rows,
  ).id;

  // Both identities are ordinary members of the SAME team workspace: the
  // refusal below has to come from the author-only clause, not from "no team".
  for (const [userId, role] of [
    [AUTHOR_ID, "member"],
    [OTHER_MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by,
       archived_at, created_at, updated_at, thumbnail_path
     )
     values ($1, $2, $3, $4, $5, $6, null, $7, $8, null)`,
    [
      PRIVATE_PROJECT,
      teamWorkspaceId,
      PRIVATE_PROJECT_NAME,
      PRIVATE_PROJECT,
      "only its author may read this",
      AUTHOR_ID,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ],
  );

  const pglitePool = createPGliteTransactionPool(db);
  const repository: ProjectReadRepository = createProjectReadRepository({
    getTransactionPool: () => pglitePool,
  });

  // `getProject` reads the repository and nothing else. The doubles below would
  // throw if a future change made it reach for an object store, a viewer or a write.
  service = createProjectService({
    // 45AK / T-133 (5th slice), re-shaped by 45BE / T-133 (10a): the thumbnail
    // store is a per-user FACTORY over the caller's token now, and `getProject`
    // must not build one either.
    createObjectStore: () => {
      throw new Error("getProject must not build an object store");
    },
    viewerService: {} as unknown as ViewerService,
    projectReadRepository: repository,
    projectWriteRepository: {} as unknown as ProjectWriteRepository,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("QA-12 / PJ-07: a private project is indistinguishable from a missing one", () => {
  it("QA-12 / PJ-07: B reading A's private project gets exactly the not-found answer", async () => {
    // The row really exists in the shared workspace: the answer comes from the
    // predicate, not from missing data.
    const stored = firstRow(
      (
        await db.query<{ id: string; created_by: string; workspace_id: string }>(
          "select id, created_by, workspace_id from public.projects where id = $1",
          [PRIVATE_PROJECT],
        )
      ).rows,
    );
    expect(stored.id).toBe(PRIVATE_PROJECT);
    expect(stored.created_by).toBe(AUTHOR_ID);
    expect(stored.workspace_id).toBe(teamWorkspaceId);

    const foreign = await service
      .getProject(OTHER_MEMBER, PRIVATE_PROJECT)
      .catch((reason: unknown) => reason);
    // A well-formed uuid no row uses -- "no such project" is a null answer.
    const noSuchProject = randomUUID();
    const missing = await service
      .getProject(OTHER_MEMBER, noSuchProject)
      .catch((reason: unknown) => reason);

    expect(foreign).toBeInstanceOf(ProjectServiceError);
    expect(missing).toBeInstanceOf(ProjectServiceError);

    // The published answer, spelled out once...
    expect(answerOf(foreign)).toEqual({
      code: "project_not_found",
      statusCode: 404,
      message: "Project not found.",
    });

    // ...and then the comparison that makes it non-enumerable.
    expect(answerOf(foreign)).toEqual(answerOf(missing));
    // The answer names neither the id nor the project: nothing leaks through the
    // error that the status code withholds.
    const rendered = JSON.stringify(answerOf(foreign));
    expect(rendered).not.toContain(PRIVATE_PROJECT);
    expect(rendered).not.toContain(PRIVATE_PROJECT_NAME);
  });

  it("QA-12 / PJ-07: A reads her own project (positive control)", async () => {
    const project = await service.getProject(AUTHOR, PRIVATE_PROJECT);

    expect(project.id).toBe(PRIVATE_PROJECT);
    expect(project.name).toBe(PRIVATE_PROJECT_NAME);
    expect(project.workspace_id).toBe(teamWorkspaceId);

    // The same author reading a uuid nobody created still gets the not-found
    // answer, so the success above is the ACL's doing and not "the author can
    // read anything".
    const missing = await service
      .getProject(AUTHOR, randomUUID())
      .catch((reason: unknown) => reason);
    expect(answerOf(missing)).toEqual({
      code: "project_not_found",
      statusCode: 404,
      message: "Project not found.",
    });
  });
});
