import type {
  BrandKitAssetCreateRequest,
  BrandKitAssetUpdateRequest,
  BrandKitCreateRequest,
  BrandKitDetail,
  BrandKitAsset,
  BrandKitSummary,
  BrandKitUpdateRequest,
} from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type {
  BrandKitAssetRow,
  BrandKitListResult,
  BrandKitReadRepository,
  KitDetailRow,
} from "../../db/brand-kit-read-repository.js";
import type {
  BrandKitAssetCopy,
  BrandKitAssetInsert,
  BrandKitAssetPatch,
  BrandKitKitPatch,
  BrandKitWriteRepository,
} from "../../db/brand-kit-write-repository.js";
import { ObjectStoreError } from "../storage/object-store.js";
import type { ObjectRef, ObjectStore } from "../storage/object-store.js";

const BRAND_KIT_BUCKET = "brand-kit-assets";
const SIGNED_URL_EXPIRY_SECONDS = 3600;

const KIT_NOT_FOUND_MESSAGE = "Brand kit not found.";
const KIT_CREATE_FAILED_MESSAGE = "Unable to create brand kit.";
const KIT_UPDATE_FAILED_MESSAGE = "Unable to update brand kit.";
const KIT_DELETE_FAILED_MESSAGE = "Unable to delete brand kit.";
const KIT_QUERY_FAILED_MESSAGE = "Unable to load brand kits.";
const ASSET_NOT_FOUND_MESSAGE = "Brand kit asset not found.";
const ASSET_CREATE_FAILED_MESSAGE = "Unable to create brand kit asset.";

type BrandKitServiceErrorCode =
  | "brand_kit_not_found"
  | "brand_kit_create_failed"
  | "brand_kit_update_failed"
  | "brand_kit_delete_failed"
  | "brand_kit_query_failed"
  | "brand_kit_asset_not_found"
  | "brand_kit_asset_create_failed";

export class BrandKitServiceError extends Error {
  readonly statusCode: number;
  readonly code: BrandKitServiceErrorCode;

  constructor(
    code: BrandKitServiceErrorCode,
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Every delete in this file ignored its storage error before the migration and
 * still does: a failed remove never decided the outcome of the kit or asset
 * operation around it. Swallowing here keeps that behaviour in one place.
 */
async function removeQuietly(
  store: ObjectStore,
  refs: readonly ObjectRef[],
): Promise<void> {
  try {
    await store.delete(refs);
  } catch {
    // Swallowed on purpose: see the doc comment above.
  }
}

export type BrandKitService = {
  listKits(user: AuthenticatedUser): Promise<BrandKitSummary[]>;
  getKit(user: AuthenticatedUser, kitId: string): Promise<BrandKitDetail>;
  createKit(
    user: AuthenticatedUser,
    input: BrandKitCreateRequest,
  ): Promise<BrandKitDetail>;
  updateKit(
    user: AuthenticatedUser,
    kitId: string,
    input: BrandKitUpdateRequest,
  ): Promise<BrandKitDetail>;
  deleteKit(user: AuthenticatedUser, kitId: string): Promise<void>;
  createAsset(
    user: AuthenticatedUser,
    kitId: string,
    input: BrandKitAssetCreateRequest,
  ): Promise<BrandKitAsset>;
  updateAsset(
    user: AuthenticatedUser,
    kitId: string,
    assetId: string,
    input: BrandKitAssetUpdateRequest,
  ): Promise<BrandKitAsset>;
  deleteAsset(
    user: AuthenticatedUser,
    kitId: string,
    assetId: string,
  ): Promise<void>;
  uploadAsset(
    user: AuthenticatedUser,
    kitId: string,
    assetType: "logo" | "image",
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<BrandKitAsset>;
  duplicateKit(
    user: AuthenticatedUser,
    kitId: string,
  ): Promise<BrandKitDetail>;
};

export function createBrandKitService(options: {
  /**
   * 45AH / T-133 (2nd slice), re-shaped by 45BB / T-133 (10a): object storage
   * arrives as a FACTORY keyed on the CALLER's access token —
   * `(accessToken) => ObjectStore`, never a shared instance and no longer a
   * Supabase-shaped client.
   *
   * Why not the single `ObjectStore` the first slice injected elsewhere: brand
   * kit signing is per USER. The signed URL used to come from a user-scoped
   * client built for the caller's token, so Storage answered under that user's
   * RLS.
   * A shared store would sign with whatever identity its own client carries
   * (the server's/admin's), which widens the permission on this feature — a
   * security regression, not a tidy-up. The caller's token is therefore passed
   * at every call site below and the assembly point decides how a store is
   * built from it; this file no longer names a client type at all, so it no
   * longer knows which backend builds the store (OP-05 / 43J: the `ObjectStore`
   * seam only — every call maps onto the exact SDK call this file used to
   * make).
   *
   * REQUIRED on purpose, like the two repositories below: this service has
   * exactly one assembly point (`app.ts`), and workorder 21X measured that an
   * OPTIONAL dependency fails silently when its one wiring line is dropped (the
   * type check still exits 0, the failure is only at runtime). Required means a
   * missing wire is a compile error instead.
   */
  createObjectStore: (accessToken: string) => ObjectStore;
  /**
   * ADR-0001 / workorder 21Y: the PostgreSQL home of the two reads behind
   * `listKits`. REQUIRED on purpose — this service has exactly one assembly
   * point (`app.ts`), and workorder 21X measured that an OPTIONAL dependency
   * fails silently when its one wiring line is dropped: the type check still
   * exits 0, and the read would only fail at runtime. Required means a missing
   * wire is a compile error instead.
   */
  brandKitReadRepository: BrandKitReadRepository;
  /**
   * ADR-0001 / workorder 21Z: the PostgreSQL home of every brand kit WRITE.
   *
   * REQUIRED for the same reason `brandKitReadRepository` is: this service has
   * exactly one assembly point (`app.ts`), and workorder 21X measured that an
   * OPTIONAL dependency fails silently when its one wiring line is dropped — the
   * type check still exits 0 and the write only fails at runtime. Required means
   * a missing wire is a compile error instead.
   */
  brandKitWriteRepository: BrandKitWriteRepository;
}): BrandKitService {
  /**
   * ADR-0001 / workorder 21Z: `fetchKitDetail` takes the USER, not a
   * user-scoped client.
   *
   * The two reads moved to `BrandKitReadRepository` (owner-only ACL written into
   * the SQL), and a store is built only when there really is a file asset whose
   * path needs a signed URL. The signing logic itself is unchanged — this method
   * is still the reason `createKit`, `updateKit` and `getKit` can end up building
   * one.
   */
  async function fetchKitDetail(
    user: AuthenticatedUser,
    kitId: string,
  ): Promise<BrandKitDetail> {
    // The removed PostgREST read answered a FAILED query and "no such kit"
    // differently — `brand_kit_not_found` / 500 versus `brand_kit_not_found` /
    // 404 — so the two outcomes are kept apart here too, even though both look
    // like a bug at first glance. Workorder 21Z freezes them as they are.
    let kit: KitDetailRow | null;

    try {
      kit = await options.brandKitReadRepository.findOwnKit({
        actorId: user.id,
        kitId,
      });
    } catch {
      throw new BrandKitServiceError(
        "brand_kit_not_found",
        KIT_NOT_FOUND_MESSAGE,
        500,
      );
    }

    if (!kit) {
      throw new BrandKitServiceError(
        "brand_kit_not_found",
        KIT_NOT_FOUND_MESSAGE,
        404,
      );
    }

    let assetRows: BrandKitAssetRow[];

    try {
      assetRows = await options.brandKitReadRepository.listOwnKitAssets({
        actorId: user.id,
        kitId,
      });
    } catch {
      throw new BrandKitServiceError(
        "brand_kit_query_failed",
        KIT_QUERY_FAILED_MESSAGE,
        500,
      );
    }

    const mappedAssets = assetRows.map(mapAssetRow);

    // Resolve signed URLs for file-based assets (logo/image)
    const fileAssets = mappedAssets.filter((a) => a.file_url);
    if (fileAssets.length > 0) {
      const store = options.createObjectStore(user.accessToken);
      const paths = fileAssets.map((a) => a.file_url!);
      const signed = await store.signedReadUrls(
        BRAND_KIT_BUCKET,
        paths,
        { ttlSeconds: SIGNED_URL_EXPIRY_SECONDS },
      );

      for (const asset of fileAssets) {
        const url = signed.get(asset.file_url!);
        if (url) asset.file_url = url;
      }
    }

    return {
      id: kit.id,
      name: kit.name,
      is_default: kit.is_default,
      guidance_text: kit.guidance_text,
      cover_url: kit.cover_url,
      assets: mappedAssets,
      created_at: kit.created_at,
      updated_at: kit.updated_at,
    };
  }

  return {
    async listKits(user) {
      // ADR-0001 / workorder 21Y: the two PostgREST reads that used to run here —
      // the caller's own kit rows, then the `kit_id`/`asset_type` rows of exactly
      // those kits — now run in `BrandKitReadRepository.listOwnKits`. That
      // repository replaces the two RLS policies with their verbatim SQL rather
      // than deriving a new ACL: `brand_kits` and `brand_kit_assets` are
      // owner-only, so it keys on the actor alone. The caller's own client is no
      // longer created here at all.
      let rows: BrandKitListResult;

      try {
        rows = await options.brandKitReadRepository.listOwnKits({
          actorId: user.id,
        });
      } catch {
        // `http/brand-kits.ts` answers anything that is not a
        // `BrandKitServiceError` with its own 500 and the message
        // "An unexpected error occurred.", so the repository's fixed
        // `BrandKitReadError` has to be translated here to keep the published
        // code AND message unchanged.
        throw new BrandKitServiceError(
          "brand_kit_query_failed",
          KIT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      const { kits, assets } = rows;

      if (!kits.length) {
        return [];
      }

      const countsByKit = new Map<
        string,
        { color: number; font: number; logo: number; image: number }
      >();

      for (const asset of assets) {
        let counts = countsByKit.get(asset.kit_id);
        if (!counts) {
          counts = { color: 0, font: 0, logo: 0, image: 0 };
          countsByKit.set(asset.kit_id, counts);
        }
        counts[asset.asset_type] += 1;
      }

      return kits.map((kit): BrandKitSummary => ({
        id: kit.id,
        name: kit.name,
        is_default: kit.is_default,
        cover_url: kit.cover_url,
        asset_counts: countsByKit.get(kit.id) ?? {
          color: 0,
          font: 0,
          logo: 0,
          image: 0,
        },
        created_at: kit.created_at,
        updated_at: kit.updated_at,
      }));
    },

    async getKit(user, kitId) {
      // No user-scoped client here: the detail is read through the repository, and
      // `fetchKitDetail` creates one only if a file path needs a signed URL.
      return fetchKitDetail(user, kitId);
    },

    async createKit(user, input) {
      const name = input.name?.trim() || "\u672A\u547D\u540D";

      // ADR-0001 / workorder 21Z: the insert runs in
      // `BrandKitWriteRepository.insertOwnKit`, whose `user_id = $1::uuid` is the
      // INSERT half of `brand_kits_user_policy` written out — a privileged
      // connection bypasses the policy, so the statement's own predicate is the
      // only gate. `guidance_text` is passed as null, which is what "column not
      // named by the removed insert" meant (it is nullable with no default).
      let kit: { id: string };

      try {
        kit = await options.brandKitWriteRepository.insertOwnKit({
          actorId: user.id,
          name,
          guidanceText: null,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_create_failed",
          KIT_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      return fetchKitDetail(user, kit.id);
    },

    async updateKit(user, kitId, input) {
      // If setting as default, clear existing default first.
      //
      // ADR-0001 / workorder 21Z: this stays a SEPARATE statement from the update
      // below, exactly as it was. Merging the two into one transaction would look
      // tidier and WOULD change the failure behaviour — today a successful clear
      // followed by a failed update leaves the user with no default kit, and that
      // is the behaviour this migration has to keep.
      if (input.is_default === true) {
        try {
          await options.brandKitWriteRepository.clearOwnDefault({
            actorId: user.id,
          });
        } catch {
          throw new BrandKitServiceError(
            "brand_kit_update_failed",
            KIT_UPDATE_FAILED_MESSAGE,
            500,
          );
        }
      }

      const patch: BrandKitKitPatch = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.guidance_text !== undefined) patch.guidance_text = input.guidance_text;
      if (input.is_default !== undefined) patch.is_default = input.is_default;

      if (Object.keys(patch).length === 0) {
        return fetchKitDetail(user, kitId);
      }

      try {
        // The touched-row count is deliberately not inspected: the removed write
        // only logged a note about `count === 0` and let the follow-up detail read
        // decide between 404 and 200. An update that matched nothing — the kit is
        // not the actor's, or it does not exist — therefore still ends up as the
        // 404 that `fetchKitDetail` raises.
        await options.brandKitWriteRepository.updateOwnKit({
          actorId: user.id,
          kitId,
          patch,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_update_failed",
          KIT_UPDATE_FAILED_MESSAGE,
          500,
        );
      }

      return fetchKitDetail(user, kitId);
    },

    async deleteKit(user, kitId) {
      let existing: KitDetailRow | null;

      try {
        existing = await options.brandKitReadRepository.findOwnKit({
          actorId: user.id,
          kitId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      if (!existing) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Clean up storage objects for file-based assets.
      //
      // ADR-0001 / workorder 21Z: this path read SWALLOWED its error before the
      // migration and still does — a failed lookup means "no paths", the kit is
      // deleted anyway and the objects are left behind. Turning it into a 500
      // would be a behaviour change this workorder explicitly does not own.
      let fileUrls: string[] = [];

      try {
        fileUrls = await options.brandKitReadRepository.listOwnKitFileUrls({
          actorId: user.id,
          kitId,
        });
      } catch {
        // Swallowed on purpose: see above, and the removed read did the same.
      }

      const paths = fileUrls.filter((path) => !!path);

      if (paths.length > 0) {
        const store = options.createObjectStore(user.accessToken);
        await removeQuietly(
          store,
          paths.map((path) => ({ bucket: BRAND_KIT_BUCKET, key: path })),
        );
      }

      try {
        await options.brandKitWriteRepository.deleteOwnKit({
          actorId: user.id,
          kitId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }
    },

    async createAsset(user, kitId, input) {
      // ADR-0001 / workorder 21Z: NO user-scoped client on this path at all —
      // nothing here touches Storage. The kit probe, the sort-order read and the
      // insert are three repository calls, and each keeps the outcome it had.
      let kit: KitDetailRow | null;

      try {
        kit = await options.brandKitReadRepository.findOwnKit({
          actorId: user.id,
          kitId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!kit) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Get max sort_order for this kit + asset_type.
      //
      // Swallowed on purpose: a failed read here meant "no rows", so the next
      // asset got sort_order 0. That is the pre-migration behaviour exactly, and
      // workorder 21Z freezes it rather than fixing it.
      let nextSortOrder = 0;

      try {
        nextSortOrder = await options.brandKitReadRepository.readNextSortOrder({
          actorId: user.id,
          kitId,
          assetType: input.asset_type,
        });
      } catch {
        nextSortOrder = 0;
      }

      const asset: BrandKitAssetInsert = {
        asset_type: input.asset_type,
        display_name: input.display_name,
        text_content: input.text_content ?? null,
        role: input.role ?? null,
        sort_order: nextSortOrder,
        // The removed insert sent `input.metadata ?? {}`; the column default is
        // also `'{}'`, so both spellings store the same value.
        metadata: input.metadata ?? {},
        // The removed insert never named `file_url`: the column default (NULL)
        // applied. Binding NULL is the same row.
        file_url: null,
      };

      let created: BrandKitAssetRow | null;

      try {
        created = await options.brandKitWriteRepository.insertOwnAsset({
          actorId: user.id,
          kitId,
          asset,
        });
      } catch {
        created = null;
      }

      // A `null` answer is the repository's refused-insert shape (the kit turned
      // out not to be the actor's) and a throw is a real failure: both produced
      // `brand_kit_asset_create_failed` / 500 before the migration.
      if (!created) {
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          ASSET_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      return mapAssetRow(created);
    },

    async updateAsset(user, kitId, assetId, input) {
      // ADR-0001 / workorder 21Z: no user-scoped client on this path — nothing
      // here touches Storage.
      const patch: BrandKitAssetPatch = {};
      if (input.display_name !== undefined) patch.display_name = input.display_name;
      if (input.text_content !== undefined) patch.text_content = input.text_content;
      if (input.role !== undefined) patch.role = input.role;
      if (input.sort_order !== undefined) patch.sort_order = input.sort_order;
      if (input.metadata !== undefined) patch.metadata = input.metadata;

      if (Object.keys(patch).length === 0) {
        // Nothing to update, just fetch and return current state.
        let current: BrandKitAssetRow | null;

        try {
          current = await options.brandKitReadRepository.findOwnAsset({
            actorId: user.id,
            kitId,
            assetId,
          });
        } catch {
          // A FAILED read and a missing row both answered
          // `brand_kit_asset_not_found` before the migration, but with 500 and
          // 404 respectively. That asymmetry is frozen here (workorder 21Z §6).
          throw new BrandKitServiceError(
            "brand_kit_asset_not_found",
            ASSET_NOT_FOUND_MESSAGE,
            500,
          );
        }

        if (!current) {
          throw new BrandKitServiceError(
            "brand_kit_asset_not_found",
            ASSET_NOT_FOUND_MESSAGE,
            404,
          );
        }

        return mapAssetRow(current);
      }

      let asset: BrandKitAssetRow | null;

      try {
        asset = await options.brandKitWriteRepository.updateOwnAsset({
          actorId: user.id,
          kitId,
          assetId,
          patch,
        });
      } catch {
        // A failed UPDATE is `brand_kit_update_failed` / 500 — not the
        // asset-not-found pair above. Both codes are pre-migration behaviour.
        throw new BrandKitServiceError(
          "brand_kit_update_failed",
          KIT_UPDATE_FAILED_MESSAGE,
          500,
        );
      }

      if (!asset) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      return mapAssetRow(asset);
    },

    async deleteAsset(user, kitId, assetId) {
      let existing: BrandKitAssetRow | null;

      try {
        existing = await options.brandKitReadRepository.findOwnAsset({
          actorId: user.id,
          kitId,
          assetId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      if (!existing) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Clean up storage object if this asset has a file. This is the only step
      // on the path that still needs a user-scoped client.
      if (existing.file_url) {
        const store = options.createObjectStore(user.accessToken);
        await removeQuietly(store, [
          { bucket: BRAND_KIT_BUCKET, key: existing.file_url },
        ]);
      }

      try {
        await options.brandKitWriteRepository.deleteOwnAsset({
          actorId: user.id,
          kitId,
          assetId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }
    },

    async uploadAsset(user, kitId, assetType, fileName, fileBuffer, mimeType) {
      // Verify kit exists and belongs to user — through the repository, BEFORE the
      // user-scoped client is created: the upload path must not open a PostgREST
      // client just to answer a 404.
      let kit: KitDetailRow | null;

      try {
        kit = await options.brandKitReadRepository.findOwnKit({
          actorId: user.id,
          kitId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!kit) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Storage: the ONLY reason this method still builds a store.
      const store = options.createObjectStore(user.accessToken);

      // Upload to storage
      const timestamp = Date.now();
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `${user.id}/${kitId}/${timestamp}-${safeName}`;

      try {
        await store.put(
          { bucket: BRAND_KIT_BUCKET, key: objectPath },
          fileBuffer,
          { contentType: mimeType, upsert: false },
        );
      } catch (error) {
        // The published sentence is the backend's own message, so the detail is
        // read instead of the composed one.
        const detail =
          error instanceof ObjectStoreError
            ? (error.detail ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          `File upload failed: ${detail}`,
          500,
        );
      }

      // Get max sort_order. Swallowed on purpose, exactly as on the createAsset
      // path: a failed read meant "no rows", so the next asset got sort_order 0.
      let nextSortOrder = 0;

      try {
        nextSortOrder = await options.brandKitReadRepository.readNextSortOrder({
          actorId: user.id,
          kitId,
          assetType,
        });
      } catch {
        nextSortOrder = 0;
      }

      // Create asset record — store object path in file_url
      const displayName = fileName.replace(/\.[^.]+$/, "");
      const asset: BrandKitAssetInsert = {
        asset_type: assetType,
        display_name: displayName,
        text_content: null,
        role: null,
        sort_order: nextSortOrder,
        // The removed insert named neither `metadata` nor `text_content`, so both
        // column defaults applied — `'{}'` and NULL. Binding those same values
        // writes the same row; passing nothing is not possible with a fixed
        // statement, which is exactly why they are written out here.
        metadata: {},
        file_url: objectPath,
      };

      let created: BrandKitAssetRow | null;

      try {
        created = await options.brandKitWriteRepository.insertOwnAsset({
          actorId: user.id,
          kitId,
          asset,
        });
      } catch {
        created = null;
      }

      if (!created) {
        // Clean up uploaded file on DB failure
        await removeQuietly(store, [
          { bucket: BRAND_KIT_BUCKET, key: objectPath },
        ]);
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          ASSET_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      // Generate signed URL for the response
      const mapped = mapAssetRow(created);
      try {
        mapped.file_url = await store.signedReadUrl(
          { bucket: BRAND_KIT_BUCKET, key: objectPath },
          { ttlSeconds: SIGNED_URL_EXPIRY_SECONDS },
        );
      } catch {
        // Unchanged: no signed URL means the stored path comes back as it is.
      }
      return mapped;
    },

    async duplicateKit(user, kitId) {
      // Fetch source kit — the same owner-only detail read as everywhere else, on
      // a path that must not open a user-scoped client just to look.
      let source: KitDetailRow | null;

      try {
        source = await options.brandKitReadRepository.findOwnKit({
          actorId: user.id,
          kitId,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!source) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Create new kit (never copy is_default)
      let newKit: { id: string };

      try {
        newKit = await options.brandKitWriteRepository.insertOwnKit({
          actorId: user.id,
          name: `${source.name} (副本)`,
          guidanceText: source.guidance_text,
        });
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_create_failed",
          KIT_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      // Copy non-file assets (colors, fonts) directly.
      //
      // ADR-0001 / workorder 21Z: this read SWALLOWED its error before the
      // migration and still does — a failed lookup means "no assets to copy", the
      // duplicate is still returned, and that is exactly what happens now.
      let assets: BrandKitAssetRow[] = [];

      try {
        assets = await options.brandKitReadRepository.listOwnKitAssets({
          actorId: user.id,
          kitId,
        });
      } catch {
        // Swallowed on purpose: see above, and the removed read did the same.
      }

      if (assets.length > 0) {
        // Storage is the ONLY reason this path builds a store, and it is built
        // only when there is at least one asset to look at.
        const store = options.createObjectStore(user.accessToken);
        const copies: BrandKitAssetCopy[] = [];

        for (const asset of assets) {
          let newFileUrl: string | null = null;

          // For file-based assets, copy the storage object
          if (asset.file_url) {
            const ext = asset.file_url.split(".").pop() ?? "bin";
            const newPath = `${user.id}/${newKit.id}/${Date.now()}-copy.${ext}`;
            try {
              await store.copy(
                { bucket: BRAND_KIT_BUCKET, key: asset.file_url },
                { bucket: BRAND_KIT_BUCKET, key: newPath },
              );
              newFileUrl = newPath;
            } catch {
              // Unchanged: a failed copy leaves the duplicate without a file.
            }
          }

          copies.push({
            asset_type: asset.asset_type,
            display_name: asset.display_name,
            role: asset.role,
            sort_order: asset.sort_order,
            text_content: asset.text_content,
            file_url: newFileUrl,
            metadata: asset.metadata,
          });
        }

        // ADR-0001 / workorder 21Z: this batch insert IGNORED its error before the
        // migration and still does — the duplicate comes back either way, with
        // whatever rows made it in. `kit_id` is bound once for the whole batch.
        try {
          await options.brandKitWriteRepository.insertOwnAssetCopies({
            actorId: user.id,
            kitId: newKit.id,
            copies,
          });
        } catch {
          // Swallowed on purpose: see above, and the removed write did the same.
        }
      }

      return fetchKitDetail(user, newKit.id);
    },
  };
}

/**
 * ADR-0001 / workorder 21Z: the row this maps is now the ten-column
 * `BrandKitAssetRow` the two repositories answer, not a PostgREST result. The
 * mapping itself is unchanged — including `metadata ?? {}`, which is the one place
 * a SQL NULL becomes the `{}` the response contract requires.
 */
function mapAssetRow(row: BrandKitAssetRow): BrandKitAsset {
  return {
    id: row.id,
    asset_type: row.asset_type as BrandKitAsset["asset_type"],
    display_name: row.display_name,
    role: row.role,
    sort_order: row.sort_order,
    text_content: row.text_content,
    file_url: row.file_url,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
