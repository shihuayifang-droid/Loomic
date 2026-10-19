import { describe, expect, it } from "vitest";

import {
  BrandKitReadError,
  FIND_OWN_ASSET,
  FIND_OWN_KIT,
  LIST_OWN_KIT_ASSETS,
  LIST_OWN_KIT_FILE_URLS,
  LIST_OWN_KITS,
  READ_NEXT_SORT_ORDER,
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

  it("case 24: the repository exposes exactly the six named reads and nothing else", async () => {
    const harness = createHarness(answers([KIT_ROW], [ASSET_ROW]));
    const repository = repositoryFor(harness);

    // A shape rather than a promise: no access token, no table name and no column
    // list a caller could widen a read with. Workorder 21Z adds the five reads the
    // detail path needed and closes the set there.
    expect(Object.keys(repository)).toEqual([
      LIST_OWN_KITS,
      FIND_OWN_KIT,
      LIST_OWN_KIT_ASSETS,
      LIST_OWN_KIT_FILE_URLS,
      READ_NEXT_SORT_ORDER,
      FIND_OWN_ASSET,
    ]);
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

// ---------------------------------------------------------------------------
// Workorder 21Z: the five reads the brand kit detail path used to issue itself.
// Same harness, same rule — only the DOMAIN statements are inspected.
// ---------------------------------------------------------------------------

const ASSET_ONE = "00000000-0000-0000-0000-0000000000d1";

/** A row shaped the way `findOwnKit` (`DETAIL_KIT_COLS`) answers one. */
const KIT_DETAIL_ROW = {
  id: KIT_ONE,
  name: "Kit One",
  is_default: true,
  guidance_text: "Use the warm palette.",
  cover_url: "https://example.test/cover.png",
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
};

/** A row shaped the way every ten-column asset read answers one. */
const ASSET_DETAIL_ROW = {
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

function detailRepository(respond: (sql: string) => unknown[]) {
  const harness = createHarness(respond);
  return { repository: repositoryFor(harness), harness };
}

describe("brand-kit-read-repository: findOwnKit", () => {
  it("case 26: ONE statement, owner predicate inside it, actor and kit bound in order", async () => {
    const { repository, harness } = detailRepository(() => [KIT_DETAIL_ROW]);

    await repository.findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("from public.brand_kits k");
    // `brand_kits_user_policy` verbatim: the owner predicate is the ACL, and it is
    // a bind parameter, never interpolated text.
    expect(calls[0]?.sql).toContain("k.user_id = $1::uuid");
    expect(calls[0]?.sql).toContain("k.id = $2::uuid");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE]);
    expect(calls[0]?.sql).not.toContain(ACTOR_ID);
    expect(calls[0]?.sql).not.toContain(KIT_ONE);
    // One kit row, so no aggregate, no join and no second table.
    expect(calls[0]?.sql.match(/public\.[a-z_]+/g)).toEqual(["public.brand_kits"]);
    expect(calls[0]?.sql).not.toMatch(/\bjoin\b|\bexists\b/i);
  });

  it("case 27: the detail projection carries `guidance_text` and nothing else new", async () => {
    const { repository, harness } = detailRepository(() => [KIT_DETAIL_ROW]);

    await repository.findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    const projection = /select([\s\S]*?)\bfrom\b/i.exec(sql)?.[1] ?? "";

    expect(projection.replace(/\s+/g, " ").trim()).toBe(
      "k.id, k.name, k.is_default, k.guidance_text, k.cover_url, k.created_at, k.updated_at",
    );
  });

  it("case 28: a row maps to the detail shape, timestamps normalised, nullable `guidance_text` kept", async () => {
    const { repository } = detailRepository(() => [
      {
        ...KIT_DETAIL_ROW,
        guidance_text: null,
        created_at: new Date("2026-03-01T10:20:30.400+00:00"),
      },
    ]);

    await expect(
      repository.findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toEqual({ ...KIT_DETAIL_ROW, guidance_text: null, created_at: CREATED_AT });
  });

  it("case 29: zero rows is `null` and is COMMITTED, not rolled back", async () => {
    const { repository, harness } = detailRepository(() => []);

    await expect(
      repository.findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toBeNull();

    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(statements(harness.queries)).not.toContain(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 30: two rows for one id is a statement/mapper disagreement, not a pick", async () => {
    const { repository } = detailRepository(() => [KIT_DETAIL_ROW, KIT_DETAIL_ROW]);

    const error = await repository
      .findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).operation).toBe(FIND_OWN_KIT);
  });

  it("case 31: a non-text `guidance_text` is row-shape drift and rolls back", async () => {
    const { repository, harness } = detailRepository(() => [
      { ...KIT_DETAIL_ROW, guidance_text: 7 },
    ]);

    const error = await repository
      .findOwnKit({ actorId: ACTOR_ID, kitId: KIT_ONE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).operation).toBe(FIND_OWN_KIT);
    expect((error as BrandKitReadError).message).toBe(
      `brand kit read failed (${FIND_OWN_KIT})`,
    );
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("brand-kit-read-repository: listOwnKitAssets", () => {
  it("case 32: ONE statement with the owning-kit `exists`, both ids bound in order", async () => {
    const { repository, harness } = detailRepository(() => [ASSET_DETAIL_ROW]);

    await repository.listOwnKitAssets({ actorId: ACTOR_ID, kitId: KIT_ONE });

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("from public.brand_kit_assets a");
    // `brand_kit_assets_policy`, translated literally.
    expect(sql).toContain("exists (select 1 from public.brand_kits k");
    expect(sql).toContain("k.id = a.kit_id");
    expect(sql).toContain("k.user_id = $1::uuid");
    expect(sql).toContain("a.kit_id = $2::uuid");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE]);
    expect(sql).not.toContain(ACTOR_ID);
    // The published order: `sort_order asc` then `created_at asc`.
    expect(sql).toContain("order by a.sort_order asc, a.created_at asc");
    expect(sql.match(/order by/gi)).toHaveLength(1);
    // No derived ACL.
    expect(sql).not.toMatch(/workspace|project|archived|member|owner_user_id/i);
  });

  it("case 33: the ten columns map, `metadata` comes back as it arrived and ISO strings are normalised", async () => {
    const { repository } = detailRepository(() => [
      ASSET_DETAIL_ROW,
      {
        ...ASSET_DETAIL_ROW,
        id: "00000000-0000-0000-0000-0000000000d2",
        asset_type: "logo",
        metadata: null,
        role: "primary",
        text_content: null,
        file_url: "a/b/logo.png",
        sort_order: 3,
      },
    ]);

    await expect(
      repository.listOwnKitAssets({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toEqual([
      ASSET_DETAIL_ROW,
      {
        id: "00000000-0000-0000-0000-0000000000d2",
        asset_type: "logo",
        display_name: "Brand red",
        role: "primary",
        sort_order: 3,
        text_content: null,
        file_url: "a/b/logo.png",
        metadata: null,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
      },
    ]);
  });

  it("case 34: no assets is an empty list, and the transaction still commits", async () => {
    const { repository, harness } = detailRepository(() => []);

    await expect(
      repository.listOwnKitAssets({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toEqual([]);

    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  });

  it("case 35: every row-shape rule is enforced (asset_type, sort_order, metadata, timestamps)", async () => {
    const drifts: Array<Record<string, unknown>> = [
      { ...ASSET_DETAIL_ROW, asset_type: "video" },
      { ...ASSET_DETAIL_ROW, sort_order: 1.5 },
      { ...ASSET_DETAIL_ROW, metadata: [1, 2, 3] },
      { ...ASSET_DETAIL_ROW, created_at: "not-a-timestamp" },
      { ...ASSET_DETAIL_ROW, updated_at: null },
      { ...ASSET_DETAIL_ROW, display_name: 3 },
      { ...ASSET_DETAIL_ROW, role: 3 },
    ];

    for (const drift of drifts) {
      const { repository } = detailRepository(() => [drift]);

      const error = await repository
        .listOwnKitAssets({ actorId: ACTOR_ID, kitId: KIT_ONE })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).operation).toBe(LIST_OWN_KIT_ASSETS);
    }
  });
});

describe("brand-kit-read-repository: listOwnKitFileUrls", () => {
  it("case 36: ONE statement, `file_url is not null`, owning-kit `exists`, ids bound in order", async () => {
    const { repository, harness } = detailRepository(() => [
      { file_url: "a/b/one.png" },
      { file_url: "a/b/two.png" },
    ]);

    await expect(
      repository.listOwnKitFileUrls({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toEqual(["a/b/one.png", "a/b/two.png"]);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("from public.brand_kit_assets a");
    expect(sql).toContain("a.file_url is not null");
    expect(sql).toContain("a.kit_id = $2::uuid");
    expect(sql).toContain("exists (select 1 from public.brand_kits k");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE]);
    // The removed read had no ordering either.
    expect(sql).not.toMatch(/order by/i);
  });

  it("case 37: a kit with no file path answers an empty list", async () => {
    const { repository } = detailRepository(() => []);

    await expect(
      repository.listOwnKitFileUrls({ actorId: ACTOR_ID, kitId: KIT_ONE }),
    ).resolves.toEqual([]);
  });
});

describe("brand-kit-read-repository: readNextSortOrder", () => {
  it("case 38: ONE aggregate statement, enum cast on the asset type, ids bound in order", async () => {
    const { repository, harness } = detailRepository(() => [
      { next_sort_order: 4 },
    ]);

    await expect(
      repository.readNextSortOrder({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        assetType: "logo",
      }),
    ).resolves.toBe(4);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    // `coalesce(max(...), -1) + 1` is the removed "order desc, limit 1" read.
    expect(sql).toContain("coalesce(max(a.sort_order), -1) + 1");
    expect(sql).toContain("a.kit_id = $2::uuid");
    expect(sql).toContain("a.asset_type = $3::public.brand_kit_asset_type");
    expect(sql).toContain("exists (select 1 from public.brand_kits k");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE, "logo"]);
    expect(sql).not.toContain(ACTOR_ID);
    expect(sql).not.toContain("logo");
  });

  it("case 39: zero (the empty-set and not-my-kit answer) is a value, not a failure", async () => {
    const { repository } = detailRepository(() => [{ next_sort_order: 0 }]);

    await expect(
      repository.readNextSortOrder({
        actorId: ACTOR_ID,
        kitId: KIT_ONE,
        assetType: "color",
      }),
    ).resolves.toBe(0);
  });

  it("case 40: a non-integer or missing answer is a failure, never a coerced order", async () => {
    for (const answer of [[{ next_sort_order: 1.5 }], [{ next_sort_order: "3" }], [], [{}, {}]]) {
      const { repository } = detailRepository(() => answer);

      const error = await repository
        .readNextSortOrder({
          actorId: ACTOR_ID,
          kitId: KIT_ONE,
          assetType: "color",
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).operation).toBe(READ_NEXT_SORT_ORDER);
    }
  });
});

describe("brand-kit-read-repository: findOwnAsset", () => {
  it("case 41: ONE statement binding actor, kit and asset in that order, with the owning-kit `exists`", async () => {
    const { repository, harness } = detailRepository(() => [ASSET_DETAIL_ROW]);

    await expect(
      repository.findOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_ONE }),
    ).resolves.toEqual(ASSET_DETAIL_ROW);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? "";

    expect(sql).toContain("from public.brand_kit_assets a");
    expect(sql).toContain("a.id = $3::uuid");
    // The kit from the URL is part of the read: an asset id alone is not enough.
    expect(sql).toContain("a.kit_id = $2::uuid");
    expect(sql).toContain("exists (select 1 from public.brand_kits k");
    expect(calls[0]?.params).toEqual([ACTOR_ID, KIT_ONE, ASSET_ONE]);
    expect(sql).not.toContain(ASSET_ONE);
  });

  it("case 42: an asset that is not there answers `null`", async () => {
    const { repository } = detailRepository(() => []);

    await expect(
      repository.findOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_ONE }),
    ).resolves.toBeNull();
  });
});

describe("brand-kit-read-repository: argument refusals and failure classification", () => {
  it("case 43: an unusable argument is refused per method, before any connection", async () => {
    const bad: Array<[string, (repository: ReturnType<typeof repositoryFor>) => Promise<unknown>]> = [
      [
        FIND_OWN_KIT,
        (repository) =>
          repository.findOwnKit({ actorId: "", kitId: KIT_ONE } as { actorId: string; kitId: string }),
      ],
      [
        FIND_OWN_KIT,
        (repository) =>
          repository.findOwnKit({ actorId: ACTOR_ID, kitId: "" } as { actorId: string; kitId: string }),
      ],
      [
        LIST_OWN_KIT_ASSETS,
        (repository) =>
          repository.listOwnKitAssets({ actorId: ACTOR_ID, kitId: "" } as { actorId: string; kitId: string }),
      ],
      [
        LIST_OWN_KIT_FILE_URLS,
        (repository) =>
          repository.listOwnKitFileUrls({ actorId: 7, kitId: KIT_ONE } as unknown as { actorId: string; kitId: string }),
      ],
      [
        READ_NEXT_SORT_ORDER,
        (repository) =>
          repository.readNextSortOrder({
            actorId: ACTOR_ID,
            kitId: KIT_ONE,
            assetType: "video" as never,
          }),
      ],
      [
        FIND_OWN_ASSET,
        (repository) =>
          repository.findOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: "" } as {
            actorId: string;
            kitId: string;
            assetId: string;
          }),
      ],
    ];

    for (const [operation, call] of bad) {
      const { repository, harness } = detailRepository(() => []);

      const error = await call(repository).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(BrandKitReadError);
      expect((error as BrandKitReadError).operation).toBe(operation);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 44: a SQL failure names its own operation and leaks neither statement nor host", async () => {
    const failure = new Error(
      "select a.id from public.brand_kit_assets a failed: postgres://loomic:secret@10.210.134.37:5432/loomic",
    );

    const harness = createHarness(() => [ASSET_DETAIL_ROW], { sqlError: failure });
    const repository = repositoryFor(harness);

    const error = await repository
      .findOwnAsset({ actorId: ACTOR_ID, kitId: KIT_ONE, assetId: ASSET_ONE })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrandKitReadError);
    expect((error as BrandKitReadError).operation).toBe(FIND_OWN_ASSET);
    expect((error as BrandKitReadError).cause).toBe(failure);
    expect((error as BrandKitReadError).message).toBe(
      `brand kit read failed (${FIND_OWN_ASSET})`,
    );
    expect((error as BrandKitReadError).message).not.toMatch(
      /public\.|brand_kit_assets|select|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(statements(harness.queries).at(-1)).toBe(TRANSACTION_STATEMENTS.rollback);
  });

  it("case 45: the new reads run privileged with the actor as context, and no kit predicate is derived", async () => {
    const seen: string[] = [];
    const { repository } = detailRepository((sql) => {
      seen.push(sql);
      if (sql.includes("coalesce")) return [{ next_sort_order: 1 }];
      if (sql.includes("brand_kit_assets") && !sql.includes("display_name")) {
        return [{ file_url: "a/b/one.png" }];
      }
      if (sql.includes("brand_kit_assets")) return [ASSET_DETAIL_ROW];
      return [KIT_DETAIL_ROW];
    });

    await repository.findOwnKit({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO });
    await repository.listOwnKitAssets({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO });
    await repository.listOwnKitFileUrls({ actorId: OTHER_ACTOR_ID, kitId: KIT_TWO });
    await repository.readNextSortOrder({
      actorId: OTHER_ACTOR_ID,
      kitId: KIT_TWO,
      assetType: "image",
    });
    await repository.findOwnAsset({
      actorId: OTHER_ACTOR_ID,
      kitId: KIT_TWO,
      assetId: ASSET_ONE,
    });

    // Five reads, five statements, and every one of them keys on the actor as a
    // BIND — never as interpolated text, and never widened by a second ACL.
    expect(seen).toHaveLength(5);
    for (const sql of seen) {
      expect(sql).toContain("$1::uuid");
      expect(sql).not.toContain(OTHER_ACTOR_ID);
      expect(sql).not.toMatch(/workspace|project|archived|member|owner_user_id/i);
      expect(sql).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i);
      expect(sql).not.toContain(";");
    }
  });
});
