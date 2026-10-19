import { describe, expect, it } from "vitest";

import {
  LIST_ENABLED_WORKSPACE_SKILLS,
  LIST_SKILL_FILES,
  WorkspaceSkillReadError,
  createWorkspaceSkillReadRepository,
  type WorkspaceSkillReadRepository,
} from "./workspace-skill-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor (and workspace) it carries, how it binds values,
 * and how it classifies every way a read can fail.
 *
 * The SQL assertions are deliberately about the AUTHORIZATION predicates — the
 * membership `exists` clause and the `source in ('system','community') or
 * created_by = $1` visibility clause — and about the parameter ORDER, not about a
 * happy path that merely returns rows. Workorder 21AC translates
 * `ws_skills_select`, `skills_select_all` and `skill_files_select` into these two
 * statements, so a predicate dropped here would silently widen whose skills an
 * Agent run loads.
 *
 * The number of `set_config` statements is deliberately NOT pinned: how the
 * transaction writes its four session settings is `transaction.ts`'s business,
 * not this module's.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c1";
const SKILL_ONE = "00000000-0000-0000-0000-0000000000d1";
const SKILL_TWO = "00000000-0000-0000-0000-0000000000d2";
const INVALID_ID = "not-a-uuid";

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

/** Only the two domain statements touch these tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) =>
      entry.sql.includes("public.workspace_skills") ||
      entry.sql.includes("public.skill_files"),
  );
}

/**
 * The four session settings as (name, value) pairs. The pair ORDER is
 * `TRANSACTION_SETTING_ORDER`, so the assertions below can read one value without
 * caring how many statements carried it.
 */
function contextPairs(queries: readonly QueryRecord[]): Array<[unknown, unknown]> {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);

  const pairs: Array<[unknown, unknown]> = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([flat[index], flat[index + 1]]);
  }
  return pairs;
}

function contextValue(
  queries: readonly QueryRecord[],
  name: string,
): unknown {
  const found = contextPairs(queries).find((pair) => pair[0] === name);
  return found?.[1];
}

function repositoryFor(harness: Harness): WorkspaceSkillReadRepository {
  return createWorkspaceSkillReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

const SKILL_ROW = {
  id: SKILL_ONE,
  slug: "canvas-design",
  name: "Canvas Design",
  description: "Design on the canvas",
  skill_content: "# SKILL\nDo the thing.",
  metadata: { tags: ["design"] },
};

const FILE_ROW = {
  skill_id: SKILL_ONE,
  file_path: "scripts/analyze.py",
  content: "print('hi')\n",
};

describe("workspace-skill-read-repository: listEnabledWorkspaceSkills", () => {
  it("case 1: exactly one domain statement, inside one privileged transaction that carries the actor AND the workspace", async () => {
    const harness = createHarness(() => [SKILL_ROW]);

    const rows = await repositoryFor(harness).listEnabledWorkspaceSkills({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(rows).toHaveLength(1);

    // ONE statement, not one per skill and not one per predicate.
    const domain = domainCalls(harness.queries);
    expect(domain).toHaveLength(1);

    // The actor and the workspace ride in the transaction context: a privileged
    // read is never anonymous, and the workspace read names its workspace.
    expect(contextValue(harness.queries, TRANSACTION_SETTING_NAMES.userId)).toBe(
      ACTOR_ID,
    );
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.workspaceId),
    ).toBe(WORKSPACE_ID);
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.executionMode),
    ).toBe("privileged");
    // No role is claimed: these reads grant no role.
    expect(contextValue(harness.queries, TRANSACTION_SETTING_NAMES.role)).toBe("");
  });

  it("case 2: the statement carries the membership predicate AND the skill-visibility predicate, and binds actor before workspace", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).listEnabledWorkspaceSkills({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
    });

    const [statement] = domainCalls(harness.queries);
    const sql = statement?.sql ?? "";

    // `ws_skills_select`: private.is_workspace_member(ws.workspace_id), with the
    // membership table and both of its columns named.
    expect(sql).toContain("public.workspace_members m");
    expect(sql).toContain("m.workspace_id = ws.workspace_id");
    expect(sql).toContain("m.user_id = $1::uuid");

    // `skills_select_all`: system/community are visible, user skills only to their
    // author. The author is the bound actor, never a literal.
    expect(sql).toContain("s.source in ('system', 'community')");
    expect(sql).toContain("s.created_by = $1::uuid");

    // The question itself: this workspace, enabled rows only.
    expect(sql).toContain("ws.workspace_id = $2::uuid");
    expect(sql).toContain("ws.enabled = true");

    // The row order is deliberately unpinned, exactly like the removed read.
    expect(sql).not.toContain("order by");

    // Parameter ORDER is part of the contract: $1 is the actor, $2 the workspace.
    expect(statement?.params).toEqual([ACTOR_ID, WORKSPACE_ID]);
  });

  it("case 3: a row whose skill_content or metadata is SQL NULL is an answer, not a failure", async () => {
    const harness = createHarness(() => [
      { ...SKILL_ROW, skill_content: null, metadata: null },
    ]);

    const rows = await repositoryFor(harness).listEnabledWorkspaceSkills({
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
    });

    // The loader is the layer that skips an empty skill and warns; the repository
    // must hand the absence on rather than turning it into an error.
    expect(rows).toEqual([
      {
        id: SKILL_ONE,
        slug: "canvas-design",
        name: "Canvas Design",
        description: "Design on the canvas",
        skill_content: null,
        metadata: null,
      },
    ]);
  });

  it("case 4: an unusable actorId or workspaceId fails BEFORE a connection is opened, and reports the operation", async () => {
    for (const input of [
      { actorId: "", workspaceId: WORKSPACE_ID },
      { actorId: ACTOR_ID, workspaceId: "" },
    ]) {
      const harness = createHarness(() => []);

      const error = await repositoryFor(harness)
        .listEnabledWorkspaceSkills(input)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceSkillReadError);
      expect((error as WorkspaceSkillReadError).operation).toBe(
        LIST_ENABLED_WORKSPACE_SKILLS,
      );
      // Not a database failure: the pool was never touched.
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 5: a row whose skill_content is not a string is rejected as a shape disagreement", async () => {
    const harness = createHarness(() => [
      { ...SKILL_ROW, skill_content: 42 },
    ]);

    const error = await repositoryFor(harness)
      .listEnabledWorkspaceSkills({ actorId: ACTOR_ID, workspaceId: WORKSPACE_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceSkillReadError);
    expect((error as WorkspaceSkillReadError).operation).toBe(
      LIST_ENABLED_WORKSPACE_SKILLS,
    );
    // The reason is on the cause; the published message names only the operation.
    expect(String((error as WorkspaceSkillReadError).cause)).toContain(
      "skill_content",
    );
    expect((error as WorkspaceSkillReadError).message).toBe(
      `workspace skill read failed (${LIST_ENABLED_WORKSPACE_SKILLS})`,
    );
  });
});

describe("workspace-skill-read-repository: listSkillFiles", () => {
  it("case 6: exactly one domain statement carrying the skill-visibility predicate, actor and id list in that order", async () => {
    const harness = createHarness(() => [FILE_ROW]);

    const rows = await repositoryFor(harness).listSkillFiles({
      actorId: ACTOR_ID,
      skillIds: [SKILL_ONE, SKILL_TWO],
    });

    expect(rows).toEqual([FILE_ROW]);

    const domain = domainCalls(harness.queries);
    expect(domain).toHaveLength(1);

    const [statement] = domain;
    const sql = statement?.sql ?? "";

    // `skill_files_select` verbatim: the join half and the `exists` half are the
    // same predicate, so either one alone is the policy.
    expect(sql).toContain("public.skills s");
    expect(sql).toContain("s.id = f.skill_id");
    expect(sql).toContain("s.source in ('system', 'community')");
    expect(sql).toContain("s.created_by = $1::uuid");
    expect(sql).toContain("f.skill_id = any($2::uuid[])");

    // No workspace predicate: the file read is authorised by skill visibility.
    expect(sql).not.toContain("workspace_members");
    expect(sql).not.toContain("order by");

    // $1 actor, $2 ids — the array is passed through whole, never spread.
    expect(statement?.params).toEqual([ACTOR_ID, [SKILL_ONE, SKILL_TWO]]);

    // The actor is carried, and no workspace is claimed for this read.
    expect(contextValue(harness.queries, TRANSACTION_SETTING_NAMES.userId)).toBe(
      ACTOR_ID,
    );
    expect(
      contextValue(harness.queries, TRANSACTION_SETTING_NAMES.workspaceId),
    ).toBe("");
  });

  it("case 7: an empty id list is the answer `[]` and never opens a connection", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).listSkillFiles({ actorId: ACTOR_ID, skillIds: [] }),
    ).resolves.toEqual([]);

    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });

  it("case 8: a half-formed id is refused before the pool, so it cannot become an SQL error that looks like a legitimate miss", async () => {
    for (const skillIds of [[""], [SKILL_ONE, ""], [42 as unknown as string]]) {
      const harness = createHarness(() => []);

      const error = await repositoryFor(harness)
        .listSkillFiles({ actorId: ACTOR_ID, skillIds })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceSkillReadError);
      expect((error as WorkspaceSkillReadError).operation).toBe(LIST_SKILL_FILES);
      expect(harness.connectAttempts()).toBe(0);
    }
  });

  it("case 9: a row whose file_path is missing is rejected as a shape disagreement, while an EMPTY file is accepted", async () => {
    const broken = createHarness(() => [
      { skill_id: SKILL_ONE, content: "x" },
    ]);

    const error = await repositoryFor(broken)
      .listSkillFiles({ actorId: ACTOR_ID, skillIds: [SKILL_ONE] })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceSkillReadError);
    expect((error as WorkspaceSkillReadError).operation).toBe(LIST_SKILL_FILES);
    expect(String((error as WorkspaceSkillReadError).cause)).toContain("file_path");

    // An empty content is a real (empty) file: `text not null`, and the loader
    // publishes whatever was stored.
    const emptyFile = createHarness(() => [
      { skill_id: SKILL_ONE, file_path: "assets/empty.txt", content: "" },
    ]);

    await expect(
      repositoryFor(emptyFile).listSkillFiles({
        actorId: ACTOR_ID,
        skillIds: [SKILL_ONE],
      }),
    ).resolves.toEqual([
      { skill_id: SKILL_ONE, file_path: "assets/empty.txt", content: "" },
    ]);
  });
});

describe("workspace-skill-read-repository: failure classification", () => {
  it("case 10: a driver error becomes a fixed-message WorkspaceSkillReadError, with the driver error on the cause", async () => {
    const driverError = Object.assign(
      new Error(
        'invalid input syntax for type uuid: "not-a-uuid" — select f.skill_id from public.skill_files f',
      ),
      { code: "22P02" },
    );
    const harness = createHarness(() => {
      throw driverError;
    });

    const error = await repositoryFor(harness)
      .listSkillFiles({ actorId: ACTOR_ID, skillIds: [INVALID_ID] })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WorkspaceSkillReadError);
    expect((error as WorkspaceSkillReadError).operation).toBe(LIST_SKILL_FILES);
    // The published message carries no SQL, no host and no id.
    expect((error as WorkspaceSkillReadError).message).toBe(
      `workspace skill read failed (${LIST_SKILL_FILES})`,
    );
    expect((error as WorkspaceSkillReadError).message).not.toMatch(
      /public\.|skill_files|invalid input|postgres:\/\//i,
    );
    expect((error as WorkspaceSkillReadError).cause).toBe(driverError);
  });

  it("case 11: a connect failure is classified the same way and never leaves a silent empty answer", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("pool exhausted"),
    });

    const error = await repositoryFor(harness)
      .listEnabledWorkspaceSkills({ actorId: ACTOR_ID, workspaceId: WORKSPACE_ID })
      .catch((reason: unknown) => reason);

    // An empty skill list and an unreachable database are DIFFERENT answers, and
    // only the caller may decide to degrade.
    expect(error).toBeInstanceOf(WorkspaceSkillReadError);
    expect((error as WorkspaceSkillReadError).operation).toBe(
      LIST_ENABLED_WORKSPACE_SKILLS,
    );
    expect(String((error as WorkspaceSkillReadError).cause)).toContain(
      "pool exhausted",
    );
  });
});
