/**
 * Asset provenance repository (GN-11, workorder 33F).
 *
 * Writes where an artifact came from (source, operation, model, prompt, credits,
 * action, originating job, parent artifact) onto the `asset_objects` row itself,
 * so the answer survives the job row being cleaned up.
 *
 * Rules this module keeps:
 *
 * - The interface is CLOSED: two methods, two fixed statements. No table name,
 *   column or predicate ever arrives from the caller; every value is a bind
 *   parameter with an explicit cast.
 * - `source` is validated BEFORE a connection is opened, with the same rule as the
 *   `asset_objects_source_check` constraint (see `isValidAssetSource`).
 * - Zero updated rows is an ANSWER (`{updated: 0}`), not an error.
 * - Any connect or SQL failure becomes `AssetProvenanceError`, whose message is
 *   fixed text naming only the operation; the driver error rides along as `cause`.
 * - The pool is reached through a getter, so importing this module never reads
 *   `DATABASE_URL` and never connects.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

export type AssetProvenance = {
  /** 'agent' | 'generator' | 'user_upload' | 'sketch' | 'agent:sandbox' | `tool:${string}` */
  source: string;
  operation: string | null;
  modelId: string | null;
  prompt: string | null;
  creditsCharged: number | null;
  actionId: string | null;
  sourceJobId: string | null;
  parentArtifactId: string | null;
};

export type AssetProvenanceRepository = {
  /** Write provenance onto ONE existing asset row; answers how many rows it changed (0 or 1). */
  recordProvenance(input: {
    actorId: string | null;
    assetId: string;
    provenance: AssetProvenance;
  }): Promise<{ updated: number }>;
  /** Read it back (for the API and for tests). null when the row does not exist. */
  readProvenance(input: {
    assetId: string;
  }): Promise<(AssetProvenance & { assetId: string }) | null>;
  /**
   * ED-05: keep the name a person gave the file next to the ASCII object key.
   * Answers how many rows it changed (0 or 1).
   */
  recordDisplayName(input: {
    actorId: string | null;
    assetId: string;
    displayName: string;
  }): Promise<{ updated: number }>;
  /** Read that name back. null when the row is missing or carries no name. */
  readDisplayName(input: { assetId: string }): Promise<string | null>;
};

export const RECORD_PROVENANCE = "recordProvenance";
export const READ_PROVENANCE = "readProvenance";
export const RECORD_DISPLAY_NAME = "recordDisplayName";
export const READ_DISPLAY_NAME = "readDisplayName";

export type AssetProvenanceOperation =
  | typeof RECORD_PROVENANCE
  | typeof READ_PROVENANCE
  | typeof RECORD_DISPLAY_NAME
  | typeof READ_DISPLAY_NAME;

export class AssetProvenanceError extends Error {
  readonly operation: AssetProvenanceOperation;

  constructor(operation: AssetProvenanceOperation, cause: unknown) {
    super(
      `asset provenance failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "AssetProvenanceError";
    this.operation = operation;
  }
}

const FIXED_SOURCES: readonly string[] = [
  "agent",
  "generator",
  "user_upload",
  "sketch",
  "agent:sandbox",
];

const TOOL_SOURCE_PATTERN = /^tool:[a-z0-9_]+$/;

/** Same rule as the `asset_objects_source_check` constraint. */
export function isValidAssetSource(source: string): boolean {
  if (typeof source !== "string") return false;
  return FIXED_SOURCES.includes(source) || TOOL_SOURCE_PATTERN.test(source);
}

const RECORD_PROVENANCE_SQL = `
update public.asset_objects
   set source = $2::text, operation = $3::text, model_id = $4::text, prompt = $5::text,
       credits_charged = $6::integer, action_id = $7::text,
       source_job_id = $8::uuid, parent_artifact_id = $9::uuid
 where id = $1::uuid
returning id
`;

const READ_PROVENANCE_SQL = `
select id::text as asset_id, source, operation, model_id, prompt, credits_charged,
       action_id, source_job_id::text as source_job_id,
       parent_artifact_id::text as parent_artifact_id
  from public.asset_objects
 where id = $1::uuid
`;

type ProvenanceRow = {
  asset_id: string;
  source: string;
  operation: string | null;
  model_id: string | null;
  prompt: string | null;
  credits_charged: number | null;
  action_id: string | null;
  source_job_id: string | null;
  parent_artifact_id: string | null;
};

const RECORD_DISPLAY_NAME_SQL = `
update public.asset_objects
   set display_name = $2::text
 where id = $1::uuid
returning id
`;

const READ_DISPLAY_NAME_SQL = `
select display_name
  from public.asset_objects
 where id = $1::uuid
`;

/** ED-05: same rule as the `asset_objects_display_name_check` constraint. */
const DISPLAY_NAME_MAX_LENGTH = 255;

export function createAssetProvenanceRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AssetProvenanceRepository {
  return {
    async recordProvenance(input) {
      validateRecordInput(input);
      const { assetId, provenance } = input;

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          input.actorId ? { userId: input.actorId } : null,
          async (client) => {
            const result = await client.query(RECORD_PROVENANCE_SQL, [
              assetId,
              provenance.source,
              provenance.operation,
              provenance.modelId,
              provenance.prompt,
              provenance.creditsCharged,
              provenance.actionId,
              provenance.sourceJobId,
              provenance.parentArtifactId,
            ]);

            return { updated: result.rows.length };
          },
        );
      } catch (error) {
        throw new AssetProvenanceError(RECORD_PROVENANCE, error);
      }
    },

    async readProvenance(input) {
      if (typeof input?.assetId !== "string" || input.assetId.length === 0) {
        throw new AssetProvenanceError(
          READ_PROVENANCE,
          new Error('asset provenance needs a non-empty "assetId"'),
        );
      }

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(READ_PROVENANCE_SQL, [
            input.assetId,
          ]);
          const row = result.rows[0] as ProvenanceRow | undefined;

          if (row === undefined) return null;

          return {
            assetId: row.asset_id,
            source: row.source,
            operation: row.operation,
            modelId: row.model_id,
            prompt: row.prompt,
            creditsCharged: row.credits_charged,
            actionId: row.action_id,
            sourceJobId: row.source_job_id,
            parentArtifactId: row.parent_artifact_id,
          };
        });
      } catch (error) {
        throw new AssetProvenanceError(READ_PROVENANCE, error);
      }
    },

    async recordDisplayName(input) {
      const displayName = validateRecordDisplayNameInput(input);

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(
          pool,
          input.actorId ? { userId: input.actorId } : null,
          async (client) => {
            const result = await client.query(RECORD_DISPLAY_NAME_SQL, [
              input.assetId,
              displayName,
            ]);

            return { updated: result.rows.length };
          },
        );
      } catch (error) {
        throw new AssetProvenanceError(RECORD_DISPLAY_NAME, error);
      }
    },

    async readDisplayName(input) {
      if (typeof input?.assetId !== "string" || input.assetId.length === 0) {
        throw new AssetProvenanceError(
          READ_DISPLAY_NAME,
          new Error('asset provenance needs a non-empty "assetId"'),
        );
      }

      try {
        const pool = options.getTransactionPool();

        return await withPrivilegedTransaction(pool, null, async (client) => {
          const result = await client.query(READ_DISPLAY_NAME_SQL, [
            input.assetId,
          ]);
          const row = result.rows[0] as { display_name: string | null } | undefined;

          if (row === undefined || row.display_name === null) return null;

          return row.display_name;
        });
      } catch (error) {
        throw new AssetProvenanceError(READ_DISPLAY_NAME, error);
      }
    },
  };
}

/** Unusable input is refused before any connection is opened. */
function validateRecordInput(input: {
  assetId: string;
  provenance: AssetProvenance;
}): void {
  if (typeof input?.assetId !== "string" || input.assetId.length === 0) {
    throw new AssetProvenanceError(
      RECORD_PROVENANCE,
      new Error('asset provenance needs a non-empty "assetId"'),
    );
  }

  const provenance = input.provenance;

  if (!isValidAssetSource(provenance?.source)) {
    throw new AssetProvenanceError(
      RECORD_PROVENANCE,
      new Error("asset provenance needs a valid source"),
    );
  }

  const credits = provenance.creditsCharged;

  if (credits !== null && !(Number.isInteger(credits) && credits >= 0)) {
    throw new AssetProvenanceError(
      RECORD_PROVENANCE,
      new Error("asset provenance needs a non-negative integer creditsCharged"),
    );
  }
}

/**
 * ED-05: unusable input is refused before any connection is opened, and the
 * name that reaches the database is the trimmed one.
 */
function validateRecordDisplayNameInput(input: {
  assetId: string;
  displayName: string;
}): string {
  if (typeof input?.assetId !== "string" || input.assetId.length === 0) {
    throw new AssetProvenanceError(
      RECORD_DISPLAY_NAME,
      new Error('asset provenance needs a non-empty "assetId"'),
    );
  }

  if (typeof input?.displayName !== "string") {
    throw new AssetProvenanceError(
      RECORD_DISPLAY_NAME,
      new Error("asset provenance needs a string displayName"),
    );
  }

  const trimmed = input.displayName.trim();

  if (
    trimmed.length < 1 ||
    trimmed.length > DISPLAY_NAME_MAX_LENGTH
  ) {
    throw new AssetProvenanceError(
      RECORD_DISPLAY_NAME,
      new Error(
        "asset provenance needs a displayName that is 1 to 255 characters after trimming",
      ),
    );
  }

  return trimmed;
}
