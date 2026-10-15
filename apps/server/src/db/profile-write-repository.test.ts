import { describe, expect, it } from "vitest";

import {
  ProfileWriteError,
  UPDATE_DISPLAY_NAME,
  createProfileWriteRepository,
  type ProfileWriteRow,
} from "./profile-write-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the single statement
 * the repository issues, the actor it carries, which columns it may write, and
 * how it classifies every way that statement can answer.
 *
 * The unit tests prove WHICH statement is built; the PGlite file beside them
 * (`test-support/db/profile-write-repository-db.test.ts`) proves PostgreSQL
 * parses, executes and rolls it back.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000d1";
const DISPLAY_NAME = "Renamed By The Actor";

/** A row shaped the way `RETURNING id, email, display_name, avatar_url` answers. */
const PROFILE_ROW = {
  id: ACTOR_ID,
  email: "actor@hahart.test",
  display_name: DISPLAY_NAME,
  avatar_url: null,
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

/** The one domain statement mentions this table; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public.profiles"));
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
  return createProfileWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

describe("profile-write-repository: the statement it issues", () => {
  it("case 1: writes inside one privileged transaction that carries the actor", async () => {
    const harness = createHarness(() => [PROFILE_ROW]);

    await repositoryFor(harness).updateDisplayName({
      actorId: ACTOR_ID,
      displayName: DISPLAY_NAME,
    });

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no read-back, no second update, no cleanup.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ACTOR_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds the actor and the new name as parameters, never as text", async () => {
    const harness = createHarness(() => [PROFILE_ROW]);

    await repositoryFor(harness).updateDisplayName({
      actorId: ACTOR_ID,
      displayName: DISPLAY_NAME,
    });

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([ACTOR_ID, DISPLAY_NAME]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).toContain("$2");
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain(DISPLAY_NAME);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: updates ONLY display_name, under a predicate that can only be the actor id", async () => {
    const harness = createHarness(() => [PROFILE_ROW]);

    await repositoryFor(harness).updateDisplayName({
      actorId: ACTOR_ID,
      displayName: DISPLAY_NAME,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    const setClause = /set([\s\S]*?)where/i.exec(sql)?.[1] ?? "";

    // The assignment list is display_name and nothing else: email, avatar_url and
    // every other column of the row are untouched, and no second statement
    // follows to touch them.
    expect(setClause).toContain("display_name = $2::text");
    expect(setClause).not.toContain("email");
    expect(setClause).not.toContain("avatar_url");
    expect(setClause).not.toContain("updated_at");
    expect(sql).not.toContain(";"); // one statement, never a batch

    // The predicate is the actor id, with an explicit uuid cast so a malformed id
    // is a real SQL error rather than a silent non-match.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).not.toContain(" or ");
    expect(sql).not.toContain("join");
    expect(sql).not.toContain("owner");

    // Only one table is reachable from this statement.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.profiles"]);

    // And the four returned columns are the four the response is projected from.
    const returning = /returning([\s\S]*)$/i.exec(sql)?.[1] ?? "";
    for (const column of ["id", "email", "display_name", "avatar_url"]) {
      expect(returning).toContain(column);
    }
  });

  it("case 4: maps the returned row, keeping a null email and avatar null", async () => {
    const harness = createHarness(() => [
      { ...PROFILE_ROW, email: null, avatar_url: "https://cdn.invalid/a.png" },
    ]);

    const row = await repositoryFor(harness).updateDisplayName({
      actorId: ACTOR_ID,
      displayName: DISPLAY_NAME,
    });

    expect(row).toEqual({
      id: ACTOR_ID,
      email: null,
      displayName: DISPLAY_NAME,
      avatarUrl: "https://cdn.invalid/a.png",
    } satisfies ProfileWriteRow);
  });

  it("case 5: the repository exposes updateDisplayName and nothing else", async () => {
    const harness = createHarness(() => [PROFILE_ROW]);
    const repository = repositoryFor(harness);

    // Requirement 1 of workorder 21D, as a shape rather than a promise: there is
    // no second method, no access token, no profile id and no generic patch
    // entry point a caller could widen the write with.
    expect(Object.keys(repository)).toEqual([UPDATE_DISPLAY_NAME]);
    expect(repository.updateDisplayName).toHaveLength(1);

    await repository.updateDisplayName({
      actorId: ACTOR_ID,
      displayName: DISPLAY_NAME,
    });

    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      ACTOR_ID,
      DISPLAY_NAME,
    ]);
  });
});

describe("profile-write-repository: refusals", () => {
  it("case 6: zero rows is a fixed write failure, not a null result", async () => {
    const harness = createHarness(() => []);

    const error = await repositoryFor(harness)
      .updateDisplayName({ actorId: ACTOR_ID, displayName: DISPLAY_NAME })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    const writeError = error as ProfileWriteError;
    expect(writeError.operation).toBe(UPDATE_DISPLAY_NAME);
    expect(writeError.message).toBe(
      `profile write failed (${UPDATE_DISPLAY_NAME})`,
    );
    expect(writeError.message).not.toMatch(
      /row|profile id|uuid|sql/i,
    );
    // Zero rows is PostgreSQL's own answer (no error at all), so the refusal is
    // raised by this module INSIDE the transaction: the transaction therefore
    // rolls back. That costs nothing — the statement changed no row — and it
    // keeps the zero-row case on exactly the same path as a real SQL failure, so
    // a caller cannot tell the two apart.
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 7: more than one row is a fixed write failure, not a first row", async () => {
    const harness = createHarness(() => [PROFILE_ROW, PROFILE_ROW]);

    await expect(
      repositoryFor(harness).updateDisplayName({
        actorId: ACTOR_ID,
        displayName: DISPLAY_NAME,
      }),
    ).rejects.toBeInstanceOf(ProfileWriteError);
  });

  it("case 8: a row that is not an object is a fixed write failure", async () => {
    for (const answer of [null, "not a row", [PROFILE_ROW], 42]) {
      const harness = createHarness(() => [answer]);

      await expect(
        repositoryFor(harness).updateDisplayName({
          actorId: ACTOR_ID,
          displayName: DISPLAY_NAME,
        }),
      ).rejects.toBeInstanceOf(ProfileWriteError);
    }
  });

  it("case 9: an unusable column is a fixed write failure, never a repaired value", async () => {
    const unusable: Array<Record<string, unknown>> = [
      // id: missing entirely, empty, or not a string.
      { email: null, display_name: DISPLAY_NAME, avatar_url: null },
      { ...PROFILE_ROW, id: "" },
      { ...PROFILE_ROW, id: 7 },
      // display_name: the statement just set it, so NULL or '' is a disagreement.
      { ...PROFILE_ROW, display_name: null },
      { ...PROFILE_ROW, display_name: "" },
      { ...PROFILE_ROW, display_name: 7 },
      // email / avatar_url: nullable columns, but the COLUMN must be present.
      { id: ACTOR_ID, display_name: DISPLAY_NAME, avatar_url: null },
      { id: ACTOR_ID, display_name: DISPLAY_NAME, email: null },
      { ...PROFILE_ROW, email: 7 },
      { ...PROFILE_ROW, avatar_url: 7 },
      // An explicitly undefined column is drift, not a business NULL.
      { ...PROFILE_ROW, email: undefined },
    ];

    for (const row of unusable) {
      const harness = createHarness(() => [row]);
      const error = await repositoryFor(harness)
        .updateDisplayName({ actorId: ACTOR_ID, displayName: DISPLAY_NAME })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProfileWriteError);
      expect((error as ProfileWriteError).operation).toBe(UPDATE_DISPLAY_NAME);
    }
  });

  it("case 10: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "update public.profiles set display_name = $2 failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await repositoryFor(harness)
      .updateDisplayName({ actorId: ACTOR_ID, displayName: DISPLAY_NAME })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    const writeError = error as ProfileWriteError;
    expect(writeError.cause).toBe(failure);
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
    expect(writeError.message).not.toMatch(
      /public\.|set display_name|where id|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 11: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await repositoryFor(harness)
      .updateDisplayName({ actorId: ACTOR_ID, displayName: DISPLAY_NAME })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProfileWriteError);
    expect((error as ProfileWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 12: an unusable argument is refused before any connection is opened", async () => {
    const args: Array<{ actorId: unknown; displayName: unknown }> = [
      { actorId: undefined, displayName: DISPLAY_NAME },
      { actorId: "", displayName: DISPLAY_NAME },
      { actorId: 7, displayName: DISPLAY_NAME },
      { actorId: ACTOR_ID, displayName: undefined },
      { actorId: ACTOR_ID, displayName: "" },
      { actorId: ACTOR_ID, displayName: 7 },
    ];

    for (const input of args) {
      const harness = createHarness(() => [PROFILE_ROW]);
      const error = await repositoryFor(harness)
        .updateDisplayName(input as { actorId: string; displayName: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ProfileWriteError);
      expect((error as ProfileWriteError).operation).toBe(UPDATE_DISPLAY_NAME);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });
});

describe("profile-write-repository: the pool is lazy", () => {
  it("case 13: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createProfileWriteRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await repository
      .updateDisplayName({ actorId: ACTOR_ID, displayName: DISPLAY_NAME })
      .catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(ProfileWriteError);
    expect((error as ProfileWriteError).operation).toBe(UPDATE_DISPLAY_NAME);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as ProfileWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
