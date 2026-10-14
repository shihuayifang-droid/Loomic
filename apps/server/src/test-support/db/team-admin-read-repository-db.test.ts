import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LIST_TEAM_MEMBERS,
  TeamAdminReadError,
  createTeamAdminReadRepository,
  type TeamAdminReadRepository,
} from "../../db/team-admin-read-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL ACL integration for the team administration read repository
 * (workorder 20F-A, ADR-0001 migration step 2f).
 *
 * The unit tests beside the repository prove WHICH statement is built. This file
 * proves the statement enforces the ACL on a real PostgreSQL parser and planner:
 * the team-workspace subquery, the actor's membership + admin/owner predicate,
 * the LEFT JOIN that keeps a profile-less member, the created_at ordering, the
 * rollback path, and the absence of the legacy `owner_user_id` bypass.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. Its session is the database owner, which BYPASSES RLS
 * — that is exactly why every judge below reads through the repository and never
 * through `asUser`: the old policies are not the evidence, the SQL is.
 *
 * The fixture is built in ordered phases (no team workspace -> a team workspace
 * whose `owner_user_id` holds no membership row -> memberships), because
 * `workspaces_single_team_key` allows exactly one team workspace per database.
 * The describes below therefore run in declaration order and share one migrated
 * instance; `afterAll` closes it.
 */

const uid = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

const OWNER_ID = uid("0f"); // team owner: membership row, role owner
const ADMIN_ID = uid("0e"); // team admin: membership row, role admin
const MEMBER_ID = uid("0a"); // plain member: membership row, role member
const PROFILELESS_ID = uid("0d"); // member whose profile row is deleted
const STRANGER_ID = uid("0c"); // never a member of anything

const TEAM_NAME = "HaHart Team";

/**
 * Explicit join dates. Insertion order below is deliberately scrambled, so the
 * expected list order can only come from `created_at` — `joinedAt` is what the
 * ORDER BY reads, not the order rows were written in.
 */
const JOINED = {
  member: "2026-01-01T00:00:00.000Z",
  owner: "2026-01-02T00:00:00.000Z",
  admin: "2026-01-03T00:00:00.000Z",
  profileless: "2026-01-04T00:00:00.000Z",
} as const;

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/** A uuid no row uses: "no team", "not a member" and "not an admin" answer alike. */
const UNKNOWN_ID = uid("ff");

/** If the actor were concatenated instead of bound, this would be valid SQL. */
const INJECTION_ID = "' or true --";

let db: PGlite;
let repository: TeamAdminReadRepository;
let teamId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

async function read(actorId: string) {
  return repository.listTeamMembers({ actorId });
}

/** Run a read that is expected to fail and return what it threw. */
async function capture(actorId: string): Promise<unknown> {
  return repository.listTeamMembers({ actorId }).catch((reason: unknown) => reason);
}

function expectReadError(error: unknown): TeamAdminReadError {
  expect(error).toBeInstanceOf(TeamAdminReadError);
  const readError = error as TeamAdminReadError;
  expect(readError.operation).toBe(LIST_TEAM_MEMBERS);
  return readError;
}

async function countAuditRows(): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>(
      "select count(*)::int as n from public.admin_audit_log",
    )).rows,
  ).n;
}

async function addMembership(
  userId: string,
  role: "owner" | "admin" | "member",
  joinedAt: string,
): Promise<void> {
  await db.query(
    "insert into public.workspace_members (workspace_id, user_id, role, created_at) " +
      "values ($1, $2, $3::public.workspace_member_role, $4::timestamptz)",
    [teamId, userId, role, joinedAt],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;

  for (const [id, email] of [
    [OWNER_ID, "o@hahart.test"],
    [ADMIN_ID, "e@hahart.test"],
    [MEMBER_ID, "a@hahart.test"],
    [PROFILELESS_ID, "d@hahart.test"],
    [STRANGER_ID, "c@hahart.test"],
  ] as const) {
    await createUser(db, id, email);
  }

  // The signup trigger creates the profiles (display_name defaults to the email
  // local part); owner and member get a real name, the admin an explicit NULL, so
  // the projection below is checkable field by field.
  await db.query("update public.profiles set display_name = $2 where id = $1", [
    OWNER_ID,
    "Team Owner",
  ]);
  await db.query("update public.profiles set display_name = $2 where id = $1", [
    MEMBER_ID,
    "Member A",
  ]);
  await db.query("update public.profiles set display_name = null where id = $1", [
    ADMIN_ID,
  ]);

  repository = createTeamAdminReadRepository({
    getTransactionPool: () => createPGliteTransactionPool(db),
  });
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("team member list: no team workspace", () => {
  it("case 1: an empty list, even for the user who will later own the team", async () => {
    expect(await countAuditRows()).toBe(0);

    await expect(read(OWNER_ID)).resolves.toEqual([]);
    await expect(read(STRANGER_ID)).resolves.toEqual([]);
    await expect(read(UNKNOWN_ID)).resolves.toEqual([]);
  });
});

describe("team member list: a team workspace whose owner holds no membership row", () => {
  beforeAll(async () => {
    // Built directly rather than through `ensure_team_workspace`, which would
    // also write the owner's membership row: this phase needs the workspace
    // owner WITHOUT one, because the legacy policy helper
    // `private.is_workspace_admin_or_owner` grants on `owner_user_id` alone.
    teamId = firstRow(
      (await db.query<{ id: string }>(
        "insert into public.workspaces (type, name, owner_user_id) " +
          "values ('team', $1, $2) returning id",
        [TEAM_NAME, OWNER_ID],
      )).rows,
    ).id;
  });

  it("case 2: `owner_user_id` alone is not a membership — the legacy bypass is not copied", async () => {
    const ownerRowCount = firstRow(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspace_members where workspace_id = $1",
        [teamId],
      )).rows,
    ).n;
    expect(ownerRowCount).toBe(0);

    await expect(read(OWNER_ID)).resolves.toEqual([]);
  });

  it("case 3: a caller with no membership row reads nothing", async () => {
    await expect(read(STRANGER_ID)).resolves.toEqual([]);
  });
});

describe("team member list: memberships exist", () => {
  beforeAll(async () => {
    // Scrambled insertion order against the expected created_at order.
    await addMembership(PROFILELESS_ID, "member", JOINED.profileless);
    await addMembership(ADMIN_ID, "admin", JOINED.admin);
    await addMembership(OWNER_ID, "owner", JOINED.owner);
    await addMembership(MEMBER_ID, "member", JOINED.member);

    // The one member without a profile row: LEFT JOIN must keep them.
    await db.query("delete from public.profiles where id = $1", [PROFILELESS_ID]);
  });

  it("case 4: a plain member reads nothing — the role predicate is in the SQL", async () => {
    await expect(read(MEMBER_ID)).resolves.toEqual([]);
    await expect(read(PROFILELESS_ID)).resolves.toEqual([]);
  });

  it("case 5: an admin sees every member, ordered by created_at with the profile-less member kept", async () => {
    const members = await read(ADMIN_ID);

    expect(members).toEqual([
      {
        userId: MEMBER_ID,
        email: "a@hahart.test",
        displayName: "Member A",
        role: "member",
        joinedAt: JOINED.member,
      },
      {
        userId: OWNER_ID,
        email: "o@hahart.test",
        displayName: "Team Owner",
        role: "owner",
        joinedAt: JOINED.owner,
      },
      {
        userId: ADMIN_ID,
        email: "e@hahart.test",
        displayName: null,
        role: "admin",
        joinedAt: JOINED.admin,
      },
      {
        userId: PROFILELESS_ID,
        email: "",
        displayName: null,
        role: "member",
        joinedAt: JOINED.profileless,
      },
    ]);
  });

  it("case 6: the owner sees the same list as the admin", async () => {
    await expect(read(OWNER_ID)).resolves.toEqual(await read(ADMIN_ID));
  });

  it("case 7: reading the roster writes no audit row and no other row", async () => {
    const before = await countAuditRows();
    const membershipsBefore = firstRow(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.workspace_members where workspace_id = $1",
        [teamId],
      )).rows,
    ).n;

    await read(ADMIN_ID);
    await read(OWNER_ID);
    await read(MEMBER_ID);

    expect(await countAuditRows()).toBe(before);
    expect(await countAuditRows()).toBe(0);
    expect(
      firstRow(
        (await db.query<{ n: number }>(
          "select count(*)::int as n from public.workspace_members where workspace_id = $1",
          [teamId],
        )).rows,
      ).n,
    ).toBe(membershipsBefore);
  });
});

describe("team member list: failures", () => {
  it("case 8: an invalid uuid actor fails loud and the same pool keeps reading", async () => {
    const error = expectReadError(await capture(INVALID_ID));

    // The message is fixed text: no SQL, no host, no driver detail.
    expect(error.message).toBe(`team admin read failed (${LIST_TEAM_MEMBERS})`);
    expect(error.message).not.toContain("select");
    expect(error.message).not.toContain("workspace_members");

    // `withTransaction` rolled the failed transaction back, so the next read
    // both succeeds and still returns the full roster: an aborted transaction
    // left open would answer `25P02 current transaction is aborted`.
    const members = await read(ADMIN_ID);
    expect(members).toHaveLength(4);
    expect(firstRow((await db.query<{ n: number }>("select 1::int as n")).rows).n).toBe(1);
  });

  it("case 9: an injection-shaped actor is a bind parameter, not SQL", async () => {
    const error = expectReadError(await capture(INJECTION_ID));

    expect(error.message).toBe(`team admin read failed (${LIST_TEAM_MEMBERS})`);
    // The statement compares the parameter against a uuid column, so the payload
    // can only fail as a uuid — it never reaches the parser as SQL.
    expect((error.cause as Error).message).toMatch(/uuid/i);

    // The failed attempt changed nothing.
    await expect(read(ADMIN_ID)).resolves.toHaveLength(4);
  });
});
