/**
 * Read-only project repository (workorder 20B, ADR-0001 migration step 2b).
 *
 * The three PostgREST reads behind `getProject` and `listProjects` move here:
 * one project by id, the caller's own project list, and the primary canvases of
 * those projects. The interface stays narrow and domain-shaped — no generic
 * `BaseRepository`, no PostgREST-compatible builder — so a caller cannot widen a
 * query it was not given.
 *
 * Access control is part of the SQL, not a side effect of the environment:
 *
 * - every read joins `public.workspace_members` on the caller, so a non-member
 *   can never reach a row;
 * - a project is readable by id only when the caller created it or holds
 *   `admin`/`owner` in its workspace, and only while it is not archived;
 * - the LIST is `created_by = caller` and never widens for admin/owner (PJ-11) —
 *   the team-wide list is not a thing this module can produce;
 * - the canvas read re-joins project and membership and re-applies the same
 *   predicate: feeding it the ids of a previous query is not an authorization.
 *
 * This runs on the PGlite/PostgreSQL path (`withPrivilegedTransaction`), which
 * writes the caller into the transaction settings, so audit trails keep the
 * actor. `app.execution_mode` is a diagnostic label and is never consulted for
 * authorization here — real database privileges are workorder 24's job. The old
 * RLS policies and the HTTP team gate are deliberately NOT relied upon: the
 * database owner bypasses RLS, which is exactly why the predicate has to be in
 * the statement.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter (`$1`, `$2`, `$3`). No id, column name or
 *   table name is ever concatenated into a statement.
 * - `null` / `[]` mean exactly "nothing the caller may read". A connect, SQL,
 *   timeout or row-shape failure throws `ProjectReadError`, whose own message is
 *   fixed text: no SQL, no host, no connection string.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 * - An empty canvas id set answers `[]` without issuing SQL at all.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/** The project columns `getProject` answers with, in the existing DTO shape. */
export type ProjectDetailRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  workspace_id: string;
  brand_kit_id: string | null;
  created_at: string;
  updated_at: string;
};

/** One row of the caller's own project list, including the thumbnail reference. */
export type ProjectListRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  thumbnail_path: string | null;
};

/** The primary canvas of a project. */
export type PrimaryCanvasRow = {
  id: string;
  name: string;
  is_primary: boolean;
  project_id: string;
};

export type ProjectReadRepository = {
  findReadableProject(input: {
    actorId: string;
    projectId: string;
  }): Promise<ProjectDetailRow | null>;
  listOwnProjects(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<ProjectListRow[]>;
  listReadablePrimaryCanvases(input: {
    actorId: string;
    workspaceId: string;
    projectIds: readonly string[];
  }): Promise<PrimaryCanvasRow[]>;
};

export const FIND_READABLE_PROJECT = "findReadableProject";
export const LIST_OWN_PROJECTS = "listOwnProjects";
export const LIST_READABLE_PRIMARY_CANVASES = "listReadablePrimaryCanvases";

export type ProjectReadOperation =
  | typeof FIND_READABLE_PROJECT
  | typeof LIST_OWN_PROJECTS
  | typeof LIST_READABLE_PRIMARY_CANVASES;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ProjectReadError extends Error {
  readonly operation: ProjectReadOperation;

  constructor(operation: ProjectReadOperation, cause: unknown) {
    super(
      `project read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "ProjectReadError";
    this.operation = operation;
  }
}

/**
 * One project by id, readable by the caller.
 *
 * `$1` is the actor and is used twice on purpose: once to require a membership
 * row in the project's workspace, once to recognise the author. `admin`/`owner`
 * widen the id read only (matrix row 2/3 of the ACL contract), never the list.
 * A duplicate row is impossible (membership is keyed by workspace + user), so a
 * second row means the SQL and this module disagree and the caller fails loud.
 */
const READABLE_PROJECT_SQL = `
select
  p.id as id,
  p.name as name,
  p.slug as slug,
  p.description as description,
  p.workspace_id as workspace_id,
  p.brand_kit_id as brand_kit_id,
  p.created_at as created_at,
  p.updated_at as updated_at
from public.projects as p
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where p.id = $2
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
`;

/**
 * The caller's own projects in one workspace (PJ-11). Membership is required,
 * the workspace is pinned, the author is the caller and archived rows are gone.
 * `admin`/`owner` are NOT special-cased here: an administrator's list would
 * otherwise mix in everyone else's projects.
 */
const OWN_PROJECTS_SQL = `
select
  p.id as id,
  p.name as name,
  p.slug as slug,
  p.description as description,
  p.created_at as created_at,
  p.updated_at as updated_at,
  p.workspace_id as workspace_id,
  p.thumbnail_path as thumbnail_path
from public.projects as p
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where p.workspace_id = $2
  and p.created_by = $1
  and p.archived_at is null
order by p.updated_at desc
`;

/**
 * Primary canvases of the requested projects that the caller may read.
 *
 * The ids come from the list query above, but they are treated as untrusted
 * input: the statement re-joins `projects` and `workspace_members` and applies
 * the same membership + author/admin/owner + not-archived predicate, so passing
 * a foreign id returns nothing. The array is bound as a single `uuid[]`
 * parameter; an empty array never reaches SQL (see the implementation).
 */
const READABLE_PRIMARY_CANVASES_SQL = `
select
  c.id as id,
  c.name as name,
  c.is_primary as is_primary,
  c.project_id as project_id
from public.canvases as c
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where p.workspace_id = $2
  and c.project_id = any($3::uuid[])
  and c.is_primary = true
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `ProjectReadError` on an actual read.
 */
export function createProjectReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ProjectReadRepository {
  async function readRows<T>(
    operation: ProjectReadOperation,
    actorId: string,
    sql: string,
    params: readonly unknown[],
    map: (row: Readonly<Record<string, unknown>>) => T,
  ): Promise<T[]> {
    try {
      const pool = options.getTransactionPool();

      const rows = await withPrivilegedTransaction(
        pool,
        { userId: actorId },
        async (client) => {
          const result = await client.query(sql, params);
          return result.rows;
        },
      );

      return rows.map((row) => map(asRow(row)));
    } catch (error) {
      throw new ProjectReadError(operation, error);
    }
  }

  async function readOne<T>(
    operation: ProjectReadOperation,
    actorId: string,
    sql: string,
    params: readonly unknown[],
    map: (row: Readonly<Record<string, unknown>>) => T,
  ): Promise<T | null> {
    const rows = await readRows(operation, actorId, sql, params, map);

    if (rows.length > 1) {
      throw new ProjectReadError(
        operation,
        new Error("project read returned more than one row"),
      );
    }

    return rows[0] ?? null;
  }

  return {
    findReadableProject({ actorId, projectId }) {
      return readOne(
        FIND_READABLE_PROJECT,
        actorId,
        READABLE_PROJECT_SQL,
        [actorId, projectId],
        mapProjectDetail,
      );
    },
    listOwnProjects({ actorId, workspaceId }) {
      return readRows(
        LIST_OWN_PROJECTS,
        actorId,
        OWN_PROJECTS_SQL,
        [actorId, workspaceId],
        mapProjectList,
      );
    },
    listReadablePrimaryCanvases({ actorId, workspaceId, projectIds }) {
      // "No ids" is not a query that returns nothing, it is the answer: skip the
      // pool entirely so an empty set cannot open a connection or a transaction.
      if (projectIds.length === 0) return Promise.resolve([]);

      return readRows(
        LIST_READABLE_PRIMARY_CANVASES,
        actorId,
        READABLE_PRIMARY_CANVASES_SQL,
        [actorId, workspaceId, [...projectIds]],
        mapPrimaryCanvas,
      );
    },
  };
}

function mapProjectDetail(
  row: Readonly<Record<string, unknown>>,
): ProjectDetailRow {
  return {
    id: requireString(row, "id"),
    name: requireString(row, "name"),
    slug: requireString(row, "slug"),
    description: optionalString(row, "description"),
    workspace_id: requireString(row, "workspace_id"),
    brand_kit_id: optionalString(row, "brand_kit_id"),
    created_at: requireTimestamp(row, "created_at"),
    updated_at: requireTimestamp(row, "updated_at"),
  };
}

function mapProjectList(row: Readonly<Record<string, unknown>>): ProjectListRow {
  return {
    id: requireString(row, "id"),
    name: requireString(row, "name"),
    slug: requireString(row, "slug"),
    description: optionalString(row, "description"),
    created_at: requireTimestamp(row, "created_at"),
    updated_at: requireTimestamp(row, "updated_at"),
    workspace_id: requireString(row, "workspace_id"),
    thumbnail_path: optionalString(row, "thumbnail_path"),
  };
}

function mapPrimaryCanvas(
  row: Readonly<Record<string, unknown>>,
): PrimaryCanvasRow {
  return {
    id: requireString(row, "id"),
    name: requireString(row, "name"),
    is_primary: requireBoolean(row, "is_primary"),
    project_id: requireString(row, "project_id"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`project read returned no usable "${field}"`);
  }

  return value;
}

function optionalString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "string") {
    throw new Error(`project read returned an unusable "${field}"`);
  }

  return value;
}

function requireBoolean(
  row: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`project read returned an unusable "${field}"`);
  }

  return value;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the HTTP DTO
 * (`timestampSchema`) is a string with an offset. Both are accepted and
 * normalised, anything else fails loud — a null timestamp would silently become
 * a project the client cannot render.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`project read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`project read returned no usable "${field}"`);
}
