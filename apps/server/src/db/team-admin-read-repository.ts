/**
 * Read-only team administration repository (workorder 20F-A, ADR-0001 migration
 * step 2f).
 *
 * One read moves here: the member list behind `GET /api/admin/team/members`,
 * which used to be three PostgREST reads (the first `type='team'` workspace, that
 * workspace's `workspace_members` rows, then the `profiles` of those members).
 * They are one statement now, so the workspace, the membership proof and the
 * members all come from a single snapshot — there is no window in which the list
 * could be assembled from two different team workspaces.
 *
 * Access control is part of the SQL now, not a side effect of the environment:
 * the database owner bypasses RLS, so the predicate has to be in the statement.
 *
 * - the actor must hold a `workspace_members` row in the team workspace with
 *   role `admin` or `owner`. There is deliberately NO `workspaces.owner_user_id`
 *   shortcut: the legacy policy helper `private.is_workspace_admin_or_owner`
 *   grants on that column alone, and copying that branch would let a workspace
 *   owner who holds no membership row read the roster. Self-owned access
 *   requires a real membership row.
 * - no team workspace, and "the actor may not read this team", are the same
 *   answer: an empty list. A partial list or a distinguishable error would leak
 *   whether a team exists.
 * - `profiles` is LEFT JOINed: a member whose profile row is missing is still a
 *   member and is still listed, projected as `email: ""` / `displayName: null`
 *   exactly as the old two-step read did. An inner join would silently drop
 *   members.
 *
 * This runs on the PGlite/PostgreSQL path (`withPrivilegedTransaction`), which
 * writes the actor into the transaction settings, so audit trails keep who asked.
 * `app.execution_mode` is a diagnostic label and is never consulted for
 * authorization here — real database privileges are workorder 24's job.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter (`$1`). No id, column name or table name is
 *   ever concatenated into a statement.
 * - An empty array means exactly "nothing the caller may read". A connect, SQL,
 *   timeout or row-shape failure throws `TeamAdminReadError`, whose own message
 *   is fixed text: no SQL, no host, no connection string.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 */

import type { TeamMember } from "@loomic/shared";

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type TeamAdminReadRepository = {
  listTeamMembers(input: { actorId: string }): Promise<TeamMember[]>;
};

export const LIST_TEAM_MEMBERS = "listTeamMembers";

export type TeamAdminReadOperation = typeof LIST_TEAM_MEMBERS;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class TeamAdminReadError extends Error {
  readonly operation: TeamAdminReadOperation;

  constructor(operation: TeamAdminReadOperation, cause: unknown) {
    super(
      `team admin read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "TeamAdminReadError";
    this.operation = operation;
  }
}

/**
 * The member list in one statement.
 *
 * The subquery pins the team workspace the way the PostgREST chain did
 * (`type = 'team'`, `order by created_at asc`, `limit 1`); the unique index
 * `workspaces_single_team_key` means there is at most one, so the ordering only
 * has to be deterministic, not selective.
 *
 * `join public.workspace_members as actor` is the ACL: it matches only when the
 * actor has a row in THAT workspace with role `admin` or `owner`. Zero rows then
 * propagate through the whole statement, which is why "no team workspace",
 * "not a member" and "plain member" all answer `[]` without a second round trip.
 *
 * `join public.workspace_members as m` lists every member of the same workspace,
 * owner included, and `order by m.created_at asc` reproduces the old ordering.
 * `m.user_id` is appended as a tiebreaker only: rows written in one transaction
 * share `created_at` to the microsecond, and without it the order of those rows
 * would be whatever the planner felt like. It never overrides `created_at`.
 *
 * `left join public.profiles` and not an inner join: a member without a profile
 * row must still come back (see the module header).
 */
const LIST_TEAM_MEMBERS_SQL = `
select
  m.user_id as user_id,
  m.role as role,
  m.created_at as created_at,
  p.email as email,
  p.display_name as display_name
from (
  select id
  from public.workspaces
  where type = 'team'
  order by created_at asc
  limit 1
) as w
join public.workspace_members as actor
  on actor.workspace_id = w.id
 and actor.user_id = $1
 and actor.role in ('admin', 'owner')
join public.workspace_members as m
  on m.workspace_id = w.id
left join public.profiles as p
  on p.id = m.user_id
order by m.created_at asc, m.user_id asc
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `TeamAdminReadError` on an actual read.
 */
export function createTeamAdminReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): TeamAdminReadRepository {
  return {
    async listTeamMembers({ actorId }) {
      try {
        const pool = options.getTransactionPool();

        const rows = await withPrivilegedTransaction(
          pool,
          { userId: actorId },
          async (client) => {
            const result = await client.query(LIST_TEAM_MEMBERS_SQL, [actorId]);
            return result.rows;
          },
        );

        return mapTeamMembers(rows);
      } catch (error) {
        throw new TeamAdminReadError(LIST_TEAM_MEMBERS, error);
      }
    },
  };
}

/**
 * Map every row, then reject a repeated `user_id`.
 *
 * `workspace_members` is keyed by `(workspace_id, user_id)` and `profiles.id` is
 * a primary key, so the statement cannot produce a duplicate member. Seeing one
 * therefore means the SQL and this module disagree — failing loud beats letting
 * one row silently win and publishing a roster nobody can reconcile.
 */
function mapTeamMembers(rows: readonly unknown[]): TeamMember[] {
  const members = rows.map((row) => mapTeamMember(asRow(row)));
  const seen = new Set<string>();

  for (const member of members) {
    if (seen.has(member.userId)) {
      throw new Error("team admin read returned a duplicate member");
    }

    seen.add(member.userId);
  }

  return members;
}

function mapTeamMember(row: Readonly<Record<string, unknown>>): TeamMember {
  const profileEmail = optionalText(row, "email");
  const displayName = optionalText(row, "display_name");

  return {
    userId: requireText(row, "user_id"),
    // The old projection was `profile?.email ?? ""`: a missing profile and a
    // profile whose email is NULL both answered an empty string, and the HTTP
    // schema (`email: z.string()`) cannot carry null.
    email: profileEmail ?? "",
    displayName,
    role: requireRole(row, "role"),
    joinedAt: requireTimestamp(row, "created_at"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("team admin read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/** A `NOT NULL` text column that must carry a value: empty is not a user id. */
function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`team admin read returned no usable "${field}"`);
  }

  return value;
}

/**
 * Read a nullable column, keeping "the database answered NULL" apart from "the
 * result row does not carry the column at all".
 *
 * `email` and `display_name` are the only nullable columns this module accepts,
 * and a nullable column has exactly one legal absent value: the field is present
 * on the row and is `null`. A row that never had the field — a column dropped
 * from the statement, a drifting alias, a half-built driver row — or one that
 * carries an explicit `undefined` means the statement and this module disagree.
 * Folding that into a business `null` would serve a column drift as a legitimate
 * answer (a missing profile would read as "this member has no email"), so it
 * fails loud, and the guard around the read turns it into a fixed
 * `TeamAdminReadError`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `field in row`: an inherited
 * key is not a column the statement selected.
 */
function requireNullableField(
  row: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`team admin read returned no "${field}"`);
  }

  const value = row[field];
  if (value === undefined) {
    throw new Error(`team admin read returned an unusable "${field}"`);
  }

  return value;
}

/** A nullable text column: a present `null` is a real answer, anything else is not. */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = requireNullableField(row, field);
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`team admin read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * The three roles the contract knows. `workspace_member_role` is an enum in the
 * database, so anything else means the statement and the shared schema drifted
 * apart — a role the HTTP contract cannot publish must not be passed through.
 */
function requireRole(
  row: Readonly<Record<string, unknown>>,
  field: string,
): TeamMember["role"] {
  const value = row[field];

  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }

  throw new Error(`team admin read returned an unusable "${field}"`);
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the shared contract
 * (`timestampSchema`) wants a string with an offset. Both are accepted and
 * normalised, anything else fails loud — an unreadable join date would silently
 * become a member the client cannot render.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`team admin read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`team admin read returned no usable "${field}"`);
}
