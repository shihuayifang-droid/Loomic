import { describe, expect, it } from "vitest";

import {
  BrandKitServiceError,
  createBrandKitService,
} from "./brand-kit-service.js";
import {
  BrandKitReadError,
  LIST_OWN_KITS,
  type BrandKitListResult,
  type BrandKitReadRepository,
} from "../../db/brand-kit-read-repository.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

/**
 * The service's `listKits` is now a thin translation of ONE repository call —
 * and this file is what holds that translation to its contract:
 *
 * - the actor handed to the repository is `user.id`, never the access token, and
 *   `createUserClient` is not reached at all on this path;
 * - the mapping and the `asset_counts` statistics survive the move unchanged,
 *   including the zero defaults and the published field order;
 * - a repository failure becomes the SAME `BrandKitServiceError` the discarded
 *   PostgREST error produced, because the route answers anything else with its
 *   own 500 and the message "An unexpected error occurred.";
 * - and the result really comes FROM the repository: a second stub with different
 *   data changes the answer, which a hard-coded mapping could not do.
 *
 * The client factory is a tripwire rather than a fake: it throws the moment it is
 * called, so "listKits no longer creates a user-scoped client" is measured and
 * not merely asserted by absence of an obvious call.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000b1";
const SECOND_ACTOR_ID = "00000000-0000-0000-0000-0000000000b2";
const KIT_ONE = "00000000-0000-0000-0000-0000000000c1";
const KIT_TWO = "00000000-0000-0000-0000-0000000000c2";

const KIT_ONE_CREATED_AT = "2026-01-10T08:00:00.000Z";
const KIT_ONE_UPDATED_AT = "2026-01-11T08:00:00.000Z";
const KIT_TWO_CREATED_AT = "2026-02-10T08:00:00.000Z";
const KIT_TWO_UPDATED_AT = "2026-02-11T08:00:00.000Z";

const KIT_QUERY_FAILED_MESSAGE = "Unable to load brand kits.";

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

/** A's two kits, exactly as the repository answers them: K2 has no assets. */
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

type ClientCalls = { count: number; tokens: string[] };

/**
 * The tripwire. `createUserClient` is still a REQUIRED dependency — the write
 * routes use it — so it is wired to something that fails loudly if `listKits`
 * ever reaches for it again.
 */
function tripwireClientFactory(calls: ClientCalls) {
  const factory = (accessToken: string): UserSupabaseClient => {
    calls.count += 1;
    calls.tokens.push(accessToken);
    throw new Error("createUserClient must not be called on the listKits path");
  };

  return factory as unknown as (accessToken: string) => UserSupabaseClient;
}

function newClientCalls(): ClientCalls {
  return { count: 0, tokens: [] };
}

/** A repository stub that records the actor it was asked for. */
function stubRepository(
  result: BrandKitListResult,
  calls: Array<{ actorId: string }> = [],
): BrandKitReadRepository {
  return {
    async listOwnKits(input) {
      calls.push({ actorId: input.actorId });
      return result;
    },
  };
}

/** A repository stub that fails, so the service's translation can be measured. */
function failingRepository(error: unknown): BrandKitReadRepository {
  return {
    async listOwnKits() {
      throw error;
    },
  };
}

function serviceWith(
  readRepository: BrandKitReadRepository,
  clientCalls: ClientCalls = newClientCalls(),
) {
  return {
    service: createBrandKitService({
      createUserClient: tripwireClientFactory(clientCalls),
      brandKitReadRepository: readRepository,
    }),
    clientCalls,
  };
}

describe("brand-kit-service: listKits reads through the repository", () => {
  it("case 1: the actor handed to the repository is `user.id`, and no user-scoped client is created", async () => {
    const calls: Array<{ actorId: string }> = [];
    const { service, clientCalls } = serviceWith(stubRepository(RESULT_FOR_A, calls));

    await service.listKits(USER);

    expect(calls).toEqual([{ actorId: ACTOR_ID }]);
    // The tripwire was never tripped: the PostgREST path is gone, not merely
    // unused. The access token is not an actor and never reaches the repository.
    expect(clientCalls.count).toBe(0);
    expect(clientCalls.tokens).toEqual([]);
  });

  it("case 2: the caller's own id is what is asked for — a second identity asks for a second actor", async () => {
    const calls: Array<{ actorId: string }> = [];
    const { service } = serviceWith(stubRepository(RESULT_FOR_A, calls));

    await service.listKits(USER);
    await service.listKits(SECOND_USER);

    expect(calls).toEqual([{ actorId: ACTOR_ID }, { actorId: SECOND_ACTOR_ID }]);
  });

  it("case 3: A's two kits map to two summaries with the counts of their assets, K2 all zeros", async () => {
    const { service } = serviceWith(stubRepository(RESULT_FOR_A));

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

    // The published FIELD ORDER is part of the contract and the move must not
    // reshuffle it: the summary keys, and the keys of a zero default.
    expect(Object.keys(summaries[0] ?? {})).toEqual([
      "id",
      "name",
      "is_default",
      "cover_url",
      "asset_counts",
      "created_at",
      "updated_at",
    ]);
    expect(Object.keys(summaries[0]?.asset_counts ?? {})).toEqual([
      "color",
      "font",
      "logo",
      "image",
    ]);
    expect(Object.keys(summaries[1]?.asset_counts ?? {})).toEqual([
      "color",
      "font",
      "logo",
      "image",
    ]);
  });

  it("case 4: every asset type is counted onto its own kit, and an unknown kit's rows are ignored", async () => {
    const { service } = serviceWith(
      stubRepository({
        kits: RESULT_FOR_A.kits,
        assets: [
          { kit_id: KIT_ONE, asset_type: "color" },
          { kit_id: KIT_ONE, asset_type: "font" },
          { kit_id: KIT_ONE, asset_type: "logo" },
          { kit_id: KIT_ONE, asset_type: "image" },
          { kit_id: KIT_TWO, asset_type: "image" },
          { kit_id: KIT_TWO, asset_type: "image" },
          // A kit the caller does not own. The repository's `exists` clause means
          // this cannot happen, and the mapping must not invent a summary for it.
          { kit_id: "00000000-0000-0000-0000-0000000000ff", asset_type: "logo" },
        ],
      }),
    );

    const summaries = await service.listKits(USER);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.asset_counts).toEqual({
      color: 1,
      font: 1,
      logo: 1,
      image: 1,
    });
    expect(summaries[1]?.asset_counts).toEqual({
      color: 0,
      font: 0,
      logo: 0,
      image: 2,
    });
  });

  it("case 5: an empty repository result is an empty list, not an error", async () => {
    const { service, clientCalls } = serviceWith(
      stubRepository({ kits: [], assets: [] }),
    );

    await expect(service.listKits(USER)).resolves.toEqual([]);
    expect(clientCalls.count).toBe(0);
  });

  it("case 6: the result comes FROM the repository — a different stub gives a different answer", async () => {
    const other = {
      kits: [
        {
          id: KIT_TWO,
          name: "Only Kit",
          is_default: true,
          cover_url: null,
          created_at: KIT_TWO_CREATED_AT,
          updated_at: KIT_TWO_UPDATED_AT,
        },
      ],
      assets: [{ kit_id: KIT_TWO, asset_type: "font" as const }],
    };

    const first = await serviceWith(stubRepository(RESULT_FOR_A)).service.listKits(
      USER,
    );
    const second = await serviceWith(stubRepository(other)).service.listKits(USER);

    // A hard-coded mapping — or a mapping that read anything other than the
    // repository's answer — could not follow the stub like this.
    expect(first).toHaveLength(2);
    expect(second).toEqual([
      {
        id: KIT_TWO,
        name: "Only Kit",
        is_default: true,
        cover_url: null,
        asset_counts: { color: 0, font: 1, logo: 0, image: 0 },
        created_at: KIT_TWO_CREATED_AT,
        updated_at: KIT_TWO_UPDATED_AT,
      },
    ]);
    expect(second).not.toEqual(first);
  });

  it("case 7: every call asks the repository again — the answer is not cached", async () => {
    const calls: Array<{ actorId: string }> = [];
    const { service } = serviceWith(stubRepository(RESULT_FOR_A, calls));

    await service.listKits(USER);
    await service.listKits(USER);

    expect(calls).toHaveLength(2);
  });
});

describe("brand-kit-service: a failed read keeps the published error", () => {
  it("case 8: a BrandKitReadError becomes `brand_kit_query_failed` / 500 / the same message", async () => {
    const cause = new Error("connect ECONNREFUSED 10.210.134.37:5432");
    const { service } = serviceWith(
      failingRepository(new BrandKitReadError(LIST_OWN_KITS, cause)),
    );

    const error = await service.listKits(USER).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitServiceError);
    const serviceError = error as BrandKitServiceError;
    expect(serviceError.code).toBe("brand_kit_query_failed");
    expect(serviceError.statusCode).toBe(500);
    expect(serviceError.message).toBe(KIT_QUERY_FAILED_MESSAGE);
    // The driver's and the repository's own text never reaches the wire: the
    // route publishes `error.message`, and that is the fixed sentence above.
    expect(serviceError.message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37|brand kit read failed|postgres:\/\//,
    );
  });

  it("case 9: ANY error from the repository is translated, never left to the route's fallback", async () => {
    const failures: unknown[] = [
      new Error("driver blew up"),
      new TypeError("reading 'kits' of undefined"),
      "not even an error",
      undefined,
    ];

    for (const failure of failures) {
      const { service } = serviceWith(failingRepository(failure));

      const error = await service.listKits(USER).catch((reason: unknown) => reason);

      // Not a `BrandKitServiceError` would mean the route answers 500 with
      // "An unexpected error occurred." instead of the fixed message.
      expect(error).toBeInstanceOf(BrandKitServiceError);
      expect((error as BrandKitServiceError).code).toBe("brand_kit_query_failed");
      expect((error as BrandKitServiceError).statusCode).toBe(500);
      expect((error as BrandKitServiceError).message).toBe(
        KIT_QUERY_FAILED_MESSAGE,
      );
    }
  });
});

describe("brand-kit-service: the rest of the service still uses the user client", () => {
  it("case 10: a write method still reaches for `createUserClient`, so the move did not unhook it", async () => {
    const { service, clientCalls } = serviceWith(stubRepository(RESULT_FOR_A));

    const error = await service
      .deleteKit(USER, KIT_ONE)
      .catch((reason: unknown) => reason);

    // The tripwire fired: the write path opened a user-scoped client exactly as
    // before, with the caller's own token.
    expect(clientCalls.count).toBe(1);
    expect(clientCalls.tokens).toEqual([USER.accessToken]);
    expect((error as Error).message).toBe(
      "createUserClient must not be called on the listKits path",
    );
  });
});
