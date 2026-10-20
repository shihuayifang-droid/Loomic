import { describe, expect, it } from "vitest";

import {
  AssetReadError,
  FIND_READABLE_ASSET,
  LIST_READABLE_PROJECT_UPLOADS,
  createAssetReadRepository,
  type AssetReadListRepository,
} from "./asset-read-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_SETTING_ORDER,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the statement the
 * repository issues, the actor it carries, how it binds values, and how it
 * classifies every way a read can fail.
 *
 * The SQL text assertions are deliberately about the AUTHORIZATION predicates —
 * the membership join, the project-author / asset-creator / admin-owner branch,
 * the absence of an archive filter — and about the absence of concatenated
 * values. A statement that merely returns rows would pass a "happy path" test
 * while handing out someone else's asset.
 */

const ACTOR_ID = "00000000-0000-0000-0000-00000000000a";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-00000000000b";
const WORKSPACE_ID = "22222222-2222-2222-2222-222222222222";
const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const ASSET_ID = "77777777-7777-7777-7777-777777777777";

const CREATED_AT = new Date("2026-01-02T03:04:05.678Z");

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (sql === TRANSACTION_STATEMENTS.setLocalSetting) return { rows: [] };
      if (
        sql === TRANSACTION_STATEMENTS.begin ||
        sql === TRANSACTION_STATEMENTS.commit ||
        sql === TRANSACTION_STATEMENTS.rollback
      ) {
        return { rows: [] };
      }

      return { rows: await respond(sql) };
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

/** Only the domain statement touches this table; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) =>
    entry.sql.includes("public.asset_objects"),
  );
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  const flat = queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .flatMap((entry) => [...(entry.params ?? [])]);
  const pairs: unknown[][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push([flat[i], flat[i + 1]]);
  }
  return pairs;
}

function repositoryFor(harness: Harness): AssetReadListRepository {
  return createAssetReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

const ASSET_ROW = {
  id: ASSET_ID,
  bucket: "project-assets",
  object_path: `${WORKSPACE_ID}/${PROJECT_ID}/photo.png`,
  mime_type: "image/png",
  byte_size: 4096,
  workspace_id: WORKSPACE_ID,
  project_id: PROJECT_ID,
  created_at: CREATED_AT,
};

describe("asset-read-repository: findReadableAsset", () => {
  it("case 1: reads inside one privileged transaction that carries the actor and binds both values", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    await repositoryFor(harness).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });

    const settingNames = contextParams(harness.queries).map(
      (params) => params[0],
    );
    expect(settingNames).toEqual([...TRANSACTION_SETTING_ORDER]);
    expect(
      contextParams(harness.queries).find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.userId, ACTOR_ID]);
    expect(
      contextParams(harness.queries).find(
        (params) => params[0] === TRANSACTION_SETTING_NAMES.executionMode,
      ),
    ).toEqual([TRANSACTION_SETTING_NAMES.executionMode, "privileged"]);

    const statements = domainCalls(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([ACTOR_ID, ASSET_ID]);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: the statement itself carries the ACL — membership, both ownership branches, no archive filter", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    await repositoryFor(harness).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("from public.asset_objects as a");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.workspace_id = a.workspace_id");
    expect(sql).toContain("m.user_id = $1");
    // The project is only consulted by the branch that has one, which is why the
    // join must not drop a project-less asset.
    expect(sql).toContain("left join public.projects as p");
    expect(sql).toContain("on p.id = a.project_id");
    expect(sql).toContain("when a.project_id is null then a.created_by = $1");
    expect(sql).toContain("else p.created_by = $1");
    expect(sql).toContain("m.role in ('admin', 'owner')");
    // Unchanged from the PostgREST lookup this replaces: no archive clause.
    expect(sql).not.toContain("archived_at");
    expect(sql).not.toMatch(/select\s+\*/i);
    // The execution mode is a diagnostic label, never an authorization input.
    expect(sql).not.toContain("execution_mode");
  });

  it("case 3: no caller value is ever concatenated into the statement", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    await repositoryFor(harness).findReadableAsset({
      actorId: OTHER_ACTOR_ID,
      assetId: ASSET_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    for (const value of [ACTOR_ID, OTHER_ACTOR_ID, WORKSPACE_ID, ASSET_ID]) {
      expect(sql).not.toContain(value);
    }
    expect(sql).not.toContain("$3");
  });

  it("case 4: the row maps to the full DTO, and byte_size arrives as a number or as a decimal string", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    const asset = await repositoryFor(harness).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });

    expect(asset).toEqual({
      id: ASSET_ID,
      bucket: "project-assets",
      object_path: `${WORKSPACE_ID}/${PROJECT_ID}/photo.png`,
      mime_type: "image/png",
      byte_size: 4096,
      workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID,
      created_at: "2026-01-02T03:04:05.678Z",
    });

    // `pg` registers int8 -> parseBigInteger, which hands back a STRING (PGlite
    // hands back a number). Both are the same column value and both must reach the
    // caller as the number the HTTP contract publishes.
    const fromString = createHarness(() => [
      { ...ASSET_ROW, byte_size: "4096" },
    ]);
    const asString = await repositoryFor(fromString).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });
    expect(asString?.byte_size).toBe(4096);

    // An ISO string instead of a Date is normalised to the same value.
    const fromTimestamp = createHarness(() => [
      { ...ASSET_ROW, created_at: "2026-01-02T03:04:05.678+00:00" },
    ]);
    const asTimestamp = await repositoryFor(fromTimestamp).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });
    expect(asTimestamp?.created_at).toBe("2026-01-02T03:04:05.678Z");
  });

  it("case 5: a present null in every nullable column is a real answer and stays null", async () => {
    const harness = createHarness(() => [
      {
        ...ASSET_ROW,
        mime_type: null,
        byte_size: null,
        project_id: null,
      },
    ]);

    const asset = await repositoryFor(harness).findReadableAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ID,
    });

    expect(asset).toEqual({
      id: ASSET_ID,
      bucket: "project-assets",
      object_path: `${WORKSPACE_ID}/${PROJECT_ID}/photo.png`,
      mime_type: null,
      byte_size: null,
      workspace_id: WORKSPACE_ID,
      project_id: null,
      created_at: "2026-01-02T03:04:05.678Z",
    });
  });

  it("case 6: a missing nullable column is not a null — the row shape fails loud", async () => {
    // Each of the three nullable columns, absent rather than null: a dropped
    // column, a drifting alias or a half-built driver row. Folding that into a
    // business null would serve a column drift as a legitimate answer.
    for (const field of ["mime_type", "byte_size", "project_id"] as const) {
      const row: Record<string, unknown> = { ...ASSET_ROW };
      delete row[field];

      const error = await repositoryFor(createHarness(() => [row]))
        .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AssetReadError);
      expect((error as AssetReadError).operation).toBe(FIND_READABLE_ASSET);
      expect(((error as AssetReadError).cause as Error).message).toContain(
        `"${field}"`,
      );
    }
  });

  it("case 7: an explicit undefined is not a null either", async () => {
    const error = await repositoryFor(
      createHarness(() => [{ ...ASSET_ROW, byte_size: undefined }]),
    )
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AssetReadError);
    expect(((error as AssetReadError).cause as Error).message).toContain(
      '"byte_size"',
    );
  });

  it("case 8: an unusable byte_size, mime_type, bucket or timestamp fails loud", async () => {
    const unusable: Array<[string, Record<string, unknown>]> = [
      ["byte_size", { byte_size: -1 }],
      ["byte_size", { byte_size: 3.5 }],
      ["byte_size", { byte_size: "not a size" }],
      ["byte_size", { byte_size: { bytes: 3 } }],
      ["mime_type", { mime_type: "" }],
      ["mime_type", { mime_type: 42 }],
      ["bucket", { bucket: "" }],
      ["bucket", { bucket: null }],
      ["created_at", { created_at: "not a timestamp" }],
      ["object_path", { object_path: "" }],
      ["workspace_id", { workspace_id: undefined }],
    ];

    for (const [field, patch] of unusable) {
      const error = await repositoryFor(createHarness(() => [{ ...ASSET_ROW, ...patch }]))
        .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AssetReadError);
      expect((error as AssetReadError).operation).toBe(FIND_READABLE_ASSET);
      expect(((error as AssetReadError).cause as Error).message).toContain(
        `"${field}"`,
      );
    }
  });

  it("case 9: zero rows mean null, a second row and a non-object row are contradictions", async () => {
    await expect(
      repositoryFor(createHarness(() => [])).findReadableAsset({
        actorId: ACTOR_ID,
        assetId: ASSET_ID,
      }),
    ).resolves.toBeNull();

    const duplicate = await repositoryFor(
      createHarness(() => [ASSET_ROW, ASSET_ROW]),
    )
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);
    expect(duplicate).toBeInstanceOf(AssetReadError);
    expect((duplicate as AssetReadError).operation).toBe(FIND_READABLE_ASSET);
    expect(((duplicate as AssetReadError).cause as Error).message).toMatch(
      /more than one row/,
    );

    const notAnObject = await repositoryFor(createHarness(() => ["row"]))
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);
    expect(notAnObject).toBeInstanceOf(AssetReadError);
    expect(((notAnObject as AssetReadError).cause as Error).message).toMatch(
      /not an object/,
    );
  });

  it("case 10: a connection failure is an AssetReadError whose message leaks no SQL or host", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error(
        "connect ECONNREFUSED 10.210.134.37:5432 for postgres://user:pw@host/db",
      ),
    });

    const error = await repositoryFor(harness)
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AssetReadError);
    const readError = error as AssetReadError;
    expect(readError.operation).toBe(FIND_READABLE_ASSET);
    expect(readError.message).toBe(`asset read failed (${FIND_READABLE_ASSET})`);
    expect(readError.message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The cause keeps the driver detail for an operator; only the public message
    // is fixed text.
    expect((readError.cause as Error).message).toContain("ECONNREFUSED");
  });

  it("case 11: a SQL failure reports its own operation with the same fixed text", async () => {
    const harness = createHarness(() => {
      throw new Error('relation "public.asset_objects" does not exist');
    });

    const error = await repositoryFor(harness)
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AssetReadError);
    expect((error as AssetReadError).message).toBe(
      `asset read failed (${FIND_READABLE_ASSET})`,
    );
    expect((error as AssetReadError).message).not.toContain("relation");
  });
});

describe("asset-read-repository: pool is lazy", () => {
  it("case 12: building the repository never resolves a pool; a missing DATABASE_URL fails on read", async () => {
    let resolutions = 0;
    const repository = createAssetReadRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await repository
      .findReadableAsset({ actorId: ACTOR_ID, assetId: ASSET_ID })
      .catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(AssetReadError);
    expect((error as AssetReadError).operation).toBe(FIND_READABLE_ASSET);
  });
});

/**
 * AS-06 (workorder 34N): the project upload list. Same fake pool, same two
 * questions — which statement is issued and how its values are bound — plus the
 * one refusal this read has that the lookup does not: a limit nobody can serve.
 */
describe("asset-read-repository: listReadableProjectUploads", () => {
  it("AS-06: limit outside 1..200 is refused before connecting", async () => {
    for (const limit of [0, 201]) {
      const harness = createHarness(() => []);

      const error = await repositoryFor(harness)
        .listReadableProjectUploads({
          actorId: ACTOR_ID,
          projectId: PROJECT_ID,
          order: "newest",
          limit,
        })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AssetReadError);
      expect((error as AssetReadError).operation).toBe(
        LIST_READABLE_PROJECT_UPLOADS,
      );
      // Refused before the pool is even asked for a connection: a bad limit must
      // not cost a transaction.
      expect(harness.connectAttempts()).toBe(0);
      expect(domainCalls(harness.queries)).toHaveLength(0);
    }
  });

  it("AS-06: the list statement binds actor, project and limit and never concatenates them", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).listReadableProjectUploads({
      actorId: ACTOR_ID,
      projectId: PROJECT_ID,
      order: "newest",
      mediaType: "image",
      limit: 25,
    });

    const statements = domainCalls(harness.queries);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toEqual([ACTOR_ID, PROJECT_ID, 25]);

    const sql = statements[0]?.sql ?? "";
    // The project and the actor are bound, never written into the statement.
    expect(sql).not.toContain(PROJECT_ID);
    expect(sql).not.toContain(ACTOR_ID);
    expect(sql).toContain("a.project_id = $2::uuid");
    expect(sql).toContain("a.source = 'user_upload'");
    expect(sql).toContain("limit $3::int");
    // The SAME ACL as the single-asset read: membership, the ownership branch,
    // admin/owner, and no archive clause.
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.workspace_id = a.workspace_id");
    expect(sql).toContain("m.user_id = $1");
    expect(sql).toContain("left join public.projects as p");
    expect(sql).toContain("else p.created_by = $1");
    expect(sql).toContain("m.role in ('admin', 'owner')");
    expect(sql).not.toContain("archived_at");
    // Fixed clause per ordering and per media kind, selected — not built.
    expect(sql).toContain("order by a.created_at desc, a.id desc");
    expect(sql).toContain("and a.mime_type like 'image/%'");
  });

  it("AS-06: a driver error is asset read failed (listReadableProjectUploads)", async () => {
    const harness = createHarness(() => {
      throw new Error('relation "public.asset_objects" does not exist');
    });

    const error = await repositoryFor(harness)
      .listReadableProjectUploads({
        actorId: ACTOR_ID,
        projectId: PROJECT_ID,
        order: "oldest",
        limit: 10,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AssetReadError);
    const readError = error as AssetReadError;
    expect(readError.operation).toBe(LIST_READABLE_PROJECT_UPLOADS);
    expect(readError.message).toBe(
      `asset read failed (${LIST_READABLE_PROJECT_UPLOADS})`,
    );
    expect(readError.message).not.toContain("relation");
  });
});
