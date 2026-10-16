import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  READ_DEFAULT_MODEL,
  WorkspaceSettingsReadError,
  createWorkspaceSettingsReadRepository,
  type WorkspaceSettingsReadRepository,
} from "../../db/workspace-settings-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the workspace settings READ repository (workorder
 * 21L), measured against the policy it replaces.
 *
 * Every case below reads the same question TWICE for the same identity:
 *
 *   (1) through the repository, which is privileged — the database owner
 *       bypasses RLS, so the ONLY gate is the statement's own membership
 *       predicate;
 *   (2) through `asUser()`, i.e. `set local role authenticated` plus a
 *       transaction-local `request.jwt.claim.sub` (the claim the PGlite stub's
 *       `auth.uid()` reads), running the exact SELECT the removed PostgREST read
 *       performed — so the `workspace_settings_select` policy decides.
 *
 * The two answers must be EQUAL for every identity, and equal to the value the
 * database holds or to `null`. That equality is the whole point of this file: a
 * repository that "looks right" but disagrees with the policy for one role would
 * silently change who can start an agent run with which model.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. One instance is migrated in `beforeAll`, the fixture
 * is built through the real signup trigger, and `afterAll` closes it. PGlite
 * holds a single session, so nothing here runs concurrently and no case may
 * leave a transaction open for the next one.
 *
 * The whole database carries at most ONE team workspace
 * (`workspaces_single_team_key`), so every team role shares the one created
 * below — the same constraint that shaped the 21E0 baseline and the 21E1 write
 * matrix.
 */

const PERSONAL_OWNER_ID = "00000000-0000-0000-0000-000000000d01";
const TEAM_OWNER_ID = "00000000-0000-0000-0000-000000000d02";
const TEAM_ADMIN_ID = "00000000-0000-0000-0000-000000000d03";
const TEAM_MEMBER_ID = "00000000-0000-0000-0000-000000000d04";
const OUTSIDER_ID = "00000000-0000-0000-0000-000000000d05";
const GHOST_OWNER_ID = "00000000-0000-0000-0000-000000000d06";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * the whole settings table. These cases exist to prove it is not.
 */
const INJECTION_ID = "' or '1'='1";

/** A well-formed uuid no row uses: "no such workspace" must be a null, not an error. */
const UNKNOWN_WORKSPACE_ID = "00000000-0000-0000-0000-000000000dff";

const TEAM_MODEL = "team-stored-model";
const PERSONAL_MODEL = "personal-stored-model";
const GHOST_MODEL = "ghost-stored-model";
const RESEEDED_MODEL = "team-reseeded-model";

const SELECT_SETTINGS_ROW = `select workspace_id, default_model,
    created_at::text as created_at, updated_at::text as updated_at
  from public.workspace_settings where workspace_id = $1`;

const SELECT_ALL_SETTINGS = `select workspace_id, default_model,
    created_at::text as created_at, updated_at::text as updated_at
  from public.workspace_settings order by workspace_id`;

/**
 * The removed PostgREST read, verbatim as SQL: one column, one key. Under
 * `asUser()` the policy filters it exactly as PostgREST's own client did, and
 * `maybeSingle()` is the `rows[0] ?? null` below.
 */
const SELECT_DEFAULT_MODEL = `select default_model
  from public.workspace_settings
 where workspace_id = $1`;

const READ_CONTEXT_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type SettingsRecord = {
  workspace_id: string;
  default_model: string;
  created_at: string;
  updated_at: string;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

let db: PGlite;
let pool: TransactionPool;
let repository: WorkspaceSettingsReadRepository;

let personalWorkspaceId = "";
let teamWorkspaceId = "";
let ghostWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

/**
 * (1) The repository read: privileged, with the ACL written into the statement.
 */
function viaRepository(
  actorId: string,
  workspaceId: string,
): Promise<string | null> {
  return repository.readDefaultModel({ actorId, workspaceId });
}

/**
 * (2) The read the removed PostgREST client performed: the caller's own
 * identity, so `workspace_settings_select` decides which row exists.
 */
async function viaRls(
  actorId: string,
  workspaceId: string,
): Promise<string | null> {
  const result = await asUser(db, actorId, (tx) =>
    tx.query<{ default_model: string }>(SELECT_DEFAULT_MODEL, [workspaceId]),
  );

  return result.rows[0]?.default_model ?? null;
}

/**
 * The comparison this file exists for. Both reads are performed for ONE identity
 * on ONE workspace and each is asserted against the expected answer AND against
 * the other, so a disagreement is reported as a disagreement rather than as two
 * independent mismatches.
 */
async function expectBothReads(
  actorId: string,
  workspaceId: string,
  expected: string | null,
): Promise<void> {
  const byRepository = await viaRepository(actorId, workspaceId);
  const byRls = await viaRls(actorId, workspaceId);

  expect(byRls).toBe(expected);
  expect(byRepository).toBe(expected);
  expect(byRepository).toBe(byRls);
}

/** The identities the team matrix walks, in one place so no case drops one. */
const TEAM_IDENTITIES = [
  { label: "team owner", id: TEAM_OWNER_ID, member: true },
  { label: "team admin", id: TEAM_ADMIN_ID, member: true },
  { label: "team member", id: TEAM_MEMBER_ID, member: true },
  { label: "personal-workspace owner (not a team member)", id: PERSONAL_OWNER_ID, member: false },
  { label: "outsider (no membership anywhere near this workspace)", id: OUTSIDER_ID, member: false },
] as const;

async function settingsRow(workspaceId: string): Promise<SettingsRecord | null> {
  const rows = (
    await db.query<SettingsRecord>(SELECT_SETTINGS_ROW, [workspaceId])
  ).rows;
  return rows[0] ?? null;
}

async function requiresSettingsRow(workspaceId: string): Promise<SettingsRecord> {
  const row = await settingsRow(workspaceId);
  if (row === null) throw new Error(`settings for ${workspaceId} are missing`);
  return row;
}

async function allSettings(): Promise<SettingsRecord[]> {
  return (await db.query<SettingsRecord>(SELECT_ALL_SETTINGS)).rows;
}

async function rowsFor(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspace_settings where workspace_id = $1",
        [workspaceId],
      )
    ).rows,
  ).n;
}

async function totalRows(): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspace_settings",
      )
    ).rows,
  ).n;
}

async function workspaceOwner(workspaceId: string): Promise<string> {
  return firstRow(
    (
      await db.query<{ owner_user_id: string }>(
        "select owner_user_id from public.workspaces where id = $1",
        [workspaceId],
      )
    ).rows,
  ).owner_user_id;
}

async function membershipCount(workspaceId: string): Promise<number> {
  return firstRow(
    (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspace_members where workspace_id = $1",
        [workspaceId],
      )
    ).rows,
  ).n;
}

async function roleOf(workspaceId: string, userId: string): Promise<string | null> {
  const rows = (
    await db.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id = $1 and user_id = $2",
      [workspaceId, userId],
    )
  ).rows;
  return rows[0]?.role ?? null;
}

/** Seeded as the database owner, so the fixture itself is never gated. */
async function seedSettings(workspaceId: string, model: string): Promise<void> {
  await db.query(
    `insert into public.workspace_settings (workspace_id, default_model)
     values ($1, $2)
     on conflict (workspace_id) do update set default_model = excluded.default_model`,
    [workspaceId, model],
  );
}

/** Clears the single row so a case can measure "no settings row at all". */
async function clearSettings(workspaceId: string): Promise<void> {
  await db.query("delete from public.workspace_settings where workspace_id = $1", [
    workspaceId,
  ]);
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createWorkspaceSettingsReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  for (const [id, email] of [
    [PERSONAL_OWNER_ID, "ws-read-personal@hahart.test"],
    [TEAM_OWNER_ID, "ws-read-owner@hahart.test"],
    [TEAM_ADMIN_ID, "ws-read-admin@hahart.test"],
    [TEAM_MEMBER_ID, "ws-read-member@hahart.test"],
    [OUTSIDER_ID, "ws-read-outsider@hahart.test"],
    [GHOST_OWNER_ID, "ws-read-ghost@hahart.test"],
  ] as const) {
    await createUser(db, id, email);
  }

  personalWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [PERSONAL_OWNER_ID],
      )
    ).rows,
  ).id;

  // Exactly one team workspace may exist in the whole database
  // (workspaces_single_team_key), so all team roles share this one.
  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', 'Workspace Settings Read Team', $1) returning id`,
        [TEAM_OWNER_ID],
      )
    ).rows,
  ).id;

  for (const [userId, role] of [
    [TEAM_OWNER_ID, "owner"],
    [TEAM_ADMIN_ID, "admin"],
    [TEAM_MEMBER_ID, "member"],
  ] as const) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [teamWorkspaceId, userId, role],
    );
  }

  // The boundary fixture: a workspace that names the caller in
  // `workspaces.owner_user_id` but has NO `workspace_members` row for anyone.
  // A second team workspace cannot be created, so the signup-granted membership
  // is stripped from the ghost user's own personal workspace instead.
  ghostWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [GHOST_OWNER_ID],
      )
    ).rows,
  ).id;
  await db.query("delete from public.workspace_members where workspace_id = $1", [
    ghostWorkspaceId,
  ]);

  await seedSettings(teamWorkspaceId, TEAM_MODEL);
  await seedSettings(personalWorkspaceId, PERSONAL_MODEL);
  await seedSettings(ghostWorkspaceId, GHOST_MODEL);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("workspace settings read repository: the fixture the matrix runs against", () => {
  it("case 1: the membership rows, the one team workspace and the membership-less owner are what the cases assume", async () => {
    expect(await roleOf(personalWorkspaceId, PERSONAL_OWNER_ID)).toBe("owner");
    expect(await roleOf(teamWorkspaceId, TEAM_OWNER_ID)).toBe("owner");
    expect(await roleOf(teamWorkspaceId, TEAM_ADMIN_ID)).toBe("admin");
    expect(await roleOf(teamWorkspaceId, TEAM_MEMBER_ID)).toBe("member");

    // The two non-members are members of their OWN workspaces only: the gate is
    // per workspace, not a global "is this user known" flag.
    expect(await roleOf(teamWorkspaceId, OUTSIDER_ID)).toBeNull();
    expect(await roleOf(teamWorkspaceId, PERSONAL_OWNER_ID)).toBeNull();
    expect(await roleOf(personalWorkspaceId, OUTSIDER_ID)).toBeNull();
    const outsiderWorkspace = firstRow(
      (
        await db.query<{ id: string }>(
          "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
          [OUTSIDER_ID],
        )
      ).rows,
    ).id;
    expect(await roleOf(outsiderWorkspace, OUTSIDER_ID)).toBe("owner");

    expect(
      firstRow(
        (
          await db.query<{ n: number }>(
            "select count(*)::int as n from public.workspaces where type = 'team'",
          )
        ).rows,
      ).n,
    ).toBe(1);

    // The boundary fixture: named as the owner, with no membership row at all.
    expect(await workspaceOwner(ghostWorkspaceId)).toBe(GHOST_OWNER_ID);
    expect(await membershipCount(ghostWorkspaceId)).toBe(0);

    // And each workspace starts with exactly one settings row, so a later case
    // that clears one is measuring its own fixture.
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
    expect(await rowsFor(personalWorkspaceId)).toBe(1);
    expect(await rowsFor(ghostWorkspaceId)).toBe(1);
  });
});

describe("workspace settings read repository: team workspace, identity by identity", () => {
  it("case 2: the team owner reads the stored model through both paths", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    await expectBothReads(TEAM_OWNER_ID, teamWorkspaceId, TEAM_MODEL);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      TEAM_MODEL,
    );
  });

  it("case 3: a team admin reads the stored model through both paths", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    await expectBothReads(TEAM_ADMIN_ID, teamWorkspaceId, TEAM_MODEL);
  });

  it("case 4: a plain member reads the stored model through both paths — the read policy has no role condition", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    expect(await roleOf(teamWorkspaceId, TEAM_MEMBER_ID)).toBe("member");

    // This is the case workorder 21E1's write ACL would have denied: an
    // owner/admin condition copied from the INSERT/UPDATE policies would answer
    // null here, and every plain member's agent run would silently lose its
    // workspace model.
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, TEAM_MODEL);
  });

  it("case 5: a personal-workspace owner who is NOT a team member reads null through both paths", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    await expectBothReads(PERSONAL_OWNER_ID, teamWorkspaceId, null);
    // The row is there and other identities still see it: null means "not for
    // you", never "no settings".
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      TEAM_MODEL,
    );
    await expectBothReads(TEAM_OWNER_ID, teamWorkspaceId, TEAM_MODEL);
  });

  it("case 6: an outsider reads null through both paths, and the row is untouched", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    await expectBothReads(OUTSIDER_ID, teamWorkspaceId, null);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      TEAM_MODEL,
    );
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });
});

describe("workspace settings read repository: personal workspace, identity by identity", () => {
  it("case 7: the personal owner reads their own stored model through both paths", async () => {
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);

    await expectBothReads(PERSONAL_OWNER_ID, personalWorkspaceId, PERSONAL_MODEL);
  });

  it("case 8: a team member reads null for a workspace they are not a member of, through both paths", async () => {
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);

    // Being a member of the ONE team workspace grants nothing here: read access
    // is membership of THIS workspace.
    await expectBothReads(TEAM_MEMBER_ID, personalWorkspaceId, null);
    await expectBothReads(TEAM_OWNER_ID, personalWorkspaceId, null);
    expect((await requiresSettingsRow(personalWorkspaceId)).default_model).toBe(
      PERSONAL_MODEL,
    );
  });

  it("case 9: an outsider reads null for the personal workspace through both paths", async () => {
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);

    await expectBothReads(OUTSIDER_ID, personalWorkspaceId, null);
  });
});

describe("workspace settings read repository: no row, no membership, no workspace", () => {
  it("case 10: with no settings row at all, EVERY identity answers null through both paths", async () => {
    await clearSettings(teamWorkspaceId);
    await clearSettings(personalWorkspaceId);
    await clearSettings(ghostWorkspaceId);
    expect(await totalRows()).toBe(0);

    for (const identity of TEAM_IDENTITIES) {
      await expectBothReads(identity.id, teamWorkspaceId, null);
    }
    await expectBothReads(PERSONAL_OWNER_ID, personalWorkspaceId, null);
    await expectBothReads(GHOST_OWNER_ID, ghostWorkspaceId, null);

    // "Not a member" and "no row" are the SAME answer on purpose — the service
    // turns either into its default model, which is what a non-member's agent
    // run has always used.
    expect(await totalRows()).toBe(0);

    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);
    await seedSettings(ghostWorkspaceId, GHOST_MODEL);
  });

  it("case 11: the membership-less owner_user_id is not a read rule — the row is invisible to them", async () => {
    await seedSettings(ghostWorkspaceId, GHOST_MODEL);

    // Named as the owner, no membership row — workorder 21E0 froze this boundary
    // for the write ACL and it holds for the read: RLS reads workspace_members.
    expect(await workspaceOwner(ghostWorkspaceId)).toBe(GHOST_OWNER_ID);
    expect(await membershipCount(ghostWorkspaceId)).toBe(0);
    expect((await requiresSettingsRow(ghostWorkspaceId)).default_model).toBe(
      GHOST_MODEL,
    );

    await expectBothReads(GHOST_OWNER_ID, ghostWorkspaceId, null);
    // Still invisible after the failed read, and the row is still there.
    expect((await requiresSettingsRow(ghostWorkspaceId)).default_model).toBe(
      GHOST_MODEL,
    );
  });

  it("case 12: a settings row of another workspace is never answered", async () => {
    await clearSettings(ghostWorkspaceId);
    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);

    const before = await allSettings();
    expect(before.map((row) => row.default_model).sort()).toEqual(
      [PERSONAL_MODEL, TEAM_MODEL].sort(),
    );

    // Each identity reads its own workspace fine, and the OTHER workspace's
    // model is not reachable through either path: the key is pinned by the
    // statement and by the policy, never by the caller.
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, TEAM_MODEL);
    await expectBothReads(TEAM_MEMBER_ID, personalWorkspaceId, null);
    await expectBothReads(PERSONAL_OWNER_ID, personalWorkspaceId, PERSONAL_MODEL);
    await expectBothReads(PERSONAL_OWNER_ID, teamWorkspaceId, null);

    // No cross-workspace answer leaked into storage either.
    expect(await allSettings()).toEqual(before);
  });

  it("case 13: a well-formed uuid with no row is null, not an error", async () => {
    // The workspace does not exist and the caller is a member of nothing by that
    // id: the same null as "no row", from both paths, with no error raised.
    await expectBothReads(TEAM_OWNER_ID, UNKNOWN_WORKSPACE_ID, null);
    await expectBothReads(OUTSIDER_ID, UNKNOWN_WORKSPACE_ID, null);
  });
});

describe("workspace settings read repository: the membership row is the gate", () => {
  it("case 14: deleting the membership row revokes the read on both paths, and restoring it returns the value", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, TEAM_MODEL);

    await db.query(
      "delete from public.workspace_members where workspace_id = $1 and user_id = $2",
      [teamWorkspaceId, TEAM_MEMBER_ID],
    );

    // Revoked for this identity only: the row is still there and the owner still
    // reads it.
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, null);
    await expectBothReads(TEAM_OWNER_ID, teamWorkspaceId, TEAM_MODEL);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      TEAM_MODEL,
    );

    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, 'member')`,
      [teamWorkspaceId, TEAM_MEMBER_ID],
    );

    // The predicate is evaluated per call, not cached: the value is readable
    // again the moment the membership row exists.
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, TEAM_MODEL);
  });

  it("case 15: a role change does not change the answer — read access is not role-conditioned", async () => {
    await seedSettings(teamWorkspaceId, RESEEDED_MODEL);

    // Down to `member`, and up to `admin`: the read follows the membership row,
    // not the role, exactly as the SELECT policy says.
    await db.query(
      "update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2",
      [teamWorkspaceId, TEAM_ADMIN_ID],
    );
    expect(await roleOf(teamWorkspaceId, TEAM_ADMIN_ID)).toBe("member");
    await expectBothReads(TEAM_ADMIN_ID, teamWorkspaceId, RESEEDED_MODEL);

    await db.query(
      "update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2",
      [teamWorkspaceId, TEAM_MEMBER_ID],
    );
    expect(await roleOf(teamWorkspaceId, TEAM_MEMBER_ID)).toBe("admin");
    await expectBothReads(TEAM_MEMBER_ID, teamWorkspaceId, RESEEDED_MODEL);

    await db.query(
      "update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2",
      [teamWorkspaceId, TEAM_ADMIN_ID],
    );
    await db.query(
      "update public.workspace_members set role = 'member' where workspace_id = $1 and user_id = $2",
      [teamWorkspaceId, TEAM_MEMBER_ID],
    );
    expect(await roleOf(teamWorkspaceId, TEAM_ADMIN_ID)).toBe("admin");
    expect(await roleOf(teamWorkspaceId, TEAM_MEMBER_ID)).toBe("member");

    await seedSettings(teamWorkspaceId, TEAM_MODEL);
  });
});

describe("workspace settings read repository: bad binds, rollback and read-only behaviour", () => {
  it("case 16: a malformed uuid is a real SQL error, wrapped, and the same pool reads again afterwards", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query(
        "select workspace_id from public.workspace_settings where workspace_id = $1",
        [INVALID_ID],
      ),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    for (const input of [
      { actorId: INVALID_ID, workspaceId: teamWorkspaceId },
      { actorId: TEAM_OWNER_ID, workspaceId: INVALID_ID },
      { actorId: INVALID_ID, workspaceId: INVALID_ID },
    ]) {
      const error = await repository
        .readDefaultModel(input)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
      expect((error as WorkspaceSettingsReadError).operation).toBe(
        READ_DEFAULT_MODEL,
      );
      // The fixed message carries no SQL, no host and no existence answer.
      expect((error as WorkspaceSettingsReadError).message).toBe(
        `workspace settings read failed (${READ_DEFAULT_MODEL})`,
      );
      expect((error as WorkspaceSettingsReadError).message).not.toMatch(
        /public\.|workspace_settings|workspace_members|invalid input|postgres:\/\//i,
      );
      // The cause is the PostgreSQL parse failure, not a null answer.
      expect(((error as WorkspaceSettingsReadError).cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    // ROLLBACK plus release left the connection usable for the next read.
    await expect(viaRepository(TEAM_OWNER_ID, teamWorkspaceId)).resolves.toBe(
      TEAM_MODEL,
    );
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      TEAM_MODEL,
    );
  });

  it("case 17: ids carrying SQL are only binds — the whole table is unchanged", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);
    const before = await allSettings();

    for (const input of [
      { actorId: INJECTION_ID, workspaceId: teamWorkspaceId },
      { actorId: TEAM_OWNER_ID, workspaceId: INJECTION_ID },
      { actorId: INJECTION_ID, workspaceId: INJECTION_ID },
    ]) {
      const error = await repository
        .readDefaultModel(input)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(WorkspaceSettingsReadError);
    }

    // A concatenated id would have rewritten or exposed every settings row; the
    // table is byte-identical instead.
    expect(await allSettings()).toEqual(before);
    expect((await allSettings()).map((row) => row.default_model)).not.toContain(
      INJECTION_ID,
    );
  });

  it("case 18: the read modifies nothing — same rows, same models, same timestamps", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);
    await seedSettings(personalWorkspaceId, PERSONAL_MODEL);
    const before = await allSettings();
    const totalBefore = await totalRows();

    await viaRepository(TEAM_MEMBER_ID, teamWorkspaceId);
    await viaRepository(OUTSIDER_ID, teamWorkspaceId);
    await viaRepository(TEAM_OWNER_ID, UNKNOWN_WORKSPACE_ID);
    await viaRls(TEAM_MEMBER_ID, teamWorkspaceId);
    await viaRls(OUTSIDER_ID, teamWorkspaceId);

    // `updated_at` is driven by a BEFORE UPDATE trigger, so an identical
    // timestamp set is proof no UPDATE ran behind the read.
    expect(await allSettings()).toEqual(before);
    expect(await totalRows()).toBe(totalBefore);
  });

  it("case 19: the read runs privileged with the actor as context, and the context does not survive it", async () => {
    await seedSettings(teamWorkspaceId, TEAM_MODEL);

    // A pool that wraps the real one and reads the four settings through the SAME
    // connection, right after the repository's own statement: whatever it sees is
    // the state of the transaction the read ran in, not a reconstruction.
    const observed: Array<Record<string, unknown>> = [];
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.workspace_settings")) {
              observed.push(
                (await inner.query(READ_CONTEXT_SQL)).rows[0] as Record<
                  string,
                  unknown
                >,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createWorkspaceSettingsReadRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.readDefaultModel({
        actorId: TEAM_MEMBER_ID,
        workspaceId: teamWorkspaceId,
      }),
    ).resolves.toBe(TEAM_MODEL);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      user_id: TEAM_MEMBER_ID,
      workspace_id: teamWorkspaceId,
      role: "",
      execution_mode: "privileged",
    });

    // And immediately after COMMIT the same four settings are gone again, so the
    // actor of this read cannot become the actor of the next one.
    const gone = (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows[0];
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });

    // The next read is still the caller's own: the context is rebuilt per call,
    // which is what makes case 14's revocation effective.
    await expect(viaRepository(OUTSIDER_ID, teamWorkspaceId)).resolves.toBeNull();
  });
});
