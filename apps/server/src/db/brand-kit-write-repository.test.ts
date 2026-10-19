import { describe, expect, it } from "vitest";

import {
  BrandKitWriteError,
  CLEAR_OWN_DEFAULT,
  DELETE_OWN_ASSET,
  DELETE_OWN_KIT,
  INSERT_OWN_ASSET,
  INSERT_OWN_ASSET_COPIES,
  INSERT_OWN_KIT,
  UPDATE_OWN_ASSET,
  UPDATE_OWN_KIT,
  createBrandKitWriteRepository,
  type BrandKitAssetCopy,
  type BrandKitAssetInsert,
} from "./brand-kit-write-repository.js";
import {
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real write repository against a recording fake pool.
 *
 * What they are FOR, and what they deliberately do NOT assert:
 *
 * - every method issues EXACTLY ONE domain statement, whose ACL is INSIDE the
 *   statement (`user_id = $1::uuid` for `brand_kits`, the owning-kit `exists`
 *   clause for `brand_kit_assets`), because a privileged connection bypasses RLS
 *   and the statement's own predicate is the only gate there is;
 * - the parameters are in the documented order, with the uuid / enum / jsonb casts
 *   on the binds and never in the SQL text;
 * - the two UPDATE statements are FIXED SQL: three different patches produce
 *   byte-identical statements and only different parameters, so no column list and
 *   no SET clause is ever assembled at run time;
 * - a refusal (a kit or asset that is not the actor's) comes back as `null` or
 *   `{updated: 0}` and NOT as a throw, because that is the shape the service maps
 *   onto the 404 it published before the migration;
 * - `insertOwnAssetCopies` with an empty array issues ZERO statements and does not
 *   even connect.
 *
 * Statement-sequence assertions look only at the DOMAIN statements (the ones naming
 * `public.`), never at how many `set_config` calls the transaction helper makes or
 * how it shapes them — that belongs to `db/transaction.ts`.
 *
 * The PGlite file beside this one
 * (`test-support/db/brand-kit-write-repository-db.test.ts`) proves PostgreSQL
 * parses and executes these statements and that they refuse exactly what the two
 * RLS policies refuse, for the same identity.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000b2";
const KIT_ONE = "00000000-0000-0000-0000-0000000000c1";
const KIT_TWO = "00000000-0000-0000-0000-0000000000c2";
const ASSET_ONE = "00000000-0000-0000-0000-0000000000d1";
const ASSET_TWO = "00000000-0000-0000-0000-0000000000d2";

const CREATED_AT = "2026-03-01T10:20:30.400Z";
const UPDATED_AT = "2026-03-02T11:21:31.500Z";

const ASSET_ROW = {
  id: ASSET_ONE,
  asset_type: "color",
  display_name: "Brand red",
  role: null as string | null,
  sort_order: 2,
  text_content: "#ff0000" as string | null,
  file_url: null as string | null,
  metadata: { hex: "#ff0000" } as Record<string, unknown> | null,
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

const ASSET_INSERT: BrandKitAssetInsert = {
  asset_type: "color",
  display_name: "Brand red",
  text_content: "#ff0000",
  role: null,
  sort_order: 2,
  metadata: { hex: "#ff0000" },
  file_url: null,
};

const ASSET_COPY: BrandKitAssetCopy = {
  asset_type: "logo",
  display_name: "Primary logo",
  text_content: null,
  role: "primary",
  sort_order: 0,
  metadata: { source: "duplicate" },
  file_url: "actor/kit/logo.png",
};

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (
    sql: string,
    params?: readonly unknown[],
  ) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error; sqlError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback ||
        sql === TRANSACTION_STATEMENTS.setLocalSetting
      ) {
        return { rows: [] };
      }

      if (options.sqlError) throw options.sqlError;

      return { rows: await respond(sql, params) };
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        connectAttempts += 1;
        if (options.connectError) throw options.connectError;
        return connection;
      },
    },
    queries,
    connectAttempts: () => connectAttempts,
  };
}

function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql);
}

function repositoryFor(harness: Harness) {
  return createBrandKitWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The owning-kit predicate every `brand_kit_assets` statement must carry. */
const OWNING_KIT_EXISTS =
  "exists (select 1 from public.brand_kits k\n                where k.id = a.kit_id and k.user_id = $1::uuid)";

/**
 * The same policy expression for the two statements that INSERT into
 * `brand_kit_assets`: there is no row yet, so the gate is the TARGET kit the caller
 * passed, and the insert is simply skipped when that kit is not the actor's.
 */
const OWNING_KIT_EXISTS_TARGET =
  "exists (select 1 from public.brand_kits k\n                where k.id = $2::uuid and k.user_id = $1::uuid)";

function expectOwnerPredicate(sql: string): void {
  expect(sql).toContain("$1::uuid");
  expect(sql).not.toMatch(/workspace|project|archived|member|owner_user_id/i);
  expect(sql).not.toContain(";");
}

describe("brand-kit-write-repository: insertOwnKit", () => {
  it("case 1: ONE insert, owner written into the row, all three values bound in order", async () => {
    const harness = createHarness(() => [{ id: KIT_ONE }]);

    await expect(
      repositoryFor(harness).insertOwnKit({
        actorId: ACTOR_ID,
        name: "Kit One",
        guidanceText: null,
      }),
    ).resolves.toEqual({ id: KIT_ONE });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("insert into public.brand_kits (user_id, name, guidance_text)");
    expect(calls[0]?.sql).toContain("values ($1::uuid, $2::text, $3::text)");
    expect(calls[0]?.sql).toContain("returning id");
    expect(calls[0]?.params).toEqual([ACTOR_ID, "Kit One", null]);
    expect(calls[0]?.sql).not.toContain(ACTOR_ID);
    expect(calls[0]?.sql).not.toContain("Kit One");
    expectOwnerPredicate(calls[0]?.sql ?? "");
    // `is_default` / `created_at` / `updated_at` keep their column defaults.
    expect(calls[0]?.sql).not.toMatch(/is_default|created_at|updated_at/);
  });

  it("case 2: an insert that does not answer exactly one row is a failure", async () => {
    for (const answer of [[], [{ id: KIT_ONE }, { id: KIT_TWO }], [{}]]) {
      const harness = createHarness(() => answer);

      const error = await repositoryFor(harness)
        .insertOwnKit({ actorId: ACTOR_ID, name: "Kit One", guidanceText: null })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitWriteError);
      expect((error as BrandKitWriteError).operation).toBe(INSERT_OWN_KIT);
    }
  });
});

describe("brand-kit-write-repository: clearOwnDefault", () => {
  it("case 3: ONE update scoped to the actor's own default flag", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).clearOwnDefault({ actorId: ACTOR_ID }),
    ).resolves.toBeUndefined();

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("update public.brand_kits k");
    expect(calls[0]?.sql).toContain("set is_default = false");
    expect(calls[0]?.sql).toContain("k.user_id = $1::uuid");
    expect(calls[0]?.sql).toContain("k.is_default = true");
    expect(calls[0]?.params).toEqual([ACTOR_ID]);
    expectOwnerPredicate(calls[0]?.sql ?? "");
  });

  it("case 4: zero rows is the normal answer and still commits", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).clearOwnDefault({ actorId: ACTOR_ID });

    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("brand-kit-write-repository: updateOwnKit", () => {
  async function updateWith(patch: Parameters<
    ReturnType<typeof repositoryFor>["updateOwnKit"]
  >[0]["patch"]) {
    const harness = createHarness(() => [{ id: KIT_ONE }]);
    const result = await repositoryFor(harness).updateOwnKit({
      actorId: ACTOR_ID,
      kitId: KIT_ONE,
      patch,
    });

    return { harness, result, call: domainCalls(harness.queries)[0] };
  }

  it("case 5: three different patches produce the SAME BYTES of SQL — only the params differ", async () => {
    const nameOnly = await updateWith({ name: "Renamed" });
    const defaultOnly = await updateWith({ is_default: true });
    const everything = await updateWith({
      name: "Renamed",
      guidance_text: "Use the warm palette.",
      is_default: false,
    });

    expect(nameOnly.call?.sql).toBe(defaultOnly.call?.sql);
    expect(nameOnly.call?.sql).toBe(everything.call?.sql);

    // No dynamic SET list: the three columns appear in the same order every time.
    expect(nameOnly.call?.sql).toContain(
      "set name = case when $3::boolean then $4::text else k.name end",
    );
    expect(nameOnly.call?.sql).toContain(
      "guidance_text = case when $5::boolean then $6::text else k.guidance_text end",
    );
    expect(nameOnly.call?.sql).toContain(
      "is_default = case when $7::boolean then $8::boolean else k.is_default end",
    );
    expect(nameOnly.call?.sql).toContain("k.id = $2::uuid");
    expect(nameOnly.call?.sql).toContain("k.user_id = $1::uuid");
    expectOwnerPredicate(nameOnly.call?.sql ?? "");

    // The parameters are what carries the difference.
    expect(nameOnly.call?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      true,
      "Renamed",
      false,
      null,
      false,
      null,
    ]);
    expect(defaultOnly.call?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      false,
      null,
      false,
      null,
      true,
      true,
    ]);
    expect(everything.call?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      true,
      "Renamed",
      true,
      "Use the warm palette.",
      true,
      false,
    ]);
  });

  it("case 6: a null `guidance_text` is a VALUE (flag true, param null); an absent one is not", async () => {
    const cleared = await updateWith({ guidance_text: null });
    const untouched = await updateWith({ name: "Renamed" });

    expect(cleared.call?.sql).toBe(untouched.call?.sql);
    expect(cleared.call?.params?.[4]).toBe(true);
    expect(cleared.call?.params?.[5]).toBeNull();
    expect(untouched.call?.params?.[4]).toBe(false);
    expect(untouched.call?.params?.[5]).toBeNull();
  });

  it("case 7: the touched-row count comes from the statement, and 0 is not an error", async () => {
    const answers: Array<[unknown[], number]> = [
      [[{ id: KIT_ONE }], 1],
      [[], 0],
    ];

    for (const [answer, expected] of answers) {
      const harness = createHarness(() => answer);

      await expect(
        repositoryFor(harness).updateOwnKit({
          actorId: ACTOR_ID,
          kitId: KIT_ONE,
          patch: { name: "Renamed" },
        }),
      ).resolves.toEqual({ updated: expected });

      expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    }
  });
});

describe("brand-kit-write-repository: deleteOwnKit", () => {
  it("case 8: ONE delete scoped by id AND owner; deleting nothing commits", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).deleteOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toBeUndefined();

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("delete from public.brand_kits k");
    expect(calls[0]?.sql).toContain("k.id = $2::uuid");
    expect(calls[0]?.sql).toContain("k.user_id = $1::uuid");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE]);
    expectOwnerPredicate(calls[0]?.sql ?? "");
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  });
});

describe("brand-kit-write-repository: insertOwnAsset", () => {
  it("case 9: insert-select gated by the owning kit, enum + jsonb casts on the binds", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    await expect(
      repositoryFor(harness).insertOwnAsset({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        asset: ASSET_INSERT,
      }),
    ).resolves.toEqual(ASSET_ROW);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("insert into public.brand_kit_assets");
    expect(sql).toContain("select $2::uuid,");
    expect(sql).toContain("$3::public.brand_kit_asset_type");
    expect(sql).toContain("$7::integer");
    expect(sql).toContain("$8::jsonb");
    expect(sql).toContain(OWNING_KIT_EXISTS_TARGET);
    expectOwnerPredicate(sql);

    expect(calls[0]?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      "color",
      "Brand red",
      "#ff0000",
      null,
      2,
      JSON.stringify({ hex: "#ff0000" }),
      null,
    ]);
    // JSONB is bound as a JSON string, never as SQL text.
    expect(sql).not.toContain("#ff0000");
  });

  it("case 10: ZERO inserted rows is the refusal shape — `null`, not a throw, and COMMITTED", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).insertOwnAsset({
        actorId: OTHER_ACTOR_ID,
        kitId: KIT_ONE,
        asset: ASSET_INSERT,
      }),
    ).resolves.toBeNull();

    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 11: the returned row is mapped strictly (Date timestamps, null metadata kept)", async () => {
    const harness = createHarness(() => [
      {
        ...ASSET_ROW,
        created_at: new Date("2026-03-01T10:20:30.400+00:00"),
        metadata: null,
      },
    ]);

    await expect(
      repositoryFor(harness).insertOwnAsset({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        asset: ASSET_INSERT,
      }),
    ).resolves.toEqual({ ...ASSET_ROW, metadata: null, created_at: CREATED_AT });
  });

  it("case 12: every row-shape drift is a fixed failure (enum, integer, metadata, timestamps)", async () => {
    const drifts: unknown[] = [
      { ...ASSET_ROW, asset_type: "video" },
      { ...ASSET_ROW, sort_order: 1.5 },
      { ...ASSET_ROW, metadata: [1, 2] },
      { ...ASSET_ROW, created_at: "nope" },
      { ...ASSET_ROW, updated_at: null },
      { ...ASSET_ROW, id: "" },
      { ...ASSET_ROW, display_name: 4 },
      { ...ASSET_ROW, role: 4 },
    ];

    for (const drift of drifts) {
      const harness = createHarness(() => [drift]);

      const error = await repositoryFor(harness)
        .insertOwnAsset({
          actorId: ACTOR_ID,
          kitId: KIT_ONE,
          asset: ASSET_INSERT,
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitWriteError);
      expect((error as BrandKitWriteError).operation).toBe(INSERT_OWN_ASSET);
      expect(statements(harness.queries).at(-1)).toBe(
        TRANSACTION_STATEMENTS.rollback,
      );
    }
  });
});

describe("brand-kit-write-repository: updateOwnAsset", () => {
  async function updateWith(patch: Parameters<
    ReturnType<typeof repositoryFor>["updateOwnAsset"]
  >[0]["patch"]) {
    const harness = createHarness(() => [ASSET_ROW]);
    const result = await repositoryFor(harness).updateOwnAsset({
      actorId: ACTOR_ID,
      kitId: KIT_ONE,
      assetId: ASSET_ONE,
      patch,
    });

    return { harness, result, call: domainCalls(harness.queries)[0] };
  }

  it("case 13: three different patches produce the SAME BYTES of SQL — only the params differ", async () => {
    const nameOnly = await updateWith({ display_name: "Renamed" });
    const orderOnly = await updateWith({ sort_order: 9 });
    const everything = await updateWith({
      display_name: "Renamed",
      text_content: null,
      role: "primary",
      sort_order: 9,
      metadata: { hex: "#00ff00" },
    });

    expect(nameOnly.call?.sql).toBe(orderOnly.call?.sql);
    expect(nameOnly.call?.sql).toBe(everything.call?.sql);
    expect(nameOnly.call?.sql).toContain("update public.brand_kit_assets a");
    expect(nameOnly.call?.sql).toContain(
      "set display_name = case when $4::boolean then $5::text else a.display_name end",
    );
    expect(nameOnly.call?.sql).toContain(
      "metadata = case when $12::boolean then $13::jsonb else a.metadata end",
    );
    expect(nameOnly.call?.sql).toContain("a.id = $3::uuid");
    expect(nameOnly.call?.sql).toContain("a.kit_id = $2::uuid");
    expect(nameOnly.call?.sql).toContain(OWNING_KIT_EXISTS);
    expectOwnerPredicate(nameOnly.call?.sql ?? "");

    expect(nameOnly.call?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      ASSET_ONE,
      true,
      "Renamed",
      false,
      null,
      false,
      null,
      false,
      null,
      false,
      null,
    ]);
    expect(orderOnly.call?.params).toEqual([
      ACTOR_ID,
      KIT_ONE,
      ASSET_ONE,
      false,
      null,
      false,
      null,
      false,
      null,
      true,
      9,
      false,
      null,
    ]);
    expect(everything.call?.params?.[5]).toBe(true);
    expect(everything.call?.params?.[6]).toBeNull();
    expect(everything.call?.params?.[11]).toBe(true);
    expect(everything.call?.params?.[12]).toBe(JSON.stringify({ hex: "#00ff00" }));
  });

  it("case 14: `text_content: null` and `role: null` are VALUES — their flags differ from an absent key", async () => {
    const cleared = await updateWith({ text_content: null, role: null });
    const untouched = await updateWith({ sort_order: 1 });

    expect(cleared.call?.sql).toBe(untouched.call?.sql);
    expect(cleared.call?.params?.[5]).toBe(true);
    expect(cleared.call?.params?.[6]).toBeNull();
    expect(cleared.call?.params?.[7]).toBe(true);
    expect(cleared.call?.params?.[8]).toBeNull();
    expect(untouched.call?.params?.[5]).toBe(false);
    expect(untouched.call?.params?.[7]).toBe(false);
  });

  it("case 15: zero updated rows is `null`, and the transaction commits", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).updateOwnAsset({
        actorId: OTHER_ACTOR_ID,
        kitId: KIT_ONE,
        assetId: ASSET_ONE,
        patch: { sort_order: 1 },
      }),
    ).resolves.toBeNull();

    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("case 16: a row-shape drift on the returned row is a fixed failure", async () => {
    const harness = createHarness(() => [{ ...ASSET_ROW, asset_type: "pdf" }]);

    const error = await repositoryFor(harness)
      .updateOwnAsset({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        assetId: ASSET_ONE,
        patch: { sort_order: 1 },
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitWriteError);
    expect((error as BrandKitWriteError).operation).toBe(UPDATE_OWN_ASSET);
  });
});

describe("brand-kit-write-repository: deleteOwnAsset", () => {
  it("case 17: ONE delete scoped by asset, kit AND the owning-kit `exists`", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).deleteOwnAsset({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        assetId: ASSET_ONE,
      }),
    ).resolves.toBeUndefined();

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("delete from public.brand_kit_assets a");
    expect(sql).toContain("a.id = $3::uuid");
    expect(sql).toContain("a.kit_id = $2::uuid");
    expect(sql).toContain(OWNING_KIT_EXISTS);
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE, ASSET_ONE]);
    expectOwnerPredicate(sql);
  });
});

describe("brand-kit-write-repository: insertOwnAssetCopies", () => {
  it("case 18: an EMPTY batch opens no connection and issues no statement", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }]);

    await expect(
      repositoryFor(harness).insertOwnAssetCopies({
        actorId: ACTOR_ID,
        kitId: KIT_TWO,
        copies: [],
      }),
    ).resolves.toEqual({ inserted: 0 });

    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });

  it("case 19: ONE statement, jsonb recordset, owning-kit gate, ids bound in order", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }, { id: ASSET_TWO }]);

    await expect(
      repositoryFor(harness).insertOwnAssetCopies({
        actorId: ACTOR_ID,
        kitId: KIT_TWO,
        copies: [ASSET_COPY],
      }),
    ).resolves.toEqual({ inserted: 2 });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("insert into public.brand_kit_assets");
    expect(sql).toContain("from jsonb_to_recordset($3::jsonb) as c(");
    expect(sql).toContain("asset_type public.brand_kit_asset_type");
    expect(sql).toContain("select $2::uuid,");
    expect(sql).toContain(OWNING_KIT_EXISTS_TARGET);
    expect(calls[0]?.params).toHaveLength(3);
    expect(calls[0]?.params?.[0]).toBe(ACTOR_ID);
    expect(calls[0]?.params?.[1]).toBe(KIT_TWO);
    expectOwnerPredicate(sql);

    // The batch is a JSON document bound as a parameter, one element per copy.
    const batch = JSON.parse(String(calls[0]?.params?.[2])) as unknown[];
    expect(batch).toEqual([
      {
        asset_type: "logo",
        display_name: "Primary logo",
        text_content: null,
        role: "primary",
        sort_order: 0,
        metadata: { source: "duplicate" },
        file_url: "actor/kit/logo.png",
      },
    ]);
    expect(sql).not.toContain("Primary logo");
  });

  it("case 20: a refused batch answers 0 rather than throwing", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).insertOwnAssetCopies({
        actorId: OTHER_ACTOR_ID,
        kitId: KIT_ONE,
        copies: [ASSET_COPY],
      }),
    ).resolves.toEqual({ inserted: 0 });
  });
});

describe("brand-kit-write-repository: refusals, failures and shape", () => {
  it("case 21: an unusable argument is refused per method, before any connection", async () => {
    const bad: Array<[string, (repository: ReturnType<typeof repositoryFor>) => Promise<unknown>]> = [
      [INSERT_OWN_KIT, (r) => r.insertOwnKit({ actorId: "", name: "x", guidanceText: null })],
      [INSERT_OWN_KIT, (r) => r.insertOwnKit({ actorId: ACTOR_ID, name: "", guidanceText: null })],
      [INSERT_OWN_KIT, (r) => r.insertOwnKit({ actorId: ACTOR_ID, name: 7 as never, guidanceText: null })],
      [INSERT_OWN_KIT, (r) => r.insertOwnKit({ actorId: ACTOR_ID, name: "x", guidanceText: 7 as never })],
      [CLEAR_OWN_DEFAULT, (r) => r.clearOwnDefault({ actorId: "" })],
      [UPDATE_OWN_KIT, (r) => r.updateOwnKit({ actorId: "", kitId: KIT_ONE, patch: {} })],
      [UPDATE_OWN_KIT, (r) => r.updateOwnKit({ actorId: ACTOR_ID, kitId: "", patch: {} })],
      [UPDATE_OWN_KIT, (r) => r.updateOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE, patch: { is_default: "yes" as never } })],
      [DELETE_OWN_KIT, (r) => r.deleteOwnKit({ actorId: ACTOR_ID, kitId: "" })],
      [
        INSERT_OWN_ASSET,
        (r) => r.insertOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, asset: { ...ASSET_INSERT, asset_type: "video" as never } }),
      ],
      [
        INSERT_OWN_ASSET,
        (r) => r.insertOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, asset: { ...ASSET_INSERT, sort_order: 1.5 } }),
      ],
      [
        INSERT_OWN_ASSET,
        (r) => r.insertOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, asset: null as never }),
      ],
      [
        UPDATE_OWN_ASSET,
        (r) => r.updateOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: "", patch: {} }),
      ],
      [
        UPDATE_OWN_ASSET,
        (r) => r.updateOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_ONE, patch: { metadata: [] as never } }),
      ],
      [
        DELETE_OWN_ASSET,
        (r) => r.deleteOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: "" }),
      ],
      [
        INSERT_OWN_ASSET_COPIES,
        (r) => r.insertOwnAssetCopies({ actorId: ACTOR_ID, kitId: "", copies: [ASSET_COPY] }),
      ],
      [
        INSERT_OWN_ASSET_COPIES,
        (r) => r.insertOwnAssetCopies({ actorId: ACTOR_ID, kitId: KIT_ONE, copies: [{ ...ASSET_COPY, asset_type: "video" as never }] }),
      ],
    ];

    for (const [operation, call] of bad) {
      const harness = createHarness(() => [{ id: KIT_ONE }]);

      const error = await call(repositoryFor(harness)).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitWriteError);
      expect((error as BrandKitWriteError).operation).toBe(operation);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 22: a SQL failure names its own operation and leaks neither statement nor host", async () => {
    const failure = new Error(
      "update public.brand_kit_assets a failed: postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => [], { sqlError: failure });

    const error = await repositoryFor(harness)
      .deleteOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_ONE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitWriteError);
    expect((error as BrandKitWriteError).operation).toBe(DELETE_OWN_ASSET);
    expect((error as BrandKitWriteError).cause).toBe(failure);
    expect((error as BrandKitWriteError).message).toBe(
      `brand kit write failed (${DELETE_OWN_ASSET})`,
    );
    expect((error as BrandKitWriteError).message).not.toMatch(
      /public\.|brand_kit|update|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 23: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await repositoryFor(harness)
      .insertOwnKit({ actorId: ACTOR_ID, name: "Kit One", guidanceText: null })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitWriteError);
    expect((error as BrandKitWriteError).message).toBe(
      `brand kit write failed (${INSERT_OWN_KIT})`,
    );
    expect((error as BrandKitWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37|postgres:\/\//,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 24: every domain statement is one fixed statement with the actor only as a bind", async () => {
    const seen: string[] = [];
    const harness = createHarness((sql) => {
      seen.push(sql);
      if (sql.includes("insert into public.brand_kits")) return [{ id: KIT_ONE }];
      if (sql.includes("update public.brand_kits")) return [{ id: KIT_ONE }];
      if (sql.includes("insert into public.brand_kit_assets")) return [ASSET_ROW];
      if (sql.includes("update public.brand_kit_assets")) return [ASSET_ROW];
      return [];
    });
    const repository = repositoryFor(harness);

    await repository.insertOwnKit({ actorId: OTHER_ACTOR_ID, name: "K", guidanceText: null });
    await repository.clearOwnDefault({ actorId: OTHER_ACTOR_ID });
    await repository.updateOwnKit({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO, patch: { is_default: true } });
    await repository.deleteOwnKit({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO });
    await repository.insertOwnAsset({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO, asset: ASSET_INSERT });
    await repository.updateOwnAsset({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO, assetId: ASSET_ONE, patch: { sort_order: 1 } });
    await repository.deleteOwnAsset({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO, assetId: ASSET_ONE });
    await repository.insertOwnAssetCopies({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO, copies: [ASSET_COPY] });

    expect(seen).toHaveLength(8);
    for (const sql of seen) {
      expect(sql).not.toContain(OTHER_ACTOR_ID);
      expect(sql).not.toMatch(/\$\{/);
      expect(sql).not.toContain(";");
      expect(sql).not.toMatch(/workspace|project|archived|member|owner_user_id/i);
      expectOwnerPredicate(sql);
    }
  });

  it("case 25: the repository exposes exactly the eight named writes and nothing else", async () => {
    const harness = createHarness(() => [{ id: KIT_ONE }]);
    const repository = repositoryFor(harness);

    expect(Object.keys(repository)).toEqual([
      INSERT_OWN_KIT,
      CLEAR_OWN_DEFAULT,
      UPDATE_OWN_KIT,
      DELETE_OWN_KIT,
      INSERT_OWN_ASSET,
      UPDATE_OWN_ASSET,
      DELETE_OWN_ASSET,
      INSERT_OWN_ASSET_COPIES,
    ]);
    // One argument each: no access token, no table name, no column list.
    for (const operation of Object.keys(repository) as Array<keyof typeof repository>) {
      expect(repository[operation]).toHaveLength(1);
    }
  });

  it("case 26: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createBrandKitWriteRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await repository
      .clearOwnDefault({ actorId: ACTOR_ID })
      .catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(BrandKitWriteError);
    expect((error as BrandKitWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
