// 工单21AC: `get_brand_kit` reads through `BrandKitReadRepository` now.
//
// The tool used to read `brand_kits` and `brand_kit_assets` on the caller's own
// PostgREST client, where RLS decided what existed. It reads them through the
// owner-keyed repository instead, so this file pins the three things that must
// survive the move:
//
//   * the published JSON is BYTE-IDENTICAL in shape to what the tool produced
//     before (kit_name / design_guidance / colors / fonts / logos / images);
//   * the owner predicate is load-bearing (T-55) — an administrator can read every
//     project of their workspace, so a `brand_kit_id` belonging to somebody else
//     is reachable input, and it must answer "not found";
//   * no table read is issued at all: a table read through the caller's client
//     THROWS, and the counter stays at zero;
//   * 45AH: Storage is observed on the fake store the injected `createObjectStore`
//     factory answers — and that factory is handed the CALLER's client, not a
//     shared/admin one.
import { describe, expect, it } from "vitest";

import type {
  BrandKitAssetRow,
  BrandKitReadRepository,
  KitDetailRow,
} from "../../db/brand-kit-read-repository.js";
import type { ObjectStore } from "../../features/storage/object-store.js";
import { createBrandKitTool } from "./brand-kit.js";

const KIT_ID = "00000000-0000-0000-0000-0000000000b1";
const ACTOR = "00000000-0000-0000-0000-0000000000a1";

/** A structurally valid JWT whose `sub` is the acting user; only the payload is read. */
function tokenFor(subject: string | null): string {
  const payload = subject === null ? { email: "a@t" } : { sub: subject, email: "a@t" };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const TOKEN = tokenFor(ACTOR);

const KIT: KitDetailRow = {
  id: KIT_ID,
  name: "Acme Brand",
  is_default: true,
  guidance_text: "Warm, confident, never cute.",
  cover_url: "https://example.test/cover.png",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

function assetRow(overrides: Partial<BrandKitAssetRow>): BrandKitAssetRow {
  return {
    id: "asset-0",
    asset_type: "color",
    display_name: "Unnamed",
    role: null,
    sort_order: 0,
    text_content: null,
    file_url: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const ASSETS: BrandKitAssetRow[] = [
  assetRow({
    id: "asset-color",
    asset_type: "color",
    display_name: "Brand red",
    role: "primary",
    text_content: "#D4A574",
  }),
  assetRow({
    id: "asset-font",
    asset_type: "font",
    display_name: "Heading",
    role: "display",
    text_content: "Inter",
    metadata: { weight: "700" },
  }),
  assetRow({
    id: "asset-logo",
    asset_type: "logo",
    display_name: "Primary logo",
    role: "primary",
    file_url: "a/kit/logo.png",
  }),
  assetRow({
    id: "asset-image",
    asset_type: "image",
    display_name: "Hero",
    file_url: "a/kit/hero.png",
  }),
];

type Harness = {
  tool: ReturnType<typeof createBrandKitTool>;
  /** How many table reads the caller's client was asked for — must stay zero. */
  tableReads: () => number;
  /** Every signature batch the storage surface was asked for. */
  signCalls: () => Array<{ bucket: string; paths: string[]; expiresIn: number }>;
  kitAsks: () => Array<{ actorId: string; kitId: string }>;
  assetAsks: () => Array<{ actorId: string; kitId: string }>;
};

function makeHarness(
  options: {
    /** What `findOwnKit` answers; defaults to the kit above. */
    kit?: KitDetailRow | null;
    /** What `listOwnKitAssets` answers; defaults to the four assets above. */
    assets?: BrandKitAssetRow[];
    kitError?: Error;
    assetsError?: Error;
    signError?: { message: string } | null;
  } = {},
): Harness {
  const kitAsks: Array<{ actorId: string; kitId: string }> = [];
  const assetAsks: Array<{ actorId: string; kitId: string }> = [];
  const signCalls: Array<{ bucket: string; paths: string[]; expiresIn: number }> = [];
  let tableReads = 0;

  const repository = {
    async listOwnKits(): Promise<never> {
      throw new Error("listOwnKits is not used by this tool");
    },
    async findOwnKit(input: { actorId: string; kitId: string }): Promise<KitDetailRow | null> {
      kitAsks.push({ ...input });
      if (options.kitError) throw options.kitError;
      return options.kit === undefined ? KIT : options.kit;
    },
    async listOwnKitAssets(input: {
      actorId: string;
      kitId: string;
    }): Promise<BrandKitAssetRow[]> {
      assetAsks.push({ ...input });
      if (options.assetsError) throw options.assetsError;
      return options.assets ?? ASSETS;
    },
    async listOwnKitFileUrls(): Promise<never> {
      throw new Error("listOwnKitFileUrls is not used by this tool");
    },
    async readNextSortOrder(): Promise<never> {
      throw new Error("readNextSortOrder is not used by this tool");
    },
    async findOwnAsset(): Promise<never> {
      throw new Error("findOwnAsset is not used by this tool");
    },
  } as unknown as BrandKitReadRepository;

  const client = {
    // A table read through the caller's client is a regression: it throws and it is
    // counted, so "the tool no longer reads tables" is measured, not asserted.
    from: (table: string) => {
      tableReads += 1;
      throw new Error(`unexpected table read in brand-kit test: ${table}`);
    },
  };

  // 45AH: the tool no longer builds a backend wrapper itself — every Storage call
  // lands on this fake store, which is where the signature batch is observed.
  const store: ObjectStore = {
    async put() {
      throw new Error("get_brand_kit must not write objects");
    },
    async get() {
      throw new Error("get_brand_kit must not read objects");
    },
    async head() {
      throw new Error("get_brand_kit must not head objects");
    },
    async delete() {
      throw new Error("get_brand_kit must not delete objects");
    },
    async copy() {
      throw new Error("get_brand_kit must not copy objects");
    },
    async signedReadUrl() {
      throw new Error("get_brand_kit signs in one batch, never one key at a time");
    },
    async signedReadUrls(bucket, paths, signOptions) {
      signCalls.push({ bucket, paths: [...paths], expiresIn: signOptions.ttlSeconds });

      const signed = new Map<string, string>();
      // A failed batch is "nothing could be signed" and the caller keeps its own
      // values — the same answer the SDK's null data produced.
      if (options.signError) return signed;

      for (const path of paths) {
        signed.set(
          path,
          `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
        );
      }

      return signed;
    },
  };

  return {
    tool: createBrandKitTool(
      {
        createUserClient: () => client,
        createObjectStore: (suppliedClient) => {
          // The factory must be handed the CALLER's client: that is what keeps the
          // signature in the user's RLS scope instead of widening it to the server's.
          expect(suppliedClient).toBe(client);
          return store;
        },
        brandKitReadRepository: repository,
      },
      KIT_ID,
    ),
    tableReads: () => tableReads,
    signCalls: () => signCalls,
    kitAsks: () => kitAsks,
    assetAsks: () => assetAsks,
  };
}

function config(accessToken: string | undefined = TOKEN) {
  return accessToken === undefined
    ? {}
    : { configurable: { access_token: accessToken } };
}

async function invoke(
  harness: Harness,
  accessToken: string | undefined = TOKEN,
): Promise<any> {
  return JSON.parse(String(await harness.tool.invoke({}, config(accessToken))));
}

describe("get_brand_kit: the published JSON is unchanged", () => {
  it("case 1: an owner reads the kit and its assets, in the pre-migration shape", async () => {
    const harness = makeHarness();

    await expect(invoke(harness)).resolves.toEqual({
      kit_name: "Acme Brand",
      design_guidance: "Warm, confident, never cute.",
      colors: [{ name: "Brand red", hex: "#D4A574", role: "primary" }],
      fonts: [{ name: "Heading", family: "Inter", weight: "700", role: "display" }],
      logos: [
        {
          name: "Primary logo",
          url: "https://proj.test/storage/v1/object/sign/brand-kit-assets/a/kit/logo.png?token=sig",
          role: "primary",
        },
      ],
      images: [
        {
          name: "Hero",
          url: "https://proj.test/storage/v1/object/sign/brand-kit-assets/a/kit/hero.png?token=sig",
        },
      ],
    });

    // Both reads were asked with the token's own subject — never a `configurable`
    // field that could disagree with the JWT.
    expect(harness.kitAsks()).toEqual([{ actorId: ACTOR, kitId: KIT_ID }]);
    expect(harness.assetAsks()).toEqual([{ actorId: ACTOR, kitId: KIT_ID }]);

    // Storage signing did NOT move: one batch, the brand-kit bucket, one hour.
    expect(harness.signCalls()).toEqual([
      { bucket: "brand-kit-assets", paths: ["a/kit/logo.png", "a/kit/hero.png"], expiresIn: 3600 },
    ]);

    // And not one table was read through the caller's client.
    expect(harness.tableReads()).toBe(0);
  });

  it("case 2: an empty guidance text publishes `\"\"`, exactly as the old `?? \"\"` did", async () => {
    const harness = makeHarness({
      kit: { ...KIT, guidance_text: null },
      // No file-backed asset, so nothing needs signing at all.
      assets: [assetRow({ asset_type: "color", display_name: "Only red" })],
    });

    const parsed = await invoke(harness);

    expect(parsed.design_guidance).toBe("");
    // No file-backed assets means no signing call at all.
    expect(harness.signCalls()).toEqual([]);
  });

  it("case 3: a font without a `metadata.weight` publishes the old `\"400\"` default", async () => {
    const harness = makeHarness({
      assets: [
        assetRow({
          asset_type: "font",
          display_name: "Body",
          text_content: "Source Sans",
          metadata: null,
        }),
      ],
    });

    const parsed = await invoke(harness);

    expect(parsed.fonts).toEqual([
      { name: "Body", family: "Source Sans", weight: "400", role: null },
    ]);
  });
});

describe("get_brand_kit: the owner predicate and the swallowed failures", () => {
  it("case 4: a kit id that is not the caller's answers `Brand kit not found`, and no asset read follows", async () => {
    // T-55: an administrator can read every project of their workspace, so a kit id
    // reached through a canvas link may belong to somebody else. The repository
    // answers `null` for it, exactly as the owner-only RLS policy did.
    const harness = makeHarness({ kit: null });

    await expect(invoke(harness)).resolves.toEqual({
      error: "Brand kit not found",
    });

    expect(harness.kitAsks()).toEqual([{ actorId: ACTOR, kitId: KIT_ID }]);
    // The old code returned before the asset read; so does this one.
    expect(harness.assetAsks()).toEqual([]);
    expect(harness.signCalls()).toEqual([]);
    expect(harness.tableReads()).toBe(0);
  });

  it("case 5: a failed kit read answers the SAME JSON instead of throwing into LangChain", async () => {
    // The old PostgREST kit read ignored `error` and published the not-found
    // answer, so a driver failure must not become a tool exception.
    const harness = makeHarness({
      kitError: new Error("brand kit read failed (findOwnKit)"),
    });

    await expect(invoke(harness)).resolves.toEqual({
      error: "Brand kit not found",
    });
  });

  it("case 6: a failed ASSET read leaves the kit in place with no assets, instead of failing the call", async () => {
    const harness = makeHarness({
      assetsError: new Error("brand kit read failed (listOwnKitAssets)"),
    });

    const parsed = await invoke(harness);

    expect(parsed.kit_name).toBe("Acme Brand");
    expect(parsed.design_guidance).toBe("Warm, confident, never cute.");
    expect(parsed.colors).toEqual([]);
    expect(parsed.fonts).toEqual([]);
    expect(parsed.logos).toEqual([]);
    expect(parsed.images).toEqual([]);
    expect(parsed.error).toBeUndefined();
  });

  it("case 7: a failed signing batch publishes the un-signed paths rather than throwing", async () => {
    const harness = makeHarness({ signError: { message: "storage said no" } });

    const parsed = await invoke(harness);

    // The old code kept the pre-signing values when `signedData` was null.
    expect(parsed.logos[0].url).toBe("a/kit/logo.png");
    expect(parsed.images[0].url).toBe("a/kit/hero.png");
  });
});

describe("get_brand_kit: the token is the actor", () => {
  it("case 8: no access token answers `No access token available` without touching a repository", async () => {
    const harness = makeHarness();

    const parsed = JSON.parse(
      String(await harness.tool.invoke({}, { configurable: {} })),
    );

    expect(parsed).toEqual({ error: "No access token available" });

    expect(harness.kitAsks()).toEqual([]);
    expect(harness.tableReads()).toBe(0);
  });

  it("case 9: a token with no usable `sub` is treated as `Brand kit not found`, never as an anonymous read", async () => {
    const harness = makeHarness();

    const parsed = JSON.parse(
      String(
        await harness.tool.invoke(
          {},
          { configurable: { access_token: tokenFor(null) } },
        ),
      ),
    );

    // The same answer an unusable token produced through RLS — and no repository
    // was asked, so there is no "read as nobody" path at all.
    expect(parsed).toEqual({ error: "Brand kit not found" });
    expect(harness.kitAsks()).toEqual([]);
  });
});
