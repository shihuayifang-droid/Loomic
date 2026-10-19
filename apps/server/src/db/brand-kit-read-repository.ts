/**
 * Brand kit read repository (workorders 21Y and 21Z, ADR-0001 migration step).
 *
 * Workorder 21Y moved the TWO PostgREST reads behind `GET /api/brand-kits` —
 * the caller's own kit rows and the `kit_id` / `asset_type` rows of those kits —
 * here. Workorder 21Z then moved the remaining reads of
 * `features/brand-kit/brand-kit-service.ts` (the kit detail, its asset rows, its
 * file paths, the next `sort_order` and a single asset row), so this module is
 * now the only place a brand kit row is READ.
 *
 * Every read used to run on the caller's own user-scoped PostgREST client, where
 * ROW LEVEL SECURITY decided what was visible. The policies
 * (`supabase/migrations/20260325000001_create_brand_kits.sql`) are:
 *
 *   CREATE POLICY brand_kits_user_policy ON public.brand_kits
 *     FOR ALL USING (auth.uid() = user_id);
 *
 *   CREATE POLICY brand_kit_assets_policy ON public.brand_kit_assets
 *     FOR ALL USING (
 *       EXISTS (SELECT 1 FROM public.brand_kits WHERE id = kit_id AND user_id = auth.uid()));
 *
 * A brand kit is a PRIVATE, OWNER-ONLY resource and that is the whole ACL: a
 * kit belongs to exactly one `user_id` and nobody else reads it. Being a member
 * of a workspace, being able to read a project, or being an administrator grants
 * NOTHING here — an admin cannot read somebody else's brand kit today and this
 * migration must not start granting that. So there is deliberately no helper
 * function, no membership join, no role clause and no `is_default`/archive
 * filter: every predicate below is one of the two policy expressions translated
 * into SQL verbatim, and neither ACL may be derived from the other.
 *
 * This repository runs privileged (the pool's role bypasses RLS), so the
 * policies above no longer run and the statements' OWN predicates are the only
 * gate there is. That is exactly why they are written out here rather than
 * inherited from a policy that is no longer evaluated.
 *
 * The interface is a closed set of six reads: no access token, no table name, no
 * column list and no generic query object. The only rows they can ever answer
 * with are the caller's own kits and the assets of those kits, because `$1` is
 * the actor and nothing else keys the reads. Two of them answer with the SAME
 * ten-column asset projection, so a caller cannot get one shape here and another
 * there.
 *
 * `listOwnKits`'s statement 1 answering ZERO rows is a legal empty answer AND the
 * end of that call: the read it replaces returned early on an empty kit list and
 * never issued the asset read, so statement 2 is not sent here either. That keeps
 * the shape of the work identical (one round trip for a user with no kits) and
 * keeps a pointless `any('{}')` off the wire.
 *
 * Every failure — a bad argument, a connect, SQL, timeout or row-shape failure —
 * throws `BrandKitReadError`, whose own message is fixed text naming only the
 * operation: no SQL, no host, no connection string and no kit/user/asset id. The
 * driver's own error rides along as `cause` so a caller can classify it without
 * the driver's message reaching a log line or an HTTP body.
 *
 * One intended difference from the reads this replaces: PostgREST returned
 * timestamps with microseconds and a `+00:00` offset, while `toISOString()`
 * publishes milliseconds and `Z`. Both satisfy the published
 * `z.string().datetime({ offset: true })` contract, and the pg-backed
 * project/settings repositories that preceded this one made exactly the same
 * move.
 *
 * The pool is reached through a getter, so importing or wiring this module never
 * reads `DATABASE_URL`, never connects and never fails at build time. A missing
 * pool is a read failure on the call, never a silent fallback: nothing in this
 * module can reach PostgREST.
 */

import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/** The enum `public.brand_kit_asset_type`, verbatim. */
export type BrandKitReadAssetType = "color" | "font" | "logo" | "image";

/** A `brand_kits` row as the list statement reads it, timestamps already ISO strings. */
export type BrandKitRow = {
  id: string;
  name: string;
  is_default: boolean;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
};

/** ONE `brand_kit_assets` row as the list statement reads it — two columns. */
export type BrandKitAssetCountRow = {
  kit_id: string;
  asset_type: BrandKitReadAssetType;
};

export type BrandKitListResult = {
  kits: BrandKitRow[];
  assets: BrandKitAssetCountRow[];
};

/** The kit detail projection: `DETAIL_KIT_COLS`, timestamps already ISO strings. */
export type KitDetailRow = {
  id: string;
  name: string;
  is_default: boolean;
  guidance_text: string | null;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The ten columns of a `brand_kit_assets` row, in the order every projection in
 * this file (and in `db/brand-kit-write-repository.ts`) names them.
 *
 * `metadata` is JSONB and is published as it arrived — an object or SQL NULL —
 * because the service's `mapAssetRow` is the layer that turns NULL into `{}`.
 */
export type BrandKitAssetRow = {
  id: string;
  asset_type: BrandKitReadAssetType;
  display_name: string;
  role: string | null;
  sort_order: number;
  text_content: string | null;
  file_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

/** The single projection `findOwnKit` and the detail path use. */
export const DETAIL_KIT_COLS =
  "id, name, is_default, guidance_text, cover_url, created_at, updated_at";

/**
 * The single projection every ten-column asset read uses. `asset_type` is cast
 * to `text` so the driver hands back a plain string and the mapper can check the
 * four enum values itself instead of trusting an enum wrapper.
 */
export const ASSET_COLS =
  "id, asset_type::text as asset_type, display_name, role, sort_order, text_content, file_url, metadata, created_at, updated_at";

export type BrandKitReadRepository = {
  /**
   * The kits `actorId` owns, in the order `created_at asc`, plus the
   * `kit_id`/`asset_type` rows of exactly those kits. Both lists are empty when
   * the actor owns none.
   */
  listOwnKits(input: { actorId: string }): Promise<BrandKitListResult>;

  /** The kit row `kitId` IF `actorId` owns it, otherwise `null`. */
  findOwnKit(input: { actorId: string; kitId: string }): Promise<KitDetailRow | null>;

  /**
   * Every asset row of the caller's own kit `kitId`, ordered
   * `sort_order asc, created_at asc` — the order the detail response published
   * before this migration. A kit that is not the actor's answers `[]`.
   */
  listOwnKitAssets(input: {
    actorId: string;
    kitId: string;
  }): Promise<BrandKitAssetRow[]>;

  /**
   * The non-null `file_url` values of the caller's own kit `kitId`, unordered —
   * the paths `deleteKit` removes from storage. A kit that is not the actor's
   * answers `[]`.
   */
  listOwnKitFileUrls(input: { actorId: string; kitId: string }): Promise<string[]>;

  /**
   * `coalesce(max(sort_order), -1) + 1` over the caller's own assets of `kitId`
   * with this `assetType`, i.e. the next free `sort_order` (0 for an empty set).
   * A kit that is not the actor's also answers 0: the absent kit contributes no
   * row, exactly like the absent assets.
   */
  readNextSortOrder(input: {
    actorId: string;
    kitId: string;
    assetType: BrandKitReadAssetType;
  }): Promise<number>;

  /** The asset row `assetId` of the caller's own kit `kitId`, otherwise `null`. */
  findOwnAsset(input: {
    actorId: string;
    kitId: string;
    assetId: string;
  }): Promise<BrandKitAssetRow | null>;
};

export const LIST_OWN_KITS = "listOwnKits";
export const FIND_OWN_KIT = "findOwnKit";
export const LIST_OWN_KIT_ASSETS = "listOwnKitAssets";
export const LIST_OWN_KIT_FILE_URLS = "listOwnKitFileUrls";
export const READ_NEXT_SORT_ORDER = "readNextSortOrder";
export const FIND_OWN_ASSET = "findOwnAsset";

export type BrandKitReadOperation =
  | typeof LIST_OWN_KITS
  | typeof FIND_OWN_KIT
  | typeof LIST_OWN_KIT_ASSETS
  | typeof LIST_OWN_KIT_FILE_URLS
  | typeof READ_NEXT_SORT_ORDER
  | typeof FIND_OWN_ASSET;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class BrandKitReadError extends Error {
  readonly operation: BrandKitReadOperation;

  constructor(operation: BrandKitReadOperation, cause: unknown) {
    super(
      `brand kit read failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "BrandKitReadError";
    this.operation = operation;
  }
}

/**
 * List statement 1: `brand_kits_user_policy`, translated literally.
 *
 * `k.user_id = $1::uuid` IS the policy — `auth.uid() = user_id` with the actor
 * bound as a parameter. The id is bound with an explicit `::uuid` cast, so a
 * malformed one fails as a real SQL error (SQLSTATE 22P02) inside the
 * transaction instead of silently matching something else.
 *
 * The ORDER BY is `created_at asc` and nothing else, exactly as the removed
 * PostgREST read ordered it. Appending a tie-breaker here would change the order
 * the endpoint publishes for two kits created in the same transaction, which is
 * a behaviour change this workorder does not own.
 *
 * There is deliberately no workspace, project, archive or role predicate: the
 * read policy has none.
 */
const LIST_OWN_KITS_SQL = `
select k.id, k.name, k.is_default, k.cover_url, k.created_at, k.updated_at
  from public.brand_kits k
 where k.user_id = $1::uuid
 order by k.created_at asc
`;

/**
 * List statement 2: `brand_kit_assets_policy`, translated literally.
 *
 * The `exists` clause IS the policy, even though on this call path it looks
 * redundant — `$2` already came from statement 1, so every id in it belongs to
 * the actor. It is kept because a repository whose authorisation is "the caller
 * passed the right ids" has no authorisation of its own: the statement has to
 * refuse a kit that is not the actor's even if one is ever bound to it. Dropping
 * it would make the ACL a property of the caller instead of a property of this
 * statement.
 *
 * `asset_type` is cast to `text` because the column is the
 * `public.brand_kit_asset_type` enum and this module maps strings; the cast keeps
 * the driver from handing back an enum wrapper and lets the mapper do the
 * four-value check itself.
 */
const LIST_OWN_KIT_ASSETS_SQL = `
select a.kit_id, a.asset_type::text as asset_type
  from public.brand_kit_assets a
 where a.kit_id = any($2::uuid[])
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * `findOwnKit`: the kit DETAIL projection of one kit the actor owns.
 *
 * `brand_kits_user_policy` again, verbatim — `user_id = $1::uuid` — plus the
 * primary key. Both predicates are needed and neither is redundant: the id alone
 * would read a stranger's kit on a privileged connection, the owner alone would
 * read every kit of the actor. Zero rows is a legal answer and becomes `null`;
 * `id` is the primary key, so more than one row is a statement/mapper
 * disagreement rather than a value.
 *
 * This one statement answers the four separate probes the service used to issue
 * (`getKit`/`createKit`/`updateKit` detail, and the "does this kit exist and is
 * it mine" check behind `deleteKit`, `createAsset`, `uploadAsset` and
 * `duplicateKit`): they all asked the same owner-only question.
 */
const FIND_OWN_KIT_SQL = `
select ${DETAIL_KIT_COLS.replace(/(^|, )/g, "$1k.")}
  from public.brand_kits k
 where k.id = $2::uuid
   and k.user_id = $1::uuid
`;

/**
 * `listOwnKitAssets`: `brand_kit_assets_policy` translated literally, over the
 * ten-column projection.
 *
 * The ORDER BY is the pair the removed PostgREST read applied
 * (`sort_order asc`, then `created_at asc`) — the order `brandKitDetailSchema`
 * publishes. It is a property of the response, not a convenience.
 */
const LIST_OWN_KIT_ASSETS_DETAIL_SQL = `
select ${ASSET_COLS.replace(/(^|, )/g, "$1a.")}
  from public.brand_kit_assets a
 where a.kit_id = $2::uuid
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
 order by a.sort_order asc, a.created_at asc
`;

/**
 * `findOwnAsset`: one asset row of the actor's own kit.
 *
 * `brand_kit_assets_policy` verbatim (`exists` over the owning kit) plus the
 * asset primary key and its kit. The kit predicate is not decoration: the service
 * passes the kit from the URL, and an asset id alone must not be enough to read a
 * row that belongs to a different kit of the same owner — the removed read had
 * the same `.eq("id", …).eq("kit_id", …)` pair.
 */
const FIND_OWN_ASSET_SQL = `
select ${ASSET_COLS.replace(/(^|, )/g, "$1a.")}
  from public.brand_kit_assets a
 where a.id = $3::uuid
   and a.kit_id = $2::uuid
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * `listOwnKitFileUrls`: the only column `deleteKit` needs before it removes the
 * objects from storage.
 *
 * `file_url is not null` is a projection rule, not an ACL: a NULL path is not a
 * path. The `exists` clause is `brand_kit_assets_policy` again, so a kit that is
 * not the actor's answers no row at all — the caller's storage cleanup can never
 * name an object it does not own.
 *
 * There is deliberately no ORDER BY: the removed read had none either, and the
 * order of a `remove([...])` batch is not part of any published contract.
 */
const LIST_OWN_KIT_FILE_URLS_SQL = `
select a.file_url
  from public.brand_kit_assets a
 where a.kit_id = $2::uuid
   and a.file_url is not null
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * `readNextSortOrder`: the `max(sort_order)` read `createAsset` and `uploadAsset`
 * perform before appending an asset.
 *
 * `coalesce(max(...), -1) + 1` IS the removed read: `.order("sort_order",
 * { ascending: false }).limit(1).maybeSingle()` then `(maxRow?.sort_order ?? -1)
 * + 1`. Both answer 0 on an empty set, so no branch is needed here.
 *
 * The removed read bound `asset_type` as an equality on the enum column; the bind
 * is cast to `public.brand_kit_asset_type` for exactly that reason — an
 * out-of-enum value is a real SQL error (22P02) here, just as it was an error
 * there, and the caller decides what to do with it.
 *
 * The aggregate always answers exactly one row, so zero rows means "no kit of the
 * actor was in scope" but the value is still 0 — which is exactly the answer the
 * removed read gave for a kit that is not the caller's.
 */
const READ_NEXT_SORT_ORDER_SQL = `
select coalesce(max(a.sort_order), -1) + 1 as next_sort_order
  from public.brand_kit_assets a
 where a.kit_id = $2::uuid
   and a.asset_type = $3::public.brand_kit_asset_type
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `BrandKitReadError` on an actual read.
 *
 * There is no fallback path. A caller that was handed this repository either
 * reads through it or fails.
 */
export function createBrandKitReadRepository(options: {
  getTransactionPool: () => TransactionPool;
}): BrandKitReadRepository {
  /**
   * The one privileged transaction every method runs in, with the failure
   * classification every method shares: anything that escapes the callback becomes
   * a `BrandKitReadError` naming ITS operation, and the driver's own error rides
   * along as `cause` only.
   */
  async function read<T>(
    operation: BrandKitReadOperation,
    actorId: string,
    run: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(
        pool,
        // The transaction context carries WHO asked, so a privileged read is not
        // anonymous in a log or an audit trail. It grants nothing: the
        // statements' own predicates above are the authorisation rule.
        { userId: actorId },
        run,
      );
    } catch (error) {
      throw new BrandKitReadError(operation, error);
    }
  }

  return {
    async listOwnKits(input) {
      // Arguments first: an unusable one must not open a connection, and it must
      // not be reported as a database failure either.
      const actorId = requireReadArgument(input.actorId, "actorId", LIST_OWN_KITS);

      return read(LIST_OWN_KITS, actorId, async (client) => {
        const kitResult = await client.query(LIST_OWN_KITS_SQL, [actorId]);
        const kits = kitResult.rows.map(mapKitRow);

        // Zero kits: the read this replaces returned here without issuing the
        // asset read at all, so it is not issued either — see the header.
        if (kits.length === 0) return { kits: [], assets: [] };

        const assetResult = await client.query(LIST_OWN_KIT_ASSETS_SQL, [
          actorId,
          kits.map((kit) => kit.id),
        ]);

        return { kits, assets: assetResult.rows.map(mapAssetCountRow) };
      });
    },

    async findOwnKit(input) {
      const actorId = requireReadArgument(input.actorId, "actorId", FIND_OWN_KIT);
      const kitId = requireReadArgument(input.kitId, "kitId", FIND_OWN_KIT);

      return read(FIND_OWN_KIT, actorId, async (client) => {
        const result = await client.query(FIND_OWN_KIT_SQL, [actorId, kitId]);

        return singleRow(result.rows, mapKitDetailRow, FIND_OWN_KIT);
      });
    },

    async listOwnKitAssets(input) {
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        LIST_OWN_KIT_ASSETS,
      );
      const kitId = requireReadArgument(input.kitId, "kitId", LIST_OWN_KIT_ASSETS);

      return read(LIST_OWN_KIT_ASSETS, actorId, async (client) => {
        const result = await client.query(LIST_OWN_KIT_ASSETS_DETAIL_SQL, [
          actorId,
          kitId,
        ]);

        return result.rows.map(mapAssetDetailRow);
      });
    },

    async listOwnKitFileUrls(input) {
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        LIST_OWN_KIT_FILE_URLS,
      );
      const kitId = requireReadArgument(
        input.kitId,
        "kitId",
        LIST_OWN_KIT_FILE_URLS,
      );

      return read(LIST_OWN_KIT_FILE_URLS, actorId, async (client) => {
        const result = await client.query(LIST_OWN_KIT_FILE_URLS_SQL, [
          actorId,
          kitId,
        ]);

        return result.rows.map(mapFileUrlRow);
      });
    },

    async readNextSortOrder(input) {
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        READ_NEXT_SORT_ORDER,
      );
      const kitId = requireReadArgument(
        input.kitId,
        "kitId",
        READ_NEXT_SORT_ORDER,
      );
      const assetType = requireAssetTypeArgument(
        input.assetType,
        "assetType",
        READ_NEXT_SORT_ORDER,
      );

      return read(READ_NEXT_SORT_ORDER, actorId, async (client) => {
        const result = await client.query(READ_NEXT_SORT_ORDER_SQL, [
          actorId,
          kitId,
          assetType,
        ]);

        if (result.rows.length !== 1) {
          throw new Error(
            "brand kit read did not answer exactly one sort-order row",
          );
        }

        return requireInteger(
          asReadRow(result.rows[0]),
          "next_sort_order",
          READ_NEXT_SORT_ORDER,
        );
      });
    },

    async findOwnAsset(input) {
      const actorId = requireReadArgument(
        input.actorId,
        "actorId",
        FIND_OWN_ASSET,
      );
      const kitId = requireReadArgument(input.kitId, "kitId", FIND_OWN_ASSET);
      const assetId = requireReadArgument(input.assetId, "assetId", FIND_OWN_ASSET);

      return read(FIND_OWN_ASSET, actorId, async (client) => {
        const result = await client.query(FIND_OWN_ASSET_SQL, [
          actorId,
          kitId,
          assetId,
        ]);

        return singleRow(result.rows, mapAssetDetailRow, FIND_OWN_ASSET);
      });
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
 */
function requireReadArgument(
  value: unknown,
  field: string,
  operation: BrandKitReadOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrandKitReadError(
      operation,
      new Error(`brand kit read needs a non-empty "${field}"`),
    );
  }

  return value;
}

function requireAssetTypeArgument(
  value: unknown,
  field: string,
  operation: BrandKitReadOperation,
): BrandKitReadAssetType {
  if (value === undefined) {
    throw new BrandKitReadError(
      operation,
      new Error(`brand kit read needs a non-empty "${field}"`),
    );
  }

  return requireAssetType(value, operation);
}

/**
 * Statement 1's row, mapped strictly. Every column of the projection has a
 * declared type — `name text not null`, `is_default boolean not null`,
 * `cover_url text` (nullable), two `timestamptz not null` — so a value of any
 * other shape means the statement and this mapper disagree, and it fails here
 * rather than travelling on as a brand kit the client cannot render.
 */
function mapKitRow(row: unknown): BrandKitRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    name: requireText(record, "name"),
    is_default: requireBoolean(record, "is_default"),
    cover_url: requireNullableString(record, "cover_url"),
    created_at: requireTimestamp(record, "created_at"),
    updated_at: requireTimestamp(record, "updated_at"),
  };
}

/** `DETAIL_KIT_COLS`'s row: the six kit columns plus the nullable `guidance_text`. */
function mapKitDetailRow(row: unknown): KitDetailRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    name: requireText(record, "name"),
    is_default: requireBoolean(record, "is_default"),
    guidance_text: requireNullableString(record, "guidance_text"),
    cover_url: requireNullableString(record, "cover_url"),
    created_at: requireTimestamp(record, "created_at"),
    updated_at: requireTimestamp(record, "updated_at"),
  };
}

/**
 * List statement 2's row. `asset_type` arrives as text (the statement casts it) and
 * is checked against the four values of `public.brand_kit_asset_type`: the
 * service keeps a `Record` of the four counts and would silently create a fifth
 * key — or count `NaN` — for anything else.
 */
function mapAssetCountRow(row: unknown): BrandKitAssetCountRow {
  const record = asReadRow(row);

  return {
    kit_id: requireString(record, "kit_id"),
    asset_type: requireAssetType(record["asset_type"], LIST_OWN_KITS),
  };
}

/** `ASSET_COLS`'s row: the ten columns, each held to its declared shape. */
function mapAssetDetailRow(row: unknown): BrandKitAssetRow {
  const record = asReadRow(row);

  return {
    id: requireString(record, "id"),
    asset_type: requireAssetType(record["asset_type"], LIST_OWN_KIT_ASSETS),
    display_name: requireText(record, "display_name"),
    role: requireNullableString(record, "role"),
    sort_order: requireInteger(record, "sort_order", LIST_OWN_KIT_ASSETS),
    text_content: requireNullableString(record, "text_content"),
    file_url: requireNullableString(record, "file_url"),
    metadata: requireMetadata(record, "metadata"),
    created_at: requireTimestamp(record, "created_at"),
    updated_at: requireTimestamp(record, "updated_at"),
  };
}

/**
 * `file_url`'s row. The statement's `is not null` predicate is the projection
 * rule, so a value that is not a string means statement and mapper disagree.
 * An EMPTY string is accepted on purpose: the removed service filtered `""` out
 * of the removal batch itself, and this module has no mandate to change what
 * reaches that filter.
 */
function mapFileUrlRow(row: unknown): string {
  const record = asReadRow(row);
  const value = record["file_url"];

  if (typeof value !== "string") {
    throw new Error('brand kit read returned no usable "file_url"');
  }

  return value;
}

function asReadRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("brand kit read returned a row that is not an object");
  }

  return value as Record<string, unknown>;
}

function requireString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`brand kit read returned no usable "${field}"`);
  }

  return value;
}

/**
 * `name` is `text not null` with a default, and an EMPTY name is a string this
 * module has no mandate to reject: `PATCH /api/brand-kits/:id` accepts a
 * one-space name (the request schema checks length, then the service trims it),
 * so `""` is reachable in the column today. The read this replaces published it
 * unchanged, and tightening that here would be a silent behaviour change.
 */
function requireText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

function requireBoolean(
  row: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `cover_url`, `guidance_text`, `role`, `text_content` and `file_url` are nullable
 * text columns, so the projection always carries them: SQL NULL is the only
 * "absent" this accepts. A missing key or any other type is drift, not a null —
 * the removed PostgREST reads published the column as it was and never invented a
 * value for it.
 */
function requireNullableString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value;
}

/**
 * `sort_order` is `INT NOT NULL`. A non-integer would silently become a fractional
 * order or `NaN` in the published `sort_order: z.number().int()`, so it fails
 * here instead.
 */
function requireInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: BrandKitReadOperation,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BrandKitReadError(
      operation,
      new Error(`brand kit read returned an unusable "${field}"`),
    );
  }

  return value;
}

/**
 * `metadata` is `JSONB DEFAULT '{}'` and NULLABLE. An OBJECT or SQL NULL is the
 * whole accepted set: the service's `mapAssetRow` turns NULL into `{}` and
 * publishes the object as-is, so anything else (an array, a scalar) is drift.
 */
function requireMetadata(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`brand kit read returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}

const ASSET_TYPES: readonly BrandKitReadAssetType[] = [
  "color",
  "font",
  "logo",
  "image",
];

function requireAssetType(
  value: unknown,
  operation: BrandKitReadOperation,
): BrandKitReadAssetType {
  for (const candidate of ASSET_TYPES) {
    if (value === candidate) return candidate;
  }

  throw new BrandKitReadError(
    operation,
    new Error('brand kit read returned an unusable "asset_type"'),
  );
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the HTTP DTO
 * (`brandKitSummarySchema`) is a string with an offset. Both are accepted and
 * normalised to `toISOString()`, anything else fails loud — a null timestamp
 * would silently become a kit the client cannot render.
 *
 * A private copy of the rule `db/project-read-repository.ts` established, kept
 * local on purpose: importing it from there would couple two repositories that
 * have no other reason to know about each other, and `project-read-repository.ts`
 * is outside this workorder's whitelist.
 */
function requireTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`brand kit read returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`brand kit read returned no usable "${field}"`);
}

/**
 * Zero rows is `null`, one row is mapped, and more than one row is impossible for
 * a primary-key lookup — so it is reported as a statement/mapper disagreement
 * rather than silently picked from.
 */
function singleRow<T>(
  rows: readonly unknown[],
  map: (row: unknown) => T,
  operation: BrandKitReadOperation,
): T | null {
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new BrandKitReadError(
      operation,
      new Error("brand kit read answered more than one row for one id"),
    );
  }

  return map(rows[0]);
}
