import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrandKitReadError,
  LIST_OWN_KITS,
  createBrandKitReadRepository,
  type BrandKitReadRepository,
} from "../../db/brand-kit-read-repository.js";
import type { TransactionPool } from "../../db/transaction.js";
import {
  asUser,
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL identity matrix for the brand kit READ repository (workorder 21Y),
 * measured against the two policies it replaces.
 *
 * Every case below reads the same question THREE times for the same identity:
 *
 *   (1) through the repository, which is privileged — the database owner
 *       bypasses RLS, so the ONLY gate is each statement's own predicate, i.e.
 *       `brand_kits_user_policy` and `brand_kit_assets_policy` translated into
 *       SQL;
 *   (2) through `asUser()`, i.e. `set local role authenticated` plus a
 *       transaction-local `request.jwt.claim.sub` (the claim the PGlite stub's
 *       `auth.uid()` reads), running the EXACT two SELECTs the removed PostgREST
 *       reads performed — caller filter and all — so the policies decide;
 *   (3) through `asUser()` again, running the same two tables with NO caller
 *       filter at all. Only the policies may narrow those, so this is the
 *       strongest of the three: it fails if the repository's predicate is
 *       narrower OR wider than the policy, including the case where a caller
 *       filter in (2) would have hidden a policy that is too generous.
 *
 * All three answers must be EQUAL for every identity, and equal to the frozen
 * expectation built from the fixture. That equality is the whole point of this
 * file: a repository that "looks right" but disagrees with a policy for one
 * identity would silently change whose brand kits `GET /api/brand-kits` shows.
 *
 * A brand kit is a PRIVATE, OWNER-ONLY resource: no workspace membership, no
 * project ACL and no administrator rule grants anything here, and none may be
 * derived and added. The fixture has three unrelated owners precisely so a leak
 * in either direction is visible.
 *
 * PGlite runs in-process, in-repo: no server, no socket, no `DATABASE_URL`, no
 * connection to any host. One instance is migrated in `beforeAll`, the identities
 * are created through the real signup trigger, and `afterAll` closes it. PGlite
 * holds a single session, so nothing here runs concurrently and no case may leave
 * a transaction open for the next one.
 */

const OWNER_A_ID = "00000000-0000-0000-0000-000000000e01";
const OWNER_B_ID = "00000000-0000-0000-0000-000000000e02";
const OWNER_C_ID = "00000000-0000-0000-0000-000000000e03";

const KIT_ONE = "00000000-0000-0000-0000-000000000f01";
const KIT_TWO = "00000000-0000-0000-0000-000000000f02";
const KIT_THREE = "00000000-0000-0000-0000-000000000f03";

/**
 * Explicit, DIFFERENT values: `created_at asc` is the published order, so a
 * fixture that leaned on `now()` would make the order of A's two kits depend on
 * how fast two inserts ran.
 */
const KIT_ONE_CREATED_AT = "2026-01-10T08:00:00.000Z";
const KIT_ONE_UPDATED_AT = "2026-01-11T08:00:00.000Z";
const KIT_TWO_CREATED_AT = "2026-02-10T08:00:00.000Z";
const KIT_TWO_UPDATED_AT = "2026-02-11T08:00:00.000Z";
const KIT_THREE_CREATED_AT = "2026-03-10T08:00:00.000Z";
const KIT_THREE_UPDATED_AT = "2026-03-11T08:00:00.000Z";

const KIT_ONE_NAME = "Kit One";
const KIT_TWO_NAME = "Kit Two";
const KIT_THREE_NAME = "Kit Three";
const KIT_ONE_COVER = "https://example.test/kit-one.png";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * the whole read and return every owner's kits. These cases exist to prove it is
 * not.
 */
const INJECTION_ID = "' or '1'='1";

/**
 * The removed PostgREST kit read, verbatim as SQL: the six columns, the caller's
 * own `user_id`, `created_at asc`. Under `asUser()` the policy filters it
 * exactly as PostgREST's own client did.
 */
const SELECT_OWN_KITS = `select id, name, is_default, cover_url, created_at, updated_at
  from public.brand_kits
 where user_id = $1::uuid
 order by created_at asc`;

/**
 * The removed PostgREST asset read, verbatim as SQL: two columns, the kit ids of
 * the kits the first read returned, and NO owner predicate — `maybeSingle` aside,
 * the policy was the only thing tying those assets to the caller.
 */
const SELECT_KIT_ASSETS = `select kit_id, asset_type::text as asset_type
  from public.brand_kit_assets
 where kit_id = any($1::uuid[])`;

/** The same two tables with the caller filter REMOVED: only RLS may narrow them. */
const SELECT_ALL_KITS = `select id, name, is_default, cover_url, created_at, updated_at
  from public.brand_kits order by created_at asc`;

const SELECT_ALL_ASSETS = `select kit_id, asset_type::text as asset_type
  from public.brand_kit_assets`;

const READ_CONTEXT_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const CONTEXT_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type BrandKitAssetType = "color" | "font" | "logo" | "image";

/** `pg` and PGlite hand `timestamptz` back as a `Date`; a text cast gives a string. */
type RawKitRow = {
  id: string;
  name: string;
  is_default: boolean;
  cover_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type KitRow = {
  id: string;
  name: string;
  is_default: boolean;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
};

type AssetRow = { kit_id: string; asset_type: BrandKitAssetType };

type ReadResult = { kits: KitRow[]; assets: AssetRow[] };

type ContextGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

let db: PGlite;
let pool: TransactionPool;
let repository: BrandKitReadRepository;

/**
 * The frozen expectation for A: two kits in `created_at asc` order, and the three
 * asset rows of the FIRST kit only — K2 has none and K3 belongs to B.
 */
const EXPECTED_FOR_A: ReadResult = {
  kits: [
    {
      id: KIT_ONE,
      name: KIT_ONE_NAME,
      is_default: true,
      cover_url: KIT_ONE_COVER,
      created_at: KIT_ONE_CREATED_AT,
      updated_at: KIT_ONE_UPDATED_AT,
    },
    {
      id: KIT_TWO,
      name: KIT_TWO_NAME,
      is_default: false,
      cover_url: null,
      created_at: KIT_TWO_CREATED_AT,
      updated_at: KIT_TWO_UPDATED_AT,
    },
  ],
  assets: [
    { kit_id: KIT_ONE, asset_type: "color" },
    { kit_id: KIT_ONE, asset_type: "color" },
    { kit_id: KIT_ONE, asset_type: "logo" },
  ],
};

const EXPECTED_FOR_B: ReadResult = {
  kits: [
    {
      id: KIT_THREE,
      name: KIT_THREE_NAME,
      is_default: true,
      cover_url: null,
      created_at: KIT_THREE_CREATED_AT,
      updated_at: KIT_THREE_UPDATED_AT,
    },
  ],
  assets: [{ kit_id: KIT_THREE, asset_type: "font" }],
};

const EXPECTED_FOR_C: ReadResult = { kits: [], assets: [] };

/** The `asset_counts` the service derives from a result — the published shape. */
function countAssets(
  assets: readonly AssetRow[],
): Record<BrandKitAssetType, number> {
  const counts: Record<BrandKitAssetType, number> = {
    color: 0,
    font: 0,
    logo: 0,
    image: 0,
  };

  for (const asset of assets) {
    counts[asset.asset_type] += 1;
  }

  return counts;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

/**
 * Statement 2 has no ORDER BY (the PostgREST read it replaces had none either),
 * so the comparison canonicalises the asset list instead of inventing an order
 * the statement does not promise. The KIT list is left in the order the reads
 * return it: `created_at asc` IS part of the published behaviour.
 */
function canonicalAssets(assets: readonly AssetRow[]): AssetRow[] {
  return [...assets].sort((left, right) =>
    left.kit_id === right.kit_id
      ? left.asset_type.localeCompare(right.asset_type)
      : left.kit_id.localeCompare(right.kit_id),
  );
}

function canonical(
  kits: readonly RawKitRow[],
  assets: readonly AssetRow[],
): ReadResult {
  return {
    kits: kits.map((row) => ({
      id: row.id,
      name: row.name,
      is_default: row.is_default,
      cover_url: row.cover_url,
      created_at: isoOf(row.created_at),
      updated_at: isoOf(row.updated_at),
    })),
    assets: canonicalAssets(assets),
  };
}

/** (1) The repository read: privileged, with both ACLs written into the statements. */
async function viaRepository(actorId: string): Promise<ReadResult> {
  const result = await repository.listOwnKits({ actorId });
  return canonical(result.kits, result.assets);
}

/**
 * (2) The two reads the removed PostgREST client performed: the caller's own
 * identity AND the caller's own filters, so `brand_kits_user_policy` and
 * `brand_kit_assets_policy` decide what exists.
 */
async function viaPolicy(actorId: string): Promise<ReadResult> {
  const read = await asUser(db, actorId, async (tx) => {
    const kitRows = await tx.query<RawKitRow>(SELECT_OWN_KITS, [actorId]);
    const kitIds = kitRows.rows.map((row) => row.id);

    if (kitIds.length === 0) {
      return { kits: kitRows.rows, assets: [] as AssetRow[] };
    }

    const assetRows = await tx.query<AssetRow>(SELECT_KIT_ASSETS, [[...kitIds]]);
    return { kits: kitRows.rows, assets: assetRows.rows };
  });

  return canonical(read.kits, read.assets);
}

/**
 * (3) The same tables with NO caller filter: the policy alone decides, so a
 * predicate that is wider than the policy shows up here even though (2) would
 * have agreed.
 */
async function viaRlsOnly(actorId: string): Promise<ReadResult> {
  const read = await asUser(db, actorId, async (tx) => {
    const kitRows = await tx.query<RawKitRow>(SELECT_ALL_KITS);
    const assetRows = await tx.query<AssetRow>(SELECT_ALL_ASSETS);
    return { kits: kitRows.rows, assets: assetRows.rows };
  });

  return canonical(read.kits, read.assets);
}

/**
 * The comparison this file exists for. All three reads are performed for ONE
 * identity and each is asserted against the frozen expectation AND against the
 * others, so a disagreement is reported as a disagreement rather than as three
 * independent mismatches.
 */
async function expectAllThreeReads(
  actorId: string,
  expected: ReadResult,
): Promise<void> {
  const byRepository = await viaRepository(actorId);
  const byPolicy = await viaPolicy(actorId);
  const byRlsOnly = await viaRlsOnly(actorId);

  expect(byPolicy).toEqual(expected);
  expect(byRlsOnly).toEqual(expected);
  expect(byRepository).toEqual(expected);
  expect(byRepository).toEqual(byPolicy);
  expect(byRepository).toEqual(byRlsOnly);
}

/** Total row counts, as the database owner: they never depend on an identity. */
async function kitCountsByOwner(): Promise<Array<{ user_id: string; n: number }>> {
  return (
    await db.query<{ user_id: string; n: number }>(
      `select user_id, count(*)::int as n
         from public.brand_kits group by user_id order by user_id`,
    )
  ).rows;
}

async function assetCountsByKit(): Promise<Array<{ kit_id: string; n: number }>> {
  return (
    await db.query<{ kit_id: string; n: number }>(
      `select kit_id, count(*)::int as n
         from public.brand_kit_assets group by kit_id order by kit_id`,
    )
  ).rows;
}

/** Every kit row as stored, ordered by id: an untouched-fixture fingerprint. */
async function allKits(): Promise<RawKitRow[]> {
  return (
    await db.query<RawKitRow>(
      `select id, name, is_default, cover_url, created_at, updated_at
         from public.brand_kits order by id`,
    )
  ).rows;
}

async function allAssets(): Promise<AssetRow[]> {
  return (
    await db.query<AssetRow>(
      `select kit_id, asset_type::text as asset_type
         from public.brand_kit_assets order by kit_id, asset_type`,
    )
  ).rows;
}

async function insertKit(options: {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  await db.query(
    `insert into public.brand_kits
       (id, user_id, name, is_default, cover_url, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      options.id,
      options.userId,
      options.name,
      options.isDefault,
      options.coverUrl,
      options.createdAt,
      options.updatedAt,
    ],
  );
}

async function insertAsset(
  kitId: string,
  assetType: BrandKitAssetType,
  displayName: string,
): Promise<void> {
  await db.query(
    `insert into public.brand_kit_assets (kit_id, asset_type, display_name, sort_order)
     values ($1, $2::public.brand_kit_asset_type, $3, 0)`,
    [kitId, assetType, displayName],
  );
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createBrandKitReadRepository({
    getTransactionPool: () => pool,
  });

  // Real signup path: the trigger builds profile, personal workspace and owner
  // membership for each identity. Brand kits are then seeded as the database
  // owner, so the fixture itself is never gated by a policy.
  await createUser(db, OWNER_A_ID, "brand-kit-read-a@hahart.test");
  await createUser(db, OWNER_B_ID, "brand-kit-read-b@hahart.test");
  await createUser(db, OWNER_C_ID, "brand-kit-read-c@hahart.test");

  await insertKit({
    id: KIT_ONE,
    userId: OWNER_A_ID,
    name: KIT_ONE_NAME,
    isDefault: true,
    coverUrl: KIT_ONE_COVER,
    createdAt: KIT_ONE_CREATED_AT,
    updatedAt: KIT_ONE_UPDATED_AT,
  });
  await insertKit({
    id: KIT_TWO,
    userId: OWNER_A_ID,
    name: KIT_TWO_NAME,
    isDefault: false,
    coverUrl: null,
    createdAt: KIT_TWO_CREATED_AT,
    updatedAt: KIT_TWO_UPDATED_AT,
  });
  await insertKit({
    id: KIT_THREE,
    userId: OWNER_B_ID,
    name: KIT_THREE_NAME,
    isDefault: true,
    coverUrl: null,
    createdAt: KIT_THREE_CREATED_AT,
    updatedAt: KIT_THREE_UPDATED_AT,
  });

  await insertAsset(KIT_ONE, "color", "Brand red");
  await insertAsset(KIT_ONE, "color", "Brand blue");
  await insertAsset(KIT_ONE, "logo", "Primary logo");
  await insertAsset(KIT_THREE, "font", "Heading font");
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("brand kit read repository: the fixture the matrix runs against", () => {
  it("case 1: the three identities, the two kits of A and the assets of K1/K3 are what the cases assume", async () => {
    // A has two kits, B has one, C has none — and the tables are NOT empty, so a
    // later "empty answer" means "not yours" rather than "nothing stored".
    expect(await kitCountsByOwner()).toEqual([
      { user_id: OWNER_A_ID, n: 2 },
      { user_id: OWNER_B_ID, n: 1 },
    ]);

    expect(await assetCountsByKit()).toEqual([
      { kit_id: KIT_ONE, n: 3 },
      { kit_id: KIT_THREE, n: 1 },
    ]);

    const kits = await allKits();
    expect(kits.map((kit) => kit.id)).toEqual([KIT_ONE, KIT_TWO, KIT_THREE]);
    expect(kits.map((kit) => isoOf(kit.created_at))).toEqual([
      KIT_ONE_CREATED_AT,
      KIT_TWO_CREATED_AT,
      KIT_THREE_CREATED_AT,
    ]);

    // K1 is earlier than K2 by construction, so the expected order is a fact of
    // the fixture and not of how fast two inserts ran.
    expect(
      new Date(KIT_ONE_CREATED_AT).getTime() <
        new Date(KIT_TWO_CREATED_AT).getTime(),
    ).toBe(true);

    // K2 carries no asset at all, which is what makes A's `logo`/`font`/`image`
    // zeros meaningful rather than absent.
    expect(
      (await assetCountsByKit()).some((row) => row.kit_id === KIT_TWO),
    ).toBe(false);
  });
});

describe("brand kit read repository: each owner, identity by identity", () => {
  it("case 2: A reads exactly their own two kits in `created_at asc`, and only K1's three assets", async () => {
    await expectAllThreeReads(OWNER_A_ID, EXPECTED_FOR_A);

    // The published order is K1 then K2, not merely "some order".
    expect((await viaRepository(OWNER_A_ID)).kits.map((kit) => kit.id)).toEqual([
      KIT_ONE,
      KIT_TWO,
    ]);

    // The statistics the service derives from this result.
    expect(countAssets((await viaRepository(OWNER_A_ID)).assets)).toEqual({
      color: 2,
      font: 0,
      logo: 1,
      image: 0,
    });

    // K3 belongs to another owner: not one row of it may appear, in either list.
    const result = await viaRepository(OWNER_A_ID);
    expect(result.assets.some((asset) => asset.kit_id === KIT_THREE)).toBe(false);
    expect(result.kits.some((kit) => kit.id === KIT_THREE)).toBe(false);
  });

  it("case 3: B reads only K3 — none of A's kits and none of A's assets", async () => {
    await expectAllThreeReads(OWNER_B_ID, EXPECTED_FOR_B);

    expect(countAssets((await viaRepository(OWNER_B_ID)).assets)).toEqual({
      color: 0,
      font: 1,
      logo: 0,
      image: 0,
    });

    const result = await viaRepository(OWNER_B_ID);
    for (const kitId of [KIT_ONE, KIT_TWO]) {
      expect(result.kits.some((kit) => kit.id === kitId)).toBe(false);
      expect(result.assets.some((asset) => asset.kit_id === kitId)).toBe(false);
    }
  });

  it("case 4: C owns nothing and reads nothing, while the tables stay populated", async () => {
    await expectAllThreeReads(OWNER_C_ID, EXPECTED_FOR_C);

    // "Empty" here means "not yours": the same query answers rows for A and B.
    expect(await kitCountsByOwner()).toEqual([
      { user_id: OWNER_A_ID, n: 2 },
      { user_id: OWNER_B_ID, n: 1 },
    ]);
    await expectAllThreeReads(OWNER_A_ID, EXPECTED_FOR_A);
    await expectAllThreeReads(OWNER_B_ID, EXPECTED_FOR_B);
  });

  it("case 5: no identity ever answers another owner's row — the matrix, in both directions", async () => {
    const matrix: Array<{ actorId: string; expected: ReadResult; foreign: string[] }> =
      [
        { actorId: OWNER_A_ID, expected: EXPECTED_FOR_A, foreign: [KIT_THREE] },
        { actorId: OWNER_B_ID, expected: EXPECTED_FOR_B, foreign: [KIT_ONE, KIT_TWO] },
        { actorId: OWNER_C_ID, expected: EXPECTED_FOR_C, foreign: [KIT_ONE, KIT_TWO, KIT_THREE] },
      ];

    for (const entry of matrix) {
      const result = await viaRepository(entry.actorId);
      expect(result).toEqual(entry.expected);

      // The ids the read was never allowed to reach are absent from BOTH lists —
      // an owner-only ACL leaks through the kit list or through the asset list,
      // and this checks both.
      const reached = [
        ...result.kits.map((kit) => kit.id),
        ...result.assets.map((asset) => asset.kit_id),
      ];
      for (const foreignId of entry.foreign) {
        expect(reached).not.toContain(foreignId);
      }
    }
  });
});

describe("brand kit read repository: bad binds and read-only behaviour", () => {
  it("case 6: a malformed uuid is a real SQL error (22P02), wrapped, and the same pool reads again afterwards", async () => {
    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.brand_kits where user_id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await repository
      .listOwnKits({ actorId: INVALID_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).operation).toBe(LIST_OWN_KITS);
    // The fixed message carries no SQL, no host and no existence answer.
    expect((error as BrandKitReadError).message).toBe(
      `brand kit read failed (${LIST_OWN_KITS})`,
    );
    expect((error as BrandKitReadError).message).not.toMatch(
      /public\.|brand_kits|brand_kit_assets|invalid input|postgres:\/\//i,
    );
    // The cause is the PostgreSQL parse failure, not an empty answer.
    expect(((error as BrandKitReadError).cause as { code?: string }).code).toBe(
      "22P02",
    );

    // ROLLBACK plus release left the connection usable for the next read.
    await expect(viaRepository(OWNER_A_ID)).resolves.toEqual(EXPECTED_FOR_A);
  });

  it("case 7: an actor carrying SQL is only a bind — the same refusal, and every row untouched", async () => {
    const kitsBefore = await allKits();
    const assetsBefore = await allAssets();

    const error = await repository
      .listOwnKits({ actorId: INJECTION_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect(((error as BrandKitReadError).cause as { code?: string }).code).toBe(
      "22P02",
    );

    // A concatenated actor would have rewritten the predicate and answered every
    // owner's rows; the tables are byte-identical instead, and the repository
    // still answers only the caller's own kits.
    expect(await allKits()).toEqual(kitsBefore);
    expect(await allAssets()).toEqual(assetsBefore);
    await expectAllThreeReads(OWNER_A_ID, EXPECTED_FOR_A);
  });

  it("case 8: the read runs privileged with the actor as context, and the context does not survive it", async () => {
    // A pool that wraps the real one and reads the four settings through the SAME
    // connection, right after the repository's own statements: whatever it sees is
    // the state of the transaction the read ran in, not a reconstruction.
    const observed: Array<Record<string, unknown>> = [];
    const observingPool: TransactionPool = {
      async connect() {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.brand_kits")) {
              observed.push(
                (await inner.query(READ_CONTEXT_SQL)).rows[0] as Record<
                  string,
                  unknown
                >,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createBrandKitReadRepository({
      getTransactionPool: () => observingPool,
    });

    await expect(
      observing.listOwnKits({ actorId: OWNER_A_ID }),
    ).resolves.toEqual({
      kits: EXPECTED_FOR_A.kits,
      assets: EXPECTED_FOR_A.assets,
    });

    // Both domain statements name `public.brand_kits` (statement 2 names it in
    // its `exists` clause), and each ran with the actor set and the mode labelled
    // privileged. The context grants nothing: the predicates are the ACL.
    expect(observed).toHaveLength(2);
    for (const context of observed) {
      expect(context).toEqual({
        user_id: OWNER_A_ID,
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone again, so the
    // actor of this read cannot become the actor of the next one.
    const gone = (await db.query<ContextGoneRow>(CONTEXT_GONE_SQL)).rows[0];
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });

    // The next read is still the caller's own.
    await expect(viaRepository(OWNER_C_ID)).resolves.toEqual(EXPECTED_FOR_C);
  });

  it("case 9: the read modifies nothing — same rows, same names, same timestamps", async () => {
    const kitsBefore = await allKits();
    const assetsBefore = await allAssets();

    await viaRepository(OWNER_A_ID);
    await viaRepository(OWNER_B_ID);
    await viaRepository(OWNER_C_ID);
    await viaPolicy(OWNER_A_ID);
    await viaRlsOnly(OWNER_A_ID);

    // `created_at`/`updated_at` are driven by the table defaults and a BEFORE
    // UPDATE trigger, so an identical set is proof no write ran behind the read.
    expect(await allKits()).toEqual(kitsBefore);
    expect(await allAssets()).toEqual(assetsBefore);
  });
});
