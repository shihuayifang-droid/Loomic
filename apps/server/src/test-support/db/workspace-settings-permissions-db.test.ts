import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

/**
 * Real-SQL baseline for `public.workspace_settings` (workorder 21E0).
 *
 * `SettingsService.updateWorkspaceSettings()` writes this table with a
 * single-key upsert under the caller's own JWT. A later workorder migrates that
 * write to a privileged repository, which will bypass RLS entirely; unless the
 * CURRENT authorisation surface is pinned down first, the repository would be
 * guessing which callers the database accepts today. This file is that
 * baseline and NOTHING else: no production code, no migration, no policy and no
 * repository is added or changed. The audit counters published by
 * `scripts/audit-supabase-dependencies.mjs` must therefore stay identical.
 *
 * Every statement below runs against the full migration chain loaded by
 * `createMigratedDb()` and, where an identity matters, inside `asUser()` -
 * `set local role authenticated` plus a transaction-local
 * `request.jwt.claim.sub`. Nothing is mocked: PostgreSQL decides, and these
 * cases assert what it actually answered.
 *
 * The policy in force is the 2026-03 one (the 2026-09 team-workspace migration
 * deliberately leaves `workspace_settings` alone), and it gates on
 * `workspace_members.role`, never on `workspaces.owner_user_id`:
 *
 *   SELECT  any member of the workspace
 *   INSERT  a member whose role is owner or admin      (WITH CHECK)
 *   UPDATE  a member whose role is owner or admin      (USING only)
 *
 * Two shapes of "denied" exist and they are NOT the same thing:
 *
 * - the upsert (`INSERT ... ON CONFLICT DO UPDATE`) is refused by a policy
 *   check that also covers the conflict branch, so it raises SQLSTATE 42501;
 * - a plain `UPDATE` filtered out by its USING clause is not an error at all -
 *   it reports zero affected rows and the row survives untouched.
 *
 * Every case seeds or clears the single row it is about as the database owner,
 * so no case depends on the order the others ran in. The row is keyed by
 * `workspace_id` (PRIMARY KEY), so "the row count for that workspace is 1" is
 * the assertion that a conflict really updated in place.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** The migration that creates the table and the only three policies on it. */
const SETTINGS_MIGRATION = "20260323000005_workspace_settings.sql";

const PERSONAL_OWNER_ID = "00000000-0000-0000-0000-0000000000f1";
const TEAM_OWNER_ID = "00000000-0000-0000-0000-0000000000f2";
const TEAM_ADMIN_ID = "00000000-0000-0000-0000-0000000000f3";
const TEAM_MEMBER_ID = "00000000-0000-0000-0000-0000000000f4";
const OUTSIDER_ID = "00000000-0000-0000-0000-0000000000f5";
const GHOST_OWNER_ID = "00000000-0000-0000-0000-0000000000f6";

/**
 * The production statement shape, verbatim: one key per workspace, the model
 * overwritten from `excluded`. `workspace_id` is never in the SET list, which
 * is what the conflict cases assert by reading the row back.
 */
const UPSERT_SETTINGS = `insert into public.workspace_settings (workspace_id, default_model)
  values ($1, $2)
  on conflict (workspace_id) do update
    set default_model = excluded.default_model
  returning workspace_id, default_model`;

/** A plain UPDATE, used only to show it is refused silently, not loudly. */
const PLAIN_UPDATE = `update public.workspace_settings set default_model = $2
  where workspace_id = $1`;

type SettingsRow = {
  workspace_id: string;
  default_model: string;
  created_at: string;
  updated_at: string;
};

const SELECT_SETTINGS_ROW = `select workspace_id, default_model,
    created_at::text as created_at, updated_at::text as updated_at
  from public.workspace_settings where workspace_id = $1`;

const UPSERT_AS_OWNER = `insert into public.workspace_settings (workspace_id, default_model)
  values ($1, $2)
  on conflict (workspace_id) do update set default_model = excluded.default_model`;

let db: PGlite;
let applied: string[] = [];
let personalWorkspaceId = "";
let teamWorkspaceId = "";
let ghostWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

type Denial = { code: string; message: string; severity: string };

/** Run `statement` and return the SQLSTATE/message it was denied with. */
async function denial(statement: () => Promise<unknown>): Promise<Denial> {
  try {
    await statement();
  } catch (error) {
    const refused = error as { code?: unknown; message?: unknown; severity?: unknown };
    return {
      code: String(refused.code),
      message: String(refused.message),
      severity: String(refused.severity),
    };
  }
  throw new Error("expected the statement to be denied, but it succeeded");
}

/** The exact shape a policy refusal has: 42501, never a missing GRANT. */
function expectRlsDenial(result: Denial): void {
  expect(result.code).toBe("42501");
  expect(result.severity).toBe("ERROR");
  expect(result.message).toBe(
    'new row violates row-level security policy for table "workspace_settings"',
  );
  expect(result.message).not.toMatch(/permission denied/);
  expect(result.message).not.toMatch(/foreign key/);
  expect(result.message).not.toMatch(/duplicate key/);
}

/** The statement under test, run as one identity inside one transaction. */
async function upsertAs(
  userId: string,
  workspaceId: string,
  model: string,
): Promise<{ affectedRows: number; rows: Array<{ workspace_id: string; default_model: string }> }> {
  const result = await asUser(db, userId, (tx) =>
    tx.query<{ workspace_id: string; default_model: string }>(UPSERT_SETTINGS, [
      workspaceId,
      model,
    ]),
  );
  return { affectedRows: result.affectedRows ?? 0, rows: result.rows };
}

/** Seeded as the database owner, so the fixture itself is never blocked by RLS. */
async function seedSettings(workspaceId: string, model: string): Promise<void> {
  await db.query(UPSERT_AS_OWNER, [workspaceId, model]);
}

/** Clears the single row so a case can measure the INSERT path (no conflict). */
async function clearSettings(workspaceId: string): Promise<void> {
  await db.query("delete from public.workspace_settings where workspace_id = $1", [
    workspaceId,
  ]);
}

async function settingsRow(workspaceId: string): Promise<SettingsRow | null> {
  const rows = (
    await db.query<SettingsRow>(SELECT_SETTINGS_ROW, [workspaceId])
  ).rows;
  return rows[0] ?? null;
}

async function requiresSettingsRow(workspaceId: string): Promise<SettingsRow> {
  return firstRow((await db.query<SettingsRow>(SELECT_SETTINGS_ROW, [workspaceId])).rows);
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

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity.
  for (const [id, email] of [
    [PERSONAL_OWNER_ID, "ws-settings-personal@hahart.test"],
    [TEAM_OWNER_ID, "ws-settings-owner@hahart.test"],
    [TEAM_ADMIN_ID, "ws-settings-admin@hahart.test"],
    [TEAM_MEMBER_ID, "ws-settings-member@hahart.test"],
    [OUTSIDER_ID, "ws-settings-outsider@hahart.test"],
    [GHOST_OWNER_ID, "ws-settings-ghost@hahart.test"],
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
         values ('team', 'Workspace Settings Team', $1) returning id`,
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

describe("workspace settings permissions: the schema the baseline is measured against", () => {
  it("case 1: the whole migration chain loads, and workspace_settings is RLS-guarded by three write/read policies", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

    // Not a subset: every migration on disk really ran, in filename order.
    expect(applied).toEqual(files.sort());
    expect(applied).toContain(SETTINGS_MIGRATION);

    const policies = await db.query<{
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select policyname, cmd, qual, with_check
         from pg_policies
        where schemaname = 'public' and tablename = 'workspace_settings'`,
    );

    // Exactly three: the 2026-09 team-workspace migration deliberately does not
    // touch workspace_settings, so this is the whole policy set in force.
    expect(policies.rows).toHaveLength(3);
    const byName = new Map(policies.rows.map((row) => [row.policyname, row]));

    const select = byName.get("workspace_settings_select");
    expect(select?.cmd).toBe("SELECT");
    expect(select?.qual).toContain("workspace_members");
    // Read access is membership, with no role restriction at all.
    expect(select?.qual).not.toContain("owner");
    expect(select?.qual).not.toContain("admin");

    const insert = byName.get("workspace_settings_insert");
    expect(insert?.cmd).toBe("INSERT");
    expect(insert?.qual).toBeNull();
    expect(insert?.with_check).toContain("workspace_members");
    expect(insert?.with_check).toContain("owner");
    expect(insert?.with_check).toContain("admin");

    const update = byName.get("workspace_settings_update");
    expect(update?.cmd).toBe("UPDATE");
    expect(update?.qual).toContain("workspace_members");
    expect(update?.qual).toContain("owner");
    expect(update?.qual).toContain("admin");
    // No separate WITH CHECK: the USING expression is re-evaluated against the
    // new row, which is why a role change on the row cannot slip past it.
    expect(update?.with_check).toBeNull();

    // There is no DELETE policy, so deletion is refused for every non-owner role.
    expect(policies.rows.filter((row) => row.cmd === "DELETE")).toHaveLength(0);

    const table = firstRow(
      (
        await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `select relrowsecurity, relforcerowsecurity
             from pg_class where oid = 'public.workspace_settings'::regclass`,
        )
      ).rows,
    );
    expect(table.relrowsecurity).toBe(true);
    expect(table.relforcerowsecurity).toBe(false);

    const column = firstRow(
      (
        await db.query<{ is_nullable: string; column_default: string | null }>(
          `select is_nullable, column_default from information_schema.columns
            where table_schema = 'public' and table_name = 'workspace_settings'
              and column_name = 'default_model'`,
        )
      ).rows,
    );
    expect(column.is_nullable).toBe("NO");
    expect(column.column_default).toContain("gpt-5.4-mini");
  });
});

describe("workspace settings permissions: owners and admins may write", () => {
  it("case 2: the personal workspace owner creates the settings row with the upsert", async () => {
    await clearSettings(personalWorkspaceId);

    const created = await upsertAs(
      PERSONAL_OWNER_ID,
      personalWorkspaceId,
      "personal-create-model",
    );
    expect(created.affectedRows).toBe(1);
    // RETURNING proves the row landed under the workspace the caller asked for.
    expect(created.rows).toEqual([
      { workspace_id: personalWorkspaceId, default_model: "personal-create-model" },
    ]);

    const stored = await requiresSettingsRow(personalWorkspaceId);
    expect(stored.workspace_id).toBe(personalWorkspaceId);
    expect(stored.default_model).toBe("personal-create-model");
    expect(await rowsFor(personalWorkspaceId)).toBe(1);
  });

  it("case 3: the personal workspace owner's conflict update overwrites the model and keeps the row", async () => {
    await seedSettings(personalWorkspaceId, "personal-before-model");
    const before = await requiresSettingsRow(personalWorkspaceId);

    const updated = await upsertAs(
      PERSONAL_OWNER_ID,
      personalWorkspaceId,
      "personal-after-model",
    );
    expect(updated.affectedRows).toBe(1);
    expect(updated.rows).toEqual([
      { workspace_id: personalWorkspaceId, default_model: "personal-after-model" },
    ]);

    const after = await requiresSettingsRow(personalWorkspaceId);
    expect(after.default_model).toBe("personal-after-model");
    // The conflict path updated in place: same row, same workspace_id,
    // same created_at - `workspace_id` is not in the SET list and no second
    // row appeared.
    expect(after.workspace_id).toBe(personalWorkspaceId);
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(personalWorkspaceId)).toBe(1);
  });

  it("case 4: a team owner creates the settings row", async () => {
    await clearSettings(teamWorkspaceId);

    const created = await upsertAs(TEAM_OWNER_ID, teamWorkspaceId, "team-owner-create-model");
    expect(created.affectedRows).toBe(1);
    expect(created.rows).toEqual([
      { workspace_id: teamWorkspaceId, default_model: "team-owner-create-model" },
    ]);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "team-owner-create-model",
    );
  });

  it("case 5: a team owner's conflict update overwrites the model and keeps the workspace_id", async () => {
    await seedSettings(teamWorkspaceId, "team-owner-before-model");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const updated = await upsertAs(TEAM_OWNER_ID, teamWorkspaceId, "team-owner-after-model");
    expect(updated.affectedRows).toBe(1);
    expect(updated.rows).toEqual([
      { workspace_id: teamWorkspaceId, default_model: "team-owner-after-model" },
    ]);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.workspace_id).toBe(teamWorkspaceId);
    expect(after.default_model).toBe("team-owner-after-model");
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });

  it("case 6: a team admin creates the settings row", async () => {
    await clearSettings(teamWorkspaceId);

    const created = await upsertAs(TEAM_ADMIN_ID, teamWorkspaceId, "team-admin-create-model");
    expect(created.affectedRows).toBe(1);
    expect(created.rows).toEqual([
      { workspace_id: teamWorkspaceId, default_model: "team-admin-create-model" },
    ]);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "team-admin-create-model",
    );
  });

  it("case 7: a team admin's conflict update overwrites the model and keeps the workspace_id", async () => {
    await seedSettings(teamWorkspaceId, "team-admin-before-model");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const updated = await upsertAs(TEAM_ADMIN_ID, teamWorkspaceId, "team-admin-after-model");
    expect(updated.affectedRows).toBe(1);
    expect(updated.rows).toEqual([
      { workspace_id: teamWorkspaceId, default_model: "team-admin-after-model" },
    ]);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.workspace_id).toBe(teamWorkspaceId);
    expect(after.default_model).toBe("team-admin-after-model");
    expect(after.created_at).toBe(before.created_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);
  });
});

describe("workspace settings permissions: members and non-members are refused", () => {
  it("case 8: a plain member cannot create a missing settings row", async () => {
    await clearSettings(teamWorkspaceId);
    const totalBefore = await totalRows();

    const refused = await denial(() =>
      upsertAs(TEAM_MEMBER_ID, teamWorkspaceId, "member-create-model"),
    );
    expectRlsDenial(refused);

    // The WITH CHECK refusal is the INSERT branch of the same statement: the
    // role is the gate, not the row's absence.
    expect(await settingsRow(teamWorkspaceId)).toBeNull();
    expect(await totalRows()).toBe(totalBefore);
  });

  it("case 9: a plain member cannot conflict-update an existing row, and the stored value survives", async () => {
    await seedSettings(teamWorkspaceId, "member-row-before");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const refused = await denial(() =>
      upsertAs(TEAM_MEMBER_ID, teamWorkspaceId, "member-row-after"),
    );
    expectRlsDenial(refused);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.default_model).toBe("member-row-before");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);

    // The same refusal without ON CONFLICT is a USING-filtered UPDATE: no
    // SQLSTATE at all, zero affected rows, and the row is still untouched.
    const plain = await asUser(db, TEAM_MEMBER_ID, (tx) =>
      tx.query(PLAIN_UPDATE, [teamWorkspaceId, "member-plain-update"]),
    );
    expect(plain.affectedRows ?? 0).toBe(0);
    expect(await requiresSettingsRow(teamWorkspaceId)).toEqual(before);
  });

  it("case 10: a non-member - and an owner_user_id with no membership row - cannot create the settings row", async () => {
    await clearSettings(teamWorkspaceId);
    const totalBefore = await totalRows();

    const byOutsider = await denial(() =>
      upsertAs(OUTSIDER_ID, teamWorkspaceId, "outsider-create-model"),
    );
    expectRlsDenial(byOutsider);
    expect(await settingsRow(teamWorkspaceId)).toBeNull();

    // Boundary assertion: `workspaces.owner_user_id` alone is NOT a write rule.
    // This workspace names the caller as its owner and has no membership row at
    // all, so the INSERT is still refused - the policy reads workspace_members
    // only, and the bootstrap that normally writes that row is an
    // implementation detail, not part of the RLS contract.
    expect(await workspaceOwner(ghostWorkspaceId)).toBe(GHOST_OWNER_ID);
    expect(await membershipCount(ghostWorkspaceId)).toBe(0);
    await clearSettings(ghostWorkspaceId);

    const byGhostOwner = await denial(() =>
      upsertAs(GHOST_OWNER_ID, ghostWorkspaceId, "ghost-owner-create-model"),
    );
    expectRlsDenial(byGhostOwner);
    expect(await settingsRow(ghostWorkspaceId)).toBeNull();

    expect(await totalRows()).toBe(totalBefore);
  });

  it("case 11: a non-member - and an owner_user_id with no membership row - cannot conflict-update, and the value survives", async () => {
    await seedSettings(teamWorkspaceId, "outsider-row-before");
    const before = await requiresSettingsRow(teamWorkspaceId);

    const byOutsider = await denial(() =>
      upsertAs(OUTSIDER_ID, teamWorkspaceId, "outsider-row-after"),
    );
    expectRlsDenial(byOutsider);

    const after = await requiresSettingsRow(teamWorkspaceId);
    expect(after.default_model).toBe("outsider-row-before");
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at).toBe(before.updated_at);
    expect(await rowsFor(teamWorkspaceId)).toBe(1);

    // The row is not merely unwritable for the outsider, it is unreadable: the
    // SELECT policy checks membership, so the conflict target is invisible.
    const unreadable = await asUser(db, OUTSIDER_ID, (tx) =>
      tx.query<{ workspace_id: string }>(
        "select workspace_id from public.workspace_settings where workspace_id = $1",
        [teamWorkspaceId],
      ),
    );
    expect(unreadable.rows).toEqual([]);

    // Boundary assertion on the conflict path: the membership-less owner is
    // refused here too, and its row keeps the old model.
    expect(await workspaceOwner(ghostWorkspaceId)).toBe(GHOST_OWNER_ID);
    expect(await membershipCount(ghostWorkspaceId)).toBe(0);
    await seedSettings(ghostWorkspaceId, "ghost-owner-row-before");
    const ghostBefore = await requiresSettingsRow(ghostWorkspaceId);

    const byGhostOwner = await denial(() =>
      upsertAs(GHOST_OWNER_ID, ghostWorkspaceId, "ghost-owner-row-after"),
    );
    expectRlsDenial(byGhostOwner);
    expect(await requiresSettingsRow(ghostWorkspaceId)).toEqual(ghostBefore);
    expect(await rowsFor(ghostWorkspaceId)).toBe(1);
  });
});

describe("workspace settings permissions: refusal shape and transaction-local recovery", () => {
  it("case 12: a refused write aborts only its transaction; the session, the role and the identity all recover", async () => {
    await clearSettings(teamWorkspaceId);
    const totalBefore = await totalRows();

    await db.exec("begin");
    try {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [TEAM_MEMBER_ID]);

      const refused = await denial(() =>
        db.query(UPSERT_SETTINGS, [teamWorkspaceId, "member-in-aborted-block"]),
      );
      expectRlsDenial(refused);

      // The failure really did abort the block: the next statement is refused
      // with 25P02 instead of running.
      const aborted = await denial(() => db.query("select 1 as one"));
      expect(aborted.code).toBe("25P02");
      expect(aborted.message).toMatch(/current transaction is aborted/);
    } finally {
      await db.exec("rollback");
    }

    // Same connection (PGlite has exactly one session): querying works again,
    // the refused write left nothing behind, and the identity set with
    // `set local role` went away with the transaction.
    expect((await db.query<{ one: number }>("select 1 as one")).rows).toEqual([{ one: 1 }]);
    expect(await settingsRow(teamWorkspaceId)).toBeNull();
    expect(await totalRows()).toBe(totalBefore);

    const identity = firstRow(
      (
        await db.query<{ role: string; uid: string | null; claim: string | null }>(
          `select current_user as role,
                  auth.uid() as uid,
                  current_setting('request.jwt.claim.sub', true) as claim`,
        )
      ).rows,
    );
    expect(identity.role).not.toBe("authenticated");
    expect(identity.uid).toBeNull();
    expect(identity.claim).not.toBe(TEAM_MEMBER_ID);

    // A legal write still lands on that same connection afterwards.
    const allowed = await upsertAs(TEAM_OWNER_ID, teamWorkspaceId, "owner-after-refusal");
    expect(allowed.affectedRows).toBe(1);
    expect((await requiresSettingsRow(teamWorkspaceId)).default_model).toBe(
      "owner-after-refusal",
    );

    // And a plain member still reads it: the refusal was about writing, not
    // about membership itself.
    const memberRead = await asUser(db, TEAM_MEMBER_ID, (tx) =>
      tx.query<{ default_model: string }>(
        "select default_model from public.workspace_settings where workspace_id = $1",
        [teamWorkspaceId],
      ),
    );
    expect(memberRead.rows).toEqual([{ default_model: "owner-after-refusal" }]);
  });
});
