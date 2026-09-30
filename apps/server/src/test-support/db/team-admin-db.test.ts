import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const uid = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

const USER_O = uid("0f"); // team owner
const USER_M = uid("0e"); // team admin
const USER_A = uid("0a"); // team member, owns project P
const USER_B = uid("0b"); // not in the team yet — case 4 adds them
const USER_X = uid("0c"); // never in the team

let db: PGlite;
let applied: string[] = [];
let teamId = "";
let projectId = "";
let canvasId = "";
let sessionId = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Superuser helper: call a function and return its value. */
async function call<T>(sql: string, params: unknown[]): Promise<T> {
  const result = await db.query<{ r: T }>(`select ${sql} as r`, params);
  return firstRow(result.rows).r;
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

async function auditCount(): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>(
      "select count(*)::int as n from public.admin_audit_log",
    )).rows,
  ).n;
}

async function roleOf(userId: string): Promise<string> {
  return firstRow(
    (await db.query<{ role: string }>(
      "select role::text as role from public.workspace_members where workspace_id = $1 and user_id = $2",
      [teamId, userId],
    )).rows,
  ).role;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  for (const [id, email] of [
    [USER_O, "o@hahart.test"],
    [USER_M, "m@hahart.test"],
    [USER_A, "a@hahart.test"],
    [USER_B, "b@hahart.test"],
    [USER_X, "x@hahart.test"],
  ] as const) {
    await createUser(db, id, email);
  }

  teamId = await call<string>("public.ensure_team_workspace($1, $2)", [
    USER_O,
    "HaHart 团队",
  ]);
  await db.query("select public.add_team_member($1, $2)", [USER_M, "admin"]);
  await db.query("select public.add_team_member($1, $2)", [USER_A, "member"]);

  // A's content, inserted as the superuser (same shape spike6 used).
  projectId = firstRow(
    (await db.query<{ id: string }>(
      "insert into public.projects (workspace_id, name, slug, created_by) values ($1,$2,$3,$4) returning id",
      [teamId, "p", "p", USER_A],
    )).rows,
  ).id;
  canvasId = firstRow(
    (await db.query<{ id: string }>(
      "insert into public.canvases (project_id, name, created_by) values ($1,$2,$3) returning id",
      [projectId, "c", USER_A],
    )).rows,
  ).id;
  sessionId = firstRow(
    (await db.query<{ id: string }>(
      "insert into public.chat_sessions (canvas_id, created_by) values ($1,$2) returning id",
      [canvasId, USER_A],
    )).rows,
  ).id;
}, 120_000);

describe("team admin audit database functions", () => {
  it("case 1: set_team_member_role changes the role once, then reports no change", async () => {
    expect(
      await call<boolean>("public.set_team_member_role($1, $2)", [USER_A, "admin"]),
    ).toBe(true);
    expect(
      await call<boolean>("public.set_team_member_role($1, $2)", [USER_A, "admin"]),
    ).toBe(false);
    expect(await roleOf(USER_A)).toBe("admin");
  });

  it("case 2: set_team_member_role refuses owner, the team owner, and non-members", async () => {
    expect(
      await failure(() =>
        db.query("select public.set_team_member_role($1, $2)", [USER_A, "owner"]),
      ),
    ).toContain("role owner is not assignable");

    expect(
      await failure(() =>
        db.query("select public.set_team_member_role($1, $2)", [USER_O, "member"]),
      ),
    ).toContain("cannot change the team owner");

    expect(
      await failure(() =>
        db.query("select public.set_team_member_role($1, $2)", [USER_X, "member"]),
      ),
    ).toContain("user is not a team member");
  });

  it("case 3: a non-admin cannot use the admin wrapper and writes no audit row", async () => {
    const before = await auditCount();

    const message = await failure(() =>
      db.query("select public.admin_add_team_member($1, $2, $3)", [
        USER_B,
        USER_X,
        "member",
      ]),
    );

    expect(message).toContain("actor is not a team admin");
    expect(await auditCount()).toBe(before);
  });

  it("case 4: adding a member audits once; adding again does not", async () => {
    const before = await auditCount();

    expect(
      await call<boolean>("public.admin_add_team_member($1, $2, $3)", [
        USER_M,
        USER_B,
        "member",
      ]),
    ).toBe(true);
    expect(await auditCount()).toBe(before + 1);

    expect(
      await call<boolean>("public.admin_add_team_member($1, $2, $3)", [
        USER_M,
        USER_B,
        "member",
      ]),
    ).toBe(false);
    expect(await auditCount()).toBe(before + 1);
  });

  it("case 5: promoting a member records before/after in the audit detail", async () => {
    expect(
      await call<boolean>("public.admin_set_team_member_role($1, $2, $3)", [
        USER_M,
        USER_B,
        "admin",
      ]),
    ).toBe(true);

    const detail = firstRow(
      (await db.query<{ detail: unknown }>(
        "select detail from public.admin_audit_log where action = 'team.member.role' order by created_at desc limit 1",
      )).rows,
    ).detail;

    expect(detail).toEqual({ before: "member", after: "admin" });
  });

  it("case 6: an admin cannot change or remove themselves", async () => {
    expect(
      await failure(() =>
        db.query("select public.admin_set_team_member_role($1, $1, $2)", [
          USER_M,
          "member",
        ]),
      ),
    ).toContain("cannot change your own role");

    expect(
      await failure(() =>
        db.query("select public.admin_remove_team_member($1, $1)", [USER_M]),
      ),
    ).toContain("cannot remove yourself");
  });

  it("case 7: reading your own project is not a foreign read", async () => {
    const before = await auditCount();

    expect(
      await call<boolean>("public.record_foreign_read($1, $2, $3)", [
        USER_A,
        "project",
        projectId,
      ]),
    ).toBe(false);
    expect(await auditCount()).toBe(before);
  });

  it("case 8: reading someone else's content by project, canvas and session audits each", async () => {
    expect(
      await call<boolean>("public.record_foreign_read($1, $2, $3)", [
        USER_M,
        "project",
        projectId,
      ]),
    ).toBe(true);
    expect(
      await call<boolean>("public.record_foreign_read($1, $2, null, $3)", [
        USER_M,
        "canvas",
        canvasId,
      ]),
    ).toBe(true);
    expect(
      await call<boolean>("public.record_foreign_read($1, $2, null, null, $3)", [
        USER_M,
        "messages",
        sessionId,
      ]),
    ).toBe(true);

    const rows = firstRow(
      (await db.query<{ n: number }>(
        `select count(*)::int as n from public.admin_audit_log
         where action = 'content.foreign_read'
           and target_user_id = $1
           and target_project_id = $2`,
        [USER_A, projectId],
      )).rows,
    ).n;

    expect(rows).toBe(3);
  });

  it("case 9: record_foreign_read rejects bad arguments", async () => {
    expect(
      await failure(() =>
        db.query("select public.record_foreign_read($1, $2, $3, $4)", [
          USER_M,
          "x",
          projectId,
          canvasId,
        ]),
      ),
    ).toContain("exactly one of project, canvas, session is required");

    expect(
      await failure(() =>
        db.query("select public.record_foreign_read($1, $2, null, $3)", [
          USER_M,
          "canvas",
          USER_X,
        ]),
      ),
    ).toContain("project not found");
  });

  it("case 10: removing a member audits once and is idempotent", async () => {
    const removed = await call<Record<string, number>>(
      "public.admin_remove_team_member($1, $2)",
      [USER_M, USER_A],
    );
    expect(removed.removed).toBe(1);

    const afterFirst = firstRow(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.admin_audit_log where action = 'team.member.remove'",
      )).rows,
    ).n;
    expect(afterFirst).toBe(1);

    const again = await call<Record<string, number>>(
      "public.admin_remove_team_member($1, $2)",
      [USER_M, USER_A],
    );
    expect(again).toEqual({ projects: 0, assets: 0, objects: 0, removed: 0 });

    const afterSecond = firstRow(
      (await db.query<{ n: number }>(
        "select count(*)::int as n from public.admin_audit_log where action = 'team.member.remove'",
      )).rows,
    ).n;
    expect(afterSecond).toBe(1);
  });

  it("case 11: an authenticated caller cannot touch the audit table", async () => {
    const read = await failure(() =>
      asUser(db, USER_O, (tx) => tx.query("select * from public.admin_audit_log")),
    );
    expect(read).toContain("permission denied for table admin_audit_log");

    const write = await failure(() =>
      asUser(db, USER_O, (tx) =>
        tx.query(
          "insert into public.admin_audit_log (actor_user_id, action) values ($1, 'team.member.add')",
          [USER_O],
        ),
      ),
    );
    expect(write).toContain("permission denied for table admin_audit_log");
  });

  it("case 12: an authenticated caller cannot call the audit functions", async () => {
    const calls: Array<[string, string, unknown[]]> = [
      ["set_team_member_role", "select public.set_team_member_role($1, $2)", [USER_A, "member"]],
      ["admin_add_team_member", "select public.admin_add_team_member($1, $2, $3)", [USER_M, USER_X, "member"]],
      ["admin_set_team_member_role", "select public.admin_set_team_member_role($1, $2, $3)", [USER_M, USER_X, "member"]],
      ["admin_remove_team_member", "select public.admin_remove_team_member($1, $2)", [USER_M, USER_X]],
      ["record_foreign_read", "select public.record_foreign_read($1, $2, $3)", [USER_M, "project", projectId]],
    ];

    for (const [label, sql, params] of calls) {
      const message = await failure(() =>
        asUser(db, USER_M, (tx) => tx.query(sql, params)),
      );
      expect(message, label).toContain("permission denied for function");
    }
  });

  it("case 13: the action check constraint rejects unknown actions", async () => {
    const message = await failure(() =>
      db.query(
        "insert into public.admin_audit_log (actor_user_id, action) values ($1, 'x')",
        [USER_M],
      ),
    );

    expect(message).toContain("admin_audit_log_action_check");
  });
});
