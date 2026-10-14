import { describe, expect, it } from "vitest";

import {
  FIND_READABLE_PROJECT,
  LIST_OWN_PROJECTS,
  LIST_READABLE_PRIMARY_CANVASES,
  ProjectReadError,
  createProjectReadRepository,
  type ProjectReadRepository,
} from "./project-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_SETTING_ORDER,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor it carries, how it binds values, and how it
 * classifies every way a read can fail.
 *
 * The SQL text assertions are deliberately about the AUTHORIZATION predicates —
 * the membership join, the author/admin/owner clause, the archived filter — and
 * about the absence of concatenated values. A statement that merely returns rows
 * would pass a "happy path" test while opening the whole workspace.
 */

const ACTOR_ID = "00000000-0000-0000-0000-00000000000a";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const SECOND_PROJECT_ID = "44444444-4444-4444-4444-444444444444";
const CANVAS_ID = "55555555-5555-5555-5555-555555555555";

const CREATED_AT = new Date("2026-01-02T03:04:05.678Z");
const UPDATED_AT = new Date("2026-01-03T04:05:06.789Z");

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (sql === TRANSACTION_STATEMENTS.setLocalSetting) return { rows: [] };
      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;
        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

/** Only the three domain statements touch these two tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) =>
      entry.sql.includes("public.projects") ||
      entry.sql.includes("public.canvases"),
  );
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  return queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .map((entry) => [...(entry.params ?? [])]);
}

function repositoryFor(harness: Harness): ProjectReadRepository {
  return createProjectReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

const DETAIL_ROW = {
  id: PROJECT_ID,
  name: "Mine",
  slug: "mine-abc123",
  description: null,
  workspace_id: WORKSPACE_ID,
  brand_kit_id: null,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

const LIST_ROW = {
  id: PROJECT_ID,
  name: "Mine",
  slug: "mine-abc123",
  description: "a project",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  workspace_id: WORKSPACE_ID,
  thumbnail_path: `${WORKSPACE_ID}/${PROJECT_ID}/thumbnail.webp`,
};

const CANVAS_ROW = {
  id: CANVAS_ID,
  name: "Main Canvas",
  is_primary: true,
  project_id: PROJECT_ID,
};

describe("project-read-repository: findReadableProject", () => {
  it("case 1: reads inside one privileged transaction that carries the actor and binds both values", async () => {
    const harness = createHarness(() => [DETAIL_ROW]);

    await repositoryFor(harness).findReadableProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
    });

    const settingNames = contextParams(harness.queries).map((params) => params[0]);
    expect(settingNames).toEqual([...TRANSACTION_SETTING_ORDER]);
    expect(
      contextParams(harness.queries).find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.userId, ACTOR_ID]);

    const statements = domainCalls(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([ACTOR_ID, PROJECT_ID]);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: the statement itself carries the ACL — membership, author-or-admin/owner, not archived", async () => {
    const harness = createHarness(() => [DETAIL_ROW]);

    await repositoryFor(harness).findReadableProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.user_id = $1");
    expect(sql).toContain("m.workspace_id = p.workspace_id");
    expect(sql).toContain("p.created_by = $1");
    expect(sql).toContain("m.role in ('admin', 'owner')");
    expect(sql).toContain("p.archived_at is null");
    expect(sql).not.toMatch(/select\s+\*/i);
    // The execution mode is a diagnostic label, never an authorization input.
    expect(sql).not.toContain("execution_mode");
  });

  it("case 3: the row maps to the detail DTO and timestamps become ISO strings", async () => {
    const harness = createHarness(() => [
      { ...DETAIL_ROW, brand_kit_id: "66666666-6666-6666-6666-666666666666" },
    ]);

    const project = await repositoryFor(harness).findReadableProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
    });

    expect(project).toEqual({
      id: PROJECT_ID,
      name: "Mine",
      slug: "mine-abc123",
      description: null,
      workspace_id: WORKSPACE_ID,
      brand_kit_id: "66666666-6666-6666-6666-666666666666",
      created_at: "2026-01-02T03:04:05.678Z",
      updated_at: "2026-01-03T04:05:06.789Z",
    });

    // A driver that hands back an ISO string instead of a Date is normalised to
    // the same value rather than being dropped.
    const stringHarness = createHarness(() => [
      {
        ...DETAIL_ROW,
        created_at: "2026-01-02T03:04:05.678Z",
        updated_at: "2026-01-03T04:05:06.789+00:00",
      },
    ]);
    const fromStrings = await repositoryFor(stringHarness).findReadableProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
    });
    expect(fromStrings?.created_at).toBe("2026-01-02T03:04:05.678Z");
    expect(fromStrings?.updated_at).toBe("2026-01-03T04:05:06.789Z");
  });

  it("case 4: zero rows mean null — missing, archived and forbidden are one answer", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).findReadableProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ID,
      }),
    ).resolves.toBeNull();
  });

  it("case 5: a second row is a contradiction, not a null", async () => {
    const harness = createHarness(() => [DETAIL_ROW, DETAIL_ROW]);

    const error = await repositoryFor(harness)
      .findReadableProject({ actorId: ACTOR_ID, projectId: PROJECT_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProjectReadError);
    expect((error as ProjectReadError).operation).toBe(FIND_READABLE_PROJECT);
    expect(((error as ProjectReadError).cause as Error).message).toMatch(
      /more than one row/,
    );
  });

  it("case 6: an unusable row shape fails loud instead of becoming a half project", async () => {
    const missingName = createHarness(() => [{ ...DETAIL_ROW, name: null }]);
    const nameError = await repositoryFor(missingName)
      .findReadableProject({ actorId: ACTOR_ID, projectId: PROJECT_ID })
      .catch((reason: unknown) => reason);

    expect(nameError).toBeInstanceOf(ProjectReadError);
    expect(((nameError as ProjectReadError).cause as Error).message).toContain(
      '"name"',
    );

    const badTimestamp = createHarness(() => [
      { ...DETAIL_ROW, updated_at: "not a timestamp" },
    ]);
    const timestampError = await repositoryFor(badTimestamp)
      .findReadableProject({ actorId: ACTOR_ID, projectId: PROJECT_ID })
      .catch((reason: unknown) => reason);

    expect(timestampError).toBeInstanceOf(ProjectReadError);
    expect(((timestampError as ProjectReadError).cause as Error).message).toContain(
      '"updated_at"',
    );
  });

  it("case 7: a connection failure is a ProjectReadError whose message leaks no SQL or host", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 for postgres://user:pw@host/db",
      ),
    });

    const error = await repositoryFor(harness)
      .findReadableProject({ actorId: ACTOR_ID, projectId: PROJECT_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProjectReadError);
    const readError = error as ProjectReadError;
    expect(readError.operation).toBe(FIND_READABLE_PROJECT);
    expect(readError.message).toBe(
      `project read failed (${FIND_READABLE_PROJECT})`,
    );
    expect(readError.message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The cause keeps the driver detail for an operator; only the public message
    // is fixed text.
    expect((readError.cause as Error).message).toContain("ECONNREFUSED");
  });
});

describe("project-read-repository: listOwnProjects", () => {
  it("case 8: the list pins workspace and author, keeps the newest first and never widens for admin", async () => {
    const harness = createHarness(() => [LIST_ROW]);

    const projects = await repositoryFor(harness).listOwnProjects({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
    });

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([ACTOR_ID, WORKSPACE_ID]);

    const sql = statement?.sql ?? "";
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("p.workspace_id = $2");
    expect(sql).toContain("p.created_by = $1");
    expect(sql).toContain("p.archived_at is null");
    expect(sql).toContain("order by p.updated_at desc");
    // An administrator's list stays own-only, so the widening clause of the
    // by-id read must not appear here.
    expect(sql).not.toContain("m.role in");
    expect(sql).not.toMatch(/select\s+\*/i);

    expect(projects).toEqual([
      {
        id: PROJECT_ID,
        name: "Mine",
        slug: "mine-abc123",
        description: "a project",
        created_at: "2026-01-02T03:04:05.678Z",
        updated_at: "2026-01-03T04:05:06.789Z",
        workspace_id: WORKSPACE_ID,
        thumbnail_path: LIST_ROW.thumbnail_path,
      },
    ]);
  });

  it("case 9: no projects is an empty list, not null", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).listOwnProjects({
        actorId: ACTOR_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("case 10: a SQL failure reports its own operation", async () => {
    const harness = createHarness(() => {
      throw new Error('relation "public.projects" does not exist');
    });

    const error = await repositoryFor(harness)
      .listOwnProjects({ actorId: ACTOR_ID, workspaceId: WORKSPACE_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProjectReadError);
    expect((error as ProjectReadError).operation).toBe(LIST_OWN_PROJECTS);
    expect((error as ProjectReadError).message).toBe(
      `project read failed (${LIST_OWN_PROJECTS})`,
    );
  });
});

describe("project-read-repository: listReadablePrimaryCanvases", () => {
  it("case 11: the canvas read re-joins project and membership and binds the id set", async () => {
    const harness = createHarness(() => [CANVAS_ROW]);

    const canvases = await repositoryFor(harness).listReadablePrimaryCanvases({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
      projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
    });

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([
      ACTOR_ID,
      WORKSPACE_ID,
      [PROJECT_ID, SECOND_PROJECT_ID],
    ]);

    const sql = statement?.sql ?? "";
    expect(sql).toContain("c.project_id = any($3::uuid[])");
    expect(sql).toContain("c.is_primary = true");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("p.workspace_id = $2");
    expect(sql).toContain("p.archived_at is null");
    expect(sql).toContain("p.created_by = $1");
    expect(sql).not.toMatch(/select\s+\*/i);

    expect(canvases).toEqual([
      {
        id: CANVAS_ID,
        name: "Main Canvas",
        is_primary: true,
        project_id: PROJECT_ID,
      },
    ]);
  });

  it("case 12: an empty id set answers [] without touching the pool", async () => {
    const harness = createHarness(() => [CANVAS_ROW]);

    const canvases = await repositoryFor(harness).listReadablePrimaryCanvases({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
      projectIds: [],
    });

    expect(canvases).toEqual([]);
    expect(harness.queries).toHaveLength(0);
    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 13: no caller value is ever concatenated into a statement", async () => {
    const harness = createHarness((sql) =>
      sql.includes("public.canvases") ? [CANVAS_ROW] : [DETAIL_ROW],
    );
    const repository = repositoryFor(harness);

    await repository.findReadableProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
    });
    await repository.listOwnProjects({
      actorId: OTHER_ACTOR_ID,
      workspaceId: WORKSPACE_ID,
    });
    await repository.listReadablePrimaryCanvases({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
      projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
    });

    const sqlText = domainCalls(harness.queries)
      .map((entry) => entry.sql)
      .join("\n");

    for (const value of [
      ACTOR_ID,
      OTHER_ACTOR_ID,
      WORKSPACE_ID,
      PROJECT_ID,
      SECOND_PROJECT_ID,
    ]) {
      expect(sqlText).not.toContain(value);
    }
    expect(sqlText).not.toContain("$4");
  });
});
