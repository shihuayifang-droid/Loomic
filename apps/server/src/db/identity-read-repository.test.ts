import { describe, expect, it } from "vitest";

import {
  FIND_PERSONAL_FOUNDATION,
  FIND_TEAM_MEMBERSHIP,
  RepositoryReadError,
  createIdentityReadRepository,
  type PersonalFoundationRecord,
  type TeamMembershipRecord,
} from "./identity-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor it carries, and how it classifies every way a
 * read can fail.
 */

const USER_ID = "00000000-0000-0000-0000-00000000000a";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";

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

/** Only the two domain statements mention this table; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public.workspaces"));
}

function contextCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting,
  );
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  return contextCalls(queries).map((entry) => [...(entry.params ?? [])]);
}

const FOUNDATION_ROW = {
  workspace_id: WORKSPACE_ID,
  workspace_name: "Personal",
  workspace_type: "personal",
  workspace_owner_user_id: USER_ID,
  profile_id: USER_ID,
  profile_email: "member@hahart.test",
  profile_display_name: "Member",
  profile_avatar_url: null,
  membership_workspace_id: WORKSPACE_ID,
  membership_user_id: USER_ID,
  membership_role: "owner",
};

const TEAM_ROW = {
  workspace_id: "11111111-1111-1111-1111-111111111111",
  workspace_name: "HaHart 团队",
  workspace_type: "team",
  workspace_owner_user_id: "owner-1",
  membership_role: "admin",
};

describe("identity-read-repository: personal foundation", () => {
  it("case 1: reads inside one privileged transaction that carries the user as actor", async () => {
    const harness = createHarness(() => [FOUNDATION_ROW]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    await repository.findPersonalFoundation(USER_ID);

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, USER_ID],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds the user id as a parameter and never concatenates it", async () => {
    const harness = createHarness(() => [FOUNDATION_ROW]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    await repository.findPersonalFoundation(USER_ID);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([USER_ID]);
    expect(statement?.sql).toContain("$1");
    expect(statement?.sql).not.toContain(USER_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: maps workspace, profile and membership into one record", async () => {
    const harness = createHarness(() => [FOUNDATION_ROW]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const record = await repository.findPersonalFoundation(USER_ID);

    expect(record).toEqual({
      workspace: {
        id: WORKSPACE_ID,
        name: "Personal",
        ownerUserId: USER_ID,
        type: "personal",
      },
      profile: {
        id: USER_ID,
        email: "member@hahart.test",
        displayName: "Member",
        avatarUrl: null,
      },
      membership: {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        role: "owner",
      },
    } satisfies PersonalFoundationRecord);
  });

  it("case 4: null means a required row is missing, never a partial record", async () => {
    const harness = createHarness(() => []);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    expect(await repository.findPersonalFoundation(USER_ID)).toBeNull();

    // The three reads are one inner-joined statement, so "workspace missing",
    // "profile missing" and "membership missing" all yield zero rows. A left
    // join here would be the bug that produces a half-filled record.
    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("join public.profiles");
    expect(sql).toContain("join public.workspace_members");
    expect(sql).not.toContain("left join");
    expect(sql).toContain("limit 1");
  });

  it("case 5: a null profile column stays null instead of failing the shape check", async () => {
    const harness = createHarness(() => [
      {
        ...FOUNDATION_ROW,
        profile_email: null,
        profile_display_name: null,
        profile_avatar_url: null,
      },
    ]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const record = await repository.findPersonalFoundation(USER_ID);

    expect(record?.profile).toEqual({
      id: USER_ID,
      email: null,
      displayName: null,
      avatarUrl: null,
    });
  });

  it("case 6: an unusable role is a RepositoryReadError, not a null record", async () => {
    const harness = createHarness(() => [
      { ...FOUNDATION_ROW, membership_role: "root" },
    ]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const error = await repository
      .findPersonalFoundation(USER_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RepositoryReadError);
    expect((error as RepositoryReadError).operation).toBe(
      FIND_PERSONAL_FOUNDATION,
    );
  });

  it("case 7: a non-object row is a RepositoryReadError", async () => {
    const harness = createHarness(() => [null]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    await expect(
      repository.findPersonalFoundation(USER_ID),
    ).rejects.toBeInstanceOf(RepositoryReadError);
  });

  it("case 8: a failed read rolls back, keeps the cause and leaks no SQL", async () => {
    const failure = new Error(
      "select w.id from public.workspaces failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const error = await repository
      .findPersonalFoundation(USER_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RepositoryReadError);
    const repositoryError = error as RepositoryReadError;
    expect(repositoryError.operation).toBe(FIND_PERSONAL_FOUNDATION);
    expect(repositoryError.cause).toBe(failure);
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
    expect(repositoryError.message).toBe(
      `identity read failed (${FIND_PERSONAL_FOUNDATION})`,
    );
    expect(repositoryError.message).not.toMatch(
      /select|public\.|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 9: a connect failure is a RepositoryReadError and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const error = await repository
      .findPersonalFoundation(USER_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RepositoryReadError);
    expect(harness.queries).toHaveLength(0);
  });
});

describe("identity-read-repository: team membership", () => {
  it("case 10: reads privileged, parameterised, and maps the role", async () => {
    const harness = createHarness(() => [TEAM_ROW]);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const record = await repository.findTeamMembership(USER_ID);

    expect(record).toEqual({
      workspace: {
        id: "11111111-1111-1111-1111-111111111111",
        name: "HaHart 团队",
        ownerUserId: "owner-1",
        type: "team",
      },
      role: "admin",
    } satisfies TeamMembershipRecord);

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([USER_ID]);
    expect(statement?.sql).not.toContain(USER_ID);
    expect(contextParams(harness.queries).at(-1)).toEqual([
      TRANSACTION_SETTING_NAMES.executionMode,
      "privileged",
    ]);
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.commit,
    );
  });

  it("case 11: no team workspace and non-member are both null", async () => {
    const harness = createHarness(() => []);
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    expect(await repository.findTeamMembership(USER_ID)).toBeNull();

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("type = 'team'");
    expect(sql).toContain("order by created_at asc");
    expect(sql).toContain("join public.workspace_members");
    expect(sql).not.toContain("left join");
  });

  it("case 12: a failed membership read is a RepositoryReadError that keeps its cause", async () => {
    const failure = new Error("connection reset");
    const harness = createHarness(() => {
      throw failure;
    });
    const repository = createIdentityReadRepository({
      getTransactionPool: () => harness.pool,
    });

    const error = await repository
      .findTeamMembership(USER_ID)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RepositoryReadError);
    expect((error as RepositoryReadError).operation).toBe(FIND_TEAM_MEMBERSHIP);
    expect((error as RepositoryReadError).cause).toBe(failure);
    expect((error as RepositoryReadError).message).not.toMatch(
      /select|public\./i,
    );
  });
});

describe("identity-read-repository: pool is lazy", () => {
  it("case 13: building the repository never resolves a pool; a missing DATABASE_URL fails on read", async () => {
    let resolutions = 0;
    const repository = createIdentityReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await repository
      .findPersonalFoundation(USER_ID)
      .catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(RepositoryReadError);
    expect((error as RepositoryReadError).operation).toBe(
      FIND_PERSONAL_FOUNDATION,
    );
  });
});
