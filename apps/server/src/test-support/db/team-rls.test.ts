import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const uid = (suffix: string) => `00000000-0000-0000-0000-0000000000${suffix}`;

const USER_O = uid("0f"); // team owner
const USER_M = uid("0e"); // team admin
const USER_A = uid("0a"); // team member, owns the seeded project
const USER_B = uid("0b"); // team member, owns nothing
const USER_X = uid("0c"); // not in the team

const TABLES = [
  "projects",
  "canvases",
  "asset_objects",
  "chat_sessions",
  "chat_messages",
] as const;

const LEGACY_POLICIES = [
  "projects_select_member",
  "projects_insert_admin",
  "projects_update_admin",
  "projects_delete_admin",
  "canvases_select_member",
  "canvases_insert_admin",
  "canvases_update_admin",
  "canvases_delete_admin",
  "asset_objects_select_member",
  "asset_objects_insert_admin",
  "asset_objects_update_admin",
  "asset_objects_delete_admin",
  "project_assets_insert_admin",
  "project_assets_update_admin",
  "project_assets_delete_admin",
  // X-52 工单13: the path-based storage SELECT policy. Superseded by
  // `project_assets_select_metadata_reader`, which defers to asset_objects RLS
  // instead of trusting the object path's first segment.
  "project_assets_select_member",
];

let db: PGlite;
let applied: string[] = [];
let teamId = "";
let projectId = "";
let canvasId = "";
let sessionId = "";
let seededAdds: boolean[] = [];

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Run `sql` as `userId` (null = anon) and return the first row's single count column. */
async function countRows(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ n: number }>(sql, params);
    return firstRow(result.rows).n;
  });
}

async function visibleRows(userId: string | null, table: string): Promise<number> {
  return countRows(userId, `select count(*)::int as n from public.${table}`);
}

/** Run `statement` and return the rejection message; fails if it is allowed. */
async function denial(statement: () => Promise<unknown>): Promise<string> {
  try {
    await statement();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the statement to be denied, but it succeeded");
}

async function projectName(): Promise<string> {
  return firstRow(
    (await db.query<{ name: string }>("select name from public.projects where id = $1", [
      projectId,
    ])).rows,
  ).name;
}

async function projectOwner(): Promise<string> {
  return firstRow(
    (await db.query<{ created_by: string }>(
      "select created_by from public.projects where id = $1",
      [projectId],
    )).rows,
  ).created_by;
}

async function canvasName(): Promise<string | null> {
  const rows = (
    await db.query<{ name: string }>("select name from public.canvases where id = $1", [
      canvasId,
    ])
  ).rows;
  return rows[0]?.name ?? null;
}

async function storageObjectCount(name: string): Promise<number> {
  return firstRow(
    (await db.query<{ n: number }>(
      "select count(*)::int as n from storage.objects where name = $1",
      [name],
    )).rows,
  ).n;
}

async function personalWorkspace(userId: string): Promise<string> {
  return firstRow(
    (await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [userId],
    )).rows,
  ).id;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  await createUser(db, USER_O, "o@hahart.test");
  await createUser(db, USER_M, "m@hahart.test");
  await createUser(db, USER_A, "a@hahart.test");
  await createUser(db, USER_B, "b@hahart.test");
  await createUser(db, USER_X, "x@hahart.test");

  teamId = firstRow(
    (await db.query<{ id: string }>("select public.ensure_team_workspace($1, $2) as id", [
      USER_O,
      "HaHart 团队",
    ])).rows,
  ).id;

  const addMember = async (userId: string, role: string) =>
    firstRow(
      (await db.query<{ r: boolean }>("select public.add_team_member($1, $2) as r", [
        userId,
        role,
      ])).rows,
    ).r;

  seededAdds = [
    await addMember(USER_M, "admin"),
    await addMember(USER_A, "member"),
    await addMember(USER_B, "member"),
  ];

  // A builds their own content through the member-facing paths.
  const built = firstRow(
    (await asUser(db, USER_A, (tx) =>
      tx.query<{ j: { project: { id: string }; canvas: { id: string } } }>(
        "select public.create_project_with_canvas($1, $2, $3) as j",
        [teamId, "pA", "pa"],
      ),
    )).rows,
  ).j;
  projectId = built.project.id;
  canvasId = built.canvas.id;

  await asUser(db, USER_A, (tx) =>
    tx.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, $2, $3, $4, $5)`,
      [teamId, projectId, "project-assets", `${teamId}/${projectId}/a.png`, USER_A],
    ),
  );

  await asUser(db, USER_A, (tx) =>
    tx.query(
      `insert into public.asset_objects (workspace_id, bucket, object_path, created_by)
       values ($1, $2, $3, $4)`,
      [teamId, "project-assets", `${teamId}/free.png`, USER_A],
    ),
  );

  sessionId = firstRow(
    (await asUser(db, USER_A, (tx) =>
      tx.query<{ id: string }>(
        "insert into public.chat_sessions (canvas_id, created_by) values ($1, $2) returning id",
        [canvasId, USER_A],
      ),
    )).rows,
  ).id;

  await asUser(db, USER_A, (tx) =>
    tx.query("insert into public.chat_messages (session_id, role, content) values ($1, $2, $3)", [
      sessionId,
      "user",
      "hello",
    ]),
  );

  await asUser(db, USER_A, (tx) =>
    tx.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [
      "project-assets",
      `${teamId}/${projectId}/a.png`,
      USER_A,
    ]),
  );
}, 120_000);

describe("team workspace and owner-scoped project RLS", () => {
  it("case 1: ensure_team_workspace is idempotent and only one team workspace can exist", async () => {
    const again = firstRow(
      (await db.query<{ id: string }>("select public.ensure_team_workspace($1, $2) as id", [
        USER_M,
        "another name",
      ])).rows,
    ).id;
    expect(again).toBe(teamId);

    expect(
      firstRow(
        (await db.query<{ n: number }>(
          "select count(*)::int as n from public.workspaces where type = 'team'",
        )).rows,
      ).n,
    ).toBe(1);

    const message = await denial(() =>
      db.query(
        "insert into public.workspaces (type, name, owner_user_id) values ('team', 'dup', $1)",
        [USER_O],
      ),
    );
    expect(message).toContain("duplicate key");
    expect(message).toContain("workspaces_single_team_key");
  });

  it("case 2: add_team_member is once-only, keeps roles, and refuses 'owner'", async () => {
    expect(seededAdds).toEqual([true, true, true]);

    const againA = firstRow(
      (await db.query<{ r: boolean }>("select public.add_team_member($1, $2) as r", [
        USER_A,
        "member",
      ])).rows,
    ).r;
    expect(againA).toBe(false);

    const demoteM = firstRow(
      (await db.query<{ r: boolean }>("select public.add_team_member($1, $2) as r", [
        USER_M,
        "member",
      ])).rows,
    ).r;
    expect(demoteM).toBe(false);
    expect(
      firstRow(
        (await db.query<{ role: string }>(
          "select role from public.workspace_members where workspace_id = $1 and user_id = $2",
          [teamId, USER_M],
        )).rows,
      ).role,
    ).toBe("admin");

    const message = await denial(() =>
      db.query("select public.add_team_member($1, $2)", [USER_X, "owner"]),
    );
    expect(message).toContain("role owner is not assignable");

    expect(
      firstRow(
        (await db.query<{ n: number }>(
          "select count(*)::int as n from public.workspace_members where workspace_id = $1 and user_id = $2",
          [teamId, USER_X],
        )).rows,
      ).n,
    ).toBe(0);
  });

  it("case 3: read matrix over 6 identities x 5 tables", async () => {
    const cases: Array<[string, string | null, number[]]> = [
      ["A (project owner, member)", USER_A, [1, 1, 2, 1, 1]],
      ["M (team admin)", USER_M, [1, 1, 2, 1, 1]],
      ["O (team owner)", USER_O, [1, 1, 2, 1, 1]],
      ["B (member, owns nothing)", USER_B, [0, 0, 0, 0, 0]],
      ["X (not in team)", USER_X, [0, 0, 0, 0, 0]],
      ["anon", null, [0, 0, 0, 0, 0]],
    ];

    for (const [label, userId, expected] of cases) {
      const got: number[] = [];
      for (const table of TABLES) got.push(await visibleRows(userId, table));
      expect(got, label).toEqual(expected);
    }
  });

  it("case 4: a member can create their own project, directly and through the RPC", async () => {
    const direct = await asUser(db, USER_B, (tx) =>
      tx.query(
        `insert into public.projects (workspace_id, name, slug, created_by)
         values ($1, $2, $3, $4) returning id`,
        [teamId, "pB", "pb", USER_B],
      ),
    );
    expect(direct.rows.length).toBe(1);

    const viaRpc = firstRow(
      (await asUser(db, USER_B, (tx) =>
        tx.query<{ j: { project: { id: string } } }>(
          "select public.create_project_with_canvas($1, $2, $3) as j",
          [teamId, "pB2", "pb2"],
        ),
      )).rows,
    ).j;
    expect(
      firstRow(
        (await db.query<{ created_by: string }>(
          "select created_by from public.projects where id = $1",
          [viaRpc.project.id],
        )).rows,
      ).created_by,
    ).toBe(USER_B);
  });

  it("case 5: a member cannot create a project for someone else or without created_by", async () => {
    const forged = await denial(() =>
      asUser(db, USER_B, (tx) =>
        tx.query(
          `insert into public.projects (workspace_id, name, slug, created_by)
           values ($1, $2, $3, $4)`,
          [teamId, "pF", "pf", USER_A],
        ),
      ),
    );
    expect(forged).toContain("row-level security");
    expect(forged).not.toContain("permission denied");

    const anonymous = await denial(() =>
      asUser(db, USER_B, (tx) =>
        tx.query("insert into public.projects (workspace_id, name, slug) values ($1, $2, $3)", [
          teamId,
          "pN",
          "pn",
        ]),
      ),
    );
    expect(anonymous).toContain("row-level security");
    expect(anonymous).not.toContain("permission denied");
  });

  it("case 6: a non-member cannot write into the team workspace", async () => {
    const insert = await denial(() =>
      asUser(db, USER_X, (tx) =>
        tx.query(
          `insert into public.projects (workspace_id, name, slug, created_by)
           values ($1, $2, $3, $4)`,
          [teamId, "pX", "px", USER_X],
        ),
      ),
    );
    expect(insert).toContain("row-level security");
    expect(insert).not.toContain("permission denied");

    const rpc = await denial(() =>
      asUser(db, USER_X, (tx) =>
        tx.query("select public.create_project_with_canvas($1, $2, $3)", [
          teamId,
          "pX2",
          "px2",
        ]),
      ),
    );
    expect(rpc).toContain("Not a member of this workspace");
  });

  it("case 7: only the project owner can rename it; admins are read-only (Q2)", async () => {
    const before = await projectName();

    const byB = await asUser(db, USER_B, (tx) =>
      tx.query("update public.projects set name = 'hacked-by-b' where id = $1", [projectId]),
    );
    expect(byB.affectedRows ?? 0).toBe(0);
    expect(await projectName()).toBe(before);

    const byM = await asUser(db, USER_M, (tx) =>
      tx.query("update public.projects set name = 'hacked-by-m' where id = $1", [projectId]),
    );
    expect(byM.affectedRows ?? 0).toBe(0);
    expect(await projectName()).toBe(before);

    const byA = await asUser(db, USER_A, (tx) =>
      tx.query("update public.projects set name = 'pA-renamed' where id = $1", [projectId]),
    );
    expect(byA.affectedRows ?? 0).toBe(1);
    expect(await projectName()).toBe("pA-renamed");
  });

  it("case 8: the owner cannot hand the project to someone else", async () => {
    const message = await denial(() =>
      asUser(db, USER_A, (tx) =>
        tx.query("update public.projects set created_by = $2 where id = $1", [
          projectId,
          USER_B,
        ]),
      ),
    );
    expect(message).toContain("row-level security");
    expect(message).not.toContain("permission denied");
    expect(await projectOwner()).toBe(USER_A);
  });

  it("case 9: child rows follow the project owner, not mere membership", async () => {
    const canvasBefore = await canvasName();

    const canvasInsert = await denial(() =>
      asUser(db, USER_B, (tx) =>
        tx.query("insert into public.canvases (project_id, name, created_by) values ($1, $2, $3)", [
          projectId,
          "c-by-b",
          USER_B,
        ]),
      ),
    );
    expect(canvasInsert).toContain("row-level security");
    expect(canvasInsert).not.toContain("permission denied");

    const messageInsert = await denial(() =>
      asUser(db, USER_B, (tx) =>
        tx.query(
          "insert into public.chat_messages (session_id, role, content) values ($1, $2, $3)",
          [sessionId, "user", "x"],
        ),
      ),
    );
    expect(messageInsert).toContain("row-level security");
    expect(messageInsert).not.toContain("permission denied");

    const assetInsert = await denial(() =>
      asUser(db, USER_B, (tx) =>
        tx.query(
          `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
           values ($1, $2, $3, $4, $5)`,
          [teamId, projectId, "project-assets", `${teamId}/${projectId}/b.png`, USER_B],
        ),
      ),
    );
    expect(assetInsert).toContain("row-level security");
    expect(assetInsert).not.toContain("permission denied");

    const byB = await asUser(db, USER_B, (tx) =>
      tx.query("update public.canvases set name = 'x' where id = $1", [canvasId]),
    );
    expect(byB.affectedRows ?? 0).toBe(0);
    expect(await canvasName()).toBe(canvasBefore);

    const byM = await asUser(db, USER_M, (tx) =>
      tx.query("delete from public.canvases where id = $1", [canvasId]),
    );
    expect(byM.affectedRows ?? 0).toBe(0);
    expect(await canvasName()).not.toBeNull();
  });

  it("case 10: storage writes follow membership and object owner", async () => {
    const bUpload = await asUser(db, USER_B, (tx) =>
      tx.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3) returning id", [
        "project-assets",
        `${teamId}/b.png`,
        USER_B,
      ]),
    );
    expect(bUpload.rows.length).toBe(1);

    const xUpload = await denial(() =>
      asUser(db, USER_X, (tx) =>
        tx.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [
          "project-assets",
          `${teamId}/x.png`,
          USER_X,
        ]),
      ),
    );
    expect(xUpload).toContain("row-level security");
    expect(xUpload).not.toContain("permission denied");

    const aObject = `${teamId}/${projectId}/a.png`;

    const bDeleteA = await asUser(db, USER_B, (tx) =>
      tx.query("delete from storage.objects where name = $1", [aObject]),
    );
    expect(bDeleteA.affectedRows ?? 0).toBe(0);
    expect(await storageObjectCount(aObject)).toBe(1);

    const nullOwned = `${teamId}/generated/g.png`;
    await db.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, null)", [
      "project-assets",
      nullOwned,
    ]);

    const bDeleteNull = await asUser(db, USER_B, (tx) =>
      tx.query("delete from storage.objects where name = $1", [nullOwned]),
    );
    expect(bDeleteNull.affectedRows ?? 0).toBe(0);
    expect(await storageObjectCount(nullOwned)).toBe(1);

    const mDeleteNull = await asUser(db, USER_M, (tx) =>
      tx.query("delete from storage.objects where name = $1", [nullOwned]),
    );
    expect(mDeleteNull.affectedRows ?? 0).toBe(1);

    const aDeleteOwn = await asUser(db, USER_A, (tx) =>
      tx.query("delete from storage.objects where name = $1", [aObject]),
    );
    expect(aDeleteOwn.affectedRows ?? 0).toBe(1);
  });

  it("case 11: the team-management functions are service_role only", async () => {
    const calls: Array<[string, string, unknown[]]> = [
      ["ensure_team_workspace", "select public.ensure_team_workspace($1, $2)", [USER_M, "x"]],
      ["add_team_member", "select public.add_team_member($1, $2)", [USER_X, "member"]],
      ["remove_team_member", "select public.remove_team_member($1, $2)", [USER_X, USER_M]],
    ];

    for (const [label, sql, params] of calls) {
      const message = await denial(() => asUser(db, USER_M, (tx) => tx.query(sql, params)));
      expect(message, label).toContain("permission denied for function");
    }
  });

  it("case 12: removing a member transfers ownership and is idempotent", async () => {
    // 用例 10 把 A 原来的对象删掉了，这里补一个团队前缀下的对象，让 objects=1 可测。
    await db.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [
      "project-assets",
      `${teamId}/${projectId}/a2.png`,
      USER_A,
    ]);

    const byNonAdmin = await denial(() =>
      db.query("select public.remove_team_member($1, $2)", [USER_A, USER_B]),
    );
    expect(byNonAdmin).toContain("actor is not a team admin");

    const ownerTarget = await denial(() =>
      db.query("select public.remove_team_member($1, $2)", [USER_O, USER_M]),
    );
    expect(ownerTarget).toContain("cannot remove the team owner");

    const removed = firstRow(
      (await db.query<{ r: Record<string, number> }>(
        "select public.remove_team_member($1, $2) as r",
        [USER_A, USER_M],
      )).rows,
    ).r;
    expect(removed).toEqual({ projects: 1, assets: 2, objects: 1, removed: 1 });

    const again = firstRow(
      (await db.query<{ r: Record<string, number> }>(
        "select public.remove_team_member($1, $2) as r",
        [USER_A, USER_M],
      )).rows,
    ).r;
    expect(again).toEqual({ projects: 0, assets: 0, objects: 0, removed: 0 });

    expect(
      await countRows(
        USER_A,
        "select count(*)::int as n from public.projects where workspace_id = $1",
        [teamId],
      ),
    ).toBe(0);

    const byM = await asUser(db, USER_M, (tx) =>
      tx.query("update public.projects set name = 'pA-now-owned-by-m' where id = $1", [projectId]),
    );
    expect(byM.affectedRows ?? 0).toBe(1);

    // 工单 4 T0：接手人必须也能删项目内的素材（工单 3 的缺口就在这一行）
    const mDeleteAsset = await asUser(db, USER_M, (tx) =>
      tx.query("delete from public.asset_objects where workspace_id = $1 and project_id = $2", [
        teamId,
        projectId,
      ]),
    );
    expect(mDeleteAsset.affectedRows ?? 0).toBe(1);
  });

  it("case 13: personal workspaces are untouched (Q1 keeps credits per person)", async () => {
    const personalA = await personalWorkspace(USER_A);
    const personalB = await personalWorkspace(USER_B);

    await asUser(db, USER_A, (tx) =>
      tx.query("select public.create_project_with_canvas($1, $2, $3)", [
        personalA,
        "own",
        "own",
      ]),
    );

    expect(
      await countRows(
        USER_B,
        "select count(*)::int as n from public.projects where workspace_id = $1",
        [personalA],
      ),
    ).toBe(0);

    const claimedA = firstRow(
      (await db.query<{ a: boolean }>("select public.claim_daily_credits($1, 50) as a", [
        personalA,
      ])).rows,
    ).a;
    const claimedB = firstRow(
      (await db.query<{ b: boolean }>("select public.claim_daily_credits($1, 50) as b", [
        personalB,
      ])).rows,
    ).b;
    expect([claimedA, claimedB]).toEqual([true, true]);
  });

  it("case 14: the superseded policies are gone", async () => {
    const rows = (
      await db.query<{ policyname: string }>(
        "select policyname from pg_policies where policyname = any(string_to_array($1, ','))",
        [LEGACY_POLICIES.join(",")],
      )
    ).rows;
    expect(rows.map((row) => row.policyname)).toEqual([]);
  });

  it("case 15: storage reads follow asset metadata, not the object path", async () => {
    // This case brings its own objects: case 10 deliberately deletes the shared
    // `a.png` fixture, so reusing it here would measure whatever case 10 left.
    const withMetadata = `${teamId}/${projectId}/read-with-metadata.png`;
    const withoutMetadata = `${teamId}/${projectId}/read-without-metadata.png`;

    for (const name of [withMetadata, withoutMetadata]) {
      await db.query(
        "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)",
        ["project-assets", name, USER_A],
      );
    }
    await db.query(
      `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
       values ($1, $2, 'project-assets', $3, $4)`,
      [teamId, projectId, withMetadata, USER_A],
    );

    const canRead = async (userId: string | null, name: string): Promise<number> =>
      asUser(db, userId, async (tx) =>
        firstRow(
          (
            await tx.query<{ n: number }>(
              "select count(*)::int as n from storage.objects where name = $1",
              [name],
            )
          ).rows,
        ).n,
      );

    // The project's author, a team admin and the team owner may read it.
    expect(await canRead(USER_A, withMetadata)).toBe(1);
    expect(await canRead(USER_M, withMetadata)).toBe(1);
    expect(await canRead(USER_O, withMetadata)).toBe(1);

    // An unrelated member, a non-member and anon may not. The old path-based
    // policy answered 1 for USER_B (a member of the workspace named in the path),
    // which is exactly the leak this replaced.
    expect(await canRead(USER_B, withMetadata)).toBe(0);
    expect(await canRead(USER_X, withMetadata)).toBe(0);
    expect(await canRead(null, withMetadata)).toBe(0);

    // An object with no metadata row is readable only by the person who uploaded
    // it — PostgreSQL checks the RETURNING row of an INSERT against the SELECT
    // policies, so the uploader clause is what keeps `upload` itself working.
    // Nobody else gets in.
    expect(await canRead(USER_A, withoutMetadata)).toBe(1);
    expect(await canRead(USER_B, withoutMetadata)).toBe(0);
    expect(await canRead(USER_X, withoutMetadata)).toBe(0);
    expect(await canRead(null, withoutMetadata)).toBe(0);
  });

  it("case 16: an owner-less object is readable only by the team admin or owner", async () => {
    // 工单13 的第二个已确认例外：`owner is null and is_workspace_admin_or_owner(path 首段)`。
    // 它镜像的是 UPDATE/DELETE 上已有的管理员清理权限 —— 无 owner 的遗留对象如果 SELECT
    // 看不见，DELETE/UPDATE 就匹配不到行，等于永远清不掉。本用例证明这个例外没有顺带
    // 把普通成员或外部用户放进来：它只认工作区管理员/owner，与 metadata 行、与是不是
    // 项目作者都无关。
    //
    // 身份状态提醒：用例 12 已经把 USER_A 移出团队（其项目转给了 USER_M），所以这里
    // USER_A 是「前成员 + 原项目作者」，而「在册普通成员」这一行由 USER_B 承担。
    const ownerless = `${teamId}/generated/ownerless.png`;
    await db.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, null)", [
      "project-assets",
      ownerless,
    ]);

    const canRead = async (userId: string | null): Promise<number> =>
      asUser(db, userId, async (tx) =>
        firstRow(
          (
            await tx.query<{ n: number }>(
              "select count(*)::int as n from storage.objects where name = $1",
              [ownerless],
            )
          ).rows,
        ).n,
      );

    expect(await canRead(USER_M)).toBe(1);
    expect(await canRead(USER_O)).toBe(1);

    // USER_B 在册但只是 member：例外不放宽到普通成员；非成员与 anon 更不行。
    expect(await canRead(USER_B)).toBe(0);
    expect(await canRead(USER_X)).toBe(0);
    expect(await canRead(null)).toBe(0);
    // 原项目作者也不例外：这条路径上的授权只问「是不是管理员/owner」。
    expect(await canRead(USER_A)).toBe(0);
  });
});
