/**
 * Write repository for the chat session CRUD (workorder 21C, ADR-0001).
 *
 * Three PostgREST writes move here, and only these three:
 *
 * 1. the `chat_sessions` INSERT that opens a conversation,
 * 2. the `chat_sessions` title UPDATE,
 * 3. the `chat_sessions` DELETE.
 *
 * Access control is part of the SQL, not a side effect of the environment. A
 * session inherits its canvas's project ACL, so every statement below walks
 * `session/canvas → project → workspace_members` and requires
 *
 * - a membership row for the caller in the project's workspace, AND
 * - `projects.created_by = <caller>` — the author of the project, no one else.
 *
 * The insert starts from the CANVAS (there is no session yet to walk from) and
 * the update/delete start from the session; both end at the same predicate. The
 * HTTP team gate is deliberately NOT relied upon, and neither are the old RLS
 * policies: the pool's role owns the tables and bypasses RLS, which is exactly
 * why the predicate has to be in the statement. `app.execution_mode` is a
 * diagnostic label and is never consulted for authorization; the transaction
 * still carries the actor. `admin`/`owner` widen READS (workorder 20D); they
 * grant nothing here, which is the adjudicated write contract of 21A/21B.
 *
 * Three properties are adjudicated product decisions (T-34, recorded by
 * workorders 21A/21B/21C) and are NOT oversights — do not "fix" them here:
 *
 * - **No `archived_at` filter.** An archived project stays writable, so its
 *   author can still open, rename and delete a conversation. The READ repository
 *   filters archived projects; this one must not.
 * - **`created_by` is stored exactly as the caller passed it.** The write
 *   authority comes from `projects.created_by`, never from this column, so the
 *   column is neither forced to the actor nor validated against it: `null`, the
 *   actor's own id and somebody else's id are all legal values and are written
 *   verbatim. (The old insert always sent `user.id` because the SERVICE decided
 *   to; the repository keeps that a caller decision.)
 * - **A 0-row UPDATE/DELETE is a legal silent answer, not an error.** The
 *   caller is told the affected row count and decides what it means. The old
 *   PostgREST update/delete never turned an empty result into a 404 either.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter, and every one of them is bound with an
 *   explicit cast, so a malformed uuid fails as a real SQL error instead of
 *   silently matching something else. `created_by` is nullable in the schema and
 *   therefore binds as a nullable `uuid`.
 * - Arguments are checked before a connection is opened: ids and the thread id
 *   are non-empty strings, `createdBy` is a non-empty uuid string or an explicit
 *   `null`, `title` is any string (`''` included — the column is `text NOT NULL`
 *   and an empty title is a value) or an explicit `null`, and an `undefined`
 *   means the caller never decided — that is a bug in the caller, so it fails
 *   loud instead of being stored as a silent NULL.
 * - A `null` title on the insert means "do not name the column at all", so the
 *   schema's own `DEFAULT 'New Chat'` decides — the same shape the old
 *   `...(title ? { title } : {})` produced, with the default kept in one place.
 * - The DELETE is a plain row delete: which child rows follow is decided by the
 *   table's own foreign keys (`chat_messages.session_id` is `ON DELETE
 *   CASCADE`), never by a second statement of ours. Deleting messages here would
 *   be a second, drifting copy of the cascade.
 * - A connect, SQL, timeout or row-shape failure throws
 *   `ChatSessionWriteError`, whose own message is fixed text: no SQL, no host,
 *   no connection string. The driver's own error rides along as `cause` so a
 *   caller can classify it without the driver's message reaching a log line.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/** One stored session, in the shape `ChatService.createSession` returns. */
export type ChatSessionWriteRow = {
  id: string;
  title: string | null;
  updatedAt: string;
};

export type ChatSessionWriteRepository = {
  createSession(input: {
    actorId: string;
    canvasId: string;
    threadId: string;
    title: string | null;
    createdBy: string | null;
  }): Promise<ChatSessionWriteRow>;
  updateSessionTitle(input: {
    actorId: string;
    sessionId: string;
    title: string;
  }): Promise<{ affectedRows: number }>;
  deleteSession(input: {
    actorId: string;
    sessionId: string;
  }): Promise<{ affectedRows: number }>;
};

export const CREATE_SESSION = "createSession";
export const UPDATE_SESSION_TITLE = "updateSessionTitle";
export const DELETE_SESSION = "deleteSession";

export type ChatSessionWriteOperation =
  | typeof CREATE_SESSION
  | typeof UPDATE_SESSION_TITLE
  | typeof DELETE_SESSION;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ChatSessionWriteError extends Error {
  readonly operation: ChatSessionWriteOperation;

  constructor(operation: ChatSessionWriteOperation, cause: unknown) {
    super(
      `chat session write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "ChatSessionWriteError";
    this.operation = operation;
  }
}

/**
 * The error a `ChatSessionWriteError` wraps: the driver's own object, or the
 * shape failure this module raised itself.
 *
 * It is handed back rather than exposed through the fixed message because the
 * only thing a caller may do with it is CLASSIFY it. Anything a caller wants to
 * log has to come from `chatSessionWriteFailureCode`, which keeps statement text
 * out of the log.
 */
export function chatSessionWriteCause(error: unknown): unknown {
  return error instanceof ChatSessionWriteError ? error.cause : error;
}

/**
 * The driver's own code, when it has one: a SQLSTATE (`42501`, `22P02`,
 * `23502`) or a Node socket code (`ECONNRESET`, `ETIMEDOUT`).
 *
 * A code is a token — never statement text, never a bind value — which is why it
 * is the one piece of the driver's answer a caller may log. The driver's MESSAGE
 * is not: `pg` echoes the failing statement and its parameters inside it.
 */
export function chatSessionWriteFailureCode(error: unknown): string | null {
  const cause = chatSessionWriteCause(error);
  if (!cause || typeof cause !== "object") return null;

  const code = (cause as { code?: unknown }).code;
  if (typeof code !== "string") return null;

  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Open a session on a canvas the actor authors.
 *
 * `insert ... select ... where exists` is what makes the refusal observable: an
 * actor who is not the project's author (or is no longer a workspace member) has
 * the `exists` fail, so PostgreSQL inserts ZERO rows and raises NOTHING. The row
 * count is the verdict and this module turns it into a `ChatSessionWriteError`.
 *
 * `created_by` is passed straight through as `$3` — the column is nullable and
 * the value is the caller's, not ours. `thread_id` is `$4`, stored as given: the
 * id is minted by the service (`threadService.createThreadId()`), never here.
 *
 * `title` is `$5`, and the statement that carries it is only used when the
 * caller actually named a title — see `CREATE_SESSION_SQL` below.
 */
const CREATE_SESSION_SQL = `
insert into public.chat_sessions (
  canvas_id, created_by, thread_id, title
)
select
  $2::uuid,
  $3::uuid,
  $4::text,
  $5::text
where exists (
  select 1
  from public.canvases as c
  join public.projects as p
    on p.id = c.project_id
  join public.workspace_members as m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1::uuid
  where c.id = $2::uuid
    and p.created_by = $1::uuid
)
returning
  id, title, updated_at
`;

/**
 * The same insert for a caller who named no title.
 *
 * `chat_sessions.title` is `text NOT NULL DEFAULT 'New Chat'`. Binding a NULL
 * would violate the NOT NULL constraint and fail a create that used to succeed,
 * so the column is left out of the statement entirely and the schema's own
 * default decides — which is exactly what the old
 * `...(title ? { title } : {})` did. The default stays in ONE place (the
 * migration) instead of being copied into this module where it would drift.
 */
const CREATE_SESSION_WITHOUT_TITLE_SQL = `
insert into public.chat_sessions (
  canvas_id, created_by, thread_id
)
select
  $2::uuid,
  $3::uuid,
  $4::text
where exists (
  select 1
  from public.canvases as c
  join public.projects as p
    on p.id = c.project_id
  join public.workspace_members as m
    on m.workspace_id = p.workspace_id
   and m.user_id = $1::uuid
  where c.id = $2::uuid
    and p.created_by = $1::uuid
)
returning
  id, title, updated_at
`;

/**
 * Rename a session, under the session → canvas → project write ACL.
 *
 * `returning s.id` is how the affected row count is observed: `0` means the row
 * is gone or this actor may not write it, and it is a LEGAL answer the caller
 * has to interpret (T-34). No error is raised for it, exactly as the old
 * PostgREST update raised none.
 *
 * `chat_sessions` carries a `BEFORE UPDATE` `moddatetime` trigger, so this
 * statement also refreshes `updated_at` — the same precedence the old update
 * had, and the reason no timestamp is bound here.
 */
const UPDATE_SESSION_TITLE_SQL = `
update public.chat_sessions as s
set title = $3::text
where s.id = $2::uuid
  and exists (
    select 1
    from public.canvases as c
    join public.projects as p
      on p.id = c.project_id
    join public.workspace_members as m
      on m.workspace_id = p.workspace_id
     and m.user_id = $1::uuid
    where c.id = s.canvas_id
      and p.created_by = $1::uuid
  )
returning s.id as id
`;

/**
 * Delete a session, under the same ACL.
 *
 * The statement deletes the session ROW and nothing else. What happens to the
 * conversation's messages is decided by the schema — `chat_messages.session_id`
 * is `REFERENCES public.chat_sessions(id) ON DELETE CASCADE` — so the cascade
 * has exactly one definition. Deleting messages from here would be a second
 * copy of that rule, and the two would eventually disagree.
 *
 * Zero rows is the same legal answer as above: a session that is gone, or one
 * this actor may not write, deletes nothing and raises nothing.
 */
const DELETE_SESSION_SQL = `
delete from public.chat_sessions as s
where s.id = $2::uuid
  and exists (
    select 1
    from public.canvases as c
    join public.projects as p
      on p.id = c.project_id
    join public.workspace_members as m
      on m.workspace_id = p.workspace_id
     and m.user_id = $1::uuid
    where c.id = s.canvas_id
      and p.created_by = $1::uuid
  )
returning s.id as id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `ChatSessionWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails; nothing in this module can reach PostgREST.
 */
export function createChatSessionWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ChatSessionWriteRepository {
  /**
   * Run one statement as the actor, inside a privileged transaction, and turn
   * every failure into this module's fixed error.
   *
   * The callback's own row-shape failures are inside the same guard on purpose:
   * a row that is not the shape this module promises is a write failure, not an
   * exception the caller has to interpret.
   */
  async function run<T>(
    operation: ChatSessionWriteOperation,
    actorId: string,
    statement: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();
      return await withPrivilegedTransaction(pool, { userId: actorId }, statement);
    } catch (error) {
      throw new ChatSessionWriteError(operation, error);
    }
  }

  return {
    async createSession(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireWriteArgument(CREATE_SESSION, input.actorId, "actorId");
      const canvasId = requireWriteArgument(CREATE_SESSION, input.canvasId, "canvasId");
      const threadId = requireWriteArgument(CREATE_SESSION, input.threadId, "threadId");
      const createdBy = requireNullableWriteArgument(
        CREATE_SESSION,
        input.createdBy,
        "createdBy",
      );
      const title = requireNullableWriteText(CREATE_SESSION, input.title, "title");

      return run(CREATE_SESSION, actorId, async (client) => {
        // A named title and no title are two statements, not one statement with a
        // nullable bind: see CREATE_SESSION_WITHOUT_TITLE_SQL.
        const result =
          title === null
            ? await client.query(CREATE_SESSION_WITHOUT_TITLE_SQL, [
                actorId,
                canvasId,
                createdBy,
                threadId,
              ])
            : await client.query(CREATE_SESSION_SQL, [
                actorId,
                canvasId,
                createdBy,
                threadId,
                title,
              ]);

        // `id` is the primary key, so one statement is at most one row. Zero rows
        // is the ACL's silent refusal (or a canvas that is not there): the session
        // was not created and the caller must not be told it was.
        if (result.rows.length !== 1) {
          throw new Error("chat session write created no row");
        }

        return mapSessionRow(result.rows[0], CREATE_SESSION);
      });
    },

    async updateSessionTitle(input) {
      const actorId = requireWriteArgument(
        UPDATE_SESSION_TITLE,
        input.actorId,
        "actorId",
      );
      const sessionId = requireWriteArgument(
        UPDATE_SESSION_TITLE,
        input.sessionId,
        "sessionId",
      );
      const title = requireWriteText(UPDATE_SESSION_TITLE, input.title, "title");

      return run(UPDATE_SESSION_TITLE, actorId, async (client) => {
        const result = await client.query(UPDATE_SESSION_TITLE_SQL, [
          actorId,
          sessionId,
          title,
        ]);

        // No error for zero rows, on purpose: see the module header (T-34).
        return { affectedRows: result.rows.length };
      });
    },

    async deleteSession(input) {
      const actorId = requireWriteArgument(DELETE_SESSION, input.actorId, "actorId");
      const sessionId = requireWriteArgument(DELETE_SESSION, input.sessionId, "sessionId");

      return run(DELETE_SESSION, actorId, async (client) => {
        const result = await client.query(DELETE_SESSION_SQL, [actorId, sessionId]);

        // Same legal zero as the update: the caller decides what it means.
        return { affectedRows: result.rows.length };
      });
    },
  };
}

/**
 * An id (or a thread id) is only a lookup value when it is a real, non-empty
 * string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 */
function requireWriteArgument(
  operation: ChatSessionWriteOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ChatSessionWriteError(
      operation,
      new Error(`chat session write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/** A required `text` value: `''` is a value the caller chose, absent is not. */
function requireWriteText(
  operation: ChatSessionWriteOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new ChatSessionWriteError(
      operation,
      new Error(`chat session write needs a string "${field}"`),
    );
  }

  return value;
}

/**
 * A nullable uuid argument: a non-empty string or an explicit `null`.
 *
 * `null` and `undefined` are different answers and must stay different. `null`
 * means "store SQL NULL"; `undefined` means the caller never decided, which is a
 * bug in the caller and therefore fails loud instead of being silently stored as
 * NULL. An empty string is neither: it is not a uuid, so it is refused here
 * rather than sent to be rejected by PostgreSQL.
 */
function requireNullableWriteArgument(
  operation: ChatSessionWriteOperation,
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string" || value.length === 0) {
    throw new ChatSessionWriteError(
      operation,
      new Error(`chat session write needs "${field}" to be a non-empty string or null`),
    );
  }

  return value;
}

/**
 * A nullable `text` argument: any string — `''` included, because `''` is a
 * value `text NOT NULL` is happy to store — or an explicit `null`.
 *
 * `null` here means "do not name the column", so the schema's own
 * `DEFAULT 'New Chat'` decides; `undefined` is a caller that never decided and
 * fails loud. A non-string fails loud for the same reason.
 */
function requireNullableWriteText(
  operation: ChatSessionWriteOperation,
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new ChatSessionWriteError(
      operation,
      new Error(`chat session write needs "${field}" to be a string or null`),
    );
  }

  return value;
}

function mapSessionRow(
  row: unknown,
  operation: ChatSessionWriteOperation,
): ChatSessionWriteRow {
  const record = asWriteRow(row, operation);

  return {
    id: requireRowText(record, "id", operation),
    title: optionalRowText(record, "title", operation),
    updatedAt: requireRowTimestamp(record, "updated_at", operation),
  };
}

function asWriteRow(
  value: unknown,
  operation: ChatSessionWriteOperation,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned a row that is not an object`);
  }

  return value as Record<string, unknown>;
}

function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatSessionWriteOperation,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no usable "${field}"`);
  }

  return value;
}

/**
 * Read the nullable `title` a `RETURNING` handed back, keeping "the database
 * answered NULL" apart from "the result row does not carry the column at all".
 *
 * `chat_sessions.title` is `text NOT NULL DEFAULT 'New Chat'`, so an INSERT can
 * only answer a string today; the contract is still `string | null` because the
 * repository must report what the database said rather than silently repair it,
 * and the caller decides what a null title means. What is NOT tolerated is a row
 * that never had the field — a column dropped from `RETURNING`, a drifting alias,
 * a half-built driver row — or one carrying an explicit `undefined`: folding that
 * into a business `null` would serve a column drift as "this session has no
 * title". So it fails loud and the guard turns it into a `ChatSessionWriteError`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `field in row`: an inherited
 * key is not a column the statement selected.
 */
function optionalRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatSessionWriteOperation,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`${operation} returned no "${field}"`);
  }

  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`${operation} returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the shared contract wants
 * a string. Both are accepted and normalised, anything else fails loud.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function requireRowTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatSessionWriteOperation,
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
