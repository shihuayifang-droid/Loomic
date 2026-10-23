import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createIdentityReadRepository } from "../../db/identity-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import { createCanonicalDb, createCanonicalUser } from "./canonical-db.js";
import { createPGliteTransactionPool } from "./pglite-db.js";

/**
 * Ticket 43O: canonical migration 0003 (identity and workspaces) on an empty
 * database. No Supabase stubs: only `apps/server/db/canonical/*.sql`.
 */

const USER_A = "00000000-0000-0000-0000-0000000000c1";
const USER_B = "00000000-0000-0000-0000-0000000000c2";
const USER_NO_PROFILE = "00000000-0000-0000-0000-0000000000c3";
const USER_NO_MEMBER = "00000000-0000-0000-0000-0000000000c4";
const USER_CASCADE = "00000000-0000-0000-0000-0000000000c5";

const SQL_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../db/canonical/0003_identity.sql",
);

let db: PGlite;
let pool: TransactionPool;
let applied: string[] = [];

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ count: number }>(sql, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error("expected one row");
  return row.count;
}

beforeAll(async () => {
  const created = await createCanonicalDb();
  db = created.db;
  applied = created.applied;
  pool = createPGliteTransactionPool(db);

  await createCanonicalUser(db, USER_A, "a@hahart.test");
  await createCanonicalUser(db, USER_B, "b@hahart.test");
  await createCanonicalUser(db, USER_NO_PROFILE, "noprofile@hahart.test");
  await createCanonicalUser(db, USER_NO_MEMBER, "nomember@hahart.test");
  await createCanonicalUser(db, USER_CASCADE, "cascade@hahart.test");
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("canonical 0003 identity: schema", () => {
  it("applies 0003_identity.sql", () => {
    expect(applied).toContain("0003_identity.sql");
  });

  it("creates the five tables", async () => {
    const result = await db.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name in ('profiles', 'workspaces', 'workspace_members', 'workspace_settings', 'admin_audit_log')
        order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "admin_audit_log",
      "profiles",
      "workspace_members",
      "workspace_settings",
      "workspaces",
    ]);
  });

  it("deleting a hahart_auth user cascades to profile, memberships and workspaces", async () => {
    expect(
      await count("select count(*)::int as count from public.profiles where id = $1", [USER_CASCADE]),
    ).toBe(1);
    expect(
      await count("select count(*)::int as count from public.workspace_members where user_id = $1", [
        USER_CASCADE,
      ]),
    ).toBe(1);

    await db.query("delete from hahart_auth.users where id = $1", [USER_CASCADE]);

    expect(
      await count("select count(*)::int as count from public.profiles where id = $1", [USER_CASCADE]),
    ).toBe(0);
    expect(
      await count("select count(*)::int as count from public.workspace_members where user_id = $1", [
        USER_CASCADE,
      ]),
    ).toBe(0);
    expect(
      await count("select count(*)::int as count from public.workspaces where owner_user_id = $1", [
        USER_CASCADE,
      ]),
    ).toBe(0);
  });
});

describe("canonical 0003 identity: bootstrap_viewer", () => {
  it("createCanonicalUser leaves one personal workspace, an owner membership and a profile", async () => {
    expect(
      await count(
        "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
        [USER_A],
      ),
    ).toBe(1);

    const member = await db.query<{ role: string }>(
      `select m.role
         from public.workspace_members m
         join public.workspaces w on w.id = m.workspace_id
        where m.user_id = $1 and w.type = 'personal'`,
      [USER_A],
    );
    expect(member.rows).toEqual([{ role: "owner" }]);

    const profile = await db.query<{ email: string }>(
      "select email from public.profiles where id = $1",
      [USER_A],
    );
    expect(profile.rows).toEqual([{ email: "a@hahart.test" }]);
  });

  it("is idempotent: a second call adds no rows", async () => {
    const before = [
      await count("select count(*)::int as count from public.profiles"),
      await count("select count(*)::int as count from public.workspaces"),
      await count("select count(*)::int as count from public.workspace_members"),
    ];

    await db.query("select public.bootstrap_viewer($1, $2, '{}'::jsonb)", [USER_A, "a@hahart.test"]);

    const after = [
      await count("select count(*)::int as count from public.profiles"),
      await count("select count(*)::int as count from public.workspaces"),
      await count("select count(*)::int as count from public.workspace_members"),
    ];
    expect(after).toEqual(before);
  });
});

describe("canonical 0003 identity: ensure_team_workspace", () => {
  it("creates exactly one team workspace and does not duplicate it", async () => {
    const first = await db.query<{ id: string }>(
      "select public.ensure_team_workspace($1, $2) as id",
      [USER_A, "HaHart Team"],
    );
    const second = await db.query<{ id: string }>(
      "select public.ensure_team_workspace($1, $2) as id",
      [USER_A, "HaHart Team"],
    );

    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(
      await count("select count(*)::int as count from public.workspaces where type = 'team'"),
    ).toBe(1);

    const owner = await db.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id = $1 and user_id = $2",
      [first.rows[0]?.id, USER_A],
    );
    expect(owner.rows).toEqual([{ role: "owner" }]);
  });
});

describe("canonical 0003 identity: identity-read-repository on the canonical database", () => {
  const repository = () => createIdentityReadRepository({ getTransactionPool: () => pool });

  it("findPersonalFoundation returns the bootstrapped data", async () => {
    const found = await repository().findPersonalFoundation(USER_B);

    expect(found).not.toBeNull();
    expect(found?.workspace.type).toBe("personal");
    expect(found?.workspace.ownerUserId).toBe(USER_B);
    expect(found?.profile.id).toBe(USER_B);
    expect(found?.profile.email).toBe("b@hahart.test");
    expect(found?.membership.userId).toBe(USER_B);
    expect(found?.membership.workspaceId).toBe(found?.workspace.id);
    expect(found?.membership.role).toBe("owner");
  });

  it("findPersonalFoundation returns null when the profile row is missing", async () => {
    await db.query("delete from public.profiles where id = $1", [USER_NO_PROFILE]);
    expect(await repository().findPersonalFoundation(USER_NO_PROFILE)).toBeNull();
  });

  it("findPersonalFoundation returns null when the membership row is missing", async () => {
    await db.query("delete from public.workspace_members where user_id = $1", [USER_NO_MEMBER]);
    expect(await repository().findPersonalFoundation(USER_NO_MEMBER)).toBeNull();
  });
});

describe("canonical 0003 identity: SQL file hygiene", () => {
  it("contains none of the retired Supabase-only constructs", () => {
    const sql = readFileSync(SQL_FILE, "utf8").replaceAll("hahart_auth.", "").toLowerCase();
    const banned = [
      "auth.",
      "storage.",
      "pgmq",
      "auth.uid",
      "row level security",
      "create policy",
      "grant ",
      "anon",
      "authenticated",
      "service_role",
    ];
    for (const word of banned) {
      expect(sql.includes(word), `0003_identity.sql must not contain "${word}"`).toBe(false);
    }
  });

  it("stays within 400 lines", () => {
    expect(readFileSync(SQL_FILE, "utf8").split("\n").length).toBeLessThanOrEqual(400);
  });
});
