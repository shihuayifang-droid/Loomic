/**
 * Project creation as repository SQL (workorder 44O, migration plan 25, T-129).
 *
 * This is the server-side replacement for the database function that used to
 * create a project and its primary canvas from the caller's own session. That
 * function read the caller from the session and called a private membership
 * helper; neither exists in the canonical schema, so the actor is an explicit
 * argument here and the membership rule is the first statement's own predicate.
 *
 * Behaviour is kept one-to-one with the removed function:
 *
 * - The actor must have a row in `workspace_members` for the workspace, else the
 *   error carries SQLSTATE 42501 ("Not a member of this workspace").
 * - The project row carries `created_by = actor`; the canvas is the primary one
 *   and carries `created_by = actor` too.
 * - There is NO slug conflict handling. A duplicate (workspace, slug) pair fails
 *   with SQLSTATE 23505 from the unique key and the caller maps it.
 * - The return value has exactly the shape the function returned, produced by one
 *   `jsonb_build_object` so timestamps stay jsonb-serialised strings.
 *
 * Everything runs in ONE transaction: any failing step rolls the whole creation
 * back, so a failed call never leaves an orphan project. Database errors are
 * thrown as they came (their `code` is preserved).
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type CreatedProjectRow = {
  project: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    created_at: string;
    updated_at: string;
    workspace_id: string;
  };
  canvas: {
    id: string;
    name: string;
    is_primary: boolean;
  };
};

export type ProjectCreateRepository = {
  createProjectWithCanvas(input: {
    actorId: string;
    workspaceId: string;
    name: string;
    slug: string;
    description: string | null;
    canvasName: string;
  }): Promise<CreatedProjectRow>;
};

const MEMBER_CHECK_SQL =
  "select 1 as ok from public.workspace_members where workspace_id = $1::uuid and user_id = $2::uuid";

const INSERT_PROJECT_SQL =
  `insert into public.projects (workspace_id, name, slug, description, created_by)
   values ($1::uuid, $2::text, $3::text, $4::text, $5::uuid)
   returning id`;

const INSERT_CANVAS_SQL =
  `insert into public.canvases (project_id, name, is_primary, created_by)
   values ($1::uuid, $2::text, true, $3::uuid)
   returning id`;

const RESULT_SQL =
  `select jsonb_build_object(
            'project', jsonb_build_object(
              'id', p.id,
              'name', p.name,
              'slug', p.slug,
              'description', p.description,
              'created_at', p.created_at,
              'updated_at', p.updated_at,
              'workspace_id', p.workspace_id),
            'canvas', jsonb_build_object(
              'id', c.id,
              'name', c.name,
              'is_primary', c.is_primary)) as r
     from public.projects p
     join public.canvases c on c.id = $2::uuid
    where p.id = $1::uuid`;

function firstRow(rows: readonly unknown[], what: string): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined || row === null || typeof row !== "object") {
    throw new Error(`project create: expected one row from ${what}`);
  }
  return row as Record<string, unknown>;
}

export function createProjectCreateRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ProjectCreateRepository {
  return {
    async createProjectWithCanvas(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: input.actorId },
        async (client) => {
          const member = await client.query(MEMBER_CHECK_SQL, [
            input.workspaceId,
            input.actorId,
          ]);
          if (member.rows.length === 0) {
            throw Object.assign(new Error("Not a member of this workspace"), {
              code: "42501",
            });
          }

          const project = await client.query(INSERT_PROJECT_SQL, [
            input.workspaceId,
            input.name,
            input.slug,
            input.description,
            input.actorId,
          ]);
          const projectId = firstRow(project.rows, "project insert").id;

          const canvas = await client.query(INSERT_CANVAS_SQL, [
            projectId,
            input.canvasName,
            input.actorId,
          ]);
          const canvasId = firstRow(canvas.rows, "canvas insert").id;

          const result = await client.query(RESULT_SQL, [projectId, canvasId]);
          let value = firstRow(result.rows, "result select").r;
          if (typeof value === "string") value = JSON.parse(value);
          return value as CreatedProjectRow;
        },
      );
    },
  };
}
