/**
 * Write repository for the chat message state machine (workorder 21B, ADR-0001).
 *
 * Three PostgREST writes move here, and only these three:
 *
 * 1. the `chat_messages` INSERT that stores one message under a CALLER-SUPPLIED
 *    id (the id is what makes "did it land?" answerable at all),
 * 2. the "did it land?" read of that same id after a transport failure,
 * 3. the `chat_sessions.updated_at` touch that follows a stored message.
 *
 * Access control is part of the SQL, not a side effect of the environment. A
 * session inherits its canvas's project ACL, so every statement below walks
 * `session/message → canvas → project → workspace_members` and requires
 *
 * - a membership row for the caller in the project's workspace, AND
 * - `projects.created_by = <caller>` — the author of the project, no one else.
 *
 * The HTTP team gate is deliberately NOT relied upon, and neither are the old
 * RLS policies: the pool's role owns the tables and bypasses RLS, which is
 * exactly why the predicate has to be in the statement. `app.execution_mode` is
 * a diagnostic label and is never consulted for authorization; the transaction
 * still carries the actor.
 *
 * Three properties are adjudicated product decisions (T-34, recorded by workorder
 * 21B) and are NOT oversights — do not "fix" them here:
 *
 * - **No `archived_at` filter.** An archived project stays writable. The READ
 *   repository filters archived projects; this one must not, or archiving a
 *   project would silently stop its author from saving a conversation.
 * - **`chat_sessions.created_by` is neither written nor enforced.** No statement
 *   in this module touches that column; a session may carry any value or null, as
 *   it always could. The write authority comes from `projects.created_by`.
 * - **A 0-row touch is a legal answer, not an error.** `touchSession` reports the
 *   affected row count and the caller decides what it means. The old PostgREST
 *   update never checked its `error` either, so turning 0 rows into a business
 *   failure here would change the meaning of a stored message.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter, and every one of them is bound with an
 *   explicit cast, so a malformed uuid fails as a real SQL error instead of
 *   silently matching something else.
 * - Arguments are checked before a connection is opened: `role` is a closed set,
 *   ids are non-empty strings, jsonb arguments are `null` or a JSON value, and
 *   `updatedAt` is an ISO-8601 timestamp. An unusable argument never reaches the
 *   pool and never leaves a transaction open.
 * - A connect, SQL, timeout or row-shape failure throws `ChatWriteError`, whose
 *   own message is fixed text: no SQL, no host, no connection string. The
 *   driver's own error rides along as `cause` — `chatWriteCause()` hands it back
 *   so a caller can classify it (workorder 21-前置A's `isTransportFailure` reads
 *   exactly that shape) without the driver's message ever reaching a log line.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback.
 */

import type { Json } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/** One stored message, in the shape the caller and the confirm read consume. */
export type ChatMessageWriteRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_activities: unknown[] | null;
  content_blocks: unknown[] | null;
  created_at: string;
};

export type ChatWriteRepository = {
  insertMessage(input: {
    actorId: string;
    messageId: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    toolActivities: Json | null;
    contentBlocks: Json | null;
  }): Promise<ChatMessageWriteRow>;
  findMessageForRecovery(input: {
    actorId: string;
    messageId: string;
  }): Promise<ChatMessageWriteRow | null>;
  touchSession(input: {
    actorId: string;
    sessionId: string;
    updatedAt: string;
  }): Promise<{ affectedRows: number }>;
};

export const INSERT_MESSAGE = "insertMessage";
export const FIND_MESSAGE_FOR_RECOVERY = "findMessageForRecovery";
export const TOUCH_SESSION = "touchSession";

export type ChatWriteOperation =
  | typeof INSERT_MESSAGE
  | typeof FIND_MESSAGE_FOR_RECOVERY
  | typeof TOUCH_SESSION;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ChatWriteError extends Error {
  readonly operation: ChatWriteOperation;

  constructor(operation: ChatWriteOperation, cause: unknown) {
    super(`chat write failed (${operation})`, cause === undefined ? {} : { cause });
    this.name = "ChatWriteError";
    this.operation = operation;
  }
}

/**
 * The error a `ChatWriteError` wraps: the driver's own object, or the shape
 * failure this module raised itself.
 *
 * It is handed back rather than exposed through the fixed message because the
 * only thing a caller may do with it is CLASSIFY it — `isTransportFailure` reads
 * `code`/`message` on exactly this shape. Anything a caller wants to log has to
 * come from `chatWriteFailureCode`, which keeps statement text out of the log.
 */
export function chatWriteCause(error: unknown): unknown {
  return error instanceof ChatWriteError ? error.cause : error;
}

/**
 * The driver's own code, when it has one: a SQLSTATE (`42501`, `22P02`, `23514`)
 * or a Node socket code (`ECONNRESET`, `ETIMEDOUT`).
 *
 * A code is a token — never statement text, never a bind value — which is why it
 * is the one piece of the driver's answer a caller may log. The driver's MESSAGE
 * is not: `pg` echoes the failing statement and its parameters inside it.
 */
export function chatWriteFailureCode(error: unknown): string | null {
  const cause = chatWriteCause(error);
  if (!cause || typeof cause !== "object") return null;

  const code = (cause as { code?: unknown }).code;
  if (typeof code !== "string") return null;

  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Store one message under the caller's own id.
 *
 * The ACL is the `select`'s own predicate, so an actor who is not the project's
 * author (or is no longer a workspace member) inserts ZERO rows and gets no
 * error from PostgreSQL — the row count is the verdict and this module turns it
 * into a `ChatWriteError`. That is also why the archived filter is absent: see
 * the module header.
 *
 * `RETURNING` answers the same six fields the message contract is built from, so
 * the caller never has to read the row back.
 */
const INSERT_MESSAGE_SQL = `
insert into public.chat_messages (
  id, session_id, role, content, tool_activities, content_blocks
)
select
  $2::uuid,
  s.id,
  $4::text,
  $5::text,
  $6::jsonb,
  $7::jsonb
from public.chat_sessions as s
join public.canvases as c
  on c.id = s.canvas_id
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1::uuid
where s.id = $3::uuid
  and p.created_by = $1::uuid
returning
  id, role, content, tool_activities, content_blocks, created_at
`;

/**
 * The "did it land?" read, by message id only.
 *
 * It is deliberately NOT enough to look the row up by primary key: the caller
 * must not be handed a row it could not have written. So the message is joined
 * back through its session, canvas and project and re-checked against the SAME
 * write ACL as the insert (`created_by = actor`, actor still a member). A row
 * that exists in a project this actor cannot write answers exactly like a row
 * that does not exist: `null`.
 */
const FIND_MESSAGE_FOR_RECOVERY_SQL = `
select
  msg.id as id,
  msg.role as role,
  msg.content as content,
  msg.tool_activities as tool_activities,
  msg.content_blocks as content_blocks,
  msg.created_at as created_at
from public.chat_messages as msg
join public.chat_sessions as s
  on s.id = msg.session_id
join public.canvases as c
  on c.id = s.canvas_id
join public.projects as p
  on p.id = c.project_id
join public.workspace_members as m
  on m.workspace_id = p.workspace_id
 and m.user_id = $1::uuid
where msg.id = $2::uuid
  and p.created_by = $1::uuid
`;

/**
 * Refresh the session's `updated_at`, under the same ACL as the insert.
 *
 * `returning s.id` is how the affected row count is observed: `0` means the row
 * is gone or this actor may not write it, and it is a LEGAL answer the caller
 * has to interpret (T-34). No error is raised for it, exactly as the old
 * PostgREST update raised none.
 *
 * `chat_sessions` carries a `BEFORE UPDATE` `moddatetime` trigger, so the value
 * bound here is what the statement asks for while the trigger remains the last
 * word on the stored timestamp — the same precedence the PostgREST update had.
 */
const TOUCH_SESSION_SQL = `
update public.chat_sessions as s
set updated_at = $3::timestamptz
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
 * `DATABASE_URL` only surfaces as a `ChatWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails; nothing in this module can reach PostgREST.
 */
export function createChatWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ChatWriteRepository {
  /**
   * Run one statement as the actor, inside a privileged transaction, and turn
   * every failure into this module's fixed error.
   *
   * The callback's own row-shape failures are inside the same guard on purpose:
   * a row that is not the shape this module promises is a write failure, not an
   * exception the caller has to interpret.
   */
  async function run<T>(
    operation: ChatWriteOperation,
    actorId: string,
    statement: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();
      return await withPrivilegedTransaction(pool, { userId: actorId }, statement);
    } catch (error) {
      throw new ChatWriteError(operation, error);
    }
  }

  return {
    async insertMessage(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireWriteArgument(INSERT_MESSAGE, input.actorId, "actorId");
      const messageId = requireWriteArgument(INSERT_MESSAGE, input.messageId, "messageId");
      const sessionId = requireWriteArgument(INSERT_MESSAGE, input.sessionId, "sessionId");
      const role = requireWriteRole(INSERT_MESSAGE, input.role);
      const content = requireWriteContent(INSERT_MESSAGE, input.content);
      const toolActivities = requireJsonArgument(
        INSERT_MESSAGE,
        input.toolActivities,
        "toolActivities",
      );
      const contentBlocks = requireJsonArgument(
        INSERT_MESSAGE,
        input.contentBlocks,
        "contentBlocks",
      );

      return run(INSERT_MESSAGE, actorId, async (client) => {
        const result = await client.query(INSERT_MESSAGE_SQL, [
          actorId,
          messageId,
          sessionId,
          role,
          content,
          toolActivities,
          contentBlocks,
        ]);

        // The id is the primary key, so one statement is at most one row. Zero
        // rows is the ACL's silent refusal (or a session that is not there): the
        // insert did not happen and the caller must not be told it did.
        if (result.rows.length !== 1) {
          throw new Error("chat write inserted no row");
        }

        return mapMessageRow(result.rows[0], INSERT_MESSAGE);
      });
    },

    async findMessageForRecovery(input) {
      const actorId = requireWriteArgument(
        FIND_MESSAGE_FOR_RECOVERY,
        input.actorId,
        "actorId",
      );
      const messageId = requireWriteArgument(
        FIND_MESSAGE_FOR_RECOVERY,
        input.messageId,
        "messageId",
      );

      return run(FIND_MESSAGE_FOR_RECOVERY, actorId, async (client) => {
        const result = await client.query(FIND_MESSAGE_FOR_RECOVERY_SQL, [
          actorId,
          messageId,
        ]);

        // Zero rows is a real answer: either the statement never executed, or the
        // row belongs to a project this actor may not write. Both mean "do not
        // replay on top of it" to the caller, and the caller treats them the same
        // way it treated the old PostgREST `maybeSingle()` miss.
        if (result.rows.length === 0) return null;

        // One id is one primary key. A second row means the statement and this
        // module disagree, and guessing which one landed is how a duplicate reply
        // gets written.
        if (result.rows.length > 1) {
          throw new Error("chat write recovery read returned more than one row");
        }

        return mapMessageRow(result.rows[0], FIND_MESSAGE_FOR_RECOVERY);
      });
    },

    async touchSession(input) {
      const actorId = requireWriteArgument(TOUCH_SESSION, input.actorId, "actorId");
      const sessionId = requireWriteArgument(TOUCH_SESSION, input.sessionId, "sessionId");
      const updatedAt = requireWriteTimestamp(TOUCH_SESSION, input.updatedAt);

      return run(TOUCH_SESSION, actorId, async (client) => {
        const result = await client.query(TOUCH_SESSION_SQL, [
          actorId,
          sessionId,
          updatedAt,
        ]);

        return { affectedRows: result.rows.length };
      });
    },
  };
}

/** ISO-8601 with an explicit offset: the shape the write contract accepts. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An id is only a lookup key when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 */
function requireWriteArgument(
  operation: ChatWriteOperation,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ChatWriteError(
      operation,
      new Error(`chat write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/** `role` is a closed set; a new value is a contract change, not a message. */
function requireWriteRole(
  operation: ChatWriteOperation,
  value: unknown,
): "user" | "assistant" {
  if (value !== "user" && value !== "assistant") {
    throw new ChatWriteError(
      operation,
      new Error('chat write needs a "role" of user or assistant'),
    );
  }

  return value;
}

/** `content` is `text NOT NULL DEFAULT ''`: empty is a value, absent is not. */
function requireWriteContent(
  operation: ChatWriteOperation,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new ChatWriteError(
      operation,
      new Error('chat write needs a string "content"'),
    );
  }

  return value;
}

/**
 * A jsonb argument is `null` or a JSON value, and the two are different: `null`
 * means "store SQL NULL", while an `undefined` argument means the caller never
 * decided. The second is a bug in the caller, so it fails loud instead of being
 * silently stored as "no blocks".
 */
function requireJsonArgument(
  operation: ChatWriteOperation,
  value: unknown,
  field: string,
): Json | null {
  if (value === null) return null;

  if (value === undefined) {
    throw new ChatWriteError(
      operation,
      new Error(`chat write needs "${field}" to be a JSON value or null`),
    );
  }

  const kind = typeof value;
  if (kind !== "string" && kind !== "number" && kind !== "boolean" && kind !== "object") {
    throw new ChatWriteError(
      operation,
      new Error(`chat write needs "${field}" to be a JSON value or null`),
    );
  }

  return value as Json;
}

/** `updatedAt` is published as ISO-8601; anything else is not a timestamp. */
function requireWriteTimestamp(
  operation: ChatWriteOperation,
  value: unknown,
): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    throw new ChatWriteError(
      operation,
      new Error('chat write needs an ISO-8601 "updatedAt"'),
    );
  }

  return new Date(value).toISOString();
}

function mapMessageRow(
  row: unknown,
  operation: ChatWriteOperation,
): ChatMessageWriteRow {
  const record = asWriteRow(row, operation);

  return {
    id: requireRowText(record, "id", operation),
    role: requireRowRole(record, operation),
    // `content` is `text NOT NULL DEFAULT ''`: empty is legal, absent is not.
    content: requireRowPlainText(record, "content", operation),
    tool_activities: optionalJsonArray(record, "tool_activities", operation),
    content_blocks: optionalJsonArray(record, "content_blocks", operation),
    created_at: requireRowTimestamp(record, "created_at", operation),
  };
}

function asWriteRow(
  value: unknown,
  operation: ChatWriteOperation,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned a row that is not an object`);
  }

  return value as Record<string, unknown>;
}

function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatWriteOperation,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${operation} returned no usable "${field}"`);
  }

  return value;
}

function requireRowPlainText(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatWriteOperation,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`${operation} returned no usable "${field}"`);
  }

  return value;
}

function requireRowRole(
  row: Readonly<Record<string, unknown>>,
  operation: ChatWriteOperation,
): "user" | "assistant" {
  const value = row["role"];
  if (value !== "user" && value !== "assistant") {
    throw new Error(`${operation} returned an unusable "role"`);
  }

  return value;
}

/**
 * Read a nullable `jsonb` column, keeping "the database answered NULL" apart
 * from "the result row does not carry the column at all".
 *
 * A nullable column has exactly one legal absent value: the field is present on
 * the row and is `null`. A row that never had the field — a column dropped from
 * `RETURNING`, a drifting alias, a half-built driver row — or one that carries an
 * explicit `undefined` means the statement and this module disagree, and folding
 * that into a business `null` would serve a column drift as "this message has no
 * blocks". So it fails loud and the guard turns it into a `ChatWriteError`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `field in row`: an inherited
 * key is not a column the statement selected.
 */
function optionalJsonArray(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatWriteOperation,
): unknown[] | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`${operation} returned no "${field}"`);
  }

  const value = row[field];
  if (value === null) return null;

  if (!Array.isArray(value)) {
    throw new Error(`${operation} returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the shared contract wants
 * a string. Both are accepted and normalised, anything else fails loud.
 */
function requireRowTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: ChatWriteOperation,
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
