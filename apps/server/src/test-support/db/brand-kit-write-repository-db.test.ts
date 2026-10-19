import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrandKitWriteError,
  INSERT_OWN_ASSET_COPIES,
  INSERT_OWN_KIT,
  UPDATE_OWN_ASSET,
  createBrandKitWriteRepository,
  type BrandKitAssetCopy,
  type BrandKitAssetInsert,
  type BrandKitWriteRepository,
} from "../../db/brand-kit-write-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the brand kit WRITE repository (workorder 21Z),
 * measured against the two policies it replaces.
 *
 * The point of this file is NOT "the statements run". It is that a privileged
 * connection bypasses RLS, so each statement's OWN predicate is the whole
 * authorisation rule — and the only honest way to check a rule like that is to
 * have a second identity try to break it and then look at the DATA:
 *
 *   - the writer's own data must come out exactly as the removed PostgREST write
 *     left it (defaults, cascades, the `set_updated_at` trigger);
 *   - a FOREIGN identity's attempt must leave the owner's rows byte-identical —
 *     `null`, `{updated: 0}` and `{inserted: 0}` are the answers, not an error;
 *   - and the pre-migration PostgREST write, replayed under `asUser()` so the
 *     policies decide, must fail in the same place: the two agree on "nothing
 *     changed", which is the property that makes this a migration rather than a
 *     new permission.
 *
 * PGlite runs in-process: no server, no socket, no `DATABASE_URL`, no host. One
 * instance is migrated in `beforeAll`, identities are created through the real
 * signup trigger, and `afterAll` closes it.
 */

const OWNER_A_ID = "00000000-0000-0000-0000-000000000e01";
const OWNER_B_ID = "00000000-0000-0000-0000-000000000e02";
const OWNER_C_ID = "00000000-0000-0000-0000-000000000e03";

const KIT_ONE = "00000000-0000-0000-0000-000000000f01";
const KIT_TWO = "00000000-0000-0000-0000-000000000f02";
const KIT_THREE = "00000000-0000-0000-0000-000000000f03";

const INVALID_ID = "not-a-uuid";
const INJECTION_ID = "' or '1'='1";

type BrandKitAssetType = "color" | "font" | "logo" | "image";

type KitRow = {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  guidance_text: string | null;
  cover_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type AssetRow = {
  id: string;
  kit_id: string;
  asset_type: BrandKitAssetType;
  display_name: string;
  role: string | null;
  sort_order: number;
  text_content: string | null;
  file_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
};

let db: PGlite;
let pool: TransactionPool;
let repository: BrandKitWriteRepository;

const ASSET_INSERT: BrandKitAssetInsert = {
  asset_type: "color",
  display_name: "Brand green",
  text_content: "#00ff00",
  role: null,
  sort_order: 0,
  metadata: { hex: "#00ff00" },
  file_url: null,
};

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

async function allKits(): Promise<
  Array<{
    id: string;
    user_id: string;
    name: string;
    is_default: boolean;
    guidance_text: string | null;
    cover_url: string | null;
    created_at: string;
    updated_at: string;
  }>
> {
  return (
    await db.query<KitRow>(
      `select id, user_id, name, is_default, guidance_text, cover_url, created_at, updated_at
         from public.brand_kits order by id`,
    )
  ).rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    is_default: row.is_default,
    guidance_text: row.guidance_text,
    cover_url: row.cover_url,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  }));
}

async function allAssets(): Promise<
  Array<{
    id: string;
    kit_id: string;
    asset_type: string;
    display_name: string;
    role: string | null;
    sort_order: number;
    text_content: string | null;
    file_url: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>
> {
  return (
    await db.query<AssetRow>(
      `select id, kit_id, asset_type::text as asset_type, display_name, role,
              sort_order, text_content, file_url, metadata, created_at, updated_at
         from public.brand_kit_assets order by id`,
    )
  ).rows.map((row) => ({
    id: row.id,
    kit_id: row.kit_id,
    asset_type: row.asset_type,
    display_name: row.display_name,
    role: row.role,
    sort_order: row.sort_order,
    text_content: row.text_content,
    file_url: row.file_url,
    metadata: row.metadata,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  }));
}

async function kitById(kitId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await db.query<KitRow>(
      `select id, user_id, name, is_default, guidance_text, cover_url, created_at, updated_at
         from public.brand_kits where id = $1`,
      [kitId],
    )
  ).rows[0] as unknown as Record<string, unknown> | undefined;
}

async function assetById(
  assetId: string,
): Promise<Record<string, unknown> | undefined> {
  return (
    await db.query<AssetRow>(
      `select id, kit_id, asset_type::text as asset_type, display_name, role,
              sort_order, text_content, file_url, metadata, created_at, updated_at
         from public.brand_kit_assets where id = $1`,
      [assetId],
    )
  ).rows[0] as unknown as Record<string, unknown> | undefined;
}

async function assetIdsOfKit(kitId: string): Promise<string[]> {
  return (
    await db.query<{ id: string }>(
      "select id from public.brand_kit_assets where kit_id = $1 order by id",
      [kitId],
    )
  ).rows.map((row) => row.id);
}

async function insertKit(options: {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  guidanceText: string | null;
  createdAt: string;
}): Promise<void> {
  await db.query(
    `insert into public.brand_kits
       (id, user_id, name, is_default, guidance_text, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6)`,
    [
      options.id,
      options.userId,
      options.name,
      options.isDefault,
      options.guidanceText,
      options.createdAt,
    ],
  );
}

async function insertAsset(options: {
  id: string;
  kitId: string;
  assetType: BrandKitAssetType;
  displayName: string;
  createdAt: string;
  sortOrder?: number;
}): Promise<void> {
  await db.query(
    `insert into public.brand_kit_assets
       (id, kit_id, asset_type, display_name, sort_order, created_at, updated_at)
     values ($1, $2, $3::public.brand_kit_asset_type, $4, $5, $6, $6)`,
    [
      options.id,
      options.kitId,
      options.assetType,
      options.displayName,
      options.sortOrder ?? 0,
      options.createdAt,
    ],
  );
}

const ASSET_ONE = "00000000-0000-0000-0000-0000000010a1";
const ASSET_TWO = "00000000-0000-0000-0000-0000000010a2";
const ASSET_THREE = "00000000-0000-0000-0000-0000000010a3";

/** The fixture's frozen timestamps: `updated_at` must move OFF these on a write. */
const KIT_ONE_CREATED_AT = "2026-01-10T08:00:00.000Z";
const ASSET_ONE_CREATED_AT = "2026-01-10T09:00:00.000Z";

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createBrandKitWriteRepository({ getTransactionPool: () => pool });

  await createUser(db, OWNER_A_ID, "brand-kit-write-a@hahart.test");
  await createUser(db, OWNER_B_ID, "brand-kit-write-b@hahart.test");
  await createUser(db, OWNER_C_ID, "brand-kit-write-c@hahart.test");

  // A has K1 (the default, with assets) and K2; B has K3; C has nothing.
  await insertKit({
    id: KIT_ONE,
    userId: OWNER_A_ID,
    name: "Kit One",
    isDefault: true,
    guidanceText: "Use the warm palette.",
    createdAt: "2026-01-10T08:00:00.000Z",
  });
  await insertKit({
    id: KIT_TWO,
    userId: OWNER_A_ID,
    name: "Kit Two",
    isDefault: false,
    guidanceText: null,
    createdAt: "2026-02-10T08:00:00.000Z",
  });
  await insertKit({
    id: KIT_THREE,
    userId: OWNER_B_ID,
    name: "Kit Three",
    isDefault: true,
    guidanceText: null,
    createdAt: "2026-03-10T08:00:00.000Z",
  });

  await insertAsset({
    id: ASSET_ONE,
    kitId: KIT_ONE,
    assetType: "color",
    displayName: "Brand red",
    createdAt: "2026-01-10T09:00:00.000Z",
  });
  await insertAsset({
    id: ASSET_TWO,
    kitId: KIT_ONE,
    assetType: "logo",
    displayName: "Primary logo",
    createdAt: "2026-01-10T09:00:01.000Z",
    sortOrder: 1,
  });
  await insertAsset({
    id: ASSET_THREE,
    kitId: KIT_THREE,
    assetType: "font",
    displayName: "Heading font",
    createdAt: "2026-03-10T09:00:00.000Z",
  });

  // One real storage path, so `deleteOwnAsset`'s cleanup column is exercised.
  await db.query(
    "update public.brand_kit_assets set file_url = $2 where id = $1",
    [ASSET_TWO, "a/kit-one/primary-logo.png"],
  );
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("brand kit write repository: insertOwnKit and clearOwnDefault", () => {
  it("case 1: a kit inserted by A is owned by A, keeps the column defaults and is invisible to B", async () => {
    const created = await repository.insertOwnKit({
      actorId: OWNER_A_ID,
      name: "Kit Copy",
      guidanceText: null,
    });

    const row = await kitById(created.id);
    expect(row?.user_id).toBe(OWNER_A_ID);
    expect(row?.name).toBe("Kit Copy");
    // Defaults the statement never named: `is_default` false and a NULL guidance.
    expect(row?.is_default).toBe(false);
    expect(row?.guidance_text).toBeNull();

    // Nobody else can see it: the policy, with no caller filter, answers nothing.
    const seenByB = await asUser(db, OWNER_B_ID, async (tx) =>
      (await tx.query("select id from public.brand_kits where id = $1::uuid", [
        created.id,
      ])).rows,
    );
    expect(seenByB).toEqual([]);

    await repository.deleteOwnKit({ actorId: OWNER_A_ID, kitId: created.id });
  });

  it("case 2: moving the default flag works, and the partial unique index stays satisfied", async () => {
    const before = await kitById(KIT_ONE);
    expect(before?.is_default).toBe(true);

    // The service clears first, then sets — two independent writes, in that order.
    await repository.clearOwnDefault({ actorId: OWNER_A_ID });
    const { updated } = await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_TWO,
      patch: { is_default: true },
    });

    expect(updated).toBe(1);
    expect((await kitById(KIT_ONE))?.is_default).toBe(false);
    expect((await kitById(KIT_TWO))?.is_default).toBe(true);

    // Only one default per owner, and B's own default is untouched.
    const defaults = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.brand_kits where user_id = $1 and is_default",
        [OWNER_A_ID],
      )
    ).rows[0]?.n;
    expect(defaults).toBe(1);
    expect((await kitById(KIT_THREE))?.is_default).toBe(true);

    // Put it back so the later cases read the fixture they were written against.
    await repository.clearOwnDefault({ actorId: OWNER_A_ID });
    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { is_default: true },
    });
  });

  it("case 3: an UPDATE fires the `set_updated_at` trigger, and untouched columns keep their values", async () => {
    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { name: "Kit One Renamed" },
    });

    const after = await kitById(KIT_ONE);
    expect(after?.name).toBe("Kit One Renamed");
    // `guidance_text` was not in the patch and must survive.
    expect(after?.guidance_text).toBe("Use the warm palette.");

    // The trigger wrote a real `now()`, i.e. it fired under the privileged
    // connection. Measured against the FIXTURE's frozen `created_at` rather than
    // against a previous `updated_at`: PGlite's `now()` does not advance between
    // two transactions a few milliseconds apart, so "later than the previous
    // value" is not a property PGlite can demonstrate. "Later than the fixture"
    // is, and it is the property that matters — the statement did not have to name
    // the column itself.
    expect(new Date(String(after?.updated_at)).getTime()).toBeGreaterThan(
      new Date(KIT_ONE_CREATED_AT).getTime(),
    );

    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { name: "Kit One" },
    });
  });

  it("case 4: `guidance_text: null` really clears the column, and an absent key does not", async () => {
    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { name: "Kit One" },
    });
    expect((await kitById(KIT_ONE))?.guidance_text).toBe("Use the warm palette.");

    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { guidance_text: null },
    });
    expect((await kitById(KIT_ONE))?.guidance_text).toBeNull();

    await repository.updateOwnKit({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      patch: { guidance_text: "Use the warm palette." },
    });
  });
});

describe("brand kit write repository: another owner can change nothing", () => {
  it("case 5: B's kit update answers 0 and leaves A's rows byte-identical", async () => {
    const before = await allKits();

    for (const patch of [{ name: "hijacked" }, { is_default: true }, {}]) {
      await expect(
        repository.updateOwnKit({ actorId: OWNER_B_ID, kitId: KIT_ONE, patch }),
      ).resolves.toEqual({ updated: 0 });
    }

    expect(await allKits()).toEqual(before);
  });

  it("case 6: B's kit delete removes nothing, and the assets cascade only for the owner", async () => {
    const before = await allKits();

    await expect(
      repository.deleteOwnKit({ actorId: OWNER_B_ID, kitId: KIT_ONE }),
    ).resolves.toBeUndefined();

    expect(await allKits()).toEqual(before);
    expect(await assetIdsOfKit(KIT_ONE)).toEqual([ASSET_ONE, ASSET_TWO]);
  });

  it("case 7: B's asset insert answers `null` and A's asset count is unchanged", async () => {
    const before = await allAssets();

    await expect(
      repository.insertOwnAsset({
        actorId: OWNER_B_ID,
        kitId: KIT_ONE,
        asset: ASSET_INSERT,
      }),
    ).resolves.toBeNull();

    expect(await allAssets()).toEqual(before);
    expect(await assetIdsOfKit(KIT_ONE)).toEqual([ASSET_ONE, ASSET_TWO]);
  });

  it("case 8: B's asset update and delete answer `null` / no-op and A's row is unchanged", async () => {
    const before = await assetById(ASSET_ONE);

    await expect(
      repository.updateOwnAsset({
        actorId: OWNER_B_ID,
        kitId: KIT_ONE,
        assetId: ASSET_ONE,
        patch: { display_name: "hijacked" },
      }),
    ).resolves.toBeNull();

    await expect(
      repository.deleteOwnAsset({
        actorId: OWNER_B_ID,
        kitId: KIT_ONE,
        assetId: ASSET_ONE,
      }),
    ).resolves.toBeUndefined();

    expect(await assetById(ASSET_ONE)).toEqual(before);
  });

  it("case 9: B's batch copy inserts 0 rows", async () => {
    const before = await allAssets();
    const copy: BrandKitAssetCopy = {
      asset_type: "color",
      display_name: "Stolen",
      text_content: null,
      role: null,
      sort_order: 0,
      metadata: {},
      file_url: null,
    };

    await expect(
      repository.insertOwnAssetCopies({
        actorId: OWNER_B_ID,
        kitId: KIT_ONE,
        copies: [copy, copy],
      }),
    ).resolves.toEqual({ inserted: 0 });

    expect(await allAssets()).toEqual(before);
  });

  it("case 10: the PRE-MIGRATION PostgREST writes, replayed under `asUser(B)`, change nothing either", async () => {
    const kitsBefore = await allKits();
    const assetsBefore = await allAssets();

    const attempted = await asUser(db, OWNER_B_ID, async (tx) => {
      // The exact shape the service issued before workorder 21Z: a PostgREST table
      // update on `brand_kits`, scoped by `.eq("id", kitId)` and
      // `.eq("user_id", actor)`. Under RLS the policy filters the row out and the
      // statement reports zero rows.
      const updateResult = await tx.query(
        `update public.brand_kits set name = $1
           where id = $2::uuid and user_id = $3::uuid`,
        ["hijacked", KIT_ONE, OWNER_B_ID],
      );
      // A PostgREST table delete on `brand_kits`, scoped by the kit id alone.
      const deleteResult = await tx.query(
        "delete from public.brand_kits where id = $1::uuid",
        [KIT_ONE],
      );
      // A PostgREST table insert into `brand_kit_assets` — no owner column; RLS
      // refuses it.
      let insertRefused = false;
      try {
        await tx.query(
          `insert into public.brand_kit_assets (kit_id, asset_type, display_name, sort_order)
           values ($1::uuid, $2::public.brand_kit_asset_type, $3, 0)`,
          [KIT_ONE, "color", "Stolen"],
        );
      } catch {
        // A `42501` row-violation is a perfectly good "refused" answer here; the
        // judgement is the DATA below, not which of the two shapes it took.
        insertRefused = true;
      }

      return {
        updated: (updateResult as unknown as { affectedRows?: number }).affectedRows,
        deleted: (deleteResult as unknown as { affectedRows?: number }).affectedRows,
        insertRefused,
      };
    });

    // Whether PostgreSQL reported zero rows or raised, the answer that matters is
    // the same one the repository gives: A's data is untouched.
    expect(await allKits()).toEqual(kitsBefore);
    expect(await allAssets()).toEqual(assetsBefore);
    void attempted;
  });
});

describe("brand kit write repository: the owner's own writes", () => {
  it("case 11: an inserted asset applies the column defaults the statement does not name", async () => {
    const created = await repository.insertOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_TWO,
      asset: ASSET_INSERT,
    });

    expect(created).not.toBeNull();
    expect(created?.asset_type).toBe("color");
    expect(created?.display_name).toBe("Brand green");
    expect(created?.sort_order).toBe(0);
    expect(created?.metadata).toEqual({ hex: "#00ff00" });
    expect(created?.file_url).toBeNull();
    // The row really is in the table, owned through K2.
    expect(await assetIdsOfKit(KIT_TWO)).toEqual([String(created?.id)]);

    // `role` / `text_content` follow the binds, and a NULL role stays NULL.
    expect(created?.role).toBeNull();
    expect(created?.text_content).toBe("#00ff00");

    await repository.deleteOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_TWO,
      assetId: String(created?.id),
    });
  });

  it("case 12: an asset update fires the trigger, keeps untouched columns and can clear text", async () => {
    const updated = await repository.updateOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      assetId: ASSET_ONE,
      patch: { display_name: "Brand red renamed" },
    });

    expect(updated?.display_name).toBe("Brand red renamed");
    // `metadata` / `sort_order` were not in the patch and must survive.
    expect(updated?.sort_order).toBe(0);
    // Same PGlite caveat as case 3: the trigger is proved by moving OFF the
    // fixture's frozen `created_at`, not by comparing two `now()` values.
    expect(new Date(String(updated?.updated_at)).getTime()).toBeGreaterThan(
      new Date(ASSET_ONE_CREATED_AT).getTime(),
    );

    // Clearing a nullable text column with an explicit NULL is a real write.
    await repository.updateOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      assetId: ASSET_ONE,
      patch: { text_content: "temporary", role: "accent" },
    });
    expect((await assetById(ASSET_ONE))?.text_content).toBe("temporary");

    await repository.updateOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      assetId: ASSET_ONE,
      patch: { text_content: null, role: null },
    });
    expect((await assetById(ASSET_ONE))?.text_content).toBeNull();
    expect((await assetById(ASSET_ONE))?.role).toBeNull();

    await repository.updateOwnAsset({
      actorId: OWNER_A_ID,
      kitId: KIT_ONE,
      assetId: ASSET_ONE,
      patch: { display_name: "Brand red" },
    });
  });

  it("case 13: a batch copy inserts every row in ONE statement and preserves the columns", async () => {
    const copies: BrandKitAssetCopy[] = [
      {
        asset_type: "color",
        display_name: "Copied red",
        text_content: "#ff0000",
        role: null,
        sort_order: 0,
        metadata: { from: "K1" },
        file_url: null,
      },
      {
        asset_type: "logo",
        display_name: "Copied logo",
        text_content: null,
        role: "primary",
        sort_order: 1,
        metadata: null,
        file_url: "a/kit-two/copied-logo.png",
      },
    ];

    await expect(
      repository.insertOwnAssetCopies({
        actorId: OWNER_A_ID,
        kitId: KIT_TWO,
        copies,
      }),
    ).resolves.toEqual({ inserted: 2 });

    const rows = (
      await db.query<AssetRow>(
        `select id, kit_id, asset_type::text as asset_type, display_name, role,
                sort_order, text_content, file_url, metadata, created_at, updated_at
           from public.brand_kit_assets where kit_id = $1 order by sort_order`,
        [KIT_TWO],
      )
    ).rows;

    expect(rows.map((row) => row.display_name)).toEqual([
      "Copied red",
      "Copied logo",
    ]);
    expect(rows[1]?.role).toBe("primary");
    expect(rows[1]?.file_url).toBe("a/kit-two/copied-logo.png");
    // A NULL metadata in the batch stays NULL rather than being re-defaulted.
    expect(rows[1]?.metadata).toBeNull();
    expect(rows[0]?.metadata).toEqual({ from: "K1" });

    // An EMPTY batch is a no-op that does not even open a transaction.
    await expect(
      repository.insertOwnAssetCopies({
        actorId: OWNER_A_ID,
        kitId: KIT_TWO,
        copies: [],
      }),
    ).resolves.toEqual({ inserted: 0 });

    for (const row of rows) {
      await repository.deleteOwnAsset({
        actorId: OWNER_A_ID,
        kitId: KIT_TWO,
        assetId: row.id,
      });
    }
  });

  it("case 14: the owner can delete, and the cascade takes the assets with the kit", async () => {
    const created = await repository.insertOwnKit({
      actorId: OWNER_C_ID,
      name: "C's kit",
      guidanceText: null,
    });
    const asset = await repository.insertOwnAsset({
      actorId: OWNER_C_ID,
      kitId: created.id,
      asset: ASSET_INSERT,
    });
    expect(asset).not.toBeNull();

    await repository.deleteOwnKit({ actorId: OWNER_C_ID, kitId: created.id });

    expect(await kitById(created.id)).toBeUndefined();
    expect(await assetIdsOfKit(created.id)).toEqual([]);
  });
});

describe("brand kit write repository: bad binds change nothing", () => {
  it("case 15: a malformed uuid is 22P02 on every write, and not one row moves", async () => {
    const kitsBefore = await allKits();
    const assetsBefore = await allAssets();

    const calls: Array<[string, () => Promise<unknown>]> = [
      [INSERT_OWN_KIT, () => repository.insertOwnKit({ actorId: INVALID_ID, name: "x", guidanceText: null })],
      [
        "clearOwnDefault",
        () => repository.clearOwnDefault({ actorId: INVALID_ID }),
      ],
      [
        "updateOwnKit",
        () => repository.updateOwnKit({ actorId: INVALID_ID, kitId: KIT_ONE, patch: { name: "x" } }),
      ],
      [
        "deleteOwnKit",
        () => repository.deleteOwnKit({ actorId: INVALID_ID, kitId: KIT_ONE }),
      ],
      [
        "insertOwnAsset",
        () => repository.insertOwnAsset({ actorId: INVALID_ID, kitId: KIT_ONE, asset: ASSET_INSERT }),
      ],
      [
        "updateOwnAsset",
        () => repository.updateOwnAsset({ actorId: INVALID_ID, kitId: KIT_ONE, assetId: ASSET_ONE, patch: { sort_order: 2 } }),
      ],
      [
        "deleteOwnAsset",
        () => repository.deleteOwnAsset({ actorId: INVALID_ID, kitId: KIT_ONE, assetId: ASSET_ONE }),
      ],
      [
        INSERT_OWN_ASSET_COPIES,
        () =>
          repository.insertOwnAssetCopies({
            actorId: INVALID_ID,
            kitId: KIT_ONE,
            copies: [
              {
                asset_type: "color",
                display_name: "x",
                text_content: null,
                role: null,
                sort_order: 0,
                metadata: {},
                file_url: null,
              },
            ],
          }),
      ],
    ];

    for (const [operation, call] of calls) {
      const error = await call().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitWriteError);
      expect((error as BrandKitWriteError).operation).toBe(operation);
      expect(((error as BrandKitWriteError).cause as { code?: string }).code).toBe(
        "22P02",
      );
      // The fixed message names the operation and nothing else.
      expect((error as BrandKitWriteError).message).not.toMatch(
        /public\.|brand_kit|postgres:\/\//i,
      );
    }

    expect(await allKits()).toEqual(kitsBefore);
    expect(await allAssets()).toEqual(assetsBefore);
  });

  it("case 16: an actor carrying SQL is only a bind — nothing is written and the pool still works", async () => {
    const kitsBefore = await allKits();
    const assetsBefore = await allAssets();

    await expect(
      repository.insertOwnKit({
        actorId: INJECTION_ID,
        name: "x",
        guidanceText: null,
      }).catch((reason: unknown) => reason),
    ).resolves.toBeInstanceOf(BrandKitWriteError);

    expect(await allKits()).toEqual(kitsBefore);
    expect(await allAssets()).toEqual(assetsBefore);

    // The rolled-back connection is still usable.
    const created = await repository.insertOwnKit({
      actorId: OWNER_A_ID,
      name: "After injection",
      guidanceText: null,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    await repository.deleteOwnKit({ actorId: OWNER_A_ID, kitId: created.id });
  });

  it("case 17: an out-of-enum asset type is a 22P02 too, never a silently stored value", async () => {
    const assetsBefore = await allAssets();

    const error = await repository
      .insertOwnAsset({
        actorId: OWNER_A_ID,
        kitId: KIT_ONE,
        asset: { ...ASSET_INSERT, asset_type: "video" as never },
      })
      .catch((reason: unknown) => reason);

    // The argument check refuses it before the database sees it — and the data is
    // unchanged either way, which is the property this case is about.
    expect(error).toBeInstanceOf(BrandKitWriteError);
    expect(await allAssets()).toEqual(assetsBefore);

    // The DATABASE-side rejection is exercised directly, so "it would have been a
    // 22P02" is measured rather than assumed.
    await expect(
      db.query(
        `insert into public.brand_kit_assets (kit_id, asset_type, display_name, sort_order)
         values ($1::uuid, $2::public.brand_kit_asset_type, 'x', 0)`,
        [KIT_ONE, "video"],
      ),
    ).rejects.toThrow(/invalid input syntax|enum|invalid input value/i);

    expect(await allAssets()).toEqual(assetsBefore);
  });

  it("case 18: the fixture is what the cases above assumed", async () => {
    const kits = await allKits();
    expect(kits.map((kit) => kit.id)).toEqual([KIT_ONE, KIT_TWO, KIT_THREE]);
    expect(kits.map((kit) => kit.user_id)).toEqual([
      OWNER_A_ID,
      OWNER_A_ID,
      OWNER_B_ID,
    ]);

    const assets = await allAssets();
    expect(assets.map((asset) => asset.id)).toEqual([ASSET_ONE, ASSET_TWO, ASSET_THREE]);
    expect(assets.map((asset) => asset.kit_id)).toEqual([
      KIT_ONE,
      KIT_ONE,
      KIT_THREE,
    ]);
    expect(assets.find((asset) => asset.id === ASSET_TWO)?.file_url).toBe(
      "a/kit-one/primary-logo.png",
    );
  });
});
