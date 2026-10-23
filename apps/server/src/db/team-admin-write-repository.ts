/**
 * The team administration write functions (workorder 44L, migration plan 25,
 * OP-03, AD-08).
 *
 * One statement per SQL function: `public.admin_add_team_member`,
 * `public.admin_set_team_member_role`, `public.admin_remove_team_member`,
 * `public.record_foreign_read` and `public.record_foreign_asset_read`. They run
 * through the privileged transaction entry point of workorder 19 with a NULL
 * actor: the functions take the acting admin as an argument (`p_actor`) and
 * check it themselves, so the caller's identity is never taken from the session.
 *
 * Same rules as `credit-ledger-function-repository.ts`:
 *
 * - A database error is NOT wrapped. It is thrown as it came, so the SQLSTATE
 *   (`err.code`: 42501 not a team admin, P0002 target not found, 22023 refused
 *   argument) reaches the service, which maps it by `code`. The transaction has
 *   rolled back by then, so a refused call never leaves a half-written audit row.
 * - All ids and the role are bind parameters; nothing a caller passes becomes
 *   SQL text. The role is cast to `public.workspace_member_role` in SQL.
 * - A result row without a usable value is an error, never a silent default.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type TeamAdminRole = "admin" | "member" | "owner";

export type TeamAdminRemoveResult = {
  removed: number;
  projects: number;
  assets: number;
  objects: number;
};

export type TeamAdminWriteRepository = {
  /** Add a member; true when added, false when already a member. Throws the database error as is. */
  addMember(input: {
    actorId: string;
    userId: string;
    role: TeamAdminRole;
  }): Promise<boolean>;
  /** Change a member's role; true when changed, false when unchanged. */
  setRole(input: {
    actorId: string;
    userId: string;
    role: TeamAdminRole;
  }): Promise<boolean>;
  /** Remove a member and hand their projects and assets to the actor; counts of what moved. */
  removeMember(input: {
    actorId: string;
    userId: string;
  }): Promise<TeamAdminRemoveResult>;
  /** Audit a read of someone else's project, canvas or chat session; false when it is the actor's own. */
  recordForeignRead(input: {
    actorId: string;
    via: string;
    projectId?: string | null | undefined;
    canvasId?: string | null | undefined;
    sessionId?: string | null | undefined;
  }): Promise<boolean>;
  /** Audit a read of someone else's asset; false when it is the actor's own. */
  recordForeignAssetRead(input: {
    actorId: string;
    assetId: string;
  }): Promise<boolean>;
};

const ADD_MEMBER_SQL =
  "select public.admin_add_team_member($1::uuid, $2::uuid, $3::public.workspace_member_role) as v";

const SET_ROLE_SQL =
  "select public.admin_set_team_member_role($1::uuid, $2::uuid, $3::public.workspace_member_role) as v";

const REMOVE_MEMBER_SQL =
  "select public.admin_remove_team_member($1::uuid, $2::uuid) as v";

const FOREIGN_READ_SQL =
  "select public.record_foreign_read($1::uuid, $2::text, $3::uuid, $4::uuid, $5::uuid) as v";

const FOREIGN_ASSET_READ_SQL =
  "select public.record_foreign_asset_read($1::uuid, $2::uuid) as v";

function booleanValue(rows: readonly unknown[], name: string): boolean {
  const row = rows[0] as { v?: unknown } | undefined;
  if (row === undefined || typeof row.v !== "boolean") {
    throw new Error(`${name} returned no value`);
  }
  return row.v;
}

function countOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function createTeamAdminWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): TeamAdminWriteRepository {
  return {
    async addMember(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(ADD_MEMBER_SQL, [
            input.actorId,
            input.userId,
            input.role,
          ]);
          return booleanValue(result.rows, "admin_add_team_member");
        },
      );
    },

    async setRole(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(SET_ROLE_SQL, [
            input.actorId,
            input.userId,
            input.role,
          ]);
          return booleanValue(result.rows, "admin_set_team_member_role");
        },
      );
    },

    async removeMember(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(REMOVE_MEMBER_SQL, [
            input.actorId,
            input.userId,
          ]);
          const row = result.rows[0] as { v?: unknown } | undefined;
          if (row === undefined || row.v === null || typeof row.v !== "object") {
            throw new Error("admin_remove_team_member returned no value");
          }
          const value = row.v as Record<string, unknown>;
          return {
            removed: countOf(value.removed),
            projects: countOf(value.projects),
            assets: countOf(value.assets),
            objects: countOf(value.objects),
          };
        },
      );
    },

    async recordForeignRead(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(FOREIGN_READ_SQL, [
            input.actorId,
            input.via,
            input.projectId ?? null,
            input.canvasId ?? null,
            input.sessionId ?? null,
          ]);
          return booleanValue(result.rows, "record_foreign_read");
        },
      );
    },

    async recordForeignAssetRead(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        null,
        async (client) => {
          const result = await client.query(FOREIGN_ASSET_READ_SQL, [
            input.actorId,
            input.assetId,
          ]);
          return booleanValue(result.rows, "record_foreign_asset_read");
        },
      );
    },
  };
}
