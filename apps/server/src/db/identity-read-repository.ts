/**
 * Read-only identity repository (workorder 20, ADR-0001 migration step 2).
 *
 * The first slice of the Supabase → `pg` migration. The three PostgREST reads
 * behind the viewer foundation and the two behind team membership move here,
 * behind a narrow, domain-shaped interface instead of a generic builder or a
 * PostgREST-compatible layer.
 *
 * Rules this module keeps:
 *
 * - The only input is a user id. No access token, no Fastify request and no
 *   Supabase client is accepted, so a caller cannot widen the query.
 * - Every value is a bind parameter (`$1`). No user id, column name or table
 *   name is ever concatenated into a statement.
 * - Both reads run through workorder 19's transaction entry point in
 *   `privileged` mode with `{ userId }` as the actor, so the audit trail still
 *   records who asked. `app.execution_mode` is a diagnostic label, never a
 *   grant — real role separation is workorder 24's job.
 * - The pool is obtained lazily through `getTransactionPool`, so importing or
 *   wiring this module never reads `DATABASE_URL`, never connects and never
 *   fails at application-build time.
 * - `null` means exactly one thing: the domain record does not exist. A
 *   connect / SQL / timeout / row-shape failure throws `RepositoryReadError`,
 *   whose own message is fixed text — no SQL, no connection string.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type WorkspaceRole = "owner" | "admin" | "member";

/** The personal workspace plus the profile and membership that must accompany it. */
export type PersonalFoundationRecord = {
  workspace: {
    id: string;
    name: string;
    type: "personal";
    ownerUserId: string;
  };
  profile: {
    id: string;
    email: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  };
  membership: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
  };
};

/** The single team workspace plus the caller's role in it. */
export type TeamMembershipRecord = {
  workspace: {
    id: string;
    name: string;
    type: "team";
    ownerUserId: string;
  };
  role: WorkspaceRole;
};

export type IdentityReadRepository = {
  findPersonalFoundation(
    userId: string,
  ): Promise<PersonalFoundationRecord | null>;
  findTeamMembership(userId: string): Promise<TeamMembershipRecord | null>;
};

export const FIND_PERSONAL_FOUNDATION = "findPersonalFoundation";
export const FIND_TEAM_MEMBERSHIP = "findTeamMembership";

export type IdentityReadOperation =
  | typeof FIND_PERSONAL_FOUNDATION
  | typeof FIND_TEAM_MEMBERSHIP;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class RepositoryReadError extends Error {
  readonly operation: IdentityReadOperation;

  constructor(operation: IdentityReadOperation, cause: unknown) {
    super(
      `identity read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "RepositoryReadError";
    this.operation = operation;
  }
}

/**
 * Personal foundation in one statement, so workspace, profile and membership
 * come from a single snapshot: the inner joins make "workspace missing",
 * "profile missing" and "membership missing" all collapse to zero rows, and
 * there is no window in which a partial record could be assembled.
 *
 * `order by created_at asc limit 1` and the two equality filters reproduce the
 * PostgREST chain this replaces (`.eq("owner_user_id", …).eq("type",
 * "personal").order("created_at").limit(1).maybeSingle()`).
 */
const PERSONAL_FOUNDATION_SQL = `
select
  w.id as workspace_id,
  w.name as workspace_name,
  w.type as workspace_type,
  w.owner_user_id as workspace_owner_user_id,
  p.id as profile_id,
  p.email as profile_email,
  p.display_name as profile_display_name,
  p.avatar_url as profile_avatar_url,
  m.workspace_id as membership_workspace_id,
  m.user_id as membership_user_id,
  m.role as membership_role
from (
  select id, name, type, owner_user_id
  from public.workspaces
  where owner_user_id = $1
    and type = 'personal'
  order by created_at asc
  limit 1
) as w
join public.profiles as p on p.id = $1
join public.workspace_members as m
  on m.workspace_id = w.id
 and m.user_id = $1
`;

/**
 * Team membership in one statement: the earliest team workspace joined to the
 * caller's membership row. Inner join means "no team workspace" and "not a
 * member" both return zero rows, i.e. `null` — the same answer the two-step
 * PostgREST version produced.
 */
const TEAM_MEMBERSHIP_SQL = `
select
  w.id as workspace_id,
  w.name as workspace_name,
  w.type as workspace_type,
  w.owner_user_id as workspace_owner_user_id,
  m.role as membership_role
from (
  select id, name, type, owner_user_id
  from public.workspaces
  where type = 'team'
  order by created_at asc
  limit 1
) as w
join public.workspace_members as m
  on m.workspace_id = w.id
 and m.user_id = $1
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `RepositoryReadError` on an actual read.
 */
export function createIdentityReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): IdentityReadRepository {
  async function read<T>(
    operation: IdentityReadOperation,
    sql: string,
    userId: string,
    map: (row: Readonly<Record<string, unknown>>) => T,
  ): Promise<T | null> {
    try {
      const pool = options.getTransactionPool();

      const rows = await withPrivilegedTransaction(
        pool,
        { userId },
        async (client) => {
          const result = await client.query(sql, [userId]);
          return result.rows;
        },
      );

      if (rows.length > 1) {
        throw new Error("identity read returned more than one row");
      }

      const row = rows[0];
      if (row === undefined) return null;

      return map(asRow(row));
    } catch (error) {
      throw new RepositoryReadError(operation, error);
    }
  }

  return {
    findPersonalFoundation(userId) {
      return read(
        FIND_PERSONAL_FOUNDATION,
        PERSONAL_FOUNDATION_SQL,
        userId,
        mapPersonalFoundation,
      );
    },
    findTeamMembership(userId) {
      return read(
        FIND_TEAM_MEMBERSHIP,
        TEAM_MEMBERSHIP_SQL,
        userId,
        mapTeamMembership,
      );
    },
  };
}

function mapPersonalFoundation(
  row: Readonly<Record<string, unknown>>,
): PersonalFoundationRecord {
  requireWorkspaceType(row, "personal");

  return {
    workspace: {
      id: requireString(row, "workspace_id"),
      name: requireString(row, "workspace_name"),
      ownerUserId: requireString(row, "workspace_owner_user_id"),
      type: "personal",
    },
    profile: {
      id: requireString(row, "profile_id"),
      email: optionalString(row, "profile_email"),
      displayName: optionalString(row, "profile_display_name"),
      avatarUrl: optionalString(row, "profile_avatar_url"),
    },
    membership: {
      workspaceId: requireString(row, "membership_workspace_id"),
      userId: requireString(row, "membership_user_id"),
      role: requireRole(row, "membership_role"),
    },
  };
}

function mapTeamMembership(
  row: Readonly<Record<string, unknown>>,
): TeamMembershipRecord {
  requireWorkspaceType(row, "team");

  return {
    workspace: {
      id: requireString(row, "workspace_id"),
      name: requireString(row, "workspace_name"),
      ownerUserId: requireString(row, "workspace_owner_user_id"),
      type: "team",
    },
    role: requireRole(row, "membership_role"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("identity read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * The statement pins the workspace type in its `where` clause, so a different
 * value means the SQL and this mapper disagree — a bug worth failing loud on
 * rather than returning a record the contract cannot describe.
 */
function requireWorkspaceType(
  row: Readonly<Record<string, unknown>>,
  expected: "personal" | "team",
): void {
  const value = row["workspace_type"];
  if (value !== expected) {
    throw new Error(`identity read returned a non-${expected} workspace`);
  }
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`identity read returned no usable "${field}"`);
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
    throw new Error(`identity read returned an unusable "${field}"`);
  }

  return value;
}

function requireRole(
  row: Readonly<Record<string, unknown>>,
  field: string,
): WorkspaceRole {
  const value = requireString(row, field);
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }

  throw new Error(`identity read returned an unusable "${field}"`);
}
