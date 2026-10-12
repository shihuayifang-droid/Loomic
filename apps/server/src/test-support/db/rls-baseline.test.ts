import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createMigratedDb, createUser } from "./pglite-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";

const CONTENT_TABLES = [
  "projects",
  "canvases",
  "asset_objects",
  "chat_sessions",
  "chat_messages",
] as const;

let db: PGlite;
let applied: string[] = [];
let workspaceA = "";

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** Row count for `table` as seen through RLS by `userId` (null = anon). */
async function visibleRows(userId: string | null, table: string): Promise<number> {
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ n: number }>(
      `select count(*)::int as n from public.${table}`,
    );
    return firstRow(result.rows).n;
  });
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  applied = created.applied;

  await createUser(db, USER_A, "a@hahart.test");
  await createUser(db, USER_B, "b@hahart.test");

  const workspace = await db.query<{ id: string }>(
    "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
    [USER_A],
  );
  workspaceA = firstRow(workspace.rows).id;

  const project = await db.query<{ id: string }>(
    `insert into public.projects (workspace_id, name, slug, created_by)
     values ($1, $2, $3, $4) returning id`,
    [workspaceA, "Project A", "project-a", USER_A],
  );
  const projectA = firstRow(project.rows).id;

  const canvas = await db.query<{ id: string }>(
    "insert into public.canvases (project_id, name, created_by) values ($1, $2, $3) returning id",
    [projectA, "Canvas A", USER_A],
  );
  const canvasA = firstRow(canvas.rows).id;

  const session = await db.query<{ id: string }>(
    "insert into public.chat_sessions (canvas_id, created_by) values ($1, $2) returning id",
    [canvasA, USER_A],
  );
  const sessionA = firstRow(session.rows).id;

  await db.query(
    `insert into public.asset_objects (workspace_id, project_id, bucket, object_path, created_by)
     values ($1, $2, $3, $4, $5)`,
    [workspaceA, projectA, "project-assets", `${workspaceA}/${projectA}/a.png`, USER_A],
  );

  await db.query(
    "insert into public.chat_messages (session_id, role, content) values ($1, $2, $3)",
    [sessionA, "user", "hello"],
  );
}, 120_000);

describe("migration harness", () => {
  it("loads every migration in supabase/migrations", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
    expect(applied.length).toBe(37);
    expect(applied.length).toBe(files.length);
  });

  it("signup creates exactly one personal workspace with an owner membership", async () => {
    const workspaces = await db.query<{ id: string }>(
      "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
      [USER_A],
    );
    expect(workspaces.rows.length).toBe(1);
    expect(firstRow(workspaces.rows).id).toBe(workspaceA);

    const membership = await db.query<{ role: string }>(
      "select role from public.workspace_members where workspace_id = $1 and user_id = $2",
      [workspaceA, USER_A],
    );
    expect(membership.rows.length).toBe(1);
    expect(firstRow(membership.rows).role).toBe("owner");
  });

  it("RLS is enforced: the owner sees the project, a stranger sees none", async () => {
    expect(await visibleRows(USER_A, "projects")).toBe(1);
    expect(await visibleRows(USER_B, "projects")).toBe(0);
  });

  it("an anonymous request sees no projects", async () => {
    expect(await visibleRows(null, "projects")).toBe(0);
  });
});

describe("a member of workspace A", () => {
  beforeAll(async () => {
    await db.query(
      "insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [workspaceA, USER_B],
    );
  });

  for (const table of CONTENT_TABLES) {
    it(`FIXED: cannot read another member's ${table}`, async () => {
      expect(await visibleRows(USER_B, table)).toBe(0);
    });
  }

  it("FIXED: can create their own project by direct insert", async () => {
    const inserted = await asUser(db, USER_B, (tx) =>
      tx.query(
        `insert into public.projects (workspace_id, name, slug, created_by)
         values ($1, $2, $3, $4) returning id`,
        [workspaceA, "Project B", "project-b", USER_B],
      ),
    );

    expect(inserted.rows.length).toBe(1);
  });

  it("FIXED: can create their own project through create_project_with_canvas", async () => {
    const created = await asUser(db, USER_B, (tx) =>
      tx.query<{ j: { project: { id: string } } }>(
        "select public.create_project_with_canvas($1, $2, $3) as j",
        [workspaceA, "Project B2", "project-b2"],
      ),
    );

    expect(created.rows.length).toBe(1);
  });

  it("FIXED: can upload a storage object under the workspace prefix", async () => {
    const uploaded = await asUser(db, USER_B, (tx) =>
      tx.query(
        "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3) returning id",
        ["project-assets", `${workspaceA}/x.png`, USER_B],
      ),
    );

    expect(uploaded.rows.length).toBe(1);
  });
});

describe("daily credits", () => {
  it("credits stay on the personal workspace (Q1): one claim per workspace per day", async () => {
    const first = await db.query<{ claimed: boolean }>(
      "select public.claim_daily_credits($1, $2) as claimed",
      [workspaceA, 50],
    );
    expect(firstRow(first.rows).claimed).toBe(true);

    const second = await db.query<{ claimed: boolean }>(
      "select public.claim_daily_credits($1, $2) as claimed",
      [workspaceA, 50],
    );
    expect(firstRow(second.rows).claimed).toBe(false);
  });
});
