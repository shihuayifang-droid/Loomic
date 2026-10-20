/**
 * Read-only asset repository (workorder 20E, ADR-0001 migration step 2e).
 *
 * One lookup moves here, shared by the two write flows that need it:
 *
 * 1. `uploadFile` reads back the row `record_project_asset` just created, so the
 *    response DTO carries the real `created_at` instead of a copied value;
 * 2. `deleteAsset` locates `bucket` / `object_path` before removing the object.
 *
 * Both used to read `asset_objects` through PostgREST with the caller's token.
 * Access control is part of the SQL now, not a side effect of the environment:
 * the database owner bypasses RLS, so the predicate has to be in the statement.
 * The statement copies the readable semantics the RLS policy
 * (`asset_objects_select_reader`) has today:
 *
 * - the caller must hold a membership row in the asset's workspace, and
 * - when `project_id` is set, the caller is that project's author or holds
 *   `admin`/`owner` in its workspace (the FK `asset_objects_project_workspace_fkey`
 *   binds `(project_id, workspace_id)` to the project, so it is the same
 *   workspace);
 * - when `project_id` is null the asset has no project to inherit from, so the
 *   caller is the asset's creator or holds `admin`/`owner` in the workspace.
 *
 * There is deliberately NO archive filter: an asset inherits a project's ACL for
 * read, and the two callers above are writes that were never filtered by
 * `archived_at`. `app.execution_mode` is a diagnostic label and is never
 * consulted for authorization — the transaction still carries the actor.
 *
 * Rules this module keeps:
 *
 * - Every value is a bind parameter (`$1`, `$2`); no id or column is ever
 *   concatenated into the statement.
 * - Zero rows mean `null` — "no such asset", "not yours" and "deleted" are one
 *   answer, and the callers map it to their existing 403/404/500.
 * - A second row, a missing or unusable column, a connect, SQL or timeout
 *   failure throws `AssetReadError`, whose own message is fixed text: no SQL, no
 *   host, no connection string.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time.
 */

import {
  withPrivilegedTransaction,
  type TransactionPool,
} from "./transaction.js";

/**
 * The full row the write flows need, in the column names the database uses: the
 * upload DTO is built from these eight fields, and `deleteAsset` reads two of
 * them. Nothing else is selected.
 */
export type AssetReadRow = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: number | null;
  workspace_id: string;
  project_id: string | null;
  created_at: string;
};

export type AssetReadRepository = {
  findReadableAsset(input: {
    actorId: string;
    assetId: string;
  }): Promise<AssetReadRow | null>;
};

/**
 * One row of the project upload list (AS-06): the eight columns above plus the
 * name a person gave the file (`asset_objects.display_name`, ED-05). It is a
 * separate row type and not a wider `AssetReadRow`: the single-asset callers
 * build their DTO from exactly eight fields, and a list-only column must not
 * appear to be one of them.
 */
export type AssetReadListRow = AssetReadRow & { display_name: string | null };

/** The upload kinds the reference drawer filters by (AS-06). */
export type AssetUploadMediaType = "image" | "video" | "pdf";

/** The two fixed orderings (AS-06): newest upload first, or oldest first. */
export type AssetUploadOrder = "newest" | "oldest";

export type ListReadableProjectUploadsInput = {
  actorId: string;
  projectId: string;
  order: AssetUploadOrder;
  mediaType?: AssetUploadMediaType | undefined;
  /** 1..200; anything else is refused before a connection is opened. */
  limit: number;
};

/**
 * The project upload list added in 34N, kept as its own type instead of growing
 * `AssetReadRepository`: that type is faked field by field by callers
 * (`agent/runtime.test.ts`) that only ever need one asset by id, and widening a
 * type they already satisfy would force those fakes to grow a method they never
 * call. `createAssetReadRepository` returns this wider type.
 */
export type AssetReadListRepository = AssetReadRepository & {
  listReadableProjectUploads(
    input: ListReadableProjectUploadsInput,
  ): Promise<AssetReadListRow[]>;
};

export const FIND_READABLE_ASSET = "findReadableAsset";

/** AS-06: the project's own uploads, newest or oldest first, optionally by kind. */
export const LIST_READABLE_PROJECT_UPLOADS = "listReadableProjectUploads";

export type AssetReadOperation =
  | typeof FIND_READABLE_ASSET
  | typeof LIST_READABLE_PROJECT_UPLOADS;

/** The inclusive bounds `limit` must sit in; the caller clamps to the same ones. */
export const PROJECT_UPLOAD_LIMIT_MIN = 1;
export const PROJECT_UPLOAD_LIMIT_MAX = 200;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class AssetReadError extends Error {
  readonly operation: AssetReadOperation;

  constructor(operation: AssetReadOperation, cause: unknown) {
    super(`asset read failed (${operation})`, cause === undefined ? {} : { cause });
    this.name = "AssetReadError";
    this.operation = operation;
  }
}

/**
 * The single-asset read, plus the ACL pieces it shares with the project upload
 * list (AS-06).
 *
 * `$1` is the actor and is used twice on purpose: once to require a membership
 * row in the asset's workspace, once to recognise the author (of the project
 * when there is one, of the asset itself when there is not). The `case` mirrors
 * the policy's own two branches rather than collapsing them, because the two
 * differ in exactly one column and reading the statement should not require
 * remembering that.
 *
 * `left join` and not `join`: an asset WITHOUT a project must still be found,
 * and the project is only consulted by the branch that has one.
 *
 * The ACL is the two pieces below: the joins that
 * carry the membership row and the project, and the predicate that decides
 * readability. Both statements below use THESE constants, so the single-asset
 * lookup and the project upload list cannot drift apart — a widening of one is
 * a widening of both, in the same edit.
 *
 * `$1` is the actor in both pieces, on purpose: once to require a membership row
 * in the asset's workspace, once to recognise the author (of the project when
 * there is one, of the asset itself when there is not).
 */
const READABLE_ASSET_ACL_FROM = `
join public.workspace_members as m
  on m.workspace_id = a.workspace_id
 and m.user_id = $1
left join public.projects as p
  on p.id = a.project_id
`;

const READABLE_ASSET_ACL_WHERE = `(
    case
      when a.project_id is null then a.created_by = $1
      else p.created_by = $1
    end
    or m.role in ('admin', 'owner')
  )`;

const READABLE_ASSET_SQL = `
select
  a.id as id,
  a.bucket as bucket,
  a.object_path as object_path,
  a.mime_type as mime_type,
  a.byte_size as byte_size,
  a.workspace_id as workspace_id,
  a.project_id as project_id,
  a.created_at as created_at
from public.asset_objects as a${READABLE_ASSET_ACL_FROM}where a.id = $2
  and ${READABLE_ASSET_ACL_WHERE}
`;

/**
 * The project upload list (AS-06). Only `source = 'user_upload'` rows are the
 * project's own uploads: a generated row belongs to the generation history, not
 * to the reference drawer. `project_id = $2` is what makes the project branch of
 * the ACL the only branch here — a row with no project is not "this project's".
 *
 * The three lines the caller chooses (media kind, ordering, limit) are appended
 * from the fixed constants below; no caller value ever enters the text.
 */
const PROJECT_UPLOAD_LIST_SQL = `
select
  a.id as id,
  a.bucket as bucket,
  a.object_path as object_path,
  a.mime_type as mime_type,
  a.byte_size as byte_size,
  a.workspace_id as workspace_id,
  a.project_id as project_id,
  a.created_at as created_at,
  a.display_name as display_name
from public.asset_objects as a${READABLE_ASSET_ACL_FROM}where a.project_id = $2::uuid
  and a.source = 'user_upload'
  and ${READABLE_ASSET_ACL_WHERE}
`;

/**
 * The media filter, one fixed clause per kind, never built from the input. The
 * `pdf` branch is an equality and not `like 'application/pdf%'`: the column
 * carries the exact registered type, so a prefix would admit types that are not
 * a PDF.
 */
const PROJECT_UPLOAD_MEDIA_CLAUSES: Readonly<
  Record<AssetUploadMediaType, string>
> = {
  image: "and a.mime_type like 'image/%'",
  video: "and a.mime_type like 'video/%'",
  pdf: "and a.mime_type = 'application/pdf'",
};

/**
 * The two orderings, fixed. `a.id` is the tie-break in both directions so two
 * uploads created in the same millisecond still have one deterministic order —
 * the drawer needs a stable list across refetches, not just a sort.
 */
const PROJECT_UPLOAD_ORDER_CLAUSES: Readonly<Record<AssetUploadOrder, string>> = {
  newest: "order by a.created_at desc, a.id desc",
  oldest: "order by a.created_at asc, a.id asc",
};

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as an `AssetReadError` on an actual read.
 */
export function createAssetReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): AssetReadListRepository {
  return {
    async findReadableAsset({ actorId, assetId }) {
      let rows: unknown[];

      try {
        const pool = options.getTransactionPool();

        rows = await withPrivilegedTransaction(
          pool,
          { userId: actorId },
          async (client) => {
            const result = await client.query(READABLE_ASSET_SQL, [
              actorId,
              assetId,
            ]);
            return result.rows;
          },
        );
      } catch (error) {
        throw new AssetReadError(FIND_READABLE_ASSET, error);
      }

      // `asset_objects.id` is the primary key, so a second row means the SQL and
      // this module disagree: failing loud beats letting one row silently win.
      if (rows.length > 1) {
        throw new AssetReadError(
          FIND_READABLE_ASSET,
          new Error("asset read returned more than one row"),
        );
      }

      const row = rows[0];
      if (row === undefined) return null;

      // Mapping runs inside the same guard as the query: a row that is not the
      // shape this module promises is a read failure, not an exception the
      // caller has to interpret.
      try {
        return mapAssetRow(asRow(row));
      } catch (error) {
        throw new AssetReadError(FIND_READABLE_ASSET, error);
      }
    },

    /**
     * The project's own uploaded files, newest or oldest first (AS-06).
     *
     * `limit` is refused before the pool is resolved: an out-of-range limit is a
     * caller bug, and opening a connection just to discover it would make a
     * rejected request cost a transaction. The order and the media kind are
     * types, but they are looked up in the fixed tables anyway — a value crossed
     * from JSON has no type at runtime, and "unknown clause" must not silently
     * become "no filter" (a list that quietly returns MORE than asked for is the
     * failure this shape prevents).
     */
    async listReadableProjectUploads({
      actorId,
      projectId,
      order,
      mediaType,
      limit,
    }) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < PROJECT_UPLOAD_LIMIT_MIN ||
        limit > PROJECT_UPLOAD_LIMIT_MAX
      ) {
        throw new AssetReadError(
          LIST_READABLE_PROJECT_UPLOADS,
          new Error(
            `asset read refused a limit outside ${PROJECT_UPLOAD_LIMIT_MIN}..${PROJECT_UPLOAD_LIMIT_MAX}`,
          ),
        );
      }

      const orderClause = PROJECT_UPLOAD_ORDER_CLAUSES[order];
      const mediaClause =
        mediaType === undefined
          ? undefined
          : PROJECT_UPLOAD_MEDIA_CLAUSES[mediaType];

      if (
        orderClause === undefined ||
        (mediaType !== undefined && mediaClause === undefined)
      ) {
        throw new AssetReadError(
          LIST_READABLE_PROJECT_UPLOADS,
          new Error("asset read refused an unknown upload order or media type"),
        );
      }

      // Fixed constants only: the caller chooses WHICH clause, never what it
      // says. Nothing here comes from the input but the three bind parameters.
      const statement =
        PROJECT_UPLOAD_LIST_SQL +
        (mediaClause === undefined ? "" : `  ${mediaClause}\n`) +
        `${orderClause}\nlimit $3::int\n`;

      let rows: unknown[];

      try {
        const pool = options.getTransactionPool();

        rows = await withPrivilegedTransaction(
          pool,
          { userId: actorId },
          async (client) => {
            const result = await client.query(statement, [
              actorId,
              projectId,
              limit,
            ]);
            return result.rows;
          },
        );
      } catch (error) {
        throw new AssetReadError(LIST_READABLE_PROJECT_UPLOADS, error);
      }

      // Every row is mapped inside one guard: a single unusable row means the
      // statement and this module disagree, and half a list is not an answer.
      try {
        return rows.map((row) => mapProjectUploadRow(asRow(row)));
      } catch (error) {
        throw new AssetReadError(LIST_READABLE_PROJECT_UPLOADS, error);
      }
    },
  };
}

function mapAssetRow(row: Readonly<Record<string, unknown>>): AssetReadRow {
  return {
    id: requireText(row, "id"),
    bucket: requireText(row, "bucket"),
    object_path: requireText(row, "object_path"),
    mime_type: optionalText(row, "mime_type"),
    byte_size: optionalByteSize(row, "byte_size"),
    workspace_id: requireText(row, "workspace_id"),
    project_id: optionalText(row, "project_id"),
    created_at: requireTimestamp(row, "created_at"),
  };
}

/**
 * The list row: the eight columns mapped by the same rules as a single read,
 * plus `display_name`. A present `null` is a real answer — a row uploaded before
 * ED-05 has no name — and everything else fails loud like every nullable column
 * here: a `null` folded from a missing column would serve a column drift as "the
 * file has no name".
 */
function mapProjectUploadRow(
  row: Readonly<Record<string, unknown>>,
): AssetReadListRow {
  return {
    ...mapAssetRow(row),
    display_name: optionalText(row, "display_name"),
  };
}

function asRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("asset read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

/**
 * Read a nullable column, keeping "the database answered NULL" apart from "the
 * result row does not carry the column at all".
 *
 * A nullable column has exactly one legal absent value: the field is present on
 * the row and is `null`. A row that never had the field — a column dropped from
 * the statement, a drifting alias, a half-built driver row — or one that carries
 * an explicit `undefined` means the statement and this module disagree. Folding
 * that into a business `null` would serve a column drift as a legitimate answer:
 * a missing `project_id` would read as "this asset has no project" and a missing
 * `mime_type` as "the database does not know the type". So it fails loud, and the
 * guard around the read turns it into a fixed `AssetReadError`.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `field in row`: an inherited
 * key is not a column the statement selected.
 */
function requireNullableField(
  row: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(row, field)) {
    throw new Error(`asset read returned no "${field}"`);
  }

  const value = row[field];
  if (value === undefined) {
    throw new Error(`asset read returned an unusable "${field}"`);
  }

  return value;
}

/** A `NOT NULL` text column that must carry a value: empty is not an id or a key. */
function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`asset read returned no usable "${field}"`);
  }

  return value;
}

/**
 * A nullable text column: a present `null` is a real answer (the database allows
 * it for `mime_type` and `project_id`), anything else — a missing field, an
 * `undefined`, an empty string — is not.
 */
function optionalText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = requireNullableField(row, field);
  if (value === null) return null;

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`asset read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `asset_objects.byte_size` is `bigint` and nullable, and the two drivers
 * disagree about its JavaScript shape: PGlite hands back a number, while `pg`
 * registers int8 -> `parseBigInteger`, which returns a decimal STRING (a bigint
 * does not fit a double in general). Both are the same column value, so both are
 * accepted and normalised to the number the HTTP contract publishes
 * (`byteSize: z.number().int().nonnegative().nullable()`).
 *
 * Everything else fails loud: a negative or fractional size, a non-numeric
 * string, an object. A byte size nobody can trust must not reach a DTO.
 */
function optionalByteSize(
  row: Readonly<Record<string, unknown>>,
  field: string,
): number | null {
  const value = requireNullableField(row, field);
  if (value === null) return null;

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`asset read returned an unusable "${field}"`);
    }

    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`asset read returned an unusable "${field}"`);
    }

    return parsed;
  }

  throw new Error(`asset read returned an unusable "${field}"`);
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the shared contract wants
 * a string. Both are accepted and normalised, anything else fails loud.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`asset read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`asset read returned no usable "${field}"`);
}
