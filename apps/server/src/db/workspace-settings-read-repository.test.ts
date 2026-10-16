import { describe, expect, it } from "vitest";

import {
  READ_DEFAULT_MODEL,
  WorkspaceSettingsReadError,
  createWorkspaceSettingsReadRepository,
} from "./workspace-settings-read-repository.js";
import {
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor and workspace it carries, which table and
 * column it may read, and how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built — including that the membership
 * predicate is INSIDE it and is the READ half of the ACL (any role, no
 * `owner_user_id`). The PGlite file beside them
 * (`test-support/db/workspace-settings-read-repository-db.test.ts`) proves
 * PostgreSQL actually parses and executes it, and that it answers exactly what
 * the `workspace_settings_select` policy answers for the same identity.
 *
 * Statement-sequence assertions deliberately look only at the DOMAIN statements
 * (the ones naming `public.`), never at how many `set_config` calls the
 * transaction helper makes: that count belongs to `db/transaction.ts` and its
 * batching has already changed once without touching any repository.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000a2";
const STORED_MODEL = "stored-model";
const FALLBACK_OF_THE_CALLER = "gpt-5.4-mini";

/** A row shaped the way `select s.default_model` answers. */
const SETTINGS_ROW = { default_model: STORED_MODEL };

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

      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback ||
        sql === TRANSACTION_STATEMENTS.setLocalSetting
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
 * The repository's own statements, and only them: BEGIN / COMMIT / ROLLBACK and
 * whatever the transaction helper uses to set its context carry no
 * schema-qualified name, so anything naming `public.` is a domain statement. Two
 * of them would mean the read was split.
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql);
}

function repositoryFor(harness: Harness) {
  return createWorkspaceSettingsReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the arguments named once. */
function read(repository: ReturnType<typeof repositoryFor>) {
  return repository.readDefaultModel({
    actorId: ACTOR_ID,
    workspaceId: WORKSPACE_ID,
  });
}

describe("workspace-settings-read-repository: the statement it issues", () => {
  it("case 1: reads inside one transaction that carries the actor and the workspace", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await read(repositoryFor(harness));

    const issued = statements(harness.queries);
    expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(issued.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no second lookup, no read-back, no probe.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: binds the actor and the workspace as parameters, never as text", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await read(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([ACTOR_ID, WORKSPACE_ID]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).toContain("$2");
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain(WORKSPACE_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: the row is gated by a membership predicate inside the same statement", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await read(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // The verbatim translation of the `workspace_settings_select` policy: the
    // settings row is answered only when a membership row ties THIS actor to
    // THIS row's workspace.
    expect(sql).toContain("select s.default_model");
    expect(sql).toContain("from public.workspace_settings s");
    expect(sql).toContain("s.workspace_id = $2::uuid");
    expect(sql).toContain("exists (");
    expect(sql).toContain("from public.workspace_members wm");
    expect(sql).toContain("wm.workspace_id = s.workspace_id");
    expect(sql).toContain("wm.user_id = $1::uuid");

    // Exactly two tables are reachable: the settings row and the membership that
    // authorises it.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual([
      "public.workspace_settings",
      "public.workspace_members",
    ]);
    // One statement, never a batch: nothing can run between the gate and the read.
    expect(sql).not.toContain(";");
  });

  it("case 4: the predicate carries NO role condition — the read policy has none", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await read(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // Workorder 21E1 translated the INSERT/UPDATE policies, which DO read the
    // role. This is the read policy, which does not: every member reads. Adding
    // `role in (...)` here would deny plain members a model they can read today.
    // Matched as the column and as the three role literals, so the words may
    // still appear inside `public.workspace_members` — which is the membership
    // table, not a role filter.
    expect(sql).not.toMatch(/\brole\b/i);
    expect(sql).not.toMatch(/wm\.[a-z_]*role/);
    for (const literal of ["'owner'", "'admin'", "'member'"]) {
      expect(sql).not.toContain(literal);
    }
  });

  it("case 5: it is a read of one column and never consults workspaces.owner_user_id", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);

    await read(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // Workorder 21E0 froze this boundary: `workspaces.owner_user_id` is not a
    // settings rule, in either direction. The statement must not reach for it.
    expect(sql).not.toContain("owner_user_id");
    expect(sql).not.toMatch(/public\.workspaces\b/);
    // A read only. No write verb may appear in the statement at all.
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i);
    // The single selected column is `default_model` — nothing else of the row is
    // read, and no column list the caller supplied could widen it.
    const projection = /select([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? "";
    expect(projection.trim()).toBe("s.default_model");
  });
});

describe("workspace-settings-read-repository: the answers it maps", () => {
  it("case 6: one row answers its stored model", async () => {
    const harness = createHarness(() => [{ default_model: "another-model" }]);

    await expect(read(repositoryFor(harness))).resolves.toBe("another-model");
  });

  it("case 7: zero rows is null — not an error and not an empty string", async () => {
    const harness = createHarness(() => []);

    // "Not a member" and "no settings row" are the same answer on purpose. The
    // caller turns it into its own default model, so a 403 here would break
    // agent starts for every non-member.
    await expect(read(repositoryFor(harness))).resolves.toBeNull();
    // The read committed: a legal empty answer is not a rolled-back transaction.
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 8: an empty stored value is answered as-is, not replaced by a fallback", async () => {
    const harness = createHarness(() => [{ default_model: "" }]);

    // Pinned rather than changed: the projection this read replaces was
    // `data?.default_model ?? fallback`, and `??` only replaces null/undefined.
    // This module publishes what the column holds; choosing a fallback is the
    // caller's decision and stays there.
    await expect(read(repositoryFor(harness))).resolves.toBe("");
    await expect(read(repositoryFor(harness))).resolves.not.toBe(
      FALLBACK_OF_THE_CALLER,
    );
  });

  it("case 9: more than one row is a fixed failure, not a first row", async () => {
    const harness = createHarness(() => [SETTINGS_ROW, { default_model: "second" }]);

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
    expect((error as WorkspaceSettingsReadError).operation).toBe(READ_DEFAULT_MODEL);
    // The refusal is raised INSIDE the transaction, so it rolls back exactly like
    // a real SQL failure and the two cannot be told apart from the outside.
    expect(statements(harness.queries).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
  });
});

describe("workspace-settings-read-repository: unusable answers and failures", () => {
  it("case 10: a row that is not an object, or a `default_model` that is not a string, is a fixed failure", async () => {
    const answers: unknown[] = [
      null,
      "not a row",
      [SETTINGS_ROW],
      42,
      // `default_model` is `text NOT NULL`: a number, a boolean or a NULL is
      // drift, and a missing column means the statement and the mapper disagree.
      {},
      { default_model: 7 },
      { default_model: null },
      { default_model: true },
      { default_model: { value: STORED_MODEL } },
      { other_column: STORED_MODEL },
    ];

    for (const answer of answers) {
      const harness = createHarness(() => [answer]);
      const error = await read(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
      expect((error as WorkspaceSettingsReadError).operation).toBe(
        READ_DEFAULT_MODEL,
      );
      expect(statements(harness.queries).at(-1)).toBe(
        TRANSACTION_STATEMENTS.rollback,
      );
    }
  });

  it("case 11: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "select s.default_model from public.workspace_settings failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
    const readError = error as WorkspaceSettingsReadError;
    expect(readError.message).toBe(
      `workspace settings read failed (${READ_DEFAULT_MODEL})`,
    );
    expect(readError.cause).toBe(failure);
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(readError.message).not.toMatch(
      /public\.|workspace_settings|workspace_members|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 12: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(() => [SETTINGS_ROW], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await read(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
    expect((error as WorkspaceSettingsReadError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 13: an unusable argument is refused before any connection is opened", async () => {
    const complete = { actorId: ACTOR_ID, workspaceId: WORKSPACE_ID };
    const args: Array<Record<string, unknown>> = [
      { ...complete, actorId: undefined },
      { ...complete, actorId: null },
      { ...complete, actorId: "" },
      { ...complete, actorId: 7 },
      { ...complete, workspaceId: undefined },
      { ...complete, workspaceId: null },
      { ...complete, workspaceId: "" },
      { ...complete, workspaceId: 7 },
    ];

    for (const input of args) {
      const harness = createHarness(() => [SETTINGS_ROW]);
      const error = await repositoryFor(harness)
        .readDefaultModel(input as typeof complete)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
      expect((error as WorkspaceSettingsReadError).operation).toBe(
        READ_DEFAULT_MODEL,
      );
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 14: the repository exposes readDefaultModel and nothing else", async () => {
    const harness = createHarness(() => [SETTINGS_ROW]);
    const repository = repositoryFor(harness);

    // A shape rather than a promise: no second method, no access token, no table
    // name and no column list a caller could widen the read with.
    expect(Object.keys(repository)).toEqual([READ_DEFAULT_MODEL]);
    expect(repository.readDefaultModel).toHaveLength(1);

    await read(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      ACTOR_ID,
      WORKSPACE_ID,
    ]);
  });
});

describe("workspace-settings-read-repository: the pool is lazy", () => {
  it("case 15: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createWorkspaceSettingsReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await read(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
    expect((error as WorkspaceSettingsReadError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
