/**
 * Read-only chat repository (workorder 20D, ADR-0001 migration step 2d).
 *
 * Four PostgREST reads move here:
 *
 * 1. the session list of one canvas (`chat_sessions.select("id, title, updated_at")`),
 * 2. the message history of one session (`chat_messages.select(...)`),
 * 3. the asset identities behind a message's blocks (`asset_objects.id/object_path/bucket`),
 * 4. the thread binding of one session (`chat_sessions.select("id, thread_id")`).
 *
 * Access control is part of the SQL, not a side effect of the environment. A
 * session inherits its canvas's project ACL and a message inherits it through
 * its session (see `docs/项目/hahart/01-架构设计/内容读取ACL契约.md`): every read
 * walks `session → canvas → project → workspace_members` and requires
 *
 * - a membership row for the caller in the project's workspace,
 * - the project not archived, and
 * - the caller is the project author or holds `admin`/`owner`.
 *
 * The HTTP team gate is deliberately NOT relied upon, and neither are the old
 * RLS policies: the database owner bypasses RLS, which is exactly why the
 * predicate has to be in the statement. `app.execution_mode` is a diagnostic
 * label and is never consulted for authorization; the transaction still carries
 * the actor.
 *
 * `null` and `[]` are different answers and must stay different:
 *
 * - `null` — the parent canvas/session does not exist, is archived, or the
 *   caller may not read it. The caller turns that into a 404.
 * - `[]` — the parent IS readable and simply has no child rows yet. The caller
 *   turns that into a 200 with an empty list.
 *
 * That is why the two list statements are a readable-parent CTE LEFT JOINed to
 * the child table: the CTE row survives with a null child, so "readable but
 * empty" is observable instead of collapsing into "nothing".
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter; ids are bound as a `uuid[]` and joined with
 *   `unnest`, never concatenated into the statement.
 * - An empty id list answers `[]` without issuing SQL at all.
 * - The asset read proves ownership from the session's project:
 *   `asset_objects.project_id = <project>` AND the id must be in the bound list.
 *   A foreign project's asset, a row with a null `project_id` and a missing id
 *   all never answer.
 * - A connect, SQL, timeout or row-shape failure throws `ChatReadError`, whose
 *   own message is fixed text: no SQL, no host, no connection string.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/** One session of a canvas, in the shape the session list consumes. */
export type ChatSessionReadRow = {
  id: string;
  title: string;
  updated_at: string;
};

/** One message of a session, in the shape the history read consumes. */
export type ChatMessageReadRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_activities: unknown[] | null;
  content_blocks: unknown[] | null;
  created_at: string;
};

/** The identity the browser needs for an object a message already names. */
export type ChatAssetReadRow = {
  id: string;
  object_path: string;
  bucket: string;
};

export type ChatReadRepository = {
  listReadableSessions(input: {
    actorId: string;
    canvasId: string;
  }): Promise<ChatSessionReadRow[] | null>;
  listReadableMessages(input: {
    actorId: string;
    sessionId: string;
  }): Promise<ChatMessageReadRow[] | null>;
  listReadableSessionAssets(input: {
    actorId: string;
    sessionId: string;
    assetIds: readonly string[];
  }): Promise<ChatAssetReadRow[]>;
  findReadableSessionThread(input: {
    actorId: string;
    sessionId: string;
  }): Promise<{ id: string; threadId: string | null } | null>;
};

export const LIST_READABLE_SESSIONS = "listReadableSessions";
export const LIST_READABLE_MESSAGES = "listReadableMessages";
export const LIST_READABLE_SESSION_ASSETS = "listReadableSessionAssets";
export const FIND_READABLE_SESSION_THREAD = "findReadableSessionThread";

export type ChatReadOperation =
  | typeof LIST_READABLE_SESSIONS
  | typeof LIST_READABLE_MESSAGES
  | typeof LIST_READABLE_SESSION_ASSETS
  | typeof FIND_READABLE_SESSION_THREAD;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ChatReadError extends Error {
  readonly operation: ChatReadOperation;

  constructor(operation: ChatReadOperation, cause: unknown) {
    super(`chat read failed (${operation})`, cause === undefined ? {} : { cause });
    this.name = "ChatReadError";
    this.operation = operation;
  }
}

/**
 * Sessions of one readable canvas, most recently updated first.
 *
 * `$1` is the actor and is used twice on purpose: once to require a membership
 * row in the project's workspace, once to recognise the author. `admin`/`owner`
 * widen the read exactly as they do for a project by id.
 *
 * The readable-parent CTE is what keeps "no sessions yet" (`[]`) apart from "no
 * readable canvas" (`null`): the LEFT JOIN yields one all-null child row in the
 * first case and no row at all in the second.
 */
const READABLE_SESSIONS_SQL = `
with readable_parent as (
  select
    c.id as parent_id
  from public.canvases as c
  join public.projects as p
    on p.id = c.project_id
  join public.workspace_members as m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1
  where c.id = $2
    and p.archived_at is null
    and (p.created_by = $1 or m.role in ('admin', 'owner'))
)
select
  rp.parent_id as parent_id,
  s.id as id,
  s.title as title,
  s.updated_at as updated_at
from readable_parent as rp
left join public.chat_sessions as s
  on s.canvas_id = rp.parent_id
order by s.updated_at desc
`;

/**
 * Messages of one readable session, oldest first.
 *
 * The ACL is re-derived through the session's own canvas and project rather
 * than trusting the session id that was handed in.
 */
const READABLE_MESSAGES_SQL = `
with readable_parent as (
  select
    s.id as parent_id
  from public.chat_sessions as s
  join public.canvases as c
    on c.id = s.canvas_id
  join public.projects as p
    on p.id = c.project_id
  join public.workspace_members as m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1
  where s.id = $2
    and p.archived_at is null
    and (p.created_by = $1 or m.role in ('admin', 'owner'))
)
select
  rp.parent_id as parent_id,
  msg.id as id,
  msg.role as role,
  msg.content as content,
  msg.tool_activities as tool_activities,
  msg.content_blocks as content_blocks,
  msg.created_at as created_at
from readable_parent as rp
left join public.chat_messages as msg
  on msg.session_id = rp.parent_id
order by msg.created_at asc
`;

/**
 * Asset identities for exact ids, restricted to the session's own project.
 *
 * `a.project_id = rp.project_id` (with `rp` the session's own project) is the
 * ownership proof: a row whose `project_id` is null, or belongs to some other
 * project, is not this session's asset. The object key is never parsed to guess
 * an owner, and the ids are bound as one `uuid[]` — a value can never be
 * concatenated into the statement, and a non-uuid fails as a real SQL error
 * instead of matching something else.
 */
const READABLE_SESSION_ASSETS_SQL = `
with readable_parent as (
  select
    p.id as project_id
  from public.chat_sessions as s
  join public.canvases as c
    on c.id = s.canvas_id
  join public.projects as p
    on p.id = c.project_id
  join public.workspace_members as m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1
  where s.id = $2
    and p.archived_at is null
    and (p.created_by = $1 or m.role in ('admin', 'owner'))
)
select
  a.id as id,
  a.object_path as object_path,
  a.bucket as bucket
from readable_parent as rp
join public.asset_objects as a
  on a.project_id = rp.project_id
join unnest($3::uuid[]) as r(id)
  on r.id = a.id
order by a.id
`;

/**
 * The thread binding of one readable session.
 *
 * `thread_id` is nullable by design (legacy sessions predate it), so a null here
 * is a real answer and not a missing row: the caller decides 404 versus 409.
 */
const READABLE_SESSION_THREAD_SQL = `
select
  s.id as id,
  s.thread_id as thread_id
from public.chat_sessions as s
join public.canvases as c
  on c.id = s.canvas_id
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1
where s.id = $2
  and p.archived_at is null
  and (p.created_by = $1 or m.role in ('admin', 'owner'))
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `ChatReadError` on an actual read.
 */
export function createChatReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ChatReadRepository {
  async function readRows<T>(
    operation: ChatReadOperation,
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

      // Mapping runs inside the same guard as the query: a row that is not the
      // shape this module promises is a read failure, not an exception the
      // caller has to interpret.
      return rows.map((row) => map(asRow(row)));
    } catch (error) {
      throw new ChatReadError(operation, error);
    }
  }

  /**
   * Read a parent-scoped list, preserving the difference between "the parent is
   * not readable" and "the parent is readable and empty".
   *
   * Zero rows means the CTE matched nothing. One or more rows means the parent
   * proved readable; a null child id in one of them is the LEFT JOIN's miss and
   * simply contributes no child.
   */
  async function readParentScoped<T extends { id: string }>(
    operation: ChatReadOperation,
    actorId: string,
    sql: string,
    params: readonly unknown[],
    map: (row: Readonly<Record<string, unknown>>) => T,
  ): Promise<T[] | null> {
    const rows = await readRows(operation, actorId, sql, params, (row) => row);
    if (rows.length === 0) return null;

    try {
      const mapped: T[] = [];
      const seen = new Set<string>();

      for (const row of rows) {
        // Every row of the LEFT JOIN carries the CTE's id; if it is not there the
        // SQL and this module disagree about what was selected.
        requireText(row, "parent_id", operation);

        const childId = row["id"];
        if (childId === null || childId === undefined) continue;

        const entry = map(row);

        // The child id is a primary key, so a second row for one id means the
        // statement and this module disagree: failing loud beats letting one row
        // silently win.
        if (seen.has(entry.id)) {
          throw new Error("chat read returned a duplicate row");
        }

        seen.add(entry.id);
        mapped.push(entry);
      }

      return mapped;
    } catch (error) {
      throw new ChatReadError(operation, error);
    }
  }

  return {
    listReadableSessions({ actorId, canvasId }) {
      return readParentScoped(
        LIST_READABLE_SESSIONS,
        actorId,
        READABLE_SESSIONS_SQL,
        [actorId, canvasId],
        mapSession,
      );
    },

    listReadableMessages({ actorId, sessionId }) {
      return readParentScoped(
        LIST_READABLE_MESSAGES,
        actorId,
        READABLE_MESSAGES_SQL,
        [actorId, sessionId],
        mapMessage,
      );
    },

    async listReadableSessionAssets({ actorId, sessionId, assetIds }) {
      // "No ids" is not a query that returns nothing, it is the answer: skip the
      // pool entirely so an empty set cannot open a connection or a transaction.
      if (assetIds.length === 0) return [];

      const ids = dedupeAssetIds(LIST_READABLE_SESSION_ASSETS, assetIds);
      if (ids.length === 0) return [];

      const rows = await readRows(
        LIST_READABLE_SESSION_ASSETS,
        actorId,
        READABLE_SESSION_ASSETS_SQL,
        [actorId, sessionId, ids],
        (row) => row,
      );

      try {
        const mapped: ChatAssetReadRow[] = [];
        const seen = new Set<string>();

        for (const row of rows) {
          const entry = mapAssetIdentity(row);

          // `asset_objects.id` is the primary key and the ids were deduped
          // before binding, so a second row for one id is a disagreement, not a
          // result a caller should have to de-duplicate.
          if (seen.has(entry.id)) {
            throw new Error("chat read returned a duplicate row");
          }

          seen.add(entry.id);
          mapped.push(entry);
        }

        return mapped;
      } catch (error) {
        throw new ChatReadError(LIST_READABLE_SESSION_ASSETS, error);
      }
    },

    async findReadableSessionThread({ actorId, sessionId }) {
      const rows = await readRows(
        FIND_READABLE_SESSION_THREAD,
        actorId,
        READABLE_SESSION_THREAD_SQL,
        [actorId, sessionId],
        mapThreadRow,
      );

      // One session id is one row (it is the primary key); a second row means the
      // SQL and this module disagree, and a caller must not have to guess which
      // one is the session.
      if (rows.length > 1) {
        throw new ChatReadError(
          FIND_READABLE_SESSION_THREAD,
          new Error("chat read returned more than one row"),
        );
      }

      return rows[0] ?? null;
    },
  };
}

/**
 * An id is only a lookup key when it is a real, non-empty string. Sending a
 * half-formed one would either match nothing or, worse, match a different row,
 * so it fails loud instead — the caller filters what it cannot form, it does not
 * get to send it.
 */
function dedupeAssetIds(
  operation: ChatReadOperation,
  assetIds: readonly string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const assetId of assetIds) {
    if (typeof assetId !== "string" || assetId.length === 0) {
      throw new ChatReadError(
        operation,
        new Error("chat asset read needs a non-empty asset id"),
      );
    }

    if (seen.has(assetId)) continue;

    seen.add(assetId);
    ids.push(assetId);
  }

  return ids;
}

function mapSession(
  row: Readonly<Record<string, unknown>>,
): ChatSessionReadRow {
  return {
    id: requireText(row, "id", LIST_READABLE_SESSIONS),
    // `chat_sessions.title` is `text NOT NULL DEFAULT 'New Chat'`; an absent one
    // is a shape change, not a title a caller should have to guess at.
    title: requirePlainText(row, "title", LIST_READABLE_SESSIONS),
    updated_at: requireTimestamp(row, "updated_at", LIST_READABLE_SESSIONS),
  };
}

function mapMessage(
  row: Readonly<Record<string, unknown>>,
): ChatMessageReadRow {
  return {
    id: requireText(row, "id", LIST_READABLE_MESSAGES),
    role: requireRole(row),
    // `content` is `text NOT NULL DEFAULT ''`: empty is legal, absent is not.
    content: requirePlainText(row, "content", LIST_READABLE_MESSAGES),
    tool_activities: optionalJsonArray(row, "tool_activities"),
    content_blocks: optionalJsonArray(row, "content_blocks"),
    created_at: requireTimestamp(row, "created_at", LIST_READABLE_MESSAGES),
  };
}

function mapAssetIdentity(
  row: Readonly<Record<string, unknown>>,
): ChatAssetReadRow {
  return {
    id: requireText(row, "id", LIST_READABLE_SESSION_ASSETS),
    object_path: requireText(row, "object_path", LIST_READABLE_SESSION_ASSETS),
    bucket: requireText(row, "bucket", LIST_READABLE_SESSION_ASSETS),
  };
}

/** The session's own id plus its (nullable) thread binding. */
function mapThreadRow(
  row: Readonly<Record<string, unknown>>,
): { id: string; threadId: string | null } {
  return {
    id: requireText(row, "id", FIND_READABLE_SESSION_THREAD),
    threadId: optionalText(row, "thread_id"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("chat read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatReadOperation,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no usable "${field}"`);
  }

  return value;
}

/**
 * A `text NOT NULL` column with no length rule of its own: `''` is a value the
 * write path really stores, so only a missing or non-string one fails loud.
 */
function requirePlainText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatReadOperation,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`${operation} returned no usable "${field}"`);
  }

  return value;
}

/** A nullable text column: `null` is a real answer, anything else is not. */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`chat read returned an unusable "${field}"`);
  }

  return value;
}

/** `role` is a closed set; a new value is a contract change, not a message. */
function requireRole(
  row: Readonly<Record<string, unknown>>,
): "user" | "assistant" {
  const value = row["role"];
  if (value !== "user" && value !== "assistant") {
    throw new Error('chat read returned an unusable "role"');
  }

  return value;
}

/**
 * `jsonb` arrives as a parsed array from both drivers. A JSON `null` arrives as
 * SQL NULL. Anything else (an object, a scalar) is not the shape this module
 * promises its callers, so it fails loud instead of being passed along.
 */
function optionalJsonArray(
  row: Readonly<Record<string, unknown>>,
  field: string,
): unknown[] | null {
  const value = row[field];
  if (value === null || value === undefined) return null;

  if (!Array.isArray(value)) {
    throw new Error(`chat read returned an unusable "${field}"`);
  }

  return value;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the shared contract wants
 * a string. Both are accepted and normalised, anything else fails loud.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatReadOperation,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`${operation} returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`${operation} returned no usable "${field}"`);
}
