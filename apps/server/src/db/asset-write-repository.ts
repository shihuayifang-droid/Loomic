/**
 * Asset write repository (workorder 21AA, ADR-0001 migration step).
 *
 * The ONE PostgREST write left in `features/uploads/upload-service.ts` — the row
 * delete at the end of `deleteAsset` — moves here. The service keeps every error
 * code, HTTP status and message it had, including the "zero rows deleted is
 * success" answer.
 *
 * Rules this module keeps, and why each one matters:
 *
 * - The interface is CLOSED: one method with one fixed statement. No table name,
 *   no column and no predicate ever arrives from the caller.
 * - The statement runs through workorder 19's transaction entry point with the
 *   actor in the context. The pool's role owns the table and therefore bypasses
 *   row level security, which is why the authorisation rule has to be the
 *   statement's OWN predicate; the context is an audit trail and grants nothing.
 * - The ACL is `asset_objects_delete_self` of
 *   `supabase/migrations/20260929000001_hahart_team_workspace_private_rls.sql`
 *   translated verbatim:
 *
 *       using (created_by = auth.uid()
 *              and private.is_workspace_member(workspace_id)
 *              and (project_id is null
 *                   or private.can_write_project(project_id)))
 *
 *   `$1::uuid` is `auth.uid()`, so the three conjuncts are, in order:
 *   `a.created_by = $1::uuid`; the body of `private.is_workspace_member` with the
 *   argument bound to `a.workspace_id`; and the body of
 *   `private.can_write_project` with the argument bound to `a.project_id`. The
 *   last one is itself
 *
 *       exists (select 1 from public.projects p
 *                where p.id = p_project_id
 *                  and p.created_by = auth.uid()
 *                  and private.is_workspace_member(p.workspace_id))
 *
 *   so it is written out with its own membership conjunct rather than collapsed
 *   into the outer one. The FK `asset_objects_project_workspace_fkey` binds
 *   `(project_id, workspace_id)`, which makes that conjunct redundant IN FACT —
 *   and it is kept anyway, because the policy keeps it and a translation that
 *   optimises away a clause is no longer a translation.
 * - NO administrator escape and NO archive filter. The delete policy has neither:
 *   `admin`/`owner` widen the SELECT policy only, and `archived_at` is not a term
 *   anywhere in it.
 * - Zero rows is an ANSWER, not an error: `{deleted: 0}`. The removed write did
 *   not inspect the count either, and the caller's existing answer stays 204.
 * - `project_id` NULL is covered on purpose: an asset with no project inherits
 *   nothing, so the `is null or …` branch is the whole authorisation for it.
 * - Every value is a bind parameter with an explicit cast, so a malformed uuid
 *   fails as a real SQL error (SQLSTATE 22P02) inside the transaction and rolls
 *   it back, and a quote in the bound value is just data.
 * - An unusable argument (a non-empty string is required) throws
 *   `AssetWriteError` WITHOUT opening a connection.
 * - A connect, SQL, timeout or row-shape failure throws `AssetWriteError`, whose
 *   own message is fixed text naming only the operation: no SQL, no host, no
 *   connection string and no asset id. The driver's own error rides along as
 *   `cause`.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 *   Nothing in this module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type AssetWriteRepository = {
  /**
   * Delete the actor's own asset row. `deleted` is 0 when the row does not exist,
   * belongs to somebody else, sits in a workspace the actor is not a member of, or
   * points at a project the actor may not write — never an error.
   */
  deleteOwnAsset(input: {
    actorId: string;
    assetId: string;
  }): Promise<{ deleted: number }>;
};

export const DELETE_OWN_ASSET = "deleteOwnAsset";

export type AssetWriteOperation = typeof DELETE_OWN_ASSET;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class AssetWriteError extends Error {
  readonly operation: AssetWriteOperation;

  constructor(operation: AssetWriteOperation, cause: unknown) {
    super(
      `asset write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "AssetWriteError";
    this.operation = operation;
  }
}

/**
 * `deleteOwnAsset`: the row delete at the end of `DELETE /api/assets/:assetId`.
 *
 * The service removes the storage object FIRST and calls this SECOND; that order
 * is part of the contract and stays in the service. Only the row delete moved.
 *
 * The three conjuncts are the three conjuncts of `asset_objects_delete_self`, in
 * the policy's order, with `$1::uuid` standing in for `auth.uid()` and
 * `$2::uuid` for the row id. The two `exists` subqueries are the bodies of
 * `private.is_workspace_member(a.workspace_id)` and
 * `private.can_write_project(a.project_id)`; the inner one is aliased `pm` so the
 * two membership checks stay separately readable.
 */
const DELETE_OWN_ASSET_SQL = `
delete from public.asset_objects a
 where a.id = $2::uuid
   and a.created_by = $1::uuid
   and exists (select 1 from public.workspace_members m
                where m.workspace_id = a.workspace_id
                  and m.user_id = $1::uuid)
   and (a.project_id is null
        or exists (select 1 from public.projects p
                    where p.id = a.project_id
                      and p.created_by = $1::uuid
                      and exists (select 1 from public.workspace_members pm
                                   where pm.workspace_id = p.workspace_id
                                     and pm.user_id = $1::uuid)))
returning a.id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as an `AssetWriteError` on an actual delete.
 *
 * There is no fallback path. A caller that was handed this repository either
 * deletes through it or fails.
 */
export function createAssetWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AssetWriteRepository {
  return {
    async deleteOwnAsset(input) {
      const actorId = requireWriteArgument(input.actorId, "actorId");
      const assetId = requireWriteArgument(input.assetId, "assetId");

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          // WHO asked rides along for the audit trail; the predicate above is the
          // authorisation rule.
          { userId: actorId },
          async (client) => {
            const result = await client.query(DELETE_OWN_ASSET_SQL, [
              actorId,
              assetId,
            ]);

            // `returning a.id` is the row count. Zero is a legitimate answer — the
            // predicate refused the row — and the caller maps it onto its existing
            // success.
            return { deleted: result.rows.length };
          },
        );
      } catch (error) {
        throw new AssetWriteError(DELETE_OWN_ASSET, error);
      }
    },
  };
}

/**
 * A bound value is only usable when it is a real, non-empty string.
 *
 * The UUID SHAPE is deliberately not checked here: a malformed id is bound as
 * `::uuid`, so PostgreSQL rejects it (SQLSTATE 22P02) inside the transaction, the
 * transaction rolls back and the connection stays usable.
 */
function requireWriteArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AssetWriteError(
      DELETE_OWN_ASSET,
      new Error(`asset write needs a non-empty "${field}"`),
    );
  }

  return value;
}
