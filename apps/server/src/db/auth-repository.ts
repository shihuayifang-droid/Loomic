/**
 * Auth repository (ticket 42B): HaHart's own users, password credentials,
 * refresh-token sessions and login-failure counters.
 *
 * It lives on the canonical schema created by `apps/server/db/canonical/0001_auth.sql`
 * and has nothing to do with the retired Supabase baseline: no Supabase client,
 * no PostgREST builder, no `public` object.
 *
 * Rules this module keeps:
 *
 * - Every statement is a bind parameter (`$1`, `$2`, ...). No email, id, hash or
 *   family id is ever concatenated into SQL.
 * - Every entry point runs through `withPrivilegedTransaction(pool, null, ...)`:
 *   authentication happens before there is an authenticated actor, so the audit
 *   trail records a system task rather than inventing one.
 * - Ids are minted here (`crypto.randomUUID()`), never by the database, so a
 *   caller can rebuild the same object graph without a round trip.
 * - Timestamps are passed in by the caller and rendered as ISO-8601 strings with
 *   an explicit `::timestamptz` cast, so "now" is a decision of the caller (and
 *   of the tests), not of whichever clock the server happens to run on.
 * - Rotation is one transaction: either the old token is revoked *and* its
 *   successor exists, or nothing changed.
 */

import { randomUUID } from "node:crypto";

import {
  type TransactionConnection,
  type TransactionPool,
  withPrivilegedTransaction,
} from "./transaction.js";

export type UserStatus = "pending" | "active" | "disabled";

/** What a caller needs to authenticate a user: identity, state and the hash. */
export type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
  tokenVersion: number;
  mustChangePassword: boolean;
  /** sha256/scrypt form produced by `src/auth/password.ts`; null if unset. */
  passwordHash: string | null;
};

export type CreateUserInput = {
  email: string;
  displayName?: string | null;
  passwordHash: string;
};

/**
 * `{ conflict: true }` is a normal outcome, not an error: the caller turns it
 * into "email already taken" without inspecting a driver error.
 */
export type CreateUserResult = { id: string } | { conflict: true };

export type CreatedSession = {
  id: string;
  familyId: string;
};

export type CreateSessionInput = {
  userId: string;
  /** Omit to start a new rotation family. */
  familyId?: string | null;
  refreshHash: string;
  expiresAt: Date;
};

export type RotateSessionInput = {
  refreshHash: string;
  newRefreshHash: string;
  newExpiresAt: Date;
  now: Date;
};

export type RotateSessionResult =
  | {
      status: "rotated";
      session: { id: string; userId: string; familyId: string };
    }
  /** A token that was already rotated or revoked was presented again. */
  | { status: "reused"; userId: string }
  | { status: "invalid" };

const SELECT_USER_COLUMNS = `
select
  u.id as id,
  u.email as email,
  u.display_name as display_name,
  u.status as status,
  u.token_version as token_version,
  u.must_change_password as must_change_password,
  c.password_hash as password_hash
from hahart_auth.users as u
left join hahart_auth.credentials as c on c.user_id = u.id
`;

const SELECT_USER_BY_EMAIL_SQL = `${SELECT_USER_COLUMNS}
where lower(u.email) = lower($1)
limit 1
`;

const SELECT_USER_BY_ID_SQL = `${SELECT_USER_COLUMNS}
where u.id = $1::uuid
limit 1
`;

const INSERT_USER_SQL = `
insert into hahart_auth.users (id, email, display_name)
values ($1::uuid, $2, $3)
`;

const INSERT_CREDENTIAL_SQL = `
insert into hahart_auth.credentials (user_id, password_hash)
values ($1::uuid, $2)
`;

const UPSERT_CREDENTIAL_SQL = `
insert into hahart_auth.credentials (user_id, password_hash)
values ($1::uuid, $2)
on conflict (user_id) do update
  set password_hash = excluded.password_hash,
      updated_at = now()
`;

const UPDATE_USER_STATUS_SQL = `
update hahart_auth.users
   set status = $2,
       updated_at = now()
 where id = $1::uuid
`;

/** Password change: bump the credential version so old access tokens die. */
const BUMP_TOKEN_VERSION_SQL = `
update hahart_auth.users
   set token_version = token_version + 1,
       must_change_password = $2,
       updated_at = now()
 where id = $1::uuid
`;

const REVOKE_USER_SESSIONS_SQL = `
update hahart_auth.sessions
   set revoked_at = now()
 where user_id = $1::uuid
   and revoked_at is null
`;

const INSERT_SESSION_SQL = `
insert into hahart_auth.sessions (id, user_id, family_id, refresh_hash, expires_at)
values ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz)
`;

const SELECT_SESSION_BY_REFRESH_SQL = `
select
  id,
  user_id,
  family_id,
  expires_at,
  revoked_at,
  replaced_by
from hahart_auth.sessions
where refresh_hash = $1
limit 1
`;

const SELECT_SESSION_BY_ID_SQL = `
select id, expires_at, revoked_at
from hahart_auth.sessions
where id = $1::uuid
limit 1
`;

const REVOKE_SESSION_SQL = `
update hahart_auth.sessions
   set revoked_at = now()
 where id = $1::uuid
   and revoked_at is null
`;

const REVOKE_FAMILY_SQL = `
update hahart_auth.sessions
   set revoked_at = now()
 where family_id = $1::uuid
   and revoked_at is null
`;

const MARK_ROTATED_SQL = `
update hahart_auth.sessions
   set revoked_at = $2::timestamptz,
       replaced_by = $3::uuid
 where id = $1::uuid
`;

const INSERT_LOGIN_FAILURE_SQL = `
insert into hahart_auth.login_attempts (key, attempted_at)
values ($1, $2::timestamptz)
`;

const COUNT_LOGIN_FAILURES_SQL = `
select count(*)::int as attempts
from hahart_auth.login_attempts
where key = $1
  and attempted_at >= $2::timestamptz
`;

const CLEAR_LOGIN_FAILURES_SQL = `
delete from hahart_auth.login_attempts
 where key = $1
`;

/**
 * Creates a user and its credential in one transaction.
 *
 * The duplicate check runs first (`lower(email)`) so the ordinary "email taken"
 * path is a plain `{ conflict: true }` read, and the unique index on
 * `lower(email)` still guards the race: if two callers interleave, the loser
 * hits a unique violation, which is translated to the same `{ conflict: true }`.
 */
export async function createUser(
  pool: TransactionPool,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const id = randomUUID();

  try {
    return await withPrivilegedTransaction(pool, null, async (client) => {
      const existing = await client.query(
        "select id from hahart_auth.users where lower(email) = lower($1) limit 1",
        [input.email],
      );
      if (existing.rows.length > 0) return { conflict: true } as const;

      await client.query(INSERT_USER_SQL, [
        id,
        input.email,
        input.displayName ?? null,
      ]);
      await client.query(INSERT_CREDENTIAL_SQL, [id, input.passwordHash]);
      return { id } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** Case-insensitive lookup; `null` means "no such user". */
export async function findUserByEmail(
  pool: TransactionPool,
  email: string,
): Promise<AuthUser | null> {
  return withPrivilegedTransaction(pool, null, async (client) => {
    const result = await client.query(SELECT_USER_BY_EMAIL_SQL, [email]);
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  });
}

export async function findUserById(
  pool: TransactionPool,
  id: string,
): Promise<AuthUser | null> {
  return withPrivilegedTransaction(pool, null, async (client) => {
    const result = await client.query(SELECT_USER_BY_ID_SQL, [id]);
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  });
}

/** Administrator approval / suspension. */
export async function setUserStatus(
  pool: TransactionPool,
  id: string,
  status: UserStatus,
): Promise<void> {
  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(UPDATE_USER_STATUS_SQL, [id, status]);
  });
}

/**
 * Replaces the password hash and, in the same transaction, invalidates every
 * session and access token the user already has: `token_version` moves forward
 * (access tokens carry it) and all live sessions are revoked.
 */
export async function setPassword(
  pool: TransactionPool,
  id: string,
  passwordHash: string,
  options: { mustChange: boolean },
): Promise<void> {
  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(UPSERT_CREDENTIAL_SQL, [id, passwordHash]);
    await client.query(BUMP_TOKEN_VERSION_SQL, [id, options.mustChange]);
    await client.query(REVOKE_USER_SESSIONS_SQL, [id]);
  });
}

/** Issues a session row; a missing `familyId` starts a new rotation family. */
export async function createSession(
  pool: TransactionPool,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const id = randomUUID();
  const familyId = input.familyId ?? randomUUID();

  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(INSERT_SESSION_SQL, [
      id,
      input.userId,
      familyId,
      input.refreshHash,
      input.expiresAt.toISOString(),
    ]);
  });

  return { id, familyId };
}

/**
 * Consumes one refresh token and issues its successor.
 *
 * - unknown token -> `invalid`;
 * - expired token -> `invalid`;
 * - token whose row is already revoked or already replaced -> a replay: every
 *   session of that family is revoked and `reused` is reported, which the
 *   caller turns into "log in again";
 * - otherwise the old row is revoked and linked to the new one (`replaced_by`)
 *   and a successor in the same family is inserted, all in one transaction.
 */
export async function rotateSession(
  pool: TransactionPool,
  input: RotateSessionInput,
): Promise<RotateSessionResult> {
  return withPrivilegedTransaction(
    pool,
    null,
    async (client): Promise<RotateSessionResult> => {
      const found = await client.query(SELECT_SESSION_BY_REFRESH_SQL, [
        input.refreshHash,
      ]);
      const raw = found.rows[0];
      if (raw === undefined) return { status: "invalid" };

      const row = asRow(raw);
      const sessionId = requireString(row, "id");
      const userId = requireString(row, "user_id");
      const familyId = requireString(row, "family_id");

      if (asDate(row["expires_at"]).getTime() <= input.now.getTime()) {
        return { status: "invalid" };
      }

      const revokedAt = row["revoked_at"];
      const replacedBy = row["replaced_by"];
      const alreadyRevoked =
        (revokedAt !== null && revokedAt !== undefined) ||
        (replacedBy !== null && replacedBy !== undefined);
      if (alreadyRevoked) {
        await client.query(REVOKE_FAMILY_SQL, [familyId]);
        return { status: "reused", userId };
      }

      const newId = randomUUID();
      await client.query(MARK_ROTATED_SQL, [
        sessionId,
        input.now.toISOString(),
        newId,
      ]);
      await client.query(INSERT_SESSION_SQL, [
        newId,
        userId,
        familyId,
        input.newRefreshHash,
        input.newExpiresAt.toISOString(),
      ]);

      return { status: "rotated", session: { id: newId, userId, familyId } };
    },
  );
}

export async function revokeSession(
  pool: TransactionPool,
  sessionId: string,
): Promise<void> {
  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(REVOKE_SESSION_SQL, [sessionId]);
  });
}

/** Present, not revoked and not expired — at the caller's `now`. */
export async function isSessionActive(
  pool: TransactionPool,
  sessionId: string,
  at: Date,
): Promise<boolean> {
  return withPrivilegedTransaction(pool, null, async (client) => {
    const result = await client.query(SELECT_SESSION_BY_ID_SQL, [sessionId]);
    const raw = result.rows[0];
    if (raw === undefined) return false;

    const row = asRow(raw);
    const revokedAt = row["revoked_at"];
    if (revokedAt !== null && revokedAt !== undefined) return false;

    return asDate(row["expires_at"]).getTime() > at.getTime();
  });
}

/** Appends one failed-login observation for `key` (IP plus email). */
export async function recordLoginFailure(
  pool: TransactionPool,
  key: string,
  at: Date,
): Promise<void> {
  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(INSERT_LOGIN_FAILURE_SQL, [key, at.toISOString()]);
  });
}

/** Failures for `key` at or after `since` — the throttle window's counter. */
export async function countRecentLoginFailures(
  pool: TransactionPool,
  key: string,
  since: Date,
): Promise<number> {
  return withPrivilegedTransaction(pool, null, async (client) => {
    const result = await client.query(COUNT_LOGIN_FAILURES_SQL, [
      key,
      since.toISOString(),
    ]);
    const raw = result.rows[0];
    if (raw === undefined) return 0;

    return requireNumber(asRow(raw), "attempts");
  });
}

/** Successful login: the throttle bucket for `key` starts over. */
export async function clearLoginFailures(
  pool: TransactionPool,
  key: string,
): Promise<void> {
  await withPrivilegedTransaction(pool, null, async (client) => {
    await client.query(CLEAR_LOGIN_FAILURES_SQL, [key]);
  });
}

function mapUser(value: unknown): AuthUser {
  const row = asRow(value);
  const displayName = row["display_name"];
  const passwordHash = row["password_hash"];

  return {
    id: requireString(row, "id"),
    email: requireString(row, "email"),
    displayName:
      displayName === null || displayName === undefined
        ? null
        : requireString(row, "display_name"),
    status: requireStatus(row["status"]),
    tokenVersion: requireNumber(row, "token_version"),
    mustChangePassword: row["must_change_password"] === true,
    passwordHash:
      passwordHash === null || passwordHash === undefined
        ? null
        : requireString(row, "password_hash"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("auth repository received a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`auth repository received no usable "${field}"`);
  }

  return value;
}

function requireNumber(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`auth repository received no usable "${field}"`);
  }

  return value;
}

function requireStatus(value: unknown): UserStatus {
  if (value === "pending" || value === "active" || value === "disabled") {
    return value;
  }

  throw new Error("auth repository received an unusable user status");
}

/** Timestamptz columns come back as `Date`; tolerate a driver that sends text. */
function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new Error("auth repository received an unusable timestamp");
}

/**
 * A unique-index violation is the only database error this module translates:
 * it means "that email" (or refresh hash) is already taken. Everything else —
 * a connection failure, a bad cast, a constraint the caller should know about —
 * keeps propagating.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505") return true;

  const message = error instanceof Error ? error.message : "";
  return /duplicate key value|unique constraint|unique index/i.test(message);
}

/** Kept for callers that hold a client and want the same statement constants. */
export const AUTH_REPOSITORY_SQL = {
  SELECT_USER_BY_EMAIL_SQL,
  SELECT_USER_BY_ID_SQL,
} as const;

export type AuthRepositoryClient = TransactionConnection;
