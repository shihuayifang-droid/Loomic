import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIND_PERSONAL_FOUNDATION,
  FIND_TEAM_MEMBERSHIP,
  RepositoryReadError,
  createIdentityReadRepository,
  type IdentityReadRepository,
} from "../../db/identity-read-repository.js";
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
 * Real-SQL integration for the identity read repository (workorder 20
 * integration, ADR-0001 migration step 2a).
 *
 * The unit tests beside the repository prove WHICH statement is built. This
 * file proves PostgreSQL actually parses and executes it: `$1` binding, the uuid
 * and enum mappings, the transaction-local settings of workorder 19, and that a
 * real SQL error rolls back into a connection that still works.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built on real tables, and `afterAll` closes it.
 * PGlite holds a single session, so nothing here runs concurrently and no case
 * may leave a transaction open for the next one.
 */

const MAIN_USER = "00000000-0000-0000-0000-0000000000b1";
const NULLED_PROFILE_USER = "00000000-0000-0000-0000-0000000000b2";
const NO_PROFILE_USER = "00000000-0000-0000-0000-0000000000b3";
const NO_MEMBERSHIP_USER = "00000000-0000-0000-0000-0000000000b4";
const ROLLBACK_USER = "00000000-0000-0000-0000-0000000000b5";
const OUTSIDER_USER = "00000000-0000-0000-0000-0000000000b6";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_USER_ID = "not-a-uuid";

const TEAM_NAME = "HaHart Team";
const MUTATED_DISPLAY_NAME = "MUTATED BY ROLLBACK CASE";

/**
 * The four settings of workorder 19, read back from the server. `true` as the
 * second argument of `current_setting` means "missing is not an error": after
 * the transaction ends the values are simply absent.
 */
const READ_SETTINGS_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

/**
 * `nullif(..., '')` covers both ways a transaction-local setting can be gone
 * after COMMIT: unset (SQL NULL) and an empty placeholder.
 */
const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type SettingsRow = {
  user_id: string;
  workspace_id: string;
  role: string;
  execution_mode: string;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

type DisplayNameRow = { display_name: string | null };

let db: PGlite;
let pool: TransactionPool;
let repository: IdentityReadRepository;

let mainPersonalWorkspaceId = "";
let teamWorkspaceId = "";
let rollbackDisplayName = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/** `TransactionConnection.query` returns `unknown[]`; name the shape once. */
function rowAs<T>(rows: readonly unknown[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row as T;
}

async function countRows(
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  return firstRow(
    (await db.query<{ count: number }>(sql, [...params])).rows,
  ).count;
}

async function displayNameOf(userId: string): Promise<string | null> {
  return firstRow(
    (await db.query<DisplayNameRow>(
      "select display_name from public.profiles where id = $1",
      [userId],
    )).rows,
  ).display_name;
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

async function teamWorkspaceCount(): Promise<number> {
  return countRows(
    "select count(*)::int as count from public.workspaces where type = 'team'",
  );
}

async function personalWorkspaceCount(userId: string): Promise<number> {
  return countRows(
    `select count(*)::int as count
       from public.workspaces
      where owner_user_id = $1
        and type = 'personal'`,
    [userId],
  );
}

async function membershipCount(userId: string): Promise<number> {
  return countRows(
    "select count(*)::int as count from public.workspace_members where user_id = $1",
    [userId],
  );
}

async function profileCount(userId: string): Promise<number> {
  return countRows(
    "select count(*)::int as count from public.profiles where id = $1",
    [userId],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createIdentityReadRepository({ getTransactionPool: () => pool });

  // Real signup path: the auth.users trigger builds profile, personal workspace
  // and the owner membership. Nothing below hand-writes those three rows for a
  // user the cases expect to be complete.
  await createUser(db, MAIN_USER, "main@hahart.test");
  await createUser(db, NULLED_PROFILE_USER, "nulled@hahart.test");
  await createUser(db, NO_PROFILE_USER, "noprofile@hahart.test");
  await createUser(db, NO_MEMBERSHIP_USER, "nomembership@hahart.test");
  await createUser(db, ROLLBACK_USER, "rollback@hahart.test");
  await createUser(db, OUTSIDER_USER, "outsider@hahart.test");

  mainPersonalWorkspaceId = await personalWorkspaceIdOf(MAIN_USER);
  rollbackDisplayName = firstRow(
    (await db.query<DisplayNameRow>(
      "select display_name from public.profiles where id = $1",
      [ROLLBACK_USER],
    )).rows,
  ).display_name as string;

  // Case 6/7 fixture: exactly one team workspace, main user is its admin.
  teamWorkspaceId = firstRow(
    (await db.query<{ id: string }>(
      `insert into public.workspaces (type, name, owner_user_id)
       values ('team', $1, $2)
       returning id`,
      [TEAM_NAME, MAIN_USER],
    )).rows,
  ).id;

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'admin')`,
    [teamWorkspaceId, MAIN_USER],
  );

  // Case 4 fixture: a profile whose three optional column groups are all NULL.
  await db.query(
    `update public.profiles
        set email = null, display_name = null, avatar_url = null
      where id = $1`,
    [NULLED_PROFILE_USER],
  );

  // Case 5 fixture: one user missing the profile row, one missing the personal
  // membership row. Both keep their personal workspace, so the only thing that
  // can turn the read into `null` is the inner join itself.
  await db.query("delete from public.profiles where id = $1", [NO_PROFILE_USER]);
  await db.query("delete from public.workspace_members where user_id = $1", [
    NO_MEMBERSHIP_USER,
  ]);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("identity-read-repository: PGlite real SQL", () => {
  it("case 1: a privileged transaction carries the four settings and leaks none after COMMIT", async () => {
    const rows = await withPrivilegedTransaction(
      pool,
      { userId: MAIN_USER },
      async (client) => (await client.query(READ_SETTINGS_SQL)).rows,
    );

    const settings = rowAs<SettingsRow>(rows);
    expect([
      settings.user_id,
      settings.workspace_id,
      settings.role,
      settings.execution_mode,
    ]).toEqual([MAIN_USER, "", "", "privileged"]);

    // Read through the pool, outside the transaction that wrote them: the
    // settings were transaction-local, so none of the four survives COMMIT.
    const after = rowAs<SettingsGoneRow>((await db.query(SETTINGS_GONE_SQL)).rows);
    expect(after).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });

  it("case 2: a throw inside the transaction rethrows the same object and rolls the write back", async () => {
    const sentinel = new Error("identity integration sentinel");
    let thrown: unknown = null;
    let updated: readonly unknown[] = [];

    try {
      await withPrivilegedTransaction(pool, { userId: MAIN_USER }, async (client) => {
        const result = await client.query(
          "update public.profiles set display_name = $1 where id = $2 returning display_name",
          [MUTATED_DISPLAY_NAME, ROLLBACK_USER],
        );
        updated = result.rows;
        throw sentinel;
      });
    } catch (error) {
      thrown = error;
    }

    // The write really reached the row (1 row, new value returned) ...
    expect(updated).toHaveLength(1);
    expect(rowAs<DisplayNameRow>(updated).display_name).toBe(MUTATED_DISPLAY_NAME);

    // ... the caller keeps its own object, not a wrapper ...
    expect(thrown).toBe(sentinel);
    expect((thrown as Error).message).toBe("identity integration sentinel");

    // ... and the value is back to what it was before the transaction.
    expect(await displayNameOf(ROLLBACK_USER)).toBe(rollbackDisplayName);
    expect(await displayNameOf(ROLLBACK_USER)).not.toBe(MUTATED_DISPLAY_NAME);

    // The same pool is usable straight after the ROLLBACK.
    const record = await repository.findPersonalFoundation(MAIN_USER);
    expect(record?.workspace.id).toBe(mainPersonalWorkspaceId);
  });

  it("case 3: findPersonalFoundation maps the real workspace, profile and membership", async () => {
    const record = await repository.findPersonalFoundation(MAIN_USER);

    expect(record).toEqual({
      workspace: {
        id: mainPersonalWorkspaceId,
        name: "main Workspace",
        ownerUserId: MAIN_USER,
        type: "personal",
      },
      profile: {
        id: MAIN_USER,
        email: "main@hahart.test",
        displayName: "main",
        avatarUrl: null,
      },
      membership: {
        workspaceId: mainPersonalWorkspaceId,
        userId: MAIN_USER,
        role: "owner",
      },
    });

    // The uuid really is the uuid PostgreSQL stored, not a formatted copy.
    const stored = firstRow(
      (await db.query<{ id: string; type: string; owner_user_id: string }>(
        "select id, type, owner_user_id from public.workspaces where id = $1",
        [mainPersonalWorkspaceId],
      )).rows,
    );
    expect(stored.id).toBe(record?.workspace.id);
    expect(stored.type).toBe("personal");
    expect(stored.owner_user_id).toBe(MAIN_USER);
  });

  it("case 4: three null profile columns still return a record with three nulls", async () => {
    // The fixture must really be null, or this case would pass for the wrong reason.
    const stored = firstRow(
      (await db.query<{
        email: string | null;
        display_name: string | null;
        avatar_url: string | null;
      }>(
        `select email, display_name, avatar_url
           from public.profiles
          where id = $1`,
        [NULLED_PROFILE_USER],
      )).rows,
    );
    expect(stored).toEqual({ email: null, display_name: null, avatar_url: null });

    const record = await repository.findPersonalFoundation(NULLED_PROFILE_USER);

    expect(record).not.toBeNull();
    expect(record?.profile).toEqual({
      id: NULLED_PROFILE_USER,
      email: null,
      displayName: null,
      avatarUrl: null,
    });
    // The other two thirds of the record are unaffected by the null columns.
    expect(record?.workspace.ownerUserId).toBe(NULLED_PROFILE_USER);
    expect(record?.membership.role).toBe("owner");
  });

  it("case 5: a missing profile and a missing membership are both null, never half a record", async () => {
    // Sacrifice 1: the profile row is gone, workspace and membership remain.
    expect(await profileCount(NO_PROFILE_USER)).toBe(0);
    expect(await personalWorkspaceCount(NO_PROFILE_USER)).toBe(1);
    expect(await membershipCount(NO_PROFILE_USER)).toBe(1);
    expect(await repository.findPersonalFoundation(NO_PROFILE_USER)).toBeNull();

    // Sacrifice 2: the membership row is gone, profile and workspace remain.
    expect(await membershipCount(NO_MEMBERSHIP_USER)).toBe(0);
    expect(await profileCount(NO_MEMBERSHIP_USER)).toBe(1);
    expect(await personalWorkspaceCount(NO_MEMBERSHIP_USER)).toBe(1);
    expect(await repository.findPersonalFoundation(NO_MEMBERSHIP_USER)).toBeNull();
  });

  it("case 6: the single team workspace plus an admin membership reads back as team/admin", async () => {
    // "the team" is only well defined while exactly one exists.
    expect(await teamWorkspaceCount()).toBe(1);

    const record = await repository.findTeamMembership(MAIN_USER);

    expect(record).toEqual({
      workspace: {
        id: teamWorkspaceId,
        name: TEAM_NAME,
        ownerUserId: MAIN_USER,
        type: "team",
      },
      role: "admin",
    });
    // The same caller also owns a personal workspace, so this proves the read
    // selected the team row and not merely "the caller's first membership".
    expect(record?.workspace.id).not.toBe(mainPersonalWorkspaceId);
    expect(record?.role).toBe("admin");
  });

  it("case 7: an outsider of the existing team reads null", async () => {
    expect(await teamWorkspaceCount()).toBe(1);
    expect(await membershipCount(OUTSIDER_USER)).toBe(1); // personal membership only
    expect(
      firstRow(
        (await db.query<{ count: number }>(
          `select count(*)::int as count
             from public.workspace_members
            where user_id = $1
              and workspace_id = $2`,
          [OUTSIDER_USER, teamWorkspaceId],
        )).rows,
      ).count,
    ).toBe(0);

    expect(await repository.findTeamMembership(OUTSIDER_USER)).toBeNull();

    // The outsider is a complete user: only the team membership is absent.
    expect((await repository.findPersonalFoundation(OUTSIDER_USER))?.workspace.id).toBe(
      await personalWorkspaceIdOf(OUTSIDER_USER),
    );
  });

  it("case 8: an illegal uuid is a real SQL error, then the same pool still reads", async () => {
    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.workspaces where owner_user_id = $1", [
        INVALID_USER_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const personalError = await repository
      .findPersonalFoundation(INVALID_USER_ID)
      .catch((reason: unknown) => reason);

    expect(personalError).toBeInstanceOf(RepositoryReadError);
    const readError = personalError as RepositoryReadError;
    expect(readError.operation).toBe(FIND_PERSONAL_FOUNDATION);
    expect(readError.message).toBe(
      `identity read failed (${FIND_PERSONAL_FOUNDATION})`,
    );
    expect(readError.message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The cause is the PostgreSQL parse failure, not a shape or null problem.
    expect((readError.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );

    // The other read reports its own operation for the same class of failure.
    const teamError = await repository
      .findTeamMembership(INVALID_USER_ID)
      .catch((reason: unknown) => reason);
    expect(teamError).toBeInstanceOf(RepositoryReadError);
    expect((teamError as RepositoryReadError).operation).toBe(FIND_TEAM_MEMBERSHIP);

    // ROLLBACK plus release left the connection usable.
    const record = await repository.findPersonalFoundation(MAIN_USER);
    expect(record?.workspace.id).toBe(mainPersonalWorkspaceId);
  });
});
