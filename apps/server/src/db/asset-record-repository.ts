/**
 * The single entry point for recording a stored object (workorder 44B,
 * migration plan 25 "asset record" 1/7).
 *
 * One statement over `public.record_project_asset`. The SQL function is the
 * only place that decides which project and workspace an object belongs to,
 * whether a repeat call is a no-op, and whether a different caller may touch an
 * existing row. Every caller that stores an object goes through this module
 * instead of repeating that statement.
 *
 * Rules this module keeps:
 *
 * - A database error is NOT wrapped. It is thrown as it came, so the SQLSTATE
 *   (`err.code`: 23505 / P0002 / 22023) reaches the caller, which maps it to
 *   its own error type. The transaction has rolled back by then.
 * - The statement runs through the privileged transaction entry point with the
 *   creator as the actor, so the write stays attributable.
 * - All values are bind parameters; nothing a caller passes becomes SQL text.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type RecordProjectAssetInput = {
  bucket: string;
  objectPath: string;
  createdBy: string;
  fallbackWorkspaceId: string;
  projectId?: string | null;
  canvasId?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
};

export type RecordedProjectAsset = {
  assetId: string;
  workspaceId: string;
  projectId: string | null;
};

export type AssetRecordRepository = {
  /** Record one object; idempotent per bucket + path. Throws the database error as is (`code` = SQLSTATE). */
  recordProjectAsset(
    input: RecordProjectAssetInput,
  ): Promise<RecordedProjectAsset>;
};

const RECORD_SQL =
  "select public.record_project_asset($1::text, $2::text, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::bigint) as r";

type RecordedJson = {
  asset_id?: unknown;
  workspace_id?: unknown;
  project_id?: unknown;
};

export function createAssetRecordRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AssetRecordRepository {
  return {
    async recordProjectAsset(input) {
      return withPrivilegedTransaction(
        options.getTransactionPool(),
        { userId: input.createdBy },
        async (client) => {
          const result = await client.query(RECORD_SQL, [
            input.bucket,
            input.objectPath,
            input.createdBy,
            input.fallbackWorkspaceId,
            input.projectId ?? null,
            input.canvasId ?? null,
            input.mimeType ?? null,
            input.byteSize ?? null,
          ]);
          const row = result.rows[0] as { r?: RecordedJson | null } | undefined;
          const json = row?.r;
          if (
            json === undefined ||
            json === null ||
            typeof json.asset_id !== "string" ||
            json.asset_id.length === 0
          ) {
            throw new Error("record_project_asset returned no asset id");
          }
          return {
            assetId: json.asset_id,
            workspaceId:
              typeof json.workspace_id === "string" ? json.workspace_id : "",
            projectId:
              typeof json.project_id === "string" ? json.project_id : null,
          };
        },
      );
    },
  };
}
