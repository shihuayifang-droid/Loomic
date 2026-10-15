import { describe, expect, it } from "vitest";

import {
  UPSERT_DEFAULT_MODEL,
  WorkspaceSettingsWriteError,
  createWorkspaceSettingsWriteRepository,
  type WorkspaceSettingsWriteRow,
} from "./workspace-settings-write-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor and workspace it carries, which columns it may
 * write, and how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built — including that the membership
 * gate is INSIDE it, so there is no read-then-write window. The PGlite file
 * beside them (`test-support/db/workspace-settings-write-repository-db.test.ts`)
 * proves PostgreSQL actually parses, executes and rolls it back, and that the
 * frozen 21E0 write matrix still holds.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000a2";
const DEFAULT_MODEL = "gpt-5.4-mini";

/** A row shaped the way `RETURNING workspace_id, default_model` answers. */
const SETTINGS_ROW = {
  workspace_id: WORKSPACE_ID,
  default_model: DEFAULT_MODEL,
};

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

/**
 * The repository's own statement, and only it: BEGIN/COMMIT/set_config carry no
 * schema-qualified name, so anything naming `public.` is a domain statement. A
 * second one would mean the write was split (a check first, then a write).
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);
  const pairs: unknown[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]]);
  }
  return pairs;
}

function repositoryFor(harness: Harness) {
  return createWorkspaceSettingsWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the arguments named once. */
function write(repository: ReturnType<typeof repositoryFor>) {
  return repository.upsertDefaultModel({
    actorId: ACTOR_ID,
    workspaceId: WORKSPACE_ID,
    defaultModel: DEFAULT_MODEL,
  });
}

describe("workspace-settings-write-repository: the statement it issues", () => {
  it("case 1: writes inside one privileged transaction that carries the actor and the workspace", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await write(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no read-back, no check-then-write pair, no
    // second update, no cleanup. This is the structural half of "no TOCTOU".
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ACTOR_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, WORKSPACE_ID],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds the actor, the workspace and the model as parameters, never as text", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await write(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([ACTOR_ID, WORKSPACE_ID, DEFAULT_MODEL]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).toContain("$2");
    expect(statement?.sql).toContain("$3");
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain(WORKSPACE_ID);
    expect(statement?.sql).not.toContain(DEFAULT_MODEL);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: the insert is gated by an owner/admin membership predicate inside the same statement", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await write(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // The row the INSERT may write comes from a filtered SELECT: no membership
    // row for this actor and this workspace means no row to insert at all.
    expect(sql).toContain(
      "insert into public.workspace_settings (workspace_id, default_model)",
    );
    expect(sql).toContain("select $2::uuid, $3::text");
    expect(sql).toContain("where exists");
    expect(sql).toContain("from public.workspace_members wm");
    expect(sql).toContain("wm.workspace_id = $2::uuid");
    expect(sql).toContain("wm.user_id = $1::uuid");
    expect(sql).toContain("wm.role in ('owner', 'admin')");

    // Exactly two tables are reachable, and the gate is workspace_members — the
    // 21E0 contract. `workspaces.owner_user_id` is NOT a write rule, so the
    // statement must not consult it.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual([
      "public.workspace_settings",
      "public.workspace_members",
    ]);
    expect(sql).not.toContain("workspaces ");
    expect(sql).not.toContain("owner_user_id");
    // One statement, never a batch: nothing can run between the gate and the write.
    expect(sql).not.toContain(";");
  });

  it("case 4: the conflict branch updates ONLY default_model and cannot retarget the row", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await write(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("on conflict (workspace_id) do update");

    // Exactly one assignment list in the whole statement, and it sets the model
    // from `excluded` — the row cannot be moved to another workspace and no
    // other column of it is named.
    expect(sql.match(/\bset\b/gi)).toHaveLength(1);
    const conflictClause = /do update([\s\S]*?)returning/i.exec(sql)?.[1] ?? "";
    expect(conflictClause).toContain("set default_model = excluded.default_model");
    expect(conflictClause).not.toContain("workspace_id");
    expect(conflictClause).not.toContain("created_at");
    expect(conflictClause).not.toContain("updated_at");

    const returning = /returning([\s\S]*)$/i.exec(sql)?.[1] ?? "";
    expect(returning).toContain("workspace_id");
    expect(returning).toContain("default_model");
  });

  it("case 5: maps the returned row", async () => {
    const harness = createHarness(() => [
      { workspace_id: WORKSPACE_ID, default_model: "another-model" },
    ]);

    const row = await write(repositoryFor(harness));

    expect(row).toEqual({
      workspaceId: WORKSPACE_ID,
      defaultModel: "another-model",
    } satisfies WorkspaceSettingsWriteRow);
  });

  it("case 6: the repository exposes upsertDefaultModel and nothing else", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);
    const repository = repositoryFor(harness);

    // Requirement 1 of workorder 21E1, as a shape rather than a promise: there is
    // no second method, no access token, no table name and no generic patch entry
    // point a caller could widen the write with.
    expect(Object.keys(repository)).toEqual([UPSERT_DEFAULT_MODEL]);
    expect(repository.upsertDefaultModel).toHaveLength(1);

    await write(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      ACTOR_ID,
      WORKSPACE_ID,
      DEFAULT_MODEL,
    ]);
  });
});

describe("workspace-settings-write-repository: refusals", () => {
  it("case 7: zero rows is a fixed write failure, not a null result", async () => {
    const harness = createHarness(() => []);

    const error = await write(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
    const writeError = error as WorkspaceSettingsWriteError;
    expect(writeError.operation).toBe(UPSERT_DEFAULT_MODEL);
    expect(writeError.message).toBe(
      `workspace settings write failed (${UPSERT_DEFAULT_MODEL})`,
    );
    // The fixed message carries no SQL, no id and no "were you a member" answer.
    expect(writeError.message).not.toMatch(
      /row|workspace id|owner|admin|member|uuid|sql/i,
    );
    // Zero rows is PostgreSQL's own answer (no error at all), so the refusal is
    // raised by this module INSIDE the transaction: the transaction therefore
    // rolls back. That keeps the refusal on exactly the same path as a real SQL
    // failure, so a caller cannot tell the two apart.
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 8: more than one row is a fixed write failure, not a first row", async () => {
    const harness = createHarness(() => [SETTINGS_ROW, SETTINGS_ROW]);

    await expect(write(repositoryFor(harness))).rejects.toBeInstanceOf(
      WorkspaceSettingsWriteError,
    );
  });

  it("case 9: a row that is not an object, or an unusable column, is a fixed write failure", async () => {
    const answers: unknown[] = [
      null,
      "not a row",
      [SETTINGS_ROW],
      42,
      // workspace_id: missing, empty, or not a string.
      { default_model: DEFAULT_MODEL },
      { ...SETTINGS_ROW, workspace_id: "" },
      { ...SETTINGS_ROW, workspace_id: 7 },
      // default_model: the statement just wrote it, so NULL or '' is drift.
      { workspace_id: WORKSPACE_ID },
      { ...SETTINGS_ROW, default_model: null },
      { ...SETTINGS_ROW, default_model: "" },
      { ...SETTINGS_ROW, default_model: 7 },
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      const error = await write(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
      expect((error as WorkspaceSettingsWriteError).operation).toBe(
        UPSERT_DEFAULT_MODEL,
      );
    }
  });

  it("case 10: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "insert into public.workspace_settings failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await write(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
    const writeError = error as WorkspaceSettingsWriteError;
    expect(writeError.cause).toBe(failure);
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
    expect(writeError.message).not.toMatch(
      /public\.|workspace_settings|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 11: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await write(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
    expect((error as WorkspaceSettingsWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 12: an unusable argument is refused before any connection is opened", async () => {
    const complete = {
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
      defaultModel: DEFAULT_MODEL,
    };
    const args: Array<Record<string, unknown>> = [
      { ...complete, actorId: undefined },
      { ...complete, actorId: "" },
      { ...complete, actorId: 7 },
      { ...complete, workspaceId: undefined },
      { ...complete, workspaceId: "" },
      { ...complete, workspaceId: 7 },
      { ...complete, defaultModel: undefined },
      { ...complete, defaultModel: "" },
      { ...complete, defaultModel: 7 },
    ];

    for (const input of args) {
      const harness = createHarness(() => [SETTINGS_ROW]);
      const error = await repositoryFor(harness)
        .upsertDefaultModel(input as typeof complete)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
      expect((error as WorkspaceSettingsWriteError).operation).toBe(
        UPSERT_DEFAULT_MODEL,
      );
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });
});

describe("workspace-settings-write-repository: the pool is lazy", () => {
  it("case 13: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createWorkspaceSettingsWriteRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await write(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
    expect((error as WorkspaceSettingsWriteError).operation).toBe(
      UPSERT_DEFAULT_MODEL,
    );
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as WorkspaceSettingsWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
