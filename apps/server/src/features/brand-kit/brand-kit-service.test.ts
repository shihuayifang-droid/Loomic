import { describe, expect, it } from "vitest";

import {
  BrandKitServiceError,
  createBrandKitService,
} from "./brand-kit-service.js";
import {
  BrandKitReadError,
  FIND_OWN_ASSET,
  FIND_OWN_KIT,
  LIST_OWN_KITS,
  type BrandKitAssetRow,
  type BrandKitListResult,
  type BrandKitReadRepository,
  type KitDetailRow,
} from "../../db/brand-kit-read-repository.js";
import {
  BrandKitWriteError,
  INSERT_OWN_KIT,
  type BrandKitWriteRepository,
} from "../../db/brand-kit-write-repository.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

/**
 * The brand kit service after workorder 21Z: every TABLE read and write is a
 * repository call, and `createUserClient` survives for Storage only.
 *
 * What this file holds the service to:
 *
 * - the actor handed to every repository call is `user.id`, never the access
 *   token;
 * - `findOwnKit` / `listOwnKitAssets` / `listOwnKitFileUrls` / `readNextSortOrder`
 *   / `findOwnAsset` are the only reads, `insertOwnKit` / `clearOwnDefault` /
 *   `updateOwnKit` / `deleteOwnKit` / `insertOwnAsset` / `updateOwnAsset` /
 *   `deleteOwnAsset` / `insertOwnAssetCopies` the only writes — and each method
 *   calls exactly the ones workorder 21Z §1 says it calls, in that order;
 * - every error code, HTTP status and message is the one the removed PostgREST
 *   path produced, INCLUDING the two asymmetric ones (a failed kit read on the
 *   detail path is `brand_kit_not_found` / 500; a failed empty-payload asset read
 *   is `brand_kit_asset_not_found` / 500) and the FOUR places that swallowed a
 *   failure on purpose;
 * - `createUserClient` is reached only when Storage is really used, so
 *   `createAsset` / `updateAsset` / `deleteAsset` never open a PostgREST client at
 *   all, and `getKit` / `createKit` / `updateKit` / `duplicateKit` do so only when
 *   a file path needs signing.
 *
 * The fake user client has `storage` and a `.from` that THROWS: any leftover table
 * access fails loudly instead of quietly returning `undefined`.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000b1";
const SECOND_ACTOR_ID = "00000000-0000-0000-0000-0000000000b2";
const KIT_ONE = "00000000-0000-0000-0000-0000000000c1";
const KIT_TWO = "00000000-0000-0000-0000-0000000000c2";
const ASSET_ONE = "00000000-0000-0000-0000-0000000000d1";
const ASSET_TWO = "00000000-0000-0000-0000-0000000000d2";

const KIT_ONE_CREATED_AT = "2026-01-10T08:00:00.000Z";
const KIT_ONE_UPDATED_AT = "2026-01-11T08:00:00.000Z";
const KIT_TWO_CREATED_AT = "2026-02-10T08:00:00.000Z";
const KIT_TWO_UPDATED_AT = "2026-02-11T08:00:00.000Z";

const KIT_QUERY_FAILED_MESSAGE = "Unable to load brand kits.";
const KIT_NOT_FOUND_MESSAGE = "Brand kit not found.";
const KIT_CREATE_FAILED_MESSAGE = "Unable to create brand kit.";
const KIT_UPDATE_FAILED_MESSAGE = "Unable to update brand kit.";
const KIT_DELETE_FAILED_MESSAGE = "Unable to delete brand kit.";
const ASSET_NOT_FOUND_MESSAGE = "Brand kit asset not found.";
const ASSET_CREATE_FAILED_MESSAGE = "Unable to create brand kit asset.";

const BUCKET = "brand-kit-assets";
const EXPIRY = 3600;

const USER: AuthenticatedUser = {
  accessToken: "access-token-of-a",
  email: "brand-kit-service-a@hahart.test",
  id: ACTOR_ID,
  userMetadata: {},
};

const SECOND_USER: AuthenticatedUser = {
  ...USER,
  accessToken: "access-token-of-b",
  email: "brand-kit-service-b@hahart.test",
  id: SECOND_ACTOR_ID,
};

const KIT_DETAIL: KitDetailRow = {
  id: KIT_ONE,
  name: "Kit One",
  is_default: true,
  guidance_text: "Use the warm palette.",
  cover_url: "https://example.test/kit-one.png",
  created_at: KIT_ONE_CREATED_AT,
  updated_at: KIT_ONE_UPDATED_AT,
};

const ASSET_NO_FILE: BrandKitAssetRow = {
  id: ASSET_ONE,
  asset_type: "color",
  display_name: "Brand red",
  role: null,
  sort_order: 0,
  text_content: "#ff0000",
  file_url: null,
  metadata: { hex: "#ff0000" },
  created_at: KIT_ONE_CREATED_AT,
  updated_at: KIT_ONE_UPDATED_AT,
};

const ASSET_WITH_FILE: BrandKitAssetRow = {
  ...ASSET_NO_FILE,
  id: ASSET_TWO,
  asset_type: "logo",
  display_name: "Logo",
  file_url: "a/kit-one/logo.png",
  metadata: null,
};

const RESULT_FOR_A: BrandKitListResult = {
  kits: [
    {
      id: KIT_ONE,
      name: "Kit One",
      is_default: true,
      cover_url: "https://example.test/kit-one.png",
      created_at: KIT_ONE_CREATED_AT,
      updated_at: KIT_ONE_UPDATED_AT,
    },
    {
      id: KIT_TWO,
      name: "Kit Two",
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

type Call = [method: string, input: unknown];

/**
 * Wraps a repository so EVERY call is recorded. `overrides` replaces individual
 * methods; anything not overridden answers the neutral default below.
 */
function recordingRepository<T extends object>(
  base: T,
  calls: Call[],
): { repository: T; calls: Call[] } {
  const repository = {} as Record<string, unknown>;

  for (const key of Object.keys(base)) {
    repository[key] = async (input: unknown) => {
      calls.push([key, input]);
      const implementation = (base as Record<string, unknown>)[key] as (
        input: unknown,
      ) => Promise<unknown>;

      return implementation(input);
    };
  }

  return { repository: repository as T, calls };
}

function readRepository(overrides: Partial<BrandKitReadRepository> = {}) {
  const calls: Call[] = [];
  const base: BrandKitReadRepository = {
    async listOwnKits() {
      return { kits: [], assets: [] };
    },
    async findOwnKit() {
      return null;
    },
    async listOwnKitAssets() {
      return [];
    },
    async listOwnKitFileUrls() {
      return [];
    },
    async readNextSortOrder() {
      return 0;
    },
    async findOwnAsset() {
      return null;
    },
    ...overrides,
  };

  const { repository } = recordingRepository(base, calls);
  return { repository, calls };
}

function writeRepository(overrides: Partial<BrandKitWriteRepository> = {}) {
  const calls: Call[] = [];
  const base: BrandKitWriteRepository = {
    async insertOwnKit() {
      return { id: KIT_ONE };
    },
    async clearOwnDefault() {
      return undefined;
    },
    async updateOwnKit() {
      return { updated: 1 };
    },
    async deleteOwnKit() {
      return undefined;
    },
    async insertOwnAsset() {
      return null;
    },
    async updateOwnAsset() {
      return null;
    },
    async deleteOwnAsset() {
      return undefined;
    },
    async insertOwnAssetCopies() {
      return { inserted: 0 };
    },
    ...overrides,
  };

  const { repository } = recordingRepository(base, calls);
  return { repository, calls };
}

type StorageCall = { op: string; args: unknown[] };

/**
 * A user client with `storage` and NOTHING else: the `.from` getter throws, so a
 * leftover table call fails the test instead of returning `undefined`.
 */
function fakeUserClient(options: {
  calls: StorageCall[];
  uploadError?: Error;
  copyError?: Error;
  signedUrlMissing?: boolean;
}): (accessToken: string) => UserSupabaseClient {
  const client = {
    get from(): never {
      throw new Error(
        "the brand kit service must not use the PostgREST table client any more",
      );
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe(BUCKET);

        return {
          async createSignedUrls(paths: string[], expiresIn: number) {
            options.calls.push({ op: "createSignedUrls", args: [paths, expiresIn] });

            return {
              data: options.signedUrlMissing
                ? null
                : paths.map((path) => ({
                    path,
                    signedUrl: `https://signed.test/${path}?exp=${expiresIn}`,
                  })),
            };
          },
          async createSignedUrl(path: string, expiresIn: number) {
            options.calls.push({ op: "createSignedUrl", args: [path, expiresIn] });

            return {
              data: options.signedUrlMissing
                ? null
                : { signedUrl: `https://signed.test/${path}?exp=${expiresIn}` },
            };
          },
          async remove(paths: string[]) {
            options.calls.push({ op: "remove", args: [paths] });
            return { data: null, error: null };
          },
          async upload(path: string, buffer: Buffer, opts: unknown) {
            options.calls.push({ op: "upload", args: [path, buffer, opts] });

            return { error: options.uploadError ?? null };
          },
          async copy(from: string, to: string) {
            options.calls.push({ op: "copy", args: [from, to] });
            return { error: options.copyError ?? null };
          },
        };
      },
    },
  };

  return () => client as unknown as UserSupabaseClient;
}

function serviceWith(
  options: {
    read?: Partial<BrandKitReadRepository>;
    write?: Partial<BrandKitWriteRepository>;
    storage?: Parameters<typeof fakeUserClient>[0];
  } = {},
) {
  const read = readRepository(options.read);
  const write = writeRepository(options.write);
  const storageCalls = options.storage?.calls ?? [];
  const clientTokens: string[] = [];

  const storageOptions = options.storage ?? { calls: storageCalls };
  const factory = fakeUserClient(storageOptions);

  const service = createBrandKitService({
    createUserClient: (accessToken: string) => {
      clientTokens.push(accessToken);
      return factory(accessToken);
    },
    brandKitReadRepository: read.repository,
    brandKitWriteRepository: write.repository,
  });

  return {
    service,
    readCalls: read.calls,
    writeCalls: write.calls,
    storageCalls,
    clientTokens,
  };
}

async function failure(promise: Promise<unknown>): Promise<BrandKitServiceError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(BrandKitServiceError);

  return error as BrandKitServiceError;
}

// ---------------------------------------------------------------------------
// listKits (kept from workorder 21Y: it still has to work exactly as before)
// ---------------------------------------------------------------------------

describe("brand-kit-service: listKits reads through the repository", () => {
  it("case 1: the actor is `user.id` and no user-scoped client is created", async () => {
    const { service, readCalls, clientTokens } = serviceWith({
      read: {
        async listOwnKits() {
          return RESULT_FOR_A;
        },
      },
    });

    await service.listKits(USER);

    expect(readCalls).toEqual([["listOwnKits", { actorId: ACTOR_ID }]]);
    expect(clientTokens).toEqual([]);
  });

  it("case 2: A's two kits map to two summaries, K2's counts all zero, field order intact", async () => {
    const { service } = serviceWith({
      read: {
        async listOwnKits() {
          return RESULT_FOR_A;
        },
      },
    });

    const summaries = await service.listKits(USER);

    expect(summaries).toEqual([
      {
        id: KIT_ONE,
        name: "Kit One",
        is_default: true,
        cover_url: "https://example.test/kit-one.png",
        asset_counts: { color: 2, font: 0, logo: 1, image: 0 },
        created_at: KIT_ONE_CREATED_AT,
        updated_at: KIT_ONE_UPDATED_AT,
      },
      {
        id: KIT_TWO,
        name: "Kit Two",
        is_default: false,
        cover_url: null,
        asset_counts: { color: 0, font: 0, logo: 0, image: 0 },
        created_at: KIT_TWO_CREATED_AT,
        updated_at: KIT_TWO_UPDATED_AT,
      },
    ]);
    expect(Object.keys(summaries[0] ?? {})).toEqual([
      "id",
      "name",
      "is_default",
      "cover_url",
      "asset_counts",
      "created_at",
      "updated_at",
    ]);
  });

  it("case 3: an empty result is an empty list; any repository failure is `brand_kit_query_failed` / 500", async () => {
    const empty = serviceWith({
      read: {
        async listOwnKits() {
          return { kits: [], assets: [] };
        },
      },
    });
    await expect(empty.service.listKits(USER)).resolves.toEqual([]);

    for (const cause of [
      new BrandKitReadError(LIST_OWN_KITS, new Error("connect refused")),
      new Error("driver blew up"),
      undefined,
    ]) {
      const failing = serviceWith({
        read: {
          async listOwnKits() {
            throw cause;
          },
        },
      });

      const error = await failure(failing.service.listKits(USER));
      expect(error.code).toBe("brand_kit_query_failed");
      expect(error.statusCode).toBe(500);
      expect(error.message).toBe(KIT_QUERY_FAILED_MESSAGE);
    }
  });
});

// ---------------------------------------------------------------------------
// The detail path
// ---------------------------------------------------------------------------

describe("brand-kit-service: the detail path reads only through repositories", () => {
  it("case 4: getKit reads the kit and its assets, creates NO client when no path needs signing", async () => {
    const { service, readCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitAssets() {
          return [ASSET_NO_FILE];
        },
      },
    });

    const detail = await service.getKit(USER, KIT_ONE);

    expect(readCalls).toEqual([
      ["findOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }],
      ["listOwnKitAssets", { actorId: ACTOR_ID, kitId: KIT_ONE }],
    ]);
    expect(clientTokens).toEqual([]);
    expect(detail).toEqual({
      id: KIT_ONE,
      name: "Kit One",
      is_default: true,
      guidance_text: "Use the warm palette.",
      cover_url: "https://example.test/kit-one.png",
      assets: [
        {
          id: ASSET_ONE,
          asset_type: "color",
          display_name: "Brand red",
          role: null,
          sort_order: 0,
          text_content: "#ff0000",
          file_url: null,
          metadata: { hex: "#ff0000" },
          created_at: KIT_ONE_CREATED_AT,
          updated_at: KIT_ONE_UPDATED_AT,
        },
      ],
      created_at: KIT_ONE_CREATED_AT,
      updated_at: KIT_ONE_UPDATED_AT,
    });
  });

  it("case 5: file assets get signed URLs, and the client is created exactly once for it", async () => {
    const { service, clientTokens, storageCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitAssets() {
          return [ASSET_NO_FILE, ASSET_WITH_FILE];
        },
      },
    });

    const detail = await service.getKit(USER, KIT_ONE);

    expect(clientTokens).toEqual([USER.accessToken]);
    expect(storageCalls).toEqual([
      { op: "createSignedUrls", args: [["a/kit-one/logo.png"], EXPIRY] },
    ]);
    // The signed URL replaces the stored path; the colour asset keeps its null.
    expect(detail.assets[1]?.file_url).toBe(
      `https://signed.test/a/kit-one/logo.png?exp=${EXPIRY}`,
    );
    expect(detail.assets[0]?.file_url).toBeNull();
    // A NULL metadata becomes `{}` in the published row — unchanged by 21Z.
    expect(detail.assets[1]?.metadata).toEqual({});
  });

  it("case 6: a detail kit read that FAILS is `brand_kit_not_found` / 500, not query_failed", async () => {
    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          throw new BrandKitReadError(FIND_OWN_KIT, new Error("boom"));
        },
      },
    });

    const error = await failure(service.getKit(USER, KIT_ONE));

    expect(error.code).toBe("brand_kit_not_found");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(KIT_NOT_FOUND_MESSAGE);
  });

  it("case 7: a missing kit is `brand_kit_not_found` / 404 and the assets are never read", async () => {
    const { service, readCalls } = serviceWith();

    const error = await failure(service.getKit(USER, KIT_ONE));

    expect(error.code).toBe("brand_kit_not_found");
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe(KIT_NOT_FOUND_MESSAGE);
    expect(readCalls).toEqual([["findOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }]]);
  });

  it("case 8: an asset read failure is `brand_kit_query_failed` / 500", async () => {
    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitAssets() {
          throw new Error("boom");
        },
      },
    });

    const error = await failure(service.getKit(USER, KIT_ONE));

    expect(error.code).toBe("brand_kit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(KIT_QUERY_FAILED_MESSAGE);
  });

  it("case 9: every read is asked for the CALLER's own id, never the token", async () => {
    const { service, readCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    await service.getKit(SECOND_USER, KIT_ONE);

    expect(readCalls.map(([, input]) => (input as { actorId: string }).actorId)).toEqual([
      SECOND_ACTOR_ID,
      SECOND_ACTOR_ID,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Kit writes
// ---------------------------------------------------------------------------

describe("brand-kit-service: createKit", () => {
  it("case 10: one insert with the trimmed name and a null guidance, then the detail read", async () => {
    const { service, writeCalls, readCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    const detail = await service.createKit(USER, { name: "  Kit One  " });

    expect(writeCalls).toEqual([
      [
        "insertOwnKit",
        { actorId: ACTOR_ID, name: "Kit One", guidanceText: null },
      ],
    ]);
    expect(readCalls[0]).toEqual(["findOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }]);
    expect(clientTokens).toEqual([]);
    expect(detail.id).toBe(KIT_ONE);
  });

  it("case 11: a blank name falls back to the same placeholder the route always used", async () => {
    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    await service.createKit(USER, { name: "   " });

    expect((writeCalls[0]?.[1] as { name: string }).name).toBe("\u672A\u547D\u540D");
  });

  it("case 12: an insert failure is `brand_kit_create_failed` / 500", async () => {
    const { service } = serviceWith({
      write: {
        async insertOwnKit() {
          throw new BrandKitWriteError(INSERT_OWN_KIT, new Error("boom"));
        },
      },
    });

    const error = await failure(service.createKit(USER, { name: "Kit One" }));

    expect(error.code).toBe("brand_kit_create_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(KIT_CREATE_FAILED_MESSAGE);
  });
});

describe("brand-kit-service: updateKit", () => {
  it("case 13: clearing the default happens FIRST and as a separate call, then the patch", async () => {
    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    await service.updateKit(USER, KIT_ONE, { is_default: true, name: "Renamed" });

    expect(writeCalls).toEqual([
      ["clearOwnDefault", { actorId: ACTOR_ID }],
      [
        "updateOwnKit",
        { actorId: ACTOR_ID, kitId: KIT_ONE, patch: { name: "Renamed", is_default: true } },
      ],
    ]);
  });

  it("case 14: an EMPTY patch writes nothing and answers the detail read", async () => {
    const { service, writeCalls, readCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    await service.updateKit(USER, KIT_ONE, {});

    expect(writeCalls).toEqual([]);
    // The detail read is the answer, and it is the only thing that ran.
    expect(readCalls).toEqual([
      ["findOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }],
      ["listOwnKitAssets", { actorId: ACTOR_ID, kitId: KIT_ONE }],
    ]);
  });

  it("case 15: `guidance_text: null` is CARRIED into the patch, not dropped", async () => {
    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
    });

    await service.updateKit(USER, KIT_ONE, { guidance_text: null });

    expect(writeCalls).toEqual([
      [
        "updateOwnKit",
        { actorId: ACTOR_ID, kitId: KIT_ONE, patch: { guidance_text: null } },
      ],
    ]);
  });

  it("case 16: a clear failure and an update failure are both `brand_kit_update_failed` / 500", async () => {
    const clearing = serviceWith({
      write: {
        async clearOwnDefault() {
          throw new Error("boom");
        },
      },
    });
    const clearError = await failure(
      clearing.service.updateKit(USER, KIT_ONE, { is_default: true }),
    );
    expect(clearError.code).toBe("brand_kit_update_failed");
    expect(clearError.statusCode).toBe(500);
    expect(clearError.message).toBe(KIT_UPDATE_FAILED_MESSAGE);

    const updating = serviceWith({
      write: {
        async updateOwnKit() {
          throw new BrandKitWriteError("updateOwnKit", new Error("boom"));
        },
      },
    });
    const updateError = await failure(
      updating.service.updateKit(USER, KIT_ONE, { name: "Renamed" }),
    );
    expect(updateError.code).toBe("brand_kit_update_failed");
    expect(updateError.statusCode).toBe(500);
    expect(updateError.message).toBe(KIT_UPDATE_FAILED_MESSAGE);
  });

  it("case 17: an update that touched nothing is NOT an error — the detail read decides (404)", async () => {
    const { service } = serviceWith({
      write: {
        async updateOwnKit() {
          return { updated: 0 };
        },
      },
    });

    const error = await failure(service.updateKit(SECOND_USER, KIT_ONE, { name: "x" }));

    expect(error.code).toBe("brand_kit_not_found");
    expect(error.statusCode).toBe(404);
  });
});

describe("brand-kit-service: deleteKit", () => {
  it("case 18: a failed probe is `brand_kit_delete_failed` / 500; a missing kit is 404", async () => {
    const failing = serviceWith({
      read: {
        async findOwnKit() {
          throw new BrandKitReadError(FIND_OWN_KIT, new Error("boom"));
        },
      },
    });
    const probeError = await failure(failing.service.deleteKit(USER, KIT_ONE));
    expect(probeError.code).toBe("brand_kit_delete_failed");
    expect(probeError.statusCode).toBe(500);
    expect(probeError.message).toBe(KIT_DELETE_FAILED_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(missing.service.deleteKit(USER, KIT_ONE));
    expect(notFound.code).toBe("brand_kit_not_found");
    expect(notFound.statusCode).toBe(404);
  });

  it("case 19: a failed FILE-PATH read is SWALLOWED — no storage call, and the kit is still deleted", async () => {
    const { service, writeCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitFileUrls() {
          throw new BrandKitReadError("listOwnKitFileUrls", new Error("boom"));
        },
      },
    });

    await expect(service.deleteKit(USER, KIT_ONE)).resolves.toBeUndefined();

    expect(clientTokens).toEqual([]);
    expect(writeCalls).toEqual([["deleteOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }]]);
  });

  it("case 20: file paths are removed from storage ONCE, before the row is deleted", async () => {
    const { service, writeCalls, storageCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitFileUrls() {
          return ["a/kit-one/one.png", "a/kit-one/two.png"];
        },
      },
    });

    await service.deleteKit(USER, KIT_ONE);

    expect(clientTokens).toEqual([USER.accessToken]);
    expect(storageCalls).toEqual([
      { op: "remove", args: [["a/kit-one/one.png", "a/kit-one/two.png"]] },
    ]);
    expect(writeCalls).toEqual([["deleteOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }]]);
  });

  it("case 21: empty strings in the path list are filtered out before the remove call", async () => {
    const { service, storageCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitFileUrls() {
          return ["", "a/kit-one/one.png"];
        },
      },
    });

    await service.deleteKit(USER, KIT_ONE);

    expect(storageCalls).toEqual([{ op: "remove", args: [["a/kit-one/one.png"]] }]);
  });

  it("case 22: a delete failure is `brand_kit_delete_failed` / 500", async () => {
    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
      write: {
        async deleteOwnKit() {
          throw new BrandKitWriteError("deleteOwnKit", new Error("boom"));
        },
      },
    });

    const error = await failure(service.deleteKit(USER, KIT_ONE));
    expect(error.code).toBe("brand_kit_delete_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(KIT_DELETE_FAILED_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Asset writes
// ---------------------------------------------------------------------------

describe("brand-kit-service: createAsset", () => {
  it("case 23: probe, next sort order, insert — and NO user client at all", async () => {
    const { service, readCalls, writeCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async readNextSortOrder() {
          return 3;
        },
      },
      write: {
        async insertOwnAsset(input) {
          expect(input).toEqual({
            actorId: ACTOR_ID,
            kitId: KIT_ONE,
            asset: {
              asset_type: "color",
              display_name: "Brand red",
              text_content: "#ff0000",
              role: null,
              sort_order: 3,
              metadata: { hex: "#ff0000" },
              file_url: null,
            },
          });

          return ASSET_NO_FILE;
        },
      },
    });

    const asset = await service.createAsset(USER, KIT_ONE, {
      asset_type: "color",
      display_name: "Brand red",
      text_content: "#ff0000",
      metadata: { hex: "#ff0000" },
    });

    expect(readCalls).toEqual([
      ["findOwnKit", { actorId: ACTOR_ID, kitId: KIT_ONE }],
      ["readNextSortOrder", { actorId: ACTOR_ID, kitId: KIT_ONE, assetType: "color" }],
    ]);
    expect(writeCalls.map(([method]) => method)).toEqual(["insertOwnAsset"]);
    expect(clientTokens).toEqual([]);
    expect(asset.id).toBe(ASSET_ONE);
  });

  it("case 24: a probe failure is `brand_kit_not_found` / 500; a missing kit is 404", async () => {
    const failing = serviceWith({
      read: {
        async findOwnKit() {
          throw new BrandKitReadError(FIND_OWN_KIT, new Error("boom"));
        },
      },
    });
    const probeError = await failure(
      failing.service.createAsset(USER, KIT_ONE, {
        asset_type: "color",
        display_name: "x",
      }),
    );
    expect(probeError.code).toBe("brand_kit_not_found");
    expect(probeError.statusCode).toBe(500);
    expect(probeError.message).toBe(KIT_NOT_FOUND_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(
      missing.service.createAsset(USER, KIT_ONE, {
        asset_type: "color",
        display_name: "x",
      }),
    );
    expect(notFound.code).toBe("brand_kit_not_found");
    expect(notFound.statusCode).toBe(404);
  });

  it("case 25: a failed sort-order read is SWALLOWED and the asset gets sort_order 0", async () => {
    let insertedSortOrder: number | undefined;

    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async readNextSortOrder() {
          throw new BrandKitReadError("readNextSortOrder", new Error("boom"));
        },
      },
      write: {
        async insertOwnAsset(input) {
          insertedSortOrder = input.asset.sort_order;
          return ASSET_NO_FILE;
        },
      },
    });

    await service.createAsset(USER, KIT_ONE, {
      asset_type: "color",
      display_name: "Brand red",
    });

    expect(insertedSortOrder).toBe(0);
  });

  it("case 26: a refused insert or a failed one is `brand_kit_asset_create_failed` / 500", async () => {
    for (const override of [
      async () => null,
      async () => {
        throw new BrandKitWriteError("insertOwnAsset", new Error("boom"));
      },
    ]) {
      const { service } = serviceWith({
        read: {
          async findOwnKit() {
            return KIT_DETAIL;
          },
        },
        write: { insertOwnAsset: override as never },
      });

      const error = await failure(
        service.createAsset(USER, KIT_ONE, {
          asset_type: "color",
          display_name: "Brand red",
        }),
      );

      expect(error.code).toBe("brand_kit_asset_create_failed");
      expect(error.statusCode).toBe(500);
      expect(error.message).toBe(ASSET_CREATE_FAILED_MESSAGE);
    }
  });
});

describe("brand-kit-service: updateAsset", () => {
  it("case 27: an empty payload reads the asset — a failure is 500, a missing row 404", async () => {
    const failing = serviceWith({
      read: {
        async findOwnAsset() {
          throw new BrandKitReadError(FIND_OWN_ASSET, new Error("boom"));
        },
      },
    });
    const readError = await failure(failing.service.updateAsset(USER, KIT_ONE, ASSET_ONE, {}));
    expect(readError.code).toBe("brand_kit_asset_not_found");
    expect(readError.statusCode).toBe(500);
    expect(readError.message).toBe(ASSET_NOT_FOUND_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(missing.service.updateAsset(USER, KIT_ONE, ASSET_ONE, {}));
    expect(notFound.code).toBe("brand_kit_asset_not_found");
    expect(notFound.statusCode).toBe(404);
  });

  it("case 28: an empty payload answers the CURRENT row and writes nothing", async () => {
    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnAsset() {
          return ASSET_NO_FILE;
        },
      },
    });

    const asset = await service.updateAsset(USER, KIT_ONE, ASSET_ONE, {});

    expect(writeCalls).toEqual([]);
    expect(asset.id).toBe(ASSET_ONE);
    expect(asset.metadata).toEqual({ hex: "#ff0000" });
  });

  it("case 29: a non-empty payload carries every present key, nulls included, and no client is created", async () => {
    const { service, writeCalls, clientTokens } = serviceWith({
      write: {
        async updateOwnAsset(input) {
          expect(input).toEqual({
            actorId: ACTOR_ID,
            kitId: KIT_ONE,
            assetId: ASSET_ONE,
            patch: {
              display_name: "Renamed",
              text_content: null,
              role: "accent",
              sort_order: 7,
              metadata: { a: 1 },
            },
          });

          return { ...ASSET_NO_FILE, display_name: "Renamed", sort_order: 7 };
        },
      },
    });

    const asset = await service.updateAsset(USER, KIT_ONE, ASSET_ONE, {
      display_name: "Renamed",
      text_content: null,
      role: "accent",
      sort_order: 7,
      metadata: { a: 1 },
    });

    expect(writeCalls.map(([method]) => method)).toEqual(["updateOwnAsset"]);
    expect(clientTokens).toEqual([]);
    expect(asset.display_name).toBe("Renamed");
    expect(asset.sort_order).toBe(7);
  });

  it("case 30: an update failure is `brand_kit_update_failed` / 500 and a missing row 404", async () => {
    const failing = serviceWith({
      write: {
        async updateOwnAsset() {
          throw new BrandKitWriteError("updateOwnAsset", new Error("boom"));
        },
      },
    });
    const updateError = await failure(
      failing.service.updateAsset(USER, KIT_ONE, ASSET_ONE, { sort_order: 1 }),
    );
    expect(updateError.code).toBe("brand_kit_update_failed");
    expect(updateError.statusCode).toBe(500);
    expect(updateError.message).toBe(KIT_UPDATE_FAILED_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(
      missing.service.updateAsset(USER, KIT_ONE, ASSET_ONE, { sort_order: 1 }),
    );
    expect(notFound.code).toBe("brand_kit_asset_not_found");
    expect(notFound.statusCode).toBe(404);
  });
});

describe("brand-kit-service: deleteAsset", () => {
  it("case 31: a failed probe is `brand_kit_delete_failed` / 500; a missing row is 404", async () => {
    const failing = serviceWith({
      read: {
        async findOwnAsset() {
          throw new BrandKitReadError(FIND_OWN_ASSET, new Error("boom"));
        },
      },
    });
    const probeError = await failure(failing.service.deleteAsset(USER, KIT_ONE, ASSET_ONE));
    expect(probeError.code).toBe("brand_kit_delete_failed");
    expect(probeError.statusCode).toBe(500);
    expect(probeError.message).toBe(KIT_DELETE_FAILED_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(missing.service.deleteAsset(USER, KIT_ONE, ASSET_ONE));
    expect(notFound.code).toBe("brand_kit_asset_not_found");
    expect(notFound.statusCode).toBe(404);
  });

  it("case 32: a file-backed asset removes its object once; a text asset opens no client", async () => {
    const withFile = serviceWith({
      read: {
        async findOwnAsset() {
          return ASSET_WITH_FILE;
        },
      },
    });

    await withFile.service.deleteAsset(USER, KIT_ONE, ASSET_TWO);

    expect(withFile.clientTokens).toEqual([USER.accessToken]);
    expect(withFile.storageCalls).toEqual([
      { op: "remove", args: [["a/kit-one/logo.png"]] },
    ]);
    expect(withFile.writeCalls).toEqual([
      ["deleteOwnAsset", { actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_TWO }],
    ]);

    const withoutFile = serviceWith({
      read: {
        async findOwnAsset() {
          return ASSET_NO_FILE;
        },
      },
    });

    await withoutFile.service.deleteAsset(USER, KIT_ONE, ASSET_ONE);

    expect(withoutFile.clientTokens).toEqual([]);
    expect(withoutFile.storageCalls).toEqual([]);
  });

  it("case 33: a delete failure is `brand_kit_delete_failed` / 500", async () => {
    const { service } = serviceWith({
      read: {
        async findOwnAsset() {
          return ASSET_NO_FILE;
        },
      },
      write: {
        async deleteOwnAsset() {
          throw new BrandKitWriteError("deleteOwnAsset", new Error("boom"));
        },
      },
    });

    const error = await failure(service.deleteAsset(USER, KIT_ONE, ASSET_ONE));
    expect(error.code).toBe("brand_kit_delete_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(KIT_DELETE_FAILED_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// uploadAsset and duplicateKit: the two paths that still need Storage
// ---------------------------------------------------------------------------

describe("brand-kit-service: uploadAsset", () => {
  it("case 34: probe, upload, sort order, insert, signed URL — in that order", async () => {
    const storage = { calls: [] as StorageCall[] };
    const { service, readCalls, writeCalls, storageCalls, clientTokens } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async readNextSortOrder() {
          return 5;
        },
      },
      write: {
        async insertOwnAsset(input) {
          expect(input.asset).toEqual({
            asset_type: "logo",
            display_name: "logo",
            text_content: null,
            role: null,
            sort_order: 5,
            metadata: {},
            file_url: expect.stringMatching(
              new RegExp(`^${ACTOR_ID}/${KIT_ONE}/\\d+-logo\\.png$`),
            ) as unknown as string,
          });

          return { ...ASSET_WITH_FILE, file_url: input.asset.file_url };
        },
      },
      storage,
    });

    const asset = await service.uploadAsset(
      USER,
      KIT_ONE,
      "logo",
      "logo.png",
      Buffer.from("png"),
      "image/png",
    );

    expect(readCalls.map(([method]) => method)).toEqual([
      "findOwnKit",
      "readNextSortOrder",
    ]);
    expect(writeCalls.map(([method]) => method)).toEqual(["insertOwnAsset"]);
    expect(clientTokens).toEqual([USER.accessToken]);

    const objectPath = (writeCalls[0]?.[1] as { asset: { file_url: string } }).asset
      .file_url;
    expect(storageCalls[0]?.op).toBe("upload");
    expect(storageCalls[0]?.args[0]).toBe(objectPath);
    expect(storageCalls[0]?.args[2]).toEqual({
      contentType: "image/png",
      upsert: false,
    });
    expect(storageCalls[1]).toEqual({
      op: "createSignedUrl",
      args: [objectPath, EXPIRY],
    });
    expect(asset.file_url).toBe(`https://signed.test/${objectPath}?exp=${EXPIRY}`);
  });

  it("case 35: an upload failure is `brand_kit_asset_create_failed` with the driver's sentence, and nothing is inserted", async () => {
    const storage = {
      calls: [] as StorageCall[],
      uploadError: new Error("bucket is full"),
    };
    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
      storage,
    });

    const error = await failure(
      service.uploadAsset(USER, KIT_ONE, "logo", "logo.png", Buffer.from("x"), "image/png"),
    );

    expect(error.code).toBe("brand_kit_asset_create_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("File upload failed: bucket is full");
    expect(writeCalls).toEqual([]);
    // Nothing to clean up: the object was never stored.
    expect(storage.calls.filter((call) => call.op === "remove")).toEqual([]);
  });

  it("case 36: a failed insert removes the uploaded object EXACTLY ONCE, with its own path", async () => {
    const storage = { calls: [] as StorageCall[] };
    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
      write: {
        async insertOwnAsset() {
          return null;
        },
      },
      storage,
    });

    const error = await failure(
      service.uploadAsset(USER, KIT_ONE, "logo", "logo.png", Buffer.from("x"), "image/png"),
    );

    expect(error.code).toBe("brand_kit_asset_create_failed");
    expect(error.message).toBe(ASSET_CREATE_FAILED_MESSAGE);

    const uploads = storage.calls.filter((call) => call.op === "upload");
    const removals = storage.calls.filter((call) => call.op === "remove");
    expect(uploads).toHaveLength(1);
    expect(removals).toHaveLength(1);
    // `remove([objectPath])` — the batch argument is the single path just uploaded.
    expect(removals[0]?.args).toEqual([[uploads[0]?.args[0]]]);
    // No signed URL is asked for on the failure path.
    expect(storage.calls.filter((call) => call.op === "createSignedUrl")).toEqual([]);
  });

  it("case 37: a missing kit is 404 BEFORE any client is created, so nothing is uploaded", async () => {
    const storage = { calls: [] as StorageCall[] };
    const { service, clientTokens } = serviceWith({ storage });

    const error = await failure(
      service.uploadAsset(USER, KIT_ONE, "logo", "logo.png", Buffer.from("x"), "image/png"),
    );

    expect(error.code).toBe("brand_kit_not_found");
    expect(error.statusCode).toBe(404);
    expect(clientTokens).toEqual([]);
    expect(storage.calls).toEqual([]);
  });
});

describe("brand-kit-service: duplicateKit", () => {
  it("case 38: source, new kit named `(副本)`, assets, batch copy, then the detail read", async () => {
    const { service, writeCalls, readCalls, storageCalls } = serviceWith({
      read: {
        async findOwnKit(input) {
          return input.kitId === KIT_ONE ? KIT_DETAIL : { ...KIT_DETAIL, id: KIT_TWO };
        },
        async listOwnKitAssets() {
          return [ASSET_NO_FILE, ASSET_WITH_FILE];
        },
      },
      write: {
        async insertOwnKit(input) {
          expect(input).toEqual({
            actorId: ACTOR_ID,
            name: "Kit One (副本)",
            guidanceText: "Use the warm palette.",
          });

          return { id: KIT_TWO };
        },
      },
    });

    const detail = await service.duplicateKit(USER, KIT_ONE);

    expect(writeCalls.map(([method]) => method)).toEqual([
      "insertOwnKit",
      "insertOwnAssetCopies",
    ]);
    expect(storageCalls.map((call) => call.op)).toEqual(["copy", "createSignedUrls"]);
    // One copy for the text asset (no storage object) and one for the file asset,
    // whose path is the NEW object the copy produced.
    expect(writeCalls[1]?.[1]).toMatchObject({
      actorId: ACTOR_ID,
      kitId: KIT_TWO,
      copies: [
        {
          asset_type: "color",
          display_name: "Brand red",
          role: null,
          sort_order: 0,
          text_content: "#ff0000",
          file_url: null,
          metadata: { hex: "#ff0000" },
        },
        {
          asset_type: "logo",
          display_name: "Logo",
          file_url: expect.stringMatching(
            new RegExp(`^${ACTOR_ID}/${KIT_TWO}/\\d+-copy\\.png$`),
          ) as unknown as string,
        },
      ],
    });
    expect(readCalls.map(([method]) => method)).toEqual([
      "findOwnKit",
      "listOwnKitAssets",
      "findOwnKit",
      "listOwnKitAssets",
    ]);
    expect(detail.id).toBe(KIT_TWO);
  });

  it("case 39: a failed SOURCE-ASSET read is SWALLOWED — no copies, new kit still returned", async () => {
    let assetReads = 0;

    const { service, writeCalls } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitAssets() {
          assetReads += 1;
          // The FIRST call is the duplicate's source-asset read, which is the one
          // that swallowed its failure. The detail read afterwards must work, or
          // the case would be measuring the wrong thing.
          if (assetReads === 1) {
            throw new BrandKitReadError("listOwnKitAssets", new Error("boom"));
          }

          return [];
        },
      },
      write: {
        async insertOwnKit() {
          return { id: KIT_TWO };
        },
      },
    });

    const detail = await service.duplicateKit(USER, KIT_ONE);

    expect(writeCalls.map(([method]) => method)).toEqual(["insertOwnKit"]);
    expect(detail.id).toBe(KIT_ONE);
  });

  it("case 40: a failed COPIES insert is SWALLOWED — the duplicate comes back anyway", async () => {
    const { service } = serviceWith({
      read: {
        async findOwnKit(input) {
          return input.kitId === KIT_ONE ? KIT_DETAIL : { ...KIT_DETAIL, id: KIT_TWO };
        },
        async listOwnKitAssets() {
          return [ASSET_NO_FILE];
        },
      },
      write: {
        async insertOwnKit() {
          return { id: KIT_TWO };
        },
        async insertOwnAssetCopies() {
          throw new BrandKitWriteError("insertOwnAssetCopies", new Error("boom"));
        },
      },
    });

    await expect(service.duplicateKit(USER, KIT_ONE)).resolves.toMatchObject({
      id: KIT_TWO,
    });
  });

  it("case 41: a failed SOURCE KIT read is 500, a missing source kit is 404, a failed insert is `brand_kit_create_failed`", async () => {
    const failingRead = serviceWith({
      read: {
        async findOwnKit() {
          throw new BrandKitReadError(FIND_OWN_KIT, new Error("boom"));
        },
      },
    });
    const readError = await failure(failingRead.service.duplicateKit(USER, KIT_ONE));
    expect(readError.code).toBe("brand_kit_not_found");
    expect(readError.statusCode).toBe(500);
    expect(readError.message).toBe(KIT_NOT_FOUND_MESSAGE);

    const missing = serviceWith();
    const notFound = await failure(missing.service.duplicateKit(USER, KIT_ONE));
    expect(notFound.code).toBe("brand_kit_not_found");
    expect(notFound.statusCode).toBe(404);

    const failingInsert = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
      },
      write: {
        async insertOwnKit() {
          throw new BrandKitWriteError(INSERT_OWN_KIT, new Error("boom"));
        },
      },
    });
    const createError = await failure(failingInsert.service.duplicateKit(USER, KIT_ONE));
    expect(createError.code).toBe("brand_kit_create_failed");
    expect(createError.statusCode).toBe(500);
    expect(createError.message).toBe(KIT_CREATE_FAILED_MESSAGE);
  });

  it("case 42: a KIT THAT IS NOT THE CALLER'S cannot be duplicated, and nothing is written", async () => {
    const { service, writeCalls } = serviceWith();

    const error = await failure(service.duplicateKit(SECOND_USER, KIT_ONE));

    expect(error.code).toBe("brand_kit_not_found");
    expect(error.statusCode).toBe(404);
    expect(writeCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The contract that ties the two halves together
// ---------------------------------------------------------------------------

describe("brand-kit-service: the repository boundary", () => {
  it("case 43: no method ever touches the PostgREST table client", async () => {
    // The fake user client's `.from` THROWS, so any leftover table access fails the
    // case below rather than quietly returning `undefined`.
    const storage = { calls: [] as StorageCall[] };
    const { service } = serviceWith({
      read: {
        async findOwnKit() {
          return KIT_DETAIL;
        },
        async listOwnKitAssets() {
          return [ASSET_WITH_FILE];
        },
        async listOwnKitFileUrls() {
          return ["a/kit-one/logo.png"];
        },
        async readNextSortOrder() {
          return 0;
        },
        async findOwnAsset() {
          return ASSET_WITH_FILE;
        },
      },
      write: {
        async insertOwnAsset() {
          return ASSET_WITH_FILE;
        },
        async updateOwnAsset() {
          return ASSET_WITH_FILE;
        },
      },
      storage,
    });

    await service.listKits(USER);
    await service.getKit(USER, KIT_ONE);
    await service.createKit(USER, { name: "Kit" });
    await service.updateKit(USER, KIT_ONE, { name: "Kit" });
    await service.deleteKit(USER, KIT_ONE);
    await service.createAsset(USER, KIT_ONE, {
      asset_type: "color",
      display_name: "x",
    });
    await service.updateAsset(USER, KIT_ONE, ASSET_ONE, { sort_order: 1 });
    await service.deleteAsset(USER, KIT_ONE, ASSET_ONE);
    await service.uploadAsset(USER, KIT_ONE, "logo", "logo.png", Buffer.from("x"), "image/png");
    await service.duplicateKit(USER, KIT_ONE);

    // Ten methods ran and not one of them reached a table.
    expect(storage.calls.length).toBeGreaterThan(0);
  });

  it("case 44: the actor handed to every repository method is `user.id`", async () => {
    const read: Call[] = [];
    const write: Call[] = [];

    const { service } = (() => {
      const wrapped = serviceWith({
        read: {
          async findOwnKit() {
            return KIT_DETAIL;
          },
          async listOwnKitAssets() {
            return [];
          },
          async findOwnAsset() {
            return ASSET_NO_FILE;
          },
        },
        write: {
          async insertOwnAsset() {
            return ASSET_NO_FILE;
          },
          async updateOwnAsset() {
            return ASSET_NO_FILE;
          },
        },
      });
      read.push(...wrapped.readCalls);
      write.push(...wrapped.writeCalls);
      return wrapped;
    })();

    await service.getKit(SECOND_USER, KIT_ONE);
    await service.createAsset(SECOND_USER, KIT_ONE, {
      asset_type: "color",
      display_name: "x",
    });
    await service.updateAsset(SECOND_USER, KIT_ONE, ASSET_ONE, { sort_order: 1 });

    for (const [, input] of [...read, ...write]) {
      expect((input as { actorId: string }).actorId).toBe(SECOND_ACTOR_ID);
    }
  });
});
