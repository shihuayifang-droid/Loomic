import { describe, expect, it } from "vitest";

import {
  FIND_PROFILE_BY_EMAIL_FOR_ADMIN,
  LIST_TEAM_MEMBERS,
  TeamAdminReadError,
  createTeamAdminReadRepository,
  type TeamAdminReadRepository,
} from "./team-admin-read-repository.js";
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
 * The SQL assertions are deliberately about the AUTHORIZATION predicate — the
 * actor's membership row with role admin/owner, the absent `owner_user_id`
 * shortcut, the LEFT JOIN that keeps a profile-less member — and about the
 * absence of concatenated values. A statement that merely returns rows would
 * pass a "happy path" test while handing the roster to anyone.
 */

const ACTOR_ID = "00000000-0000-0000-0000-00000000000a";
const ADMIN_ID = "00000000-0000-0000-0000-00000000000e";
const OWNER_ID = "00000000-0000-0000-0000-00000000000f";
const MEMBER_ID = "00000000-0000-0000-0000-00000000000b";
const PROFILE_ID = "00000000-0000-0000-0000-000000000011";

/** The value `addMember` would pass after its own trim. */
const LOOKUP_EMAIL = "b@hahart.test";

const JOINED_AT = new Date("2026-01-02T03:04:05.678Z");

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

/** Only the domain statement touches these tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public.workspace_members"));
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

function repositoryFor(harness: Harness): TeamAdminReadRepository {
  return createTeamAdminReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** Run a read that is expected to fail and return what it threw. */
async function capture(
  repository: TeamAdminReadRepository,
  actorId = ACTOR_ID,
): Promise<unknown> {
  return repository.listTeamMembers({ actorId }).catch((reason: unknown) => reason);
}

function expectReadError(error: unknown): TeamAdminReadError {
  expect(error).toBeInstanceOf(TeamAdminReadError);
  const readError = error as TeamAdminReadError;
  expect(readError.operation).toBe(LIST_TEAM_MEMBERS);
  // Fixed text: the driver message must not travel through the repository.
  expect(readError.message).toBe(`team admin read failed (${LIST_TEAM_MEMBERS})`);
  return readError;
}

/** Run a profile lookup that is expected to fail and return what it threw. */
async function captureLookup(
  repository: TeamAdminReadRepository,
  email = LOOKUP_EMAIL,
  actorId = ACTOR_ID,
): Promise<unknown> {
  return repository
    .findProfileByEmailForAdmin({ actorId, email })
    .catch((reason: unknown) => reason);
}

function expectLookupError(error: unknown): TeamAdminReadError {
  expect(error).toBeInstanceOf(TeamAdminReadError);
  const readError = error as TeamAdminReadError;
  expect(readError.operation).toBe(FIND_PROFILE_BY_EMAIL_FOR_ADMIN);
  // Fixed text: no SQL, no host and no driver message may travel through us.
  expect(readError.message).toBe(
    `team admin read failed (${FIND_PROFILE_BY_EMAIL_FOR_ADMIN})`,
  );
  return readError;
}

/** The one statement the lookup issues (the transaction statements carry no table). */
function lookupSql(queries: readonly QueryRecord[]): string {
  const statements = domainCalls(queries);
  expect(statements).toHaveLength(1);
  return statements[0]?.sql ?? "";
}

const MEMBER_ROW = {
  user_id: MEMBER_ID,
  role: "member",
  created_at: JOINED_AT,
  email: "b@hahart.test",
  display_name: "Member B",
};

const ADMIN_ROW = {
  user_id: ADMIN_ID,
  role: "admin",
  created_at: "2026-01-01T00:00:00.000Z",
  email: "e@hahart.test",
  display_name: null,
};

describe("team-admin-read-repository: listTeamMembers", () => {
  it("case 1: reads inside one privileged transaction that carries the actor and binds it once", async () => {
    const harness = createHarness(() => [ADMIN_ROW, MEMBER_ROW]);

    await repositoryFor(harness).listTeamMembers({ actorId: ACTOR_ID });

    const settingNames = contextParams(harness.queries).map((params) => params[0]);
    expect(settingNames).toEqual([...TRANSACTION_SETTING_ORDER]);
    expect(
      contextParams(harness.queries).find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.userId, ACTOR_ID]);
    expect(
      contextParams(harness.queries).find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.executionMode,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.executionMode, "privileged"]);

    // One statement, not three: workspace, ACL and members come from the same
    // snapshot, so the list cannot be assembled from two team workspaces.
    const statements = domainCalls(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([ACTOR_ID]);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: the statement carries the ACL and the projection the old reads produced", async () => {
    const harness = createHarness(() => [ADMIN_ROW, MEMBER_ROW]);

    await repositoryFor(harness).listTeamMembers({ actorId: ACTOR_ID });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    // The first team workspace, ordered exactly as the PostgREST chain ordered it.
    expect(sql).toContain("from public.workspaces");
    expect(sql).toContain("where type = 'team'");
    expect(sql).toContain("order by created_at asc");
    expect(sql).toContain("limit 1");
    // The ACL: the actor needs a real membership row with an admin/owner role.
    expect(sql).toContain("join public.workspace_members as actor");
    expect(sql).toContain("actor.workspace_id = w.id");
    expect(sql).toContain("actor.user_id = $1");
    expect(sql).toContain("actor.role in ('admin', 'owner')");
    // Every member of that workspace, owner included.
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.workspace_id = w.id");
    expect(sql).toContain("order by m.created_at asc");
    // A member without a profile row must survive the join.
    expect(sql).toContain("left join public.profiles as p");
    expect(sql).toContain("on p.id = m.user_id");
    // The legacy branch this deliberately does NOT copy: `owner_user_id` alone.
    expect(sql).not.toContain("owner_user_id");
    expect(sql).not.toMatch(/select\s+\*/i);
    // The execution mode is a diagnostic label, never an authorization input.
    expect(sql).not.toContain("execution_mode");
  });

  it("case 3: the caller value is never concatenated into the statement", async () => {
    const harness = createHarness(() => [MEMBER_ROW]);

    await repositoryFor(harness).listTeamMembers({ actorId: ACTOR_ID });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    for (const value of [ACTOR_ID, ADMIN_ID, MEMBER_ID, OWNER_ID]) {
      expect(sql).not.toContain(value);
    }
    expect(sql).not.toContain("$2");
  });

  it("case 4: the pool is lazy — building the repository connects to nothing", async () => {
    const harness = createHarness(() => [MEMBER_ROW]);
    let asked = 0;

    const repository = createTeamAdminReadRepository({
      getTransactionPool: () => {
        asked += 1;
        return harness.pool;
      },
    });

    expect(asked).toBe(0);
    expect(harness.connectAttempts()).toBe(0);

    await repository.listTeamMembers({ actorId: ACTOR_ID });

    expect(asked).toBe(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 5: every role and both timestamp shapes map to the shared DTO", async () => {
    const harness = createHarness(() => [
      { ...ADMIN_ROW, user_id: OWNER_ID, role: "owner", created_at: JOINED_AT },
      ADMIN_ROW,
      MEMBER_ROW,
    ]);

    const members = await repositoryFor(harness).listTeamMembers({
      actorId: ACTOR_ID,
    });

    expect(members).toEqual([
      {
        userId: OWNER_ID,
        email: "e@hahart.test",
        displayName: null,
        role: "owner",
        joinedAt: "2026-01-02T03:04:05.678Z",
      },
      {
        userId: ADMIN_ID,
        email: "e@hahart.test",
        displayName: null,
        role: "admin",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: MEMBER_ID,
        email: "b@hahart.test",
        displayName: "Member B",
        role: "member",
        joinedAt: "2026-01-02T03:04:05.678Z",
      },
    ]);
  });

  it("case 6: a member without a profile is kept and projected as email '' / displayName null", async () => {
    const harness = createHarness(() => [
      { ...MEMBER_ROW, email: null, display_name: null },
      // A profile that exists but whose email is NULL answers the same way the
      // old `profile?.email ?? ""` did.
      { ...ADMIN_ROW, email: null, display_name: "Admin" },
      // An empty string is a legal value and stays empty.
      { ...MEMBER_ROW, user_id: OWNER_ID, email: "", display_name: "" },
    ]);

    const members = await repositoryFor(harness).listTeamMembers({
      actorId: ACTOR_ID,
    });

    expect(members.map((member) => [member.email, member.displayName])).toEqual([
      ["", null],
      ["", "Admin"],
      ["", ""],
    ]);
  });

  it("case 7: a missing nullable column or an explicit undefined fails loud", async () => {
    for (const field of ["email", "display_name"] as const) {
      const missing: Record<string, unknown> = { ...MEMBER_ROW };
      delete missing[field];

      const absent = expectReadError(
        await capture(repositoryFor(createHarness(() => [missing]))),
      );
      expect((absent.cause as Error).message).toContain(`"${field}"`);

      const undefinedField = expectReadError(
        await capture(
          repositoryFor(createHarness(() => [{ ...MEMBER_ROW, [field]: undefined }])),
        ),
      );
      expect((undefinedField.cause as Error).message).toContain(`"${field}"`);
    }
  });

  it("case 8: an unusable user_id, role or timestamp fails loud", async () => {
    const unusable: Array<[string, Record<string, unknown>]> = [
      ["user_id", { user_id: "" }],
      ["user_id", { user_id: null }],
      ["user_id", { user_id: 7 }],
      ["role", { role: "viewer" }],
      ["role", { role: "OWNER" }],
      ["role", { role: null }],
      ["created_at", { created_at: "not a timestamp" }],
      ["created_at", { created_at: null }],
      ["created_at", { created_at: new Date("nope") }],
    ];

    for (const [field, patch] of unusable) {
      const error = expectReadError(
        await capture(repositoryFor(createHarness(() => [{ ...MEMBER_ROW, ...patch }]))),
      );
      expect((error.cause as Error).message).toContain(`"${field}"`);
    }
  });

  it("case 9: a repeated member or a non-object row is a contradiction, not a list", async () => {
    const duplicate = expectReadError(
      await capture(repositoryFor(createHarness(() => [MEMBER_ROW, MEMBER_ROW]))),
    );
    expect((duplicate.cause as Error).message).toMatch(/duplicate member/);

    for (const row of ["row", null, ["row"], 42]) {
      const notAnObject = expectReadError(
        await capture(repositoryFor(createHarness(() => [row]))),
      );
      expect((notAnObject.cause as Error).message).toMatch(/not an object/);
    }
  });

  it("case 10: zero rows are an empty list — no team, no membership and 'not an admin' answer alike", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).listTeamMembers({ actorId: ACTOR_ID }),
    ).resolves.toEqual([]);
    expect(domainCalls(harness.queries)).toHaveLength(1);
  });

  it("case 11: a SQL failure keeps the original driver error as the cause and rolls back", async () => {
    const harness = createHarness(() => {
      throw new Error('relation "public.workspace_members" does not exist');
    });

    const error = expectReadError(
      await capture(repositoryFor(harness)),
    );

    expect((error.cause as Error).message).toContain("does not exist");
    expect(harness.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 12: a connection failure is a TeamAdminReadError whose message leaks no SQL or host", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 for postgres://user:pw@host/db",
      ),
    });

    const error = expectReadError(await capture(repositoryFor(harness)));

    expect(error.message).not.toContain("ECONNREFUSED");
    expect(error.message).not.toContain("postgres://");
    expect(error.message).not.toContain("select");
    expect((error.cause as Error).message).toContain("ECONNREFUSED");
  });
});

describe("team-admin-read-repository: findProfileByEmailForAdmin", () => {
  it("case 13: the lookup runs in one privileged transaction that binds actor and email verbatim", async () => {
    const harness = createHarness(() => [{ id: PROFILE_ID }]);
    // The spaces belong to the caller's value: trimming is the service's job, and
    // the repository must not do it a second time on the way to the statement.
    const email = `  ${LOOKUP_EMAIL}  `;

    await repositoryFor(harness).findProfileByEmailForAdmin({
      actorId: ACTOR_ID,
      email,
    });

    const settings = contextParams(harness.queries);
    expect(
      settings.find((params) => params[0] === TRANSACTION_SETTING_NAMES.userId),
    ).toEqual([TRANSACTION_SETTING_NAMES.userId, ACTOR_ID]);
    expect(
      settings.find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.executionMode,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.executionMode, "privileged"]);

    const statements = domainCalls(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([ACTOR_ID, email]);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 14: the lookup pool is lazy — building the repository connects to nothing", async () => {
    const harness = createHarness(() => [{ id: PROFILE_ID }]);
    let asked = 0;

    const repository = createTeamAdminReadRepository({
      getTransactionPool: () => {
        asked += 1;
        return harness.pool;
      },
    });

    expect(asked).toBe(0);
    expect(harness.connectAttempts()).toBe(0);

    await repository.findProfileByEmailForAdmin({
      actorId: ACTOR_ID,
      email: LOOKUP_EMAIL,
    });

    expect(asked).toBe(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 15: the statement carries the same ACL and an exact, case-sensitive equality", async () => {
    const harness = createHarness(() => [{ id: PROFILE_ID }]);

    await repositoryFor(harness).findProfileByEmailForAdmin({
      actorId: ACTOR_ID,
      email: LOOKUP_EMAIL,
    });

    const sql = lookupSql(harness.queries);
    // The team workspace, pinned exactly as the PostgREST chain pinned it.
    expect(sql).toContain("from public.workspaces");
    expect(sql).toContain("where type = 'team'");
    expect(sql).toContain("order by created_at asc");
    expect(sql).toContain("limit 1");
    // The ACL: the actor needs a real admin/owner membership row in that team.
    expect(sql).toContain("join public.workspace_members as actor");
    expect(sql).toContain("actor.workspace_id = w.id");
    expect(sql).toContain("actor.user_id = $1");
    expect(sql).toContain("actor.role in ('admin', 'owner')");
    // The legacy branch this deliberately does NOT copy: `owner_user_id` alone.
    expect(sql).not.toContain("owner_user_id");
    // The execution mode is a diagnostic label, never an authorization input.
    expect(sql).not.toContain("execution_mode");
    expect(sql).not.toMatch(/select\s+\*/i);
    // An exact equality on the email column: no trimming, no case folding, no
    // pattern matching anywhere in the statement.
    expect(sql).toContain("join public.profiles as p");
    expect(sql).toContain("on p.email = $2");
    expect(sql).not.toMatch(/lower\s*\(/i);
    expect(sql).not.toMatch(/trim\s*\(/i);
    expect(sql).not.toMatch(/ilike/i);
    expect(sql).not.toContain("$3");
    // Exactly one ordering: the team-workspace pin. The email match is never
    // narrowed down to "the first row" — several matches are a contradiction.
    expect(sql.match(/order by/gi)).toHaveLength(1);
    for (const value of [ACTOR_ID, OWNER_ID, MEMBER_ID, LOOKUP_EMAIL]) {
      expect(sql).not.toContain(value);
    }
  });

  it("case 16: no matching row answers null, exactly like 'not an admin' does", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).findProfileByEmailForAdmin({
        actorId: ACTOR_ID,
        email: LOOKUP_EMAIL,
      }),
    ).resolves.toBeNull();
    // One statement: "no team", "not a member", "not an admin" and "no such
    // email" cannot be told apart from the number of round trips either.
    expect(domainCalls(harness.queries)).toHaveLength(1);
  });

  it("case 17: one matching row is that profile — the id is taken verbatim", async () => {
    const harness = createHarness(() => [
      // Extra columns are not part of the contract and are ignored.
      { id: PROFILE_ID, email: LOOKUP_EMAIL, display_name: "Member B" },
    ]);

    await expect(
      repositoryFor(harness).findProfileByEmailForAdmin({
        actorId: ACTOR_ID,
        email: LOOKUP_EMAIL,
      }),
    ).resolves.toEqual({ id: PROFILE_ID });
  });

  it("case 18: several profiles with the same email fail loud instead of picking one", async () => {
    const harness = createHarness(() => [
      { id: PROFILE_ID },
      { id: OWNER_ID },
    ]);

    const error = expectLookupError(await captureLookup(repositoryFor(harness)));

    expect((error.cause as Error).message).toMatch(/more than one profile/);
    // The read itself succeeded: several rows are a legal result, and the
    // contradiction is in its shape. The transaction therefore commits and the
    // mapper is what refuses the answer — no row is ever selected for the caller.
    expect(harness.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("case 19: an unusable id or a non-object row is a fixed failure, never a null", async () => {
    const unusable: Array<[string, unknown]> = [
      ["the id field is absent", {}],
      ["the id is undefined", { id: undefined }],
      ["the id is null", { id: null }],
      ["the id is empty", { id: "" }],
      ["the id is a number", { id: 11 }],
    ];

    for (const [label, row] of unusable) {
      const error = expectLookupError(
        await captureLookup(repositoryFor(createHarness(() => [row]))),
      );
      expect((error.cause as Error).message, label).toContain('"id"');
    }

    for (const row of ["row", null, ["row"], 42]) {
      const notAnObject = expectLookupError(
        await captureLookup(repositoryFor(createHarness(() => [row]))),
      );
      expect((notAnObject.cause as Error).message).toMatch(/not an object/);
    }
  });

  it("case 20: a SQL failure keeps the driver cause, rolls back and leaks no SQL or host", async () => {
    const harness = createHarness(() => {
      throw new Error('relation "public.profiles" does not exist');
    });

    const error = expectLookupError(await captureLookup(repositoryFor(harness)));

    expect((error.cause as Error).message).toContain("does not exist");
    expect(harness.queries.at(-1)?.sql).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(error.message).not.toContain("select");
    expect(error.message).not.toContain("profiles");
    expect(error.message).not.toContain("postgres://");
  });
});
