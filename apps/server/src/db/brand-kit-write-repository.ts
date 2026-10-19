/**
 * Brand kit write repository (workorder 21Z, ADR-0001 migration step).
 *
 * The EIGHTEEN PostgREST writes that used to run inside
 * `features/brand-kit/brand-kit-service.ts` — kit insert, default-clear, kit
 * update, kit delete, asset insert, asset update, asset delete and the batch
 * asset copy — now run here as eight named statements. Nothing about the
 * published behaviour moves with them: the service keeps every error code, HTTP
 * status and message it had, including the four places that swallowed a failure
 * on purpose (see `WO-21Z` notes in the service).
 *
 * Rules this module keeps, and why each one matters:
 *
 * - The interface is CLOSED: eight methods, each with a fixed statement. There is
 *   no access token, no table name, no arbitrary column and no generic
 *   `patch(table, fields)` — workorder 21Z excludes dynamic SQL explicitly, so a
 *   caller cannot widen a write by naming a column this module never writes.
 * - Every statement runs through workorder 19's transaction entry point in
 *   `privileged` mode. The pool's role owns both tables and bypasses RLS, which is
 *   exactly why the authorisation rule has to be the statement's OWN predicate.
 * - The ACL is the two policies of
 *   `supabase/migrations/20260325000001_create_brand_kits.sql` translated
 *   verbatim, and nothing else:
 *
 *       brand_kits        FOR ALL USING (auth.uid() = user_id)
 *       brand_kit_assets  FOR ALL USING (
 *         EXISTS (SELECT 1 FROM public.brand_kits WHERE id = kit_id AND user_id = auth.uid()))
 *
 *   Both policies have only USING and no WITH CHECK, and PostgreSQL applies
 *   USING to the rows INSERT/UPDATE may touch, so the SAME predicate gates all
 *   four verbs. That is why no statement here invents a second, weaker rule:
 *   `brand_kits` statements carry `user_id = $1::uuid`, and `brand_kit_assets`
 *   statements carry the `exists (select 1 from public.brand_kits ...)` clause.
 *   No workspace, project, role or administrator predicate is derived or added —
 *   an admin cannot write somebody else's brand kit today and this migration must
 *   not start granting that.
 * - The two UPDATE statements use FLAG PARAMETERS instead of a dynamic SET list:
 *   `set name = case when $3::boolean then $4::text else name end`. The SQL text
 *   is therefore byte-identical whatever the patch contains, and only the
 *   parameters differ — the property the unit tests assert by comparing the three
 *   statements of three different patches.
 * - Inserts into `brand_kit_assets` are `insert ... select ... where exists(...)`
 *   so that a kit that is not the caller's produces ZERO rows rather than a
 *   permission error. Zero rows becomes `null` (or `{inserted: 0}`), never a
 *   throw: the service maps that answer onto exactly the result the removed
 *   PostgREST write produced.
 * - `updateOwnKit` reporting zero updated rows is likewise NOT an error. The
 *   removed write did not treat it as one either — the follow-up detail read
 *   decided between 404 and 200 — and turning it into a throw here would change
 *   the status a caller sees.
 * - Every value is a bind parameter with an explicit cast, so a malformed uuid
 *   fails as a real SQL error (SQLSTATE 22P02) inside the transaction, and an
 *   out-of-enum `asset_type` fails as one too (22P02 as well), exactly as the
 *   PostgREST write failed.
 * - `updated_at` is never written: both tables have a `BEFORE UPDATE`
 *   `set_updated_at()` trigger, which fires under a privileged connection too.
 *   Writing it here would be a second source of truth for the same column.
 * - A connect, SQL, timeout or row-shape failure throws `BrandKitWriteError`,
 *   whose own message is fixed text naming only the operation: no SQL, no host,
 *   no connection string and no kit/user/asset id. The driver's own error rides
 *   along as `cause` so a caller can classify it without the driver's message
 *   reaching a log line or an HTTP body.
 * - The pool is reached through a getter, so importing or wiring this module
 *   never reads `DATABASE_URL`, never connects and never fails at build time. A
 *   missing pool is a write failure on the call, never a silent fallback: nothing
 *   in this module can reach PostgREST.
 */

import {
  ASSET_COLS,
  type BrandKitAssetRow,
  type BrandKitReadAssetType,
} from "./brand-kit-read-repository.js";
import {
  withPrivilegedTransaction,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * The three columns `updateOwnKit` may set. An ABSENT key means "leave this
 * column alone"; a key present with `null` means "set it to NULL", which is a
 * value `guidance_text` really can hold.
 */
export type BrandKitKitPatch = {
  name?: string;
  guidance_text?: string | null;
  is_default?: boolean;
};

/**
 * The five columns `updateOwnAsset` may set. Same absent-vs-null rule, and it is
 * load-bearing for `text_content` and `role`: clearing them is a legitimate edit
 * and must not be confused with "do not touch them".
 */
export type BrandKitAssetPatch = {
  display_name?: string;
  text_content?: string | null;
  role?: string | null;
  sort_order?: number;
  metadata?: Record<string, unknown>;
};

/** The column values a new asset row is created with, one per writable column. */
export type BrandKitAssetInsert = {
  asset_type: BrandKitReadAssetType;
  display_name: string;
  text_content: string | null;
  role: string | null;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  file_url: string | null;
};

/**
 * One row of a kit copy. It is the asset insert minus `kit_id`, which the batch
 * statement supplies once for every row.
 */
export type BrandKitAssetCopy = {
  asset_type: BrandKitReadAssetType;
  display_name: string;
  text_content: string | null;
  role: string | null;
  sort_order: number;
  metadata: Record<string, unknown> | null;
  file_url: string | null;
};

export type BrandKitWriteRepository = {
  /** Create a kit owned by the actor. The inserted id is the whole answer. */
  insertOwnKit(input: {
    actorId: string;
    name: string;
    guidanceText: string | null;
  }): Promise<{ id: string }>;

  /** Clear the actor's default flag on every one of their kits (at most one row). */
  clearOwnDefault(input: { actorId: string }): Promise<void>;

  /**
   * Apply `patch` to the actor's own kit. Columns missing from the patch are left
   * untouched. `updated` is the number of rows the statement touched, which is 0
   * when the kit does not exist or belongs to somebody else — not an error.
   */
  updateOwnKit(input: {
    actorId: string;
    kitId: string;
    patch: BrandKitKitPatch;
  }): Promise<{ updated: number }>;

  /** Delete the actor's own kit (its assets cascade). Deleting nothing is fine. */
  deleteOwnKit(input: { actorId: string; kitId: string }): Promise<void>;

  /**
   * Append one asset to the actor's own kit. `null` when the kit is not the
   * actor's — the `exists` clause refuses the row instead of raising.
   */
  insertOwnAsset(input: {
    actorId: string;
    kitId: string;
    asset: BrandKitAssetInsert;
  }): Promise<BrandKitAssetRow | null>;

  /**
   * Apply `patch` to one asset of the actor's own kit and answer the UPDATED row.
   * `null` when the asset is not there or the kit is not the actor's.
   */
  updateOwnAsset(input: {
    actorId: string;
    kitId: string;
    assetId: string;
    patch: BrandKitAssetPatch;
  }): Promise<BrandKitAssetRow | null>;

  /** Delete one asset of the actor's own kit. Deleting nothing is fine. */
  deleteOwnAsset(input: {
    actorId: string;
    kitId: string;
    assetId: string;
  }): Promise<void>;

  /**
   * Insert every copy in ONE statement. An empty `copies` answers 0 WITHOUT
   * opening a connection: there is no statement to send and the removed write
   * sent none either.
   */
  insertOwnAssetCopies(input: {
    actorId: string;
    kitId: string;
    copies: readonly BrandKitAssetCopy[];
  }): Promise<{ inserted: number }>;
};

export const INSERT_OWN_KIT = "insertOwnKit";
export const CLEAR_OWN_DEFAULT = "clearOwnDefault";
export const UPDATE_OWN_KIT = "updateOwnKit";
export const DELETE_OWN_KIT = "deleteOwnKit";
export const INSERT_OWN_ASSET = "insertOwnAsset";
export const UPDATE_OWN_ASSET = "updateOwnAsset";
export const DELETE_OWN_ASSET = "deleteOwnAsset";
export const INSERT_OWN_ASSET_COPIES = "insertOwnAssetCopies";

export type BrandKitWriteOperation =
  | typeof INSERT_OWN_KIT
  | typeof CLEAR_OWN_DEFAULT
  | typeof UPDATE_OWN_KIT
  | typeof DELETE_OWN_KIT
  | typeof INSERT_OWN_ASSET
  | typeof UPDATE_OWN_ASSET
  | typeof DELETE_OWN_ASSET
  | typeof INSERT_OWN_ASSET_COPIES;

/**
 * The failure shape of this module. The message is built from the fixed
 * operation name only: a driver error that embeds the statement, a host or a
 * credential must never reach a log line or an HTTP body through us.
 */
export class BrandKitWriteError extends Error {
  readonly operation: BrandKitWriteOperation;

  constructor(operation: BrandKitWriteOperation, cause: unknown) {
    super(
      `brand kit write failed (${operation})`,
      cause === undefined ? {} : { cause },
    );
    this.name = "BrandKitWriteError";
    this.operation = operation;
  }
}

/**
 * `insertOwnKit`: the kit insert behind `POST /api/brand-kits` and the copy
 * behind `POST /api/brand-kits/:kitId/duplicate`.
 *
 * `user_id = $1::uuid` is the INSERT half of `brand_kits_user_policy`, written
 * out because the policy does not run on a privileged connection. Only three
 * columns are named: `is_default` keeps its `false` default (a duplicate must not
 * copy the flag), and `id` / `created_at` / `updated_at` keep their defaults.
 * `guidance_text` is bound as `$3::text` and is allowed to be NULL — it is a
 * nullable column and creating a kit from the create route really does pass null.
 */
const INSERT_OWN_KIT_SQL = `
insert into public.brand_kits (user_id, name, guidance_text)
values ($1::uuid, $2::text, $3::text)
returning id
`;

/**
 * `clearOwnDefault`: the "at most one default kit" half of `PATCH /api/brand-kits/:id`.
 *
 * It is a separate statement on purpose. The removed service issued it as an
 * independent write BEFORE the update, and keeping the two independent keeps the
 * failure behaviour identical: if the second write fails, the user is left with
 * no default kit, which is what happens today. Merging them into one transaction
 * would look tidier and would silently change that.
 *
 * `user_id = $1::uuid and is_default = true` is the same filter the removed write
 * applied, and it is also the only rows `brand_kits_user_policy` would have let
 * it touch. Zero rows is the normal case for a user with no default kit.
 */
const CLEAR_OWN_DEFAULT_SQL = `
update public.brand_kits k
   set is_default = false
 where k.user_id = $1::uuid
   and k.is_default = true
`;

/**
 * `updateOwnKit`: one statement for every possible patch.
 *
 * Three flag/value pairs, one per writable column, so the SQL text never depends
 * on WHICH keys the patch happens to carry. `case when $3::boolean then $4::text
 * else k.name end` is the whole mechanism: when the flag is false the column is
 * assigned its own value, which is a no-op PostgreSQL still evaluates as a write,
 * so the `set_updated_at` trigger fires exactly as it did for the removed
 * PostgREST update of that column.
 *
 * `where k.id = $2::uuid and k.user_id = $1::uuid` is `brand_kits_user_policy`
 * verbatim. A kit that is not the actor's yields zero rows, and the caller below
 * reports that as `{ updated: 0 }` — not as a failure, because the removed write
 * did not treat it as one either.
 */
const UPDATE_OWN_KIT_SQL = `
update public.brand_kits k
   set name = case when $3::boolean then $4::text else k.name end,
       guidance_text = case when $5::boolean then $6::text else k.guidance_text end,
       is_default = case when $7::boolean then $8::boolean else k.is_default end
 where k.id = $2::uuid
   and k.user_id = $1::uuid
returning k.id
`;

/**
 * `deleteOwnKit`: `brand_kits_user_policy` verbatim. The assets of the kit go with
 * it through the `ON DELETE CASCADE` foreign key, exactly as before. Deleting
 * zero rows is not an error — the caller already proved the kit exists, and the
 * removed write did not inspect the result either.
 */
const DELETE_OWN_KIT_SQL = `
delete from public.brand_kits k
 where k.id = $2::uuid
   and k.user_id = $1::uuid
`;

/**
 * `insertOwnAsset`: the append behind `POST /api/brand-kits/:kitId/assets` and the
 * file half of the upload route.
 *
 * The values are supplied by a `select` whose `where exists (...)` IS
 * `brand_kit_assets_policy`: a kit that is not the actor's simply produces no row
 * to insert, so the statement answers zero rows instead of raising, and the caller
 * below turns that into `null`.
 *
 * `asset_type` is bound with `::public.brand_kit_asset_type`, so a value outside
 * the enum is a real SQL error (22P02) — the same classification the PostgREST
 * write produced for the same value.
 */
const INSERT_OWN_ASSET_SQL = `
insert into public.brand_kit_assets
  (kit_id, asset_type, display_name, text_content, role, sort_order, metadata, file_url)
select $2::uuid,
       $3::public.brand_kit_asset_type,
       $4::text,
       $5::text,
       $6::text,
       $7::integer,
       $8::jsonb,
       $9::text
 where exists (select 1 from public.brand_kits k
                where k.id = $2::uuid and k.user_id = $1::uuid)
returning ${ASSET_COLS}
`;

/**
 * `updateOwnAsset`: one statement for every possible patch, five flag/value pairs.
 *
 * The flags are what make `text_content: null` mean "clear the column" while an
 * absent `text_content` means "leave it alone" — the two cases the removed
 * PostgREST update distinguished by whether the key was in its payload object.
 *
 * The `exists` clause is `brand_kit_assets_policy` verbatim; with the asset id and
 * its kit it also enforces what the removed `.eq("id", …).eq("kit_id", …)` pair
 * did, so an asset id from a different kit of the same owner cannot be reached.
 */
const UPDATE_OWN_ASSET_SQL = `
update public.brand_kit_assets a
   set display_name = case when $4::boolean then $5::text else a.display_name end,
       text_content = case when $6::boolean then $7::text else a.text_content end,
       role = case when $8::boolean then $9::text else a.role end,
       sort_order = case when $10::boolean then $11::integer else a.sort_order end,
       metadata = case when $12::boolean then $13::jsonb else a.metadata end
 where a.id = $3::uuid
   and a.kit_id = $2::uuid
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
returning ${ASSET_COLS}
`;

/**
 * `deleteOwnAsset`: `brand_kit_assets_policy` verbatim, plus the asset id and its
 * kit. Zero rows is not an error — the caller is responsible for the 404 it
 * published before this migration, and the removed write ignored the result too.
 */
const DELETE_OWN_ASSET_SQL = `
delete from public.brand_kit_assets a
 where a.id = $3::uuid
   and a.kit_id = $2::uuid
   and exists (select 1 from public.brand_kits k
                where k.id = a.kit_id and k.user_id = $1::uuid)
`;

/**
 * `insertOwnAssetCopies`: the batch copy behind `POST /api/brand-kits/:id/duplicate`.
 *
 * ONE statement for the whole batch, exactly like the removed `.insert(copies)`
 * call: `jsonb_to_recordset` turns the JSON array of copies into rows and the
 * `where exists (...)` gate excludes all of them when the target kit is not the
 * actor's. The four columns the duplicate path leaves out (id, created_at,
 * updated_at, and `kit_id` which is bound once) keep their defaults.
 *
 * `asset_type` is declared as the enum in the recordset definition so PostgreSQL
 * casts each JSON string, which is where an out-of-enum value fails. `metadata`
 * is declared `jsonb` so a null copy keeps a NULL rather than being re-defaulted.
 */
const INSERT_OWN_ASSET_COPIES_SQL = `
insert into public.brand_kit_assets
  (kit_id, asset_type, display_name, text_content, role, sort_order, metadata, file_url)
select $2::uuid,
       c.asset_type,
       c.display_name,
       c.text_content,
       c.role,
       c.sort_order,
       c.metadata,
       c.file_url
  from jsonb_to_recordset($3::jsonb) as c(
         asset_type public.brand_kit_asset_type,
         display_name text,
         text_content text,
         role text,
         sort_order integer,
         metadata jsonb,
         file_url text)
 where exists (select 1 from public.brand_kits k
                where k.id = $2::uuid and k.user_id = $1::uuid)
returning id
`;

/**
 * Build the PostgreSQL implementation. The pool is reached through a getter,
 * never stored: constructing the repository is free, and a missing
 * `DATABASE_URL` only surfaces as a `BrandKitWriteError` on an actual write.
 *
 * There is no fallback path. A caller that was handed this repository either
 * writes through it or fails.
 */
export function createBrandKitWriteRepository(options: {
  getTransactionPool: () => TransactionPool;
}): BrandKitWriteRepository {
  /**
   * The one privileged transaction every method runs in, with the failure
   * classification every method shares: anything that escapes the callback becomes
   * a `BrandKitWriteError` naming ITS operation, and the driver's own error rides
   * along as `cause` only.
   */
  async function write<T>(
    operation: BrandKitWriteOperation,
    actorId: string,
    run: (client: TransactionConnection) => Promise<T>,
  ): Promise<T> {
    try {
      const pool = options.getTransactionPool();

      return await withPrivilegedTransaction(
        pool,
        // The transaction context carries WHO asked, so a privileged write is not
        // anonymous in a log or an audit trail. It grants nothing: the statement's
        // own predicate is the authorisation rule.
        { userId: actorId },
        run,
      );
    } catch (error) {
      throw new BrandKitWriteError(operation, error);
    }
  }

  return {
    async insertOwnKit(input) {
      const actorId = requireWriteArgument(input.actorId, "actorId", INSERT_OWN_KIT);
      const name = requireWriteArgument(input.name, "name", INSERT_OWN_KIT);
      // `guidance_text` is nullable on purpose: the create route has no field for
      // it and passes null, which is the column default's equivalent.
      const guidanceText = requireNullableWriteText(
        input.guidanceText,
        "guidanceText",
        INSERT_OWN_KIT,
      );

      return write(INSERT_OWN_KIT, actorId, async (client) => {
        const result = await client.query(INSERT_OWN_KIT_SQL, [
          actorId,
          name,
          guidanceText,
        ]);

        // The insert has no `where`: it either produced the row or PostgreSQL
        // raised. Zero or two rows is therefore a statement/mapper disagreement.
        if (result.rows.length !== 1) {
          throw new Error("brand kit write inserted no kit row");
        }

        return { id: requireRowString(asWriteRow(result.rows[0]), "id") };
      });
    },

    async clearOwnDefault(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        CLEAR_OWN_DEFAULT,
      );

      // Zero rows is the ordinary "this user had no default kit" answer, so the
      // result is deliberately not inspected.
      await write(CLEAR_OWN_DEFAULT, actorId, async (client) => {
        await client.query(CLEAR_OWN_DEFAULT_SQL, [actorId]);
      });
    },

    async updateOwnKit(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        UPDATE_OWN_KIT,
      );
      const kitId = requireWriteArgument(input.kitId, "kitId", UPDATE_OWN_KIT);
      const patch = input.patch ?? {};

      // The flags are decided HERE, from whether the key is present, and the
      // statement never changes shape because of them.
      const hasName = patch.name !== undefined;
      const hasGuidance = patch.guidance_text !== undefined;
      const hasIsDefault = patch.is_default !== undefined;

      const name = hasName
        ? requireWriteArgument(patch.name, "name", UPDATE_OWN_KIT)
        : null;
      const guidanceText = hasGuidance
        ? requireNullableWriteText(
            patch.guidance_text,
            "guidance_text",
            UPDATE_OWN_KIT,
          )
        : null;
      const isDefault = hasIsDefault
        ? requireWriteBoolean(patch.is_default, "is_default", UPDATE_OWN_KIT)
        : null;

      return write(UPDATE_OWN_KIT, actorId, async (client) => {
        const result = await client.query(UPDATE_OWN_KIT_SQL, [
          actorId,
          kitId,
          hasName,
          name,
          hasGuidance,
          guidanceText,
          hasIsDefault,
          isDefault,
        ]);

        return { updated: result.rows.length };
      });
    },

    async deleteOwnKit(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        DELETE_OWN_KIT,
      );
      const kitId = requireWriteArgument(input.kitId, "kitId", DELETE_OWN_KIT);

      await write(DELETE_OWN_KIT, actorId, async (client) => {
        await client.query(DELETE_OWN_KIT_SQL, [actorId, kitId]);
      });
    },

    async insertOwnAsset(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        INSERT_OWN_ASSET,
      );
      const kitId = requireWriteArgument(input.kitId, "kitId", INSERT_OWN_ASSET);
      const asset = requireAssetInsert(input.asset, INSERT_OWN_ASSET);

      return write(INSERT_OWN_ASSET, actorId, async (client) => {
        const result = await client.query(INSERT_OWN_ASSET_SQL, [
          actorId,
          kitId,
          asset.asset_type,
          asset.display_name,
          asset.text_content,
          asset.role,
          asset.sort_order,
          asset.metadata === null ? null : JSON.stringify(asset.metadata),
          asset.file_url,
        ]);

        // The `exists` gate produces ZERO rows for a kit that is not the actor's:
        // that is the refusal shape the caller maps onto its own "not found",
        // never an error and never a leak of which reason it was.
        if (result.rows.length === 0) return null;

        if (result.rows.length !== 1) {
          throw new Error("brand kit write inserted more than one asset row");
        }

        return mapAssetRow(result.rows[0], INSERT_OWN_ASSET);
      });
    },

    async updateOwnAsset(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        UPDATE_OWN_ASSET,
      );
      const kitId = requireWriteArgument(input.kitId, "kitId", UPDATE_OWN_ASSET);
      const assetId = requireWriteArgument(
        input.assetId,
        "assetId",
        UPDATE_OWN_ASSET,
      );
      const patch = input.patch ?? {};

      const hasDisplayName = patch.display_name !== undefined;
      const hasTextContent = patch.text_content !== undefined;
      const hasRole = patch.role !== undefined;
      const hasSortOrder = patch.sort_order !== undefined;
      const hasMetadata = patch.metadata !== undefined;

      const displayName = hasDisplayName
        ? requireWriteArgument(patch.display_name, "display_name", UPDATE_OWN_ASSET)
        : null;
      // `null` here CLEARS the column; the flag is what tells the statement to do
      // it, so "clear" and "leave alone" stay distinguishable.
      const textContent = hasTextContent
        ? requireNullableWriteText(
            patch.text_content,
            "text_content",
            UPDATE_OWN_ASSET,
          )
        : null;
      const role = hasRole
        ? requireNullableWriteText(patch.role, "role", UPDATE_OWN_ASSET)
        : null;
      const sortOrder = hasSortOrder
        ? requireWriteInteger(patch.sort_order, "sort_order", UPDATE_OWN_ASSET)
        : null;
      const metadata = hasMetadata
        ? requireWriteMetadata(patch.metadata, "metadata", UPDATE_OWN_ASSET)
        : null;

      return write(UPDATE_OWN_ASSET, actorId, async (client) => {
        const result = await client.query(UPDATE_OWN_ASSET_SQL, [
          actorId,
          kitId,
          assetId,
          hasDisplayName,
          displayName,
          hasTextContent,
          textContent,
          hasRole,
          role,
          hasSortOrder,
          sortOrder,
          hasMetadata,
          metadata === null ? null : JSON.stringify(metadata),
        ]);

        if (result.rows.length === 0) return null;

        if (result.rows.length !== 1) {
          throw new Error("brand kit write updated more than one asset row");
        }

        return mapAssetRow(result.rows[0], UPDATE_OWN_ASSET);
      });
    },

    async deleteOwnAsset(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        DELETE_OWN_ASSET,
      );
      const kitId = requireWriteArgument(input.kitId, "kitId", DELETE_OWN_ASSET);
      const assetId = requireWriteArgument(
        input.assetId,
        "assetId",
        DELETE_OWN_ASSET,
      );

      await write(DELETE_OWN_ASSET, actorId, async (client) => {
        await client.query(DELETE_OWN_ASSET_SQL, [actorId, kitId, assetId]);
      });
    },

    async insertOwnAssetCopies(input) {
      const actorId = requireWriteArgument(
        input.actorId,
        "actorId",
        INSERT_OWN_ASSET_COPIES,
      );
      const kitId = requireWriteArgument(
        input.kitId,
        "kitId",
        INSERT_OWN_ASSET_COPIES,
      );

      const copies = (input.copies ?? []).map((copy) =>
        requireAssetCopy(copy, INSERT_OWN_ASSET_COPIES),
      );

      // An empty batch is answered WITHOUT a connection: there is no statement to
      // send, and the removed write sent none either (it was guarded by
      // `assets.length > 0`). Opening a transaction to send nothing would be a new
      // round trip this workorder does not own.
      if (copies.length === 0) return { inserted: 0 };

      return write(INSERT_OWN_ASSET_COPIES, actorId, async (client) => {
        const result = await client.query(INSERT_OWN_ASSET_COPIES_SQL, [
          actorId,
          kitId,
          JSON.stringify(
            copies.map((copy) => ({
              asset_type: copy.asset_type,
              display_name: copy.display_name,
              text_content: copy.text_content,
              role: copy.role,
              sort_order: copy.sort_order,
              metadata: copy.metadata,
              file_url: copy.file_url,
            })),
          ),
        ]);

        return { inserted: result.rows.length };
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
 *
 * Trimming is the caller's decision and is NOT repeated in this module: the
 * service already trimmed the name before it got here, and doing it twice would
 * make the stored value depend on which layer ran.
 */
function requireWriteArgument(
  value: unknown,
  field: string,
  operation: BrandKitWriteOperation,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write needs a non-empty "${field}"`),
    );
  }

  return value;
}

/**
 * A nullable text column: either a string (empty included — it is a legal column
 * value this module has no mandate to reject) or `null`.
 */
function requireNullableWriteText(
  value: unknown,
  field: string,
  operation: BrandKitWriteOperation,
): string | null {
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write needs a nullable string "${field}"`),
    );
  }

  return value;
}

function requireWriteBoolean(
  value: unknown,
  field: string,
  operation: BrandKitWriteOperation,
): boolean {
  if (typeof value !== "boolean") {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write needs a boolean "${field}"`),
    );
  }

  return value;
}

/** `sort_order` is `INT NOT NULL`; a non-integer would silently change the order. */
function requireWriteInteger(
  value: unknown,
  field: string,
  operation: BrandKitWriteOperation,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write needs an integer "${field}"`),
    );
  }

  return value;
}

function requireWriteMetadata(
  value: unknown,
  field: string,
  operation: BrandKitWriteOperation,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write needs an object "${field}"`),
    );
  }

  return value as Record<string, unknown>;
}

function requireAssetInsert(
  value: unknown,
  operation: BrandKitWriteOperation,
): BrandKitAssetInsert {
  const record = asWriteRow(value, operation);

  return {
    asset_type: requireAssetType(record["asset_type"], operation),
    display_name: requireWriteArgument(
      record["display_name"],
      "display_name",
      operation,
    ),
    text_content: requireNullableWriteText(
      record["text_content"],
      "text_content",
      operation,
    ),
    role: requireNullableWriteText(record["role"], "role", operation),
    sort_order: requireWriteInteger(record["sort_order"], "sort_order", operation),
    metadata:
      record["metadata"] === null
        ? null
        : requireWriteMetadata(record["metadata"], "metadata", operation),
    file_url: requireNullableWriteText(record["file_url"], "file_url", operation),
  };
}

function requireAssetCopy(
  value: unknown,
  operation: BrandKitWriteOperation,
): BrandKitAssetCopy {
  const record = asWriteRow(value, operation);

  return {
    asset_type: requireAssetType(record["asset_type"], operation),
    display_name: requireWriteArgument(
      record["display_name"],
      "display_name",
      operation,
    ),
    text_content: requireNullableWriteText(
      record["text_content"],
      "text_content",
      operation,
    ),
    role: requireNullableWriteText(record["role"], "role", operation),
    sort_order: requireWriteInteger(record["sort_order"], "sort_order", operation),
    metadata:
      record["metadata"] === null
        ? null
        : requireWriteMetadata(record["metadata"], "metadata", operation),
    file_url: requireNullableWriteText(record["file_url"], "file_url", operation),
  };
}

const ASSET_TYPES: readonly BrandKitReadAssetType[] = [
  "color",
  "font",
  "logo",
  "image",
];

function requireAssetType(
  value: unknown,
  operation: BrandKitWriteOperation,
): BrandKitReadAssetType {
  for (const candidate of ASSET_TYPES) {
    if (value === candidate) return candidate;
  }

  throw new BrandKitWriteError(
    operation,
    new Error('brand kit write returned an unusable "asset_type"'),
  );
}

function asWriteRow(
  value: unknown,
  operation?: BrandKitWriteOperation,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const failure = new Error("brand kit write received a row that is not an object");

    // Inside a `write()` callback this would be wrapped anyway; the argument
    // validators call it BEFORE the transaction opens, so they pass the operation
    // and get the same classified failure.
    throw operation === undefined
      ? failure
      : new BrandKitWriteError(operation, failure);
  }

  return value as Record<string, unknown>;
}

function requireRowString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`brand kit write returned no usable "${field}"`);
  }

  return value;
}

/** `name` / `display_name` are `text not null`; an empty string is a legal value. */
function requireRowText(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`brand kit write returned an unusable "${field}"`);
  }

  return value;
}

function requireRowNullableString(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new Error(`brand kit write returned an unusable "${field}"`);
  }

  return value;
}

function requireRowInteger(
  row: Readonly<Record<string, unknown>>,
  field: string,
  operation: BrandKitWriteOperation,
): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new BrandKitWriteError(
      operation,
      new Error(`brand kit write returned an unusable "${field}"`),
    );
  }

  return value;
}

/** JSONB: an object or SQL NULL. Anything else is statement/mapper drift. */
function requireRowMetadata(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> | null {
  const value = row[field];
  if (value === null) return null;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`brand kit write returned an unusable "${field}"`);
  }

  return value as Record<string, unknown>;
}

/** ISO-8601 with an explicit offset: the shape the HTTP contract publishes. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * `pg` and PGlite hand back `timestamptz` as a `Date`; the HTTP DTO is a string
 * with an offset. Both are accepted and normalised to `toISOString()`, anything
 * else fails loud — a null timestamp would become an asset the client cannot
 * render.
 *
 * This is the same rule `db/brand-kit-read-repository.ts` applies to the same
 * columns. It is duplicated rather than imported because the two modules report
 * failures as different error classes, and a shared mapper would have to pick one
 * of them.
 */
function requireRowTimestamp(
  row: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = row[field];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`brand kit write returned an unusable "${field}"`);
    }

    return value.toISOString();
  }

  if (typeof value === "string" && ISO_TIMESTAMP.test(value)) {
    return new Date(value).toISOString();
  }

  throw new Error(`brand kit write returned no usable "${field}"`);
}

/** `ASSET_COLS`'s row — the same ten columns the read repository answers. */
function mapAssetRow(
  row: unknown,
  operation: BrandKitWriteOperation,
): BrandKitAssetRow {
  const record = asWriteRow(row);

  return {
    id: requireRowString(record, "id"),
    asset_type: requireAssetType(record["asset_type"], operation),
    display_name: requireRowText(record, "display_name"),
    role: requireRowNullableString(record, "role"),
    sort_order: requireRowInteger(record, "sort_order", operation),
    text_content: requireRowNullableString(record, "text_content"),
    file_url: requireRowNullableString(record, "file_url"),
    metadata: requireRowMetadata(record, "metadata"),
    created_at: requireRowTimestamp(record, "created_at"),
    updated_at: requireRowTimestamp(record, "updated_at"),
  };
}
