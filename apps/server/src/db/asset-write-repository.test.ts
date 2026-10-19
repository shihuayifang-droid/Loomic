import { describe, expect, it } from "vitest";

import {
  DELETE_OWN_ASSET,
  AssetWriteError,
  createAssetWriteRepository,
} from "./asset-write-repository.js";
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
 * - the single method issues EXACTLY ONE domain statement, whose authorisation is
 *   INSIDE the statement — author, membership of the asset's workspace, and the
 *   project's write permission — because a privileged connection bypasses row level
 *   security and the statement's own predicate is the only gate there is;
 * - no administrator clause and no archive filter appear, because
 *   `asset_objects_delete_self` has neither;
 * - the parameters are in the documented order, with the uuid casts on the binds and
 *   never in the SQL text;
 * - a refusal (an asset that is not the actor's) comes back as `{deleted: 0}` and NOT
 *   as a throw, because that is the shape the service maps onto the success it
 *   published before the migration;
 * - an unusable argument throws WITHOUT connecting.
 *
 * The PGlite file beside this one
 * (`test-support/db/asset-write-repository-db.test.ts`) proves PostgreSQL parses and
 * executes the statement and that it refuses exactly what the policy refuses.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000b2";
const ASSET_ONE = "00000000-0000-0000-0000-0000000000d1";
const ASSET_TWO = "00000000-0000-0000-0000-0000000000d2";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

function createHarness(
  respond: (sql: string, params?: readonly unknown[]) => unknown[],
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

      return { rows: respond(sql, params) };
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

function repositoryFor(harness: Harness) {
  return createAssetWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

function singleStatement(harness: Harness): QueryRecord {
  const calls = domainCalls(harness.queries);
  expect(calls).toHaveLength(1);

  const call = calls[0];
  if (call === undefined) throw new Error("expected one domain statement");

  return call;
}

/**
 * The three conjuncts of `asset_objects_delete_self`, as the statement writes them.
 * The membership fragment is the body of `private.is_workspace_member`; the project
 * fragment is the body of `private.can_write_project`, which is why it carries its
 * own membership check.
 */
const MEMBER_CLAUSE = `exists (select 1 from public.workspace_members m
                where m.workspace_id = a.workspace_id
                  and m.user_id = $1::uuid)`;

const PROJECT_CLAUSE = `exists (select 1 from public.projects p
                    where p.id = a.project_id
                      and p.created_by = $1::uuid
                      and exists (select 1 from public.workspace_members pm
                                   where pm.workspace_id = p.workspace_id
                                     and pm.user_id = $1::uuid))`;

function expectPolicyPredicate(sql: string): void {
  expect(sql).toContain("a.created_by = $1::uuid");
  expect(sql).toContain(MEMBER_CLAUSE);
  // `project_id is null or …` covers the asset with no project: it inherits nothing,
  // so that branch is its whole authorisation.
  expect(sql).toContain("a.project_id is null");
  expect(sql).toContain(PROJECT_CLAUSE);
  // The delete policy grants no administrator escape and has no archive term.
  expect(sql).not.toMatch(/admin|owner_user_id|\bm\.role\b/i);
  expect(sql).not.toContain("archived_at");
  expect(sql).not.toContain(";");
}

describe("asset-write-repository: deleteOwnAsset", () => {
  it("case 1: ONE delete, owner+membership+project in the statement, the row id as the second bind", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }]);

    await expect(
      repositoryFor(harness).deleteOwnAsset({
        actorId: ACTOR_ID,
        assetId: ASSET_ONE,
      }),
    ).resolves.toEqual({ deleted: 1 });

    const call = singleStatement(harness);
    expect(call.sql).toContain("delete from public.asset_objects a");
    expect(call.sql).toContain("where a.id = $2::uuid");
    expect(call.sql).toContain("returning a.id");
    expect(call.params).toEqual([ACTOR_ID, ASSET_ONE]);
    expect(call.sql).not.toContain(ACTOR_ID);
    expect(call.sql).not.toContain(ASSET_ONE);
    expectPolicyPredicate(call.sql);
  });

  it("case 2: zero rows is {deleted: 0}, not a throw", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).deleteOwnAsset({
        actorId: OTHER_ACTOR_ID,
        assetId: ASSET_ONE,
      }),
    ).resolves.toEqual({ deleted: 0 });

    expect(domainCalls(harness.queries)).toHaveLength(1);
  });

  it("case 3: the answer is the row count, so two rows can never be reported as one", async () => {
    // `asset_objects.id` is the primary key, so this cannot happen in the database;
    // the point is that the count is passed through rather than normalised.
    const harness = createHarness(() => [{ id: ASSET_ONE }, { id: ASSET_TWO }]);

    await expect(
      repositoryFor(harness).deleteOwnAsset({
        actorId: ACTOR_ID,
        assetId: ASSET_ONE,
      }),
    ).resolves.toEqual({ deleted: 2 });
  });

  it("case 4: an empty actorId throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }]);

    const error = await repositoryFor(harness)
      .deleteOwnAsset({ actorId: "", assetId: ASSET_ONE })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AssetWriteError);
    expect((error as AssetWriteError).operation).toBe(DELETE_OWN_ASSET);
    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toEqual([]);
  });

  it("case 5: an empty assetId throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }]);

    const error = await repositoryFor(harness)
      .deleteOwnAsset({ actorId: ACTOR_ID, assetId: "" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AssetWriteError);
    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 6: a SQL failure is an AssetWriteError naming the operation, with the driver error as cause", async () => {
    const driver = Object.assign(new Error("invalid input syntax for type uuid"), {
      code: "22P02",
    });
    const harness = createHarness(() => [], { sqlError: driver });

    const error = await repositoryFor(harness)
      .deleteOwnAsset({ actorId: ACTOR_ID, assetId: "not-a-uuid" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AssetWriteError);
    expect((error as AssetWriteError).operation).toBe(DELETE_OWN_ASSET);
    expect((error as AssetWriteError).cause).toBe(driver);
    expect((error as AssetWriteError).message).toBe(
      "asset write failed (deleteOwnAsset)",
    );
    expect((error as AssetWriteError).message).not.toMatch(
      /public\.|created_by|postgres:\/\//i,
    );
  });

  it("case 7: a connect failure is classified the same way, and the transaction never begins", async () => {
    const driver = new Error("Connection terminated unexpectedly");
    const harness = createHarness(() => [], { connectError: driver });

    const error = await repositoryFor(harness)
      .deleteOwnAsset({ actorId: ACTOR_ID, assetId: ASSET_ONE })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AssetWriteError);
    expect((error as AssetWriteError).cause).toBe(driver);
    expect(harness.queries).toEqual([]);
  });

  it("case 8: the actor rides along in the transaction context, so a privileged delete is not anonymous", async () => {
    const harness = createHarness(() => [{ id: ASSET_ONE }]);

    await repositoryFor(harness).deleteOwnAsset({
      actorId: ACTOR_ID,
      assetId: ASSET_ONE,
    });

    const settings = harness.queries.find(
      (entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting,
    );
    expect(settings?.params).toContain(ACTOR_ID);
  });
});
