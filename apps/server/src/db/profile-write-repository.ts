/**
 * Profile write repository (workorder 21D, ADR-0001 migration step 2).
 *
 * ONE PostgREST write moves here, and only this one: the display-name update
 * behind `PATCH /api/viewer/profile`. It is the last remaining single-table,
 * stateless write whose target row is decided by the authenticated actor alone.
 *
 * Rules this module keeps:
 *
 * - `updateDisplayName` is the entire interface. There is no access token, no
 *   arbitrary profile id, no table name and no generic patch object, so a caller
 *   cannot widen the write: the only row this module can ever touch is
 *   `id = actorId`, and the only column it ever sets is `display_name`.
 * - Every value is a bind parameter (`$1`, `$2`), each bound with an explicit
 *   cast, so a malformed actor id fails as a real SQL error (SQLSTATE 22P02)
 *   inside the transaction instead of silently matching something else.
 * - The statement runs through workorder 19's transaction entry point in
 *   `privileged` mode with `{ userId: actorId }` as the actor, so the audit
 *   trail still records who asked. `app.execution_mode` is a diagnostic label,
 *   never a grant — real role separation is workorder 24's job. The pool's role
 *   owns the table and bypasses RLS, which is exactly why "only your own row"
 *   has to be the statement's own predicate.
 * - Zero rows is NOT a legal answer here, unlike the chat session writes of
 *   21C. The row is the actor's own profile, so "nothing was updated" means the
 *   profile is gone (or the id is not a real one) and the caller must not be
 *   told the write happened. It is reported through the same fixed error as a
 *   SQL failure, so the HTTP layer's single 500 projection stays honest and
 *   resource existence never leaks.
 * - A connect, SQL, timeout, zero-row or row-shape failure throws
 *   `ProfileWriteError`, whose own message is fixed text: no SQL, no host, no
 *   connection string, no profile id. The driver's own error rides along as
 *   `cause` so a caller can classify it without the driver's message reaching a
 *   log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback:
 *   nothing in this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The profile row as this module reports it: what `RETURNING` answered, and
 * nothing else. `email` and `avatar_url` are nullable columns this write never
 * touches; `displayName` is non-null because the statement just set it to a
 * non-empty string, so a NULL there is a contract violation, not a value.
 */
export type ProfileWriteRow = {
  id: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type ProfileWriteRepository = {
  updateDisplayName(input: {
    actorId: string;
    displayName: string;
  }): Promise<ProfileWriteRow>;
};

export const UPDATE_DISPLAY_NAME = "updateDisplayName";

export type ProfileWriteOperation = typeof UPDATE_DISPLAY_NAME;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class ProfileWriteError extends Error {
  readonly operation: ProfileWriteOperation;

  constructor(operation: ProfileWriteOperation, cause: unknown) {
    super(
      `profile write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "ProfileWriteError";
    this.operation = operation;
  }
}

/**
 * The one statement this module can issue.
 *
 * `set display_name = $2` is the ONLY assignment: email, avatar_url and every
 * other column of the row are left exactly as they were, and no second
 * statement follows. `where id = $1::uuid` is the ONLY predicate — there is no
 * owner column, no workspace join and no "any profile" variant, so the row that
 * can be written is the actor's own and nothing else. `returning` names the four
 * columns the response is projected from, in the same shape the superseded
 * PostgREST chain asked for (`.select("id, email, display_name, avatar_url")`).
 *
 * A zero-row result is not an error to PostgreSQL; it is this module's refusal
 * (see the header) and is raised by the caller below.
 */
const UPDATE_DISPLAY_NAME_SQL = `
update public.profiles
   set display_name = $2::text
 where id = $1::uuid
returning
  id, email, display_name, avatar_url
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `ProfileWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createProfileWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): ProfileWriteRepository {
  return {
    async updateDisplayName(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireWriteArgument(input.actorId, "actorId");
      const displayName = requireWriteArgument(input.displayName, "displayName");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          { userId: actorId },
          async (client) => {
            const result = await client.query(UPDATE_DISPLAY_NAME_SQL, [
              actorId,
              displayName,
            ]);

            // `id` is the primary key, so the statement is at most one row. Zero
            // rows is the refusal described in the header: the profile is gone
            // or the id is not a profile, and either way the write did not
            // happen. More than one row is impossible for the same reason and is
            // treated as a statement/mapper disagreement rather than a value.
            if (result.rows.length !== 1) {
              throw new Error("profile write updated no row");
            }

            return mapProfileRow(result.rows[0]);
          },
        );
      } catch (error) {
        throw new ProfileWriteError(UPDATE_DISPLAY_NAME, error);
      }
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable. Pre-validating it here
 * would hide that path instead of exercising it.
 *
 * The display name is held to the same rule because `display_name` is what the
 * rest of the system reads back: the shared contract requires at least one
 * character (`profileUpdateRequestSchema`), so storing `''` from here would
 * create a profile the API can no longer serve. Trimming is the caller's
 * decision and is NOT repeated in this module — the route's Zod schema already
 * did it, and doing it twice would make the stored value depend on which layer
 * ran.
 */
function requireWriteArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProfileWriteError(
      UPDATE_DISPLAY_NAME,
      new Error(`profile write needs a non-empty "${field}"`),
    );
  }

  return value;
}

function mapProfileRow(row: unknown): ProfileWriteRow {
  const record = asWriteRow(row);

  return {
    id: requireRowText(record, "id"),
    email: optionalRowText(record, "email"),
    displayName: requireRowText(record, "display_name"),
    avatarUrl: optionalRowText(record, "avatar_url"),
  };
}

function asWriteRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile write returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * A column this statement always sets to a non-empty string.
 *
 * An empty value fails here rather than travelling on: the response contract
 * cannot describe a nameless profile, and the shape check is the one place that
 * can still tell "the database answered something unusable" from "the caller
 * asked for it".
 */
function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`profile write returned no usable "${field}"`);
  }

  return value;
}

/**
 * Read a nullable column this write never touches, keeping "the database
 * answered NULL" apart from "the result row does not carry the column at all".
 *
 * `profiles.email` and `profiles.avatar_url` are nullable, so an explicit NULL
 * is a value and is reported as one. What is NOT tolerated is a row that never
 * had the field — a column dropped from `RETURNING`, a drifting alias, a
 * half-built driver row — or one carrying an explicit `undefined`: folding that
 * into a business `null` would serve a column drift as "this profile has no
 * email". So it fails loud and the guard turns it into a `ProfileWriteError`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `field in row`: an inherited
 * key is not a column the statement selected.
 */
function optionalRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`profile write returned no "${field}"`);
  }

  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`profile write returned an unusable "${field}"`);
  }

  return value;
}
