import { describe, expect, it } from "vitest";

import {
  BrandKitReadError,
  LIST_OWN_KITS,
  createBrandKitReadRepository,
} from "./brand-kit-read-repository.js";
import {
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the two statements
 * the repository issues, the actor and kit ids they carry, which tables and
 * columns they may read, and how they classify every way those statements can
 * answer.
 *
 * The unit tests prove WHICH statements are built — including that each ACL is
 * INSIDE its statement (owner-only `user_id`, and the `exists` clause of the
 * asset policy that the asset statement must keep even though the ids it binds
 * already came from the owner-checked first statement). The PGlite file beside
 * them (`test-support/db/brand-kit-read-repository-db.test.ts`) proves
 * PostgreSQL actually parses and executes them, and that they answer exactly
 * what the two RLS policies answer for the same identity.
 *
 * Statement-sequence assertions deliberately look only at the DOMAIN statements
 * (the ones naming `public.`), never at how many `set_config` calls the
 * transaction helper makes or how it shapes them: that belongs to
 * `db/transaction.ts`, which already changed its context statement once without
 * touching any repository.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000b2";
const KIT_ONE = "00000000-0000-0000-0000-0000000000c1";
const KIT_TWO = "00000000-0000-0000-0000-0000000000c2";
const KIT_THREE = "00000000-0000-0000-0000-0000000000c3";

const CREATED_AT = "2026-03-01T10:20:30.400Z";
const UPDATED_AT = "2026-03-02T11:21:31.500Z";

/** A row shaped the way statement 1 answers one. */
const KIT_ROW = {
  id: KIT_ONE,
  name: "Kit One",
  is_default: true,
  cover_url: "https://example.test/cover.png",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

/** A row shaped the way statement 2 answers one. */
const ASSET_ROW = { kit_id: KIT_ONE, asset_type: "color" };

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

/**
 * The repository's own statements, and only them: BEGIN / COMMIT / ROLLBACK and
 * whatever the transaction helper uses to set its context carry no
 * schema-qualified name, so anything naming `public.` is a domain statement.
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statements(queries: readonly QueryRecord[]): string[] {
  return queries.map((entry) => entry.sql);
}

function repositoryFor(harness: Harness) {
  return createBrandKitReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The one call every case below makes, with the argument named once. */
function list(repository: ReturnType<typeof repositoryFor>, actorId = ACTOR_ID) {
  return repository.listOwnKits({ actorId });
}

/** Answers statement 1 with `kits` and statement 2 with `assets`. */
function answers(kits: unknown[], assets: unknown[] = []) {
  return (sql: string): unknown[] =>
    sql.includes("brand_kit_assets") ? assets : kits;
}

describe("brand-kit-read-repository: the statements it issues", () => {
  it("case 1: reads both lists inside one transaction and one connection", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));

    await list(repositoryFor(harness));

    const issued = statements(harness.queries);
    expect(issued[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(issued.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(domainCalls(harness.queries)).toHaveLength(2);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: statement 1 keys on the actor as a bind parameter, never as text", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));

    await list(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.sql).toContain("from public.brand_kits");
    expect(statement?.sql).toContain("k.user_id = $1::uuid");
    expect(statement?.params).toEqual([ACTOR_ID]);
    expect(statement?.sql).not.toContain(ACTOR_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: statement 1 reads the owner-only projection, in `created_at asc` and nothing else", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));

    await list(repositoryFor(harness));

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";

    // The projection is the six columns the removed PostgREST read selected —
    // no `guidance_text`, no `user_id`, no star.
    const projection = /select([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? "";
    expect(projection.replace(/\s+/g, " ").trim()).toBe(
      "k.id, k.name, k.is_default, k.cover_url, k.created_at, k.updated_at",
    );

    // `brand_kits_user_policy` translated verbatim: the owner predicate, and no
    // other table at all.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.brand_kits"]);
    expect(sql).not.toMatch(/\bjoin\b|\bexists\b/i);

    // Ordered by `created_at asc` alone: a tie-breaker here would change the
    // published order of two kits created in the same transaction, which is a
    // behaviour change this workorder does not own.
    expect(sql).toContain("order by k.created_at asc");
    expect(sql.match(/order by/gi)).toHaveLength(1);
    expect(sql.match(/created_at/g)).toHaveLength(2);

    // A private, owner-only resource: no workspace, project, archive or role
    // predicate may be derived from another ACL and added here.
    expect(sql).not.toMatch(
      /workspace|project|archived|member|owner_user_id|can_read_project/i,
    );
    expect(sql).not.toMatch(/\brole\b/i);
    // A read only. No write verb may appear in the statement at all.
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i);
    // One statement, never a batch.
    expect(sql).not.toContain(";");
  });

  it("case 4: statement 2 binds the actor and the kit ids, and keeps the policy's `exists` clause", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));

    await list(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[1];
    const sql = statement?.sql ?? "";

    expect(sql).toContain("from public.brand_kit_assets");
    expect(sql).toContain("a.kit_id = any($2::uuid[])");
    expect(sql).toContain("exists (");
    expect(sql).toContain("from public.brand_kits k");
    expect(sql).toContain("k.id = a.kit_id");
    expect(sql).toContain("k.user_id = $1::uuid");
    expect(statement?.params).toEqual([ACTOR_ID, [KIT_ONE]]);

    // The `exists` clause is `brand_kit_assets_policy` itself. The ids in `$2`
    // already came from the owner-checked statement above, but a repository whose
    // only authorisation is "the caller passed the right ids" has none of its
    // own: the statement must refuse a kit that is not the actor's.
    expect(sql.match(/public\.[a-z_]+/g)).toEqual([
      "public.brand_kit_assets",
      "public.brand_kits",
    ]);
    expect(sql).not.toMatch(
      /workspace|project|archived|member|owner_user_id|can_read_project/i,
    );
    expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i);
    expect(sql).not.toContain(";");
  });

  it("case 5: every kit id of statement 1 is bound to statement 2, in order", async () => {
    const rows = [
      { ...KIT_ROW, id: KIT_ONE },
      { ...KIT_ROW, id: KIT_TWO, is_default: false },
      { ...KIT_ROW, id: KIT_THREE, is_default: false },
    ];
    const harness = createHarness(answers(rows, []));

    await list(repositoryFor(harness));

    expect(domainCalls(harness.queries)[1]?.params).toEqual([
      ACTOR_ID,
      [KIT_ONE, KIT_TWO, KIT_THREE],
    ]);
  });

  it("case 6: zero kits ends the call after ONE domain statement — the asset read is never sent", async () => {
    const harness = createHarness(answers([]));

    await expect(list(repositoryFor(harness))).resolves.toEqual({
      kits: [],
      assets: [],
    });

    // The read this replaces returned early on an empty kit list, so statement 2
    // is not issued and no `any('{}')` reaches the wire.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(domainCalls(harness.queries)[0]?.sql).toContain(
      "from public.brand_kits",
    );
    // The empty answer is legal and COMMITTED, not a rolled-back transaction.
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });
});

describe("brand-kit-read-repository: the rows it maps", () => {
  it("case 7: `Date` timestamps are published as `toISOString()`", async () => {
    const harness = createHarness(
      answers([
        {
          ...KIT_ROW,
          created_at: new Date("2026-03-01T10:20:30.400+00:00"),
          updated_at: new Date("2026-03-02T11:21:31.500+00:00"),
        },
      ]),
    );

    const result = await list(repositoryFor(harness));

    expect(result.kits[0]?.created_at).toBe(CREATED_AT);
    expect(result.kits[0]?.updated_at).toBe(UPDATED_AT);
  });

  it("case 8: an ISO string with an offset or microseconds is normalised to the same `toISOString()`", async () => {
    // PostgREST published microseconds and `+00:00`; `pg`/PGlite hand back a
    // Date. Both are accepted and both come out in the one millisecond/`Z` shape
    // the published contract allows.
    const harness = createHarness(
      answers([
        {
          ...KIT_ROW,
          created_at: "2026-03-01T10:20:30.400000+00:00",
          updated_at: "2026-03-02T11:21:31.5Z",
        },
      ]),
    );

    const result = await list(repositoryFor(harness));

    expect(result.kits[0]?.created_at).toBe(CREATED_AT);
    expect(result.kits[0]?.updated_at).toBe(UPDATED_AT);
  });

  it("case 9: a null `cover_url` stays null and empty strings stay empty strings", async () => {
    const harness = createHarness(
      answers([{ ...KIT_ROW, name: "", cover_url: null }]),
    );

    const result = await list(repositoryFor(harness));

    expect(result.kits[0]?.name).toBe("");
    expect(result.kits[0]?.cover_url).toBeNull();
    // `is_default` is a boolean, unchanged — never coerced.
    expect(result.kits[0]?.is_default).toBe(true);
  });

  it("case 10: both lists are mapped, and the assets keep the pair of columns they selected", async () => {
    const harness = createHarness(
      answers(
        [KIT_ROW, { ...KIT_ROW, id: KIT_TWO, is_default: false }],
        [
          { kit_id: KIT_ONE, asset_type: "color" },
          { kit_id: KIT_ONE, asset_type: "logo" },
          { kit_id: KIT_TWO, asset_type: "font" },
        ],
      ),
    );

    const result = await list(repositoryFor(harness));

    expect(result.kits.map((kit) => kit.id)).toEqual([KIT_ONE, KIT_TWO]);
    expect(result.assets).toEqual([
      { kit_id: KIT_ONE, asset_type: "color" },
      { kit_id: KIT_ONE, asset_type: "logo" },
      { kit_id: KIT_TWO, asset_type: "font" },
    ]);
  });

  it("case 11: all four asset types are accepted", async () => {
    const harness = createHarness(
      answers(
        [KIT_ROW],
        [
          { kit_id: KIT_ONE, asset_type: "color" },
          { kit_id: KIT_ONE, asset_type: "font" },
          { kit_id: KIT_ONE, asset_type: "logo" },
          { kit_id: KIT_ONE, asset_type: "image" },
        ],
      ),
    );

    const result = await list(repositoryFor(harness));

    expect(result.assets.map((asset) => asset.asset_type)).toEqual([
      "color",
      "font",
      "logo",
      "image",
    ]);
  });
});

describe("brand-kit-read-repository: row-shape drift is a fixed failure", () => {
  /** One kit row with `patch` applied, so each case changes exactly one thing. */
  function kitRowWith(patch: Record<string, unknown>): unknown[] {
    return [{ ...KIT_ROW, ...patch }];
  }

  it("case 12: a row that is not an object fails", async () => {
    for (const answer of [null, "not a row", [KIT_ROW], 42]) {
      const harness = createHarness(answers([answer]));

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).operation).toBe(LIST_OWN_KITS);
      expect(statements(harness.queries).at(-1)).toBe(
        TRANSACTION_STATEMENTS.rollback,
      );
    }
  });

  it("case 13: a row with no usable `id` fails", async () => {
    for (const answer of [
      kitRowWith({ id: undefined }),
      kitRowWith({ id: "" }),
      kitRowWith({ id: 7 }),
    ]) {
      const harness = createHarness(answers([answer]));

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
    }
  });

  it("case 14: an `is_default` that is not a boolean fails", async () => {
    for (const value of ["true", 1, null, undefined]) {
      const harness = createHarness(answers(kitRowWith({ is_default: value })));

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
    }
  });

  it("case 15: a `cover_url` that is neither a string nor null fails", async () => {
    for (const value of [7, true, {}, undefined]) {
      const harness = createHarness(answers(kitRowWith({ cover_url: value })));

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
    }
  });

  it("case 16: a timestamp that cannot be parsed fails", async () => {
    for (const patch of [
      { created_at: "not-a-timestamp" },
      { updated_at: "2026-13-45T99:99:99Z" },
      { created_at: new Date(Number.NaN) },
      { updated_at: null },
      { created_at: 1_770_000_000 },
      { updated_at: undefined },
    ]) {
      const harness = createHarness(answers(kitRowWith(patch)));

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).message).toBe(
        `brand kit read failed (${LIST_OWN_KITS})`,
      );
    }
  });

  it("case 17: an `asset_type` outside the four enum values fails", async () => {
    for (const value of ["video", "", "Color", null, 3, undefined]) {
      const harness = createHarness(
        answers([KIT_ROW], [{ kit_id: KIT_ONE, asset_type: value }]),
      );

      const error = await list(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(BrandKitReadError);
    }
  });

  it("case 18: an asset row with no usable `kit_id` fails", async () => {
    const harness = createHarness(
      answers([KIT_ROW], [{ asset_type: "color" }]),
    );

    const error = await list(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BrandKitReadError);
  });

  it("case 19: every drift rolls back on the SECOND statement too", async () => {
    const harness = createHarness(
      answers([KIT_ROW], [{ kit_id: KIT_ONE, asset_type: "video" }]),
    );

    await list(repositoryFor(harness)).catch((reason: unknown) => reason);

    expect(domainCalls(harness.queries)).toHaveLength(2);
    expect(statements(harness.queries).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
  });
});

describe("brand-kit-read-repository: unusable answers and failures", () => {
  it("case 20: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "select k.id from public.brand_kits k where k.user_id = $1::uuid failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]), {
      sqlError: failure,
    });

    const error = await list(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BrandKitReadError);
    const readError = error as BrandKitReadError;
    expect(readError.message).toBe(
      `brand kit read failed (${LIST_OWN_KITS})`,
    );
    expect(readError.cause).toBe(failure);
    expect(statements(harness.queries).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
    expect(readError.message).not.toMatch(
      /public\.|brand_kits|brand_kit_assets|select|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
  });

  it("case 21: a connect failure is a fixed read failure and issues no statement", async () => {
    const harness = createHarness(answers([KIT_ROW]), {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await list(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).message).toBe(
      `brand kit read failed (${LIST_OWN_KITS})`,
    );
    expect((error as BrandKitReadError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37|postgres:\/\//,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 22: an unusable actor is refused before any connection is opened", async () => {
    for (const actorId of ["", undefined, null, 7, {}]) {
      const harness = createHarness(answers([KIT_ROW]));

      const error = await repositoryFor(harness)
        .listOwnKits({ actorId } as { actorId: string })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).operation).toBe(LIST_OWN_KITS);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 23: another actor's id is only ever a BIND — the reached-for identity is the argument", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));

    await list(repositoryFor(harness), OTHER_ACTOR_ID);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([OTHER_ACTOR_ID]);
    expect(domainCalls(harness.queries)[1]?.params?.[0]).toBe(OTHER_ACTOR_ID);
    expect(domainCalls(harness.queries)[0]?.sql).not.toContain(OTHER_ACTOR_ID);
    expect(domainCalls(harness.queries)[1]?.sql).not.toContain(OTHER_ACTOR_ID);
  });

  it("case 24: the repository exposes listOwnKits and nothing else", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));
    const repository = repositoryFor(harness);

    // A shape rather than a promise: no second method, no access token, no table
    // name and no column list a caller could widen the read with.
    expect(Object.keys(repository)).toEqual([LIST_OWN_KITS]);
    expect(repository.listOwnKits).toHaveLength(1);

    await list(repository);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([ACTOR_ID]);
  });
});

describe("brand-kit-read-repository: the pool is lazy", () => {
  it("case 25: building never resolves a pool; a missing DATABASE_URL fails on the read", async () => {
    let resolutions = 0;
    const repository = createBrandKitReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await list(repository).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
