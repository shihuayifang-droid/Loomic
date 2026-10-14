/**
 * Read-only canvas repository (workorder 20C, ADR-0001 migration step 2c).
 *
 * Three PostgREST reads move here:
 *
 * 1. the Agent's automatic canvas summary (`canvases.select("content")`),
 * 2. the recovery list (`background_jobs` filtered to succeeded image jobs of
 *    one canvas),
 * 3. the canvas read projection that reports the real `assetId` of every
 *    `oss://` marker (`asset_objects` by exact `(bucket, object_path)`).
 *
 * Access control is part of the SQL, not a side effect of the environment. A
 * canvas inherits its project's ACL (see `docs/项目/hahart/01-架构设计/内容读取ACL契约.md`):
 * every read walks `canvas → project → workspace_members` and requires
 *
 * - a membership row for the caller in the project's workspace,
 * - the project not archived, and
 * - the caller is the project author or holds `admin`/`owner`.
 *
 * A plain member who is not the author, a non-member, an archived project and a
 * missing canvas are all the same answer: `null` for the content read, `[]` for
 * the list reads. The HTTP team gate is deliberately NOT relied upon, and neither
 * are the old RLS policies: the database owner bypasses RLS, which is exactly why
 * the predicate has to be in the statement.
 *
 * The two child reads re-derive the ACL from their own path rather than trusting
 * an id they were handed:
 *
 * - jobs go through `background_jobs.canvas_id → canvases.project_id`;
 * - assets must belong to the canvas's project (`asset_objects.project_id =
 *   canvas.project_id`) AND match a requested `(bucket, object_path)` pair
 *   exactly. A legacy row with a null `project_id` therefore never answers, and
 *   ownership is never guessed from the object key.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter. `refs` are bound as two parallel `text[]`
 *   arrays joined with `unnest`, never concatenated into the statement, and
 *   never widened into a bucket-set × path-set product.
 * - An empty ref list answers `[]` without issuing SQL at all.
 * - `null` / `[]` mean exactly "nothing the caller may read". A connect, SQL,
 *   timeout or row-shape failure throws `CanvasReadError`, whose own message is
 *   fixed text: no SQL, no host, no connection string.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 * - `app.execution_mode` is a diagnostic label and is never consulted for
 *   authorization; the transaction still carries the actor.
 */

import type { CanvasContent } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/** One succeeded image job, in the shape the recovery list consumes. */
export type CanvasRecoveryJobRow = {
  id: string;
  created_at: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

/** One `oss://` marker: the bucket and the object key, never either alone. */
export type CanvasAssetRef = { bucket: string; objectPath: string };

/** The identity the browser needs for an object it is already displaying. */
export type CanvasAssetIdentityRow = {
  id: string;
  bucket: string;
  object_path: string;
};

export type CanvasReadRepository = {
  findReadableCanvasContent(input: {
    actorId: string;
    canvasId: string;
  }): Promise<{ content: CanvasContent | null } | null>;
  listReadableSucceededImageJobs(input: {
    actorId: string;
    canvasId: string;
  }): Promise<CanvasRecoveryJobRow[]>;
  listReadableCanvasAssets(input: {
    actorId: string;
    canvasId: string;
    refs: readonly CanvasAssetRef[];
  }): Promise<CanvasAssetIdentityRow[]>;
};

export const FIND_READABLE_CANVAS_CONTENT = "findReadableCanvasContent";
export const LIST_READABLE_SUCCEEDED_IMAGE_JOBS =
  "listReadableSucceededImageJobs";
export const LIST_READABLE_CANVAS_ASSETS = "listReadableCanvasAssets";

export type CanvasReadOperation =
  | typeof FIND_READABLE_CANVAS_CONTENT
  | typeof LIST_READABLE_SUCCEEDED_IMAGE_JOBS
  | typeof LIST_READABLE_CANVAS_ASSETS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class CanvasReadError extends Error {
  readonly operation: CanvasReadOperation;

  constructor(operation: CanvasReadOperation, cause: unknown) {
    super(
      `canvas read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "CanvasReadError";
    this.operation = operation;
  }
}

/**
 * The canvas content, readable by the caller.
 *
 * `$1` is the actor and is used twice on purpose: once to require a membership
 * row in the project's workspace, once to recognise the author. `admin`/`owner`
 * widen the read exactly as they do for a project by id.
 */
const READABLE_CANVAS_CONTENT_SQL = `
select
  c.content as content
from public.canvases as c
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where c.id = $2
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
`;

/**
 * Succeeded image jobs of one canvas, oldest first.
 *
 * The ACL is re-applied through the canvas the job names, not through the job's
 * own `workspace_id`: a job records the PERSONAL billing workspace (Q1), which
 * is the wrong workspace to authorise a team canvas against. Videos are excluded
 * here for the same reason canvas-recovery.ts explains — the caller needs images.
 */
const READABLE_SUCCEEDED_IMAGE_JOBS_SQL = `
select
  j.id as id,
  j.created_at as created_at,
  j.payload as payload,
  j.result as result
from public.background_jobs as j
join public.canvases as c
  on c.id = j.canvas_id
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where j.canvas_id = $2
  and j.status = 'succeeded'
  and j.job_type = 'image_generation'
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
order by j.created_at asc
`;

/**
 * Asset identities for exact `(bucket, object_path)` pairs of one canvas.
 *
 * The pair list is bound as two parallel arrays and joined with `unnest`, so a
 * value can never be concatenated and the predicate is an exact pair — no
 * bucket-set × path-set product, which would let an object of the same name in
 * another bucket answer for this one.
 *
 * `a.project_id = p.id` (with `p` the canvas's own project) is the ownership
 * proof: a row whose `project_id` is null, or belongs to some other project, is
 * not this canvas's asset. The object key is never parsed to guess an owner.
 */
const READABLE_CANVAS_ASSETS_SQL = `
select
  a.id as id,
  a.bucket as bucket,
  a.object_path as object_path
from public.canvases as c
join public.projects as p
  on p.id = c.project_id
join public.asset_objects as a
  on a.project_id = p.id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
join unnest($3::text[], $4::text[]) as r(bucket, object_path)
  on r.bucket = a.bucket
 and r.object_path = a.object_path
where c.id = $2
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `CanvasReadError` on an actual read.
 */
export function createCanvasReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): CanvasReadRepository {
  async function readRows<T>(
    operation: CanvasReadOperation,
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
      throw new CanvasReadError(operation, error);
    }
  }

  return {
    async findReadableCanvasContent({ actorId, canvasId }) {
      const rows = await readRows(
        FIND_READABLE_CANVAS_CONTENT,
        actorId,
        READABLE_CANVAS_CONTENT_SQL,
        [actorId, canvasId],
        mapCanvasContent,
      );

      // One canvas id is one row (it is the primary key); a second row means the
      // SQL and this module disagree, and a caller must not have to guess which
      // one is the canvas.
      if (rows.length > 1) {
        throw new CanvasReadError(
          FIND_READABLE_CANVAS_CONTENT,
          new Error("canvas read returned more than one row"),
        );
      }

      return rows[0] ?? null;
    },

    listReadableSucceededImageJobs({ actorId, canvasId }) {
      return readRows(
        LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
        actorId,
        READABLE_SUCCEEDED_IMAGE_JOBS_SQL,
        [actorId, canvasId],
        mapRecoveryJob,
      );
    },

    async listReadableCanvasAssets({ actorId, canvasId, refs }) {
      // "No refs" is not a query that returns nothing, it is the answer: skip the
      // pool entirely so an empty set cannot open a connection or a transaction.
      if (refs.length === 0) return [];

      const pairs = dedupeRefs(LIST_READABLE_CANVAS_ASSETS, refs);
      if (pairs.buckets.length === 0) return [];

      const rows = await readRows(
        LIST_READABLE_CANVAS_ASSETS,
        actorId,
        READABLE_CANVAS_ASSETS_SQL,
        [actorId, canvasId, pairs.buckets, pairs.paths],
        mapAssetIdentity,
      );

      return assertNoDuplicatePairs(LIST_READABLE_CANVAS_ASSETS, rows);
    },
  };
}

/**
 * A pair is only a lookup key when both halves are real strings. Sending a
 * half-empty pair would either match nothing or, worse, match a different
 * object, so it fails loud instead — the caller filters what it cannot form, it
 * does not get to send it. Every method here is `async`, so this arrives as a
 * rejection rather than a synchronous throw out of a promise-returning call.
 */
function dedupeRefs(
  operation: CanvasReadOperation,
  refs: readonly CanvasAssetRef[],
): { buckets: string[]; paths: string[] } {
  const buckets: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const bucket = ref?.bucket;
    const objectPath = ref?.objectPath;

    if (
      typeof bucket !== "string" ||
      bucket.length === 0 ||
      typeof objectPath !== "string" ||
      objectPath.length === 0
    ) {
      throw new CanvasReadError(
        operation,
        new Error("canvas asset ref needs a non-empty bucket and objectPath"),
      );
    }

    // The pair — not the path alone — identifies an object, so the dedupe key
    // carries both halves. Duplicates would otherwise duplicate result rows.
    const key = `${bucket}\u0000${objectPath}`;
    if (seen.has(key)) continue;

    seen.add(key);
    buckets.push(bucket);
    paths.push(objectPath);
  }

  return { buckets, paths };
}

/** `(bucket, object_path)` is unique in the table; two rows for one pair is a bug. */
function assertNoDuplicatePairs(
  operation: CanvasReadOperation,
  rows: readonly CanvasAssetIdentityRow[],
): CanvasAssetIdentityRow[] {
  const seen = new Set<string>();

  for (const row of rows) {
    const key = `${row.bucket}\u0000${row.object_path}`;
    if (seen.has(key)) {
      throw new CanvasReadError(
        operation,
        new Error("canvas asset read returned a duplicate pair"),
      );
    }
    seen.add(key);
  }

  return [...rows];
}

function mapCanvasContent(
  row: Readonly<Record<string, unknown>>,
): { content: CanvasContent | null } {
  const value = row["content"];

  if (value === null || value === undefined) return { content: null };

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error('canvas read returned an unusable "content"');
  }

  return { content: value as CanvasContent };
}

function mapRecoveryJob(
  row: Readonly<Record<string, unknown>>,
): CanvasRecoveryJobRow {
  return {
    id: requireString(row, "id"),
    created_at: requireTimestamp(row, "created_at"),
    payload: optionalJsonObject(row, "payload"),
    result: optionalJsonObject(row, "result"),
  };
}

function mapAssetIdentity(
  row: Readonly<Record<string, unknown>>,
): CanvasAssetIdentityRow {
  return {
    id: requireString(row, "id"),
    bucket: requireString(row, "bucket"),
    object_path: requireString(row, "object_path"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("canvas read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`canvas read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `jsonb` arrives as a parsed object from both drivers; a JSON `null` arrives as
 * SQL NULL. Anything else (an array, a scalar) is not the record this module
 * promises its callers, so it fails loud instead of being passed along.
 */
function optionalJsonObject(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`canvas read returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; `RecoverableArtifact.createdAt`
 * is a string. Both are accepted and normalised, anything else fails loud.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`canvas read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`canvas read returned no usable "${field}"`);
}
