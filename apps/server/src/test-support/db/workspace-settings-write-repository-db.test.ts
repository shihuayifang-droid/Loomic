import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  UPSERT_DEFAULT_MODEL,
  WorkspaceSettingsWriteError,
  createWorkspaceSettingsWriteRepository,
  type WorkspaceSettingsWriteRepository,
} from "../../db/workspace-settings-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the workspace settings write repository (workorder
 * 21E1), measured against the matrix workorder 21E0 froze.
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves PostgreSQL actually parses and executes it against real tables, and —
 * the part that matters most — that the privileged, RLS-bypassing repository
 * accepts and refuses EXACTLY the callers the frozen policies do:
 *
 *   allowed  personal owner, team owner, team admin          (insert + conflict update)
 *   refused  team member, non-member, owner_user_id without a membership row
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. One instance is migrated in
 * `beforeAll`, the fixture is built through the real signup trigger, and
 * `afterAll` closes it. PGlite holds a single session, so nothing here runs
 * concurrently and no case may leave a transaction open for the next one.
 *
 * The whole database carries at most ONE team workspace
 * (`workspaces_single_team_key`), so every team role shares the one created
 * below — the same constraint that shaped the 21E0 baseline.
 */

const PERSONAL_OWNER_ID = "00000000-0000-0000-0000-000000000b01";
const TEAM_OWNER_ID = "00000000-0000-0000-0000-000000000b02";
const TEAM_ADMIN_ID = "00000000-0000-0000-0000-000000000b03";
const TEAM_MEMBER_ID = "00000000-0000-0000-0000-000000000b04";
const OUTSIDER_ID = "00000000-0000-0000-0000-000000000b05";
const GHOST_OWNER_ID = "00000000-0000-0000-0000-000000000b06";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * every settings row in the table. These cases exist to prove it does not.
 */
const INJECTION_ID = "' or '1'='1";

const SELECT_SETTINGS_ROW = `select workspace_id, default_model,
    created_at::text as created_at, updated_at::text as updated_at
  from public.workspace_settings where workspace_id = $1`;

const SELECT_ALL_SETTINGS = `select workspace_id, default_model,
    created_at::text as created_at, updated_at::text as updated_at
  from public.workspace_settings order by workspace_id`;

const READ_SETTINGS_SQL = `
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
let repository: WorkspaceSettingsWriteRepository;

let personalWorkspaceId = "";
let teamWorkspaceId = "";
let ghostWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

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

/** Seeded as the database owner, so the fixture itself is never gated. */
async function seedSettings(workspaceId: string, model: string): Promise<void> {
  await db.query(
    `insert into public.workspace_settings (workspace_id, default_model)
     values ($1, $2)
     on conflict (workspace_id) do update set default_model = excluded.default_model`,
    [workspaceId, model],
  );
}

/** Clears the single row so a case can measure the INSERT path (no conflict). */
async function clearSettings(workspaceId: string): Promise<void> {
  await db.query("delete from public.workspace_settings where workspace_id = $1", [
    workspaceId,
  ]);
}

/** The repository call, with the refusal captured instead of thrown. */
async function refusal(
  input: { actorId: string; workspaceId: string; defaultModel: string },
): Promise<WorkspaceSettingsWriteError> {
  const error = await repository
    .upsertDefaultModel(input)
    .catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(WorkspaceSettingsWriteError);
  const writeError = error as WorkspaceSettingsWriteError;
  expect(writeError.operation).toBe(UPSERT_DEFAULT_MODEL);
  expect(writeError.message).toBe(
    `workspace settings write failed (${UPSERT_DEFAULT_MODEL})`,
  );
  return writeError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createWorkspaceSettingsWriteRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  for (const [id, email] of [
    [PERSONAL_OWNER_ID, "ws-write-personal@hahart.test"],
    [TEAM_OWNER_ID, "ws-write-owner@hahart.test"],
    [TEAM_ADMIN_ID, "ws-write-admin@hahart.test"],
    [TEAM_MEMBER_ID, "ws-write-member@hahart.test"],
    [OUTSIDER_ID, "ws-write-outsider@hahart.test"],
    [GHOST_OWNER_ID, "ws-write-ghost@hahart.test"],
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
         values ('team', 'Workspace Settings Write Team', $1) returning id`,
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
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("workspace settings write repository: owners and admins may write", () => {
  it("case 1: the personal workspace owner creates the row and the answer matches storage", async () => {
    await clearSettings(personalWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: PERSONAL_OWNER_ID,
      workspaceId: personalWorkspaceId,
      defaultModel: "personal-create-model",
    });

    // RETURNING proves the row landed under the workspace the caller asked for.
    expect(row).toEqual({
      workspaceId: personalWorkspaceId,
      defaultModel: "personal-create-model",
    });

    const stored = await requiresSettingsRow(personalWorkspaceId);
    expect(stored.workspace_id).toBe(personalWorkspaceId);
    expect(stored.default_model).toBe("personal-create-model");
    expect(await rowsFor(personalWorkspaceId)).toBe(1);
  });

  it("case 2: the personal owner's conflict update overwrites the model and keeps the row", async () => {
    await seedSettings(personalWorkspaceId, "personal-before-model");
    const before = await requiresSettingsRow(personalWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: PERSONAL_OWNER_ID,
      workspaceId: personalWorkspaceId,
      defaultModel: "personal-after-model",
    });
    expect(row.defaultModel).toBe("personal-after-model");

    const after = await requiresSettingsRow(personalWorkspaceId);
    expect(after.default_model).toBe("personal-after-model");
    // The conflict path updated in place: same row, same workspace_id, same
    // created_at — `workspace_id` is not in the SET list and no second row
    // appeared.
    expect(after.workspace_id).toBe(personalWorkspaceId);
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(personalWorkspaceId)).toBe(1);
  });

  it("case 3: a team owner creates the row", async () => {
    await clearSettings(teamWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: TEAM_OWNER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "team-owner-create-model",
    });

    expect(row).toEqual({
      workspaceId: teamWorkspaceId,
      defaultModel: "team-owner-create-model",
    });
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "team-owner-create-model",
    );
  });

  it("case 4: a team owner's conflict update overwrites the model and keeps the workspace_id", async () => {
    await seedSettings(teamWorkspaceId, "team-owner-before-model");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: TEAM_OWNER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "team-owner-after-model",
    });
    expect(row.workspaceId).toBe(teamWorkspaceId);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.workspace_id).toBe(teamWorkspaceId);
    expect(after.default_model).toBe("team-owner-after-model");
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });

  it("case 5: a team admin creates the row", async () => {
    await clearSettings(teamWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: TEAM_ADMIN_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "team-admin-create-model",
    });

    expect(row).toEqual({
      workspaceId: teamWorkspaceId,
      defaultModel: "team-admin-create-model",
    });
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "team-admin-create-model",
    );
  });

  it("case 6: a team admin's conflict update overwrites the model and keeps the workspace_id", async () => {
    await seedSettings(teamWorkspaceId, "team-admin-before-model");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const row = await repository.upsertDefaultModel({
      actorId: TEAM_ADMIN_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "team-admin-after-model",
    });
    expect(row.workspaceId).toBe(teamWorkspaceId);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.workspace_id).toBe(teamWorkspaceId);
    expect(after.default_model).toBe("team-admin-after-model");
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });
});

describe("workspace settings write repository: members and non-members are refused", () => {
  it("case 7: a plain member cannot create a missing row, and the table is unchanged", async () => {
    await clearSettings(teamWorkspaceId);
    const totalBefore = await totalRows();

    await refusal({
      actorId: TEAM_MEMBER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "member-create-model",
    });

    // The gate is the membership role, not the row's absence.
    expect(await settingsRow(teamWorkspaceId)).toBeNull();
    expect(await totalRows()).toBe(totalBefore);
  });

  it("case 8: a plain member cannot conflict-update an existing row, and the stored values survive", async () => {
    await seedSettings(teamWorkspaceId, "member-row-before");
    const before = await requiresSettingsRow(teamWorkspaceId);

    await refusal({
      actorId: TEAM_MEMBER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "member-row-after",
    });

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.default_model).toBe("member-row-before");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });

  it("case 9: a non-member and an owner_user_id with no membership row cannot create the row", async () => {
    await clearSettings(teamWorkspaceId);
    await clearSettings(ghostWorkspaceId);
    const totalBefore = await totalRows();

    await refusal({
      actorId: OUTSIDER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "outsider-create-model",
    });
    expect(await settingsRow(teamWorkspaceId)).toBeNull();

    // Boundary assertion: `workspaces.owner_user_id` alone is NOT a write rule.
    // This workspace names the caller as its owner and has no membership row at
    // all, so the write is still refused.
    expect(await workspaceOwner(ghostWorkspaceId)).toBe(GHOST_OWNER_ID);
    expect(await membershipCount(ghostWorkspaceId)).toBe(0);

    await refusal({
      actorId: GHOST_OWNER_ID,
      workspaceId: ghostWorkspaceId,
      defaultModel: "ghost-owner-create-model",
    });
    expect(await settingsRow(ghostWorkspaceId)).toBeNull();

    expect(await totalRows()).toBe(totalBefore);
  });

  it("case 10: a non-member and an owner_user_id with no membership row cannot conflict-update", async () => {
    await seedSettings(teamWorkspaceId, "outsider-row-before");
    const teamBefore = await requiresSettingsRow(teamWorkspaceId);

    await refusal({
      actorId: OUTSIDER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "outsider-row-after",
    });

    const teamAfter = await requiresSettingsRow(teamWorkspaceId);
    expect(teamAfter.default_model).toBe("outsider-row-before");
    expect(teamAfter.created_at).toBe(teamBefore.created_at);
    expect(teamAfter.updated_at).toBe(teamBefore.updated_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);

    // The boundary assertion on the conflict path: the membership-less owner is
    // refused here too, and its row keeps the old model.
    await seedSettings(ghostWorkspaceId, "ghost-owner-row-before");
    const ghostBefore = await requiresSettingsRow(ghostWorkspaceId);

    await refusal({
      actorId: GHOST_OWNER_ID,
      workspaceId: ghostWorkspaceId,
      defaultModel: "ghost-owner-row-after",
    });

    expect(await requiresSettingsRow(ghostWorkspaceId)).toEqual(ghostBefore);
    expect(await rowsFor(ghostWorkspaceId)).toBe(1);
  });
});

describe("workspace settings write repository: bindings, rollback and transaction context", () => {
  it("case 11: a malformed uuid is a real SQL error, wrapped and leaked nowhere", async () => {
    await clearSettings(personalWorkspaceId);

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select workspace_id from public.workspace_settings where workspace_id = $1", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    for (const input of [
      { actorId: INVALID_ID, workspaceId: personalWorkspaceId },
      { actorId: PERSONAL_OWNER_ID, workspaceId: INVALID_ID },
    ]) {
      const error = await refusal({
        ...input,
        defaultModel: "never-stored-model",
      });

      // The fixed message carries no SQL, no host and no existence answer.
      expect(error.message).not.toMatch(
        /public\.|workspace_settings|workspace_members|invalid input|postgres:\/\//i,
      );
      // The cause is the PostgreSQL parse failure, not a shape or zero-row answer.
      expect((error.cause as Error).message).toMatch(
        /invalid input syntax for type uuid/,
      );
    }

    // Nothing was created by any of the refused binds.
    expect(await settingsRow(personalWorkspaceId)).toBeNull();
  });

  it("case 12: ids carrying SQL change nothing, because they are only binds", async () => {
    await seedSettings(personalWorkspaceId, "injection-personal-before");
    await seedSettings(teamWorkspaceId, "injection-team-before");
    const before = await allSettings();

    for (const input of [
      { actorId: INJECTION_ID, workspaceId: teamWorkspaceId },
      { actorId: PERSONAL_OWNER_ID, workspaceId: INJECTION_ID },
      { actorId: INJECTION_ID, workspaceId: INJECTION_ID },
    ]) {
      const error = await refusal({
        ...input,
        defaultModel: "INJECTED BY A CONCATENATED STATEMENT",
      });
      expect(error.cause).toBeInstanceOf(Error);
    }

    // The whole table is byte-identical: if an id had been concatenated, this
    // statement would have rewritten every settings row in it.
    expect(await allSettings()).toEqual(before);
    expect((await allSettings()).map((row) => row.default_model)).not.toContain(
      "INJECTED BY A CONCATENATED STATEMENT",
    );
  });

  it("case 13: after a refusal the same pool still writes, and the transaction context does not survive", async () => {
    // If the refusal had been left as a missing row instead of a rolled-back
    // transaction, this write would not be a clean success.
    await refusal({
      actorId: OUTSIDER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "outsider-never-stored",
    });

    // A pool that wraps the real one and reads the four settings through the SAME
    // connection, right after the repository's own statement: whatever it sees is
    // the state of the transaction the write ran in, not a reconstruction.
    const observed: Array<Record<string, unknown>> = [];
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.workspace_settings")) {
              observed.push(
                (await inner.query(READ_SETTINGS_SQL)).rows[0] as Record<
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

    const observing = createWorkspaceSettingsWriteRepository({
      getTransactionPool: () => observingPool,
    });

    const row = await observing.upsertDefaultModel({
      actorId: TEAM_OWNER_ID,
      workspaceId: teamWorkspaceId,
      defaultModel: "owner-after-refusal",
    });
    expect(row).toEqual({
      workspaceId: teamWorkspaceId,
      defaultModel: "owner-after-refusal",
    });
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "owner-after-refusal",
    );

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      user_id: TEAM_OWNER_ID,
      workspace_id: teamWorkspaceId,
      role: "",
      execution_mode: "privileged",
    });

    // And immediately after COMMIT the same four settings are gone again, so the
    // actor of this write cannot become the actor of the next one.
    const gone = (await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows[0];
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });
  });
});
