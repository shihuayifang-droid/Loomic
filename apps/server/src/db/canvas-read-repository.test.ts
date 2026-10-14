import { describe, expect, it } from "vitest";

import {
  FIND_READABLE_CANVAS_CONTENT,
  LIST_READABLE_CANVAS_ASSETS,
  LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
  CanvasReadError,
  createCanvasReadRepository,
  type CanvasReadRepository,
} from "./canvas-read-repository.js";
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
 * repository issues, the actor it carries, how it binds values — including the
 * two parallel arrays behind the asset lookup — and how it classifies every way
 * a read can fail.
 *
 * The SQL assertions are deliberately about the AUTHORIZATION predicates and the
 * ownership proof (the membership join, the author/admin/owner clause, the
 * archived filter, `asset_objects.project_id = <canvas project>`), not about a
 * happy path that merely returns rows.
 */

const ACTOR_ID = "00000000-0000-0000-0000-00000000000a";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-00000000000b";
const CANVAS_ID = "55555555-5555-5555-5555-555555555555";
const JOB_ID = "66666666-6666-6666-6666-666666666666";
const ASSET_ID = "77777777-7777-7777-7777-777777777777";
const BUCKET = "project-assets";
const OBJECT_PATH = "ws-team/canvas-1/pic.png";

const CREATED_AT = new Date("2026-01-02T03:04:05.678Z");
const INVALID_ID = "not-a-uuid";

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

/** Only the three domain statements touch these tables; BEGIN/COMMIT do not. */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter(
    (entry) =>
      entry.sql.includes("public.canvases") ||
      entry.sql.includes("public.background_jobs") ||
      entry.sql.includes("public.asset_objects"),
  );
}

function contextParams(queries: readonly QueryRecord[]): unknown[][] {
  return queries
    .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
    .map((entry) => [...(entry.params ?? [])]);
}

function repositoryFor(harness: Harness): CanvasReadRepository {
  return createCanvasReadRepository({
    getTransactionPool: () => harness.pool,
  });
}

const CONTENT = { elements: [{ id: "el-1" }], appState: {}, files: {} };

const JOB_ROW = {
  id: JOB_ID,
  created_at: CREATED_AT,
  payload: { prompt: "a cat" },
  result: { object_path: OBJECT_PATH, width: 512, height: 512 },
};

const ASSET_ROW = {
  id: ASSET_ID,
  bucket: BUCKET,
  object_path: OBJECT_PATH,
};

describe("canvas-read-repository: findReadableCanvasContent", () => {
  it("case 1: reads inside one privileged transaction that carries the actor and binds both values", async () => {
    const harness = createHarness(() => [{ content: CONTENT }]);

    const found = await repositoryFor(harness).findReadableCanvasContent({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    expect(found).toEqual({ content: CONTENT });

    const settingNames = contextParams(harness.queries).map((params) => params[0]);
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
    expect(statements[0]?.params).toEqual([ACTOR_ID, CANVAS_ID]);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 2: the statement itself inherits the project ACL — membership, author-or-admin/owner, not archived", async () => {
    const harness = createHarness(() => [{ content: CONTENT }]);

    await repositoryFor(harness).findReadableCanvasContent({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("p.id = c.project_id");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.workspace_id = p.workspace_id");
    expect(sql).toContain("m.user_id = $1");
    expect(sql).toContain("p.created_by = $1");
    expect(sql).toContain("m.role in ('admin', 'owner')");
    expect(sql).toContain("p.archived_at is null");
    expect(sql).toContain("c.id = $2");
    // No id, table or column is ever concatenated into the statement.
    expect(sql).not.toContain(ACTOR_ID);
    expect(sql).not.toContain(CANVAS_ID);
  });

  it("case 3: no readable row is null, and a readable row with a null column is not", async () => {
    const missing = createHarness(() => []);
    await expect(
      repositoryFor(missing).findReadableCanvasContent({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toBeNull();

    const nullContent = createHarness(() => [{ content: null }]);
    await expect(
      repositoryFor(nullContent).findReadableCanvasContent({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).resolves.toEqual({ content: null });
  });

  it("case 4: a second row and an unusable content shape both fail loud", async () => {
    const duplicated = createHarness(() => [
      { content: CONTENT },
      { content: CONTENT },
    ]);
    const duplicateError = await repositoryFor(duplicated)
      .findReadableCanvasContent({ actorId: ACTOR_ID, canvasId: CANVAS_ID })
      .catch((reason: unknown) => reason);

    expect(duplicateError).toBeInstanceOf(CanvasReadError);
    expect((duplicateError as CanvasReadError).operation).toBe(
      FIND_READABLE_CANVAS_CONTENT,
    );

    // jsonb `[]` is not a canvas document; passing it on would hand the Agent a
    // shape its summariser cannot read.
    const arrayContent = createHarness(() => [{ content: [] }]);
    await expect(
      repositoryFor(arrayContent).findReadableCanvasContent({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toBeInstanceOf(CanvasReadError);
  });
});

describe("canvas-read-repository: listReadableSucceededImageJobs", () => {
  it("case 5: filters to this canvas's succeeded image jobs, oldest first, and maps timestamps and json", async () => {
    const harness = createHarness(() => [JOB_ROW]);

    const jobs = await repositoryFor(harness).listReadableSucceededImageJobs({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    expect(jobs).toEqual([
      {
        id: JOB_ID,
        created_at: "2026-01-02T03:04:05.678Z",
        payload: { prompt: "a cat" },
        result: { object_path: OBJECT_PATH, width: 512, height: 512 },
      },
    ]);

    const call = domainCalls(harness.queries)[0];
    expect(call?.params).toEqual([ACTOR_ID, CANVAS_ID]);
    const sql = call?.sql ?? "";
    expect(sql).toContain("j.canvas_id = $2");
    expect(sql).toContain("j.status = 'succeeded'");
    expect(sql).toContain("j.job_type = 'image_generation'");
    expect(sql).toContain("order by j.created_at asc");
  });

  it("case 6: the job ACL is re-derived through the canvas's project, not the job's own workspace", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).listReadableSucceededImageJobs({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    const sql = domainCalls(harness.queries)[0]?.sql ?? "";
    expect(sql).toContain("join public.canvases as c");
    expect(sql).toContain("c.id = j.canvas_id");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("p.id = c.project_id");
    expect(sql).toContain("join public.workspace_members as m");
    expect(sql).toContain("m.user_id = $1");
    expect(sql).toContain("p.created_by = $1");
    expect(sql).toContain("m.role in ('admin', 'owner')");
    expect(sql).toContain("p.archived_at is null");
    // The job's own workspace_id must never be the authorization source (Q1).
    expect(sql).not.toContain("j.workspace_id");
  });

  it("case 7: a null payload or result stays null instead of becoming an empty object", async () => {
    const harness = createHarness(() => [
      { id: JOB_ID, created_at: CREATED_AT, payload: null, result: null },
    ]);

    const jobs = await repositoryFor(harness).listReadableSucceededImageJobs({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    expect(jobs).toEqual([
      {
        id: JOB_ID,
        created_at: "2026-01-02T03:04:05.678Z",
        payload: null,
        result: null,
      },
    ]);
  });
});

describe("canvas-read-repository: listReadableCanvasAssets", () => {
  it("case 8: an empty ref list answers [] without opening a connection", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    const rows = await repositoryFor(harness).listReadableCanvasAssets({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
      refs: [],
    });

    expect(rows).toEqual([]);
    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });

  it("case 9: pairs are bound as two parallel arrays, deduped, and matched exactly against the canvas's project", async () => {
    const harness = createHarness(() => [ASSET_ROW]);

    const rows = await repositoryFor(harness).listReadableCanvasAssets({
      actorId: ACTOR_ID,
      canvasId: CANVAS_ID,
      refs: [
        { bucket: BUCKET, objectPath: OBJECT_PATH },
        { bucket: BUCKET, objectPath: OBJECT_PATH },
        { bucket: BUCKET, objectPath: "ws-team/canvas-1/other.png" },
      ],
    });

    expect(rows).toEqual([
      { id: ASSET_ID, bucket: BUCKET, object_path: OBJECT_PATH },
    ]);

    const call = domainCalls(harness.queries)[0];
    expect(call?.params).toEqual([
      ACTOR_ID,
      CANVAS_ID,
      [BUCKET, BUCKET],
      [OBJECT_PATH, "ws-team/canvas-1/other.png"],
    ]);

    const sql = call?.sql ?? "";
    expect(sql).toContain("from public.canvases as c");
    expect(sql).toContain("join public.projects as p");
    expect(sql).toContain("p.id = c.project_id");
    expect(sql).toContain("join public.asset_objects as a");
    expect(sql).toContain("a.project_id = p.id");
    expect(sql).toContain("join unnest($3::text[], $4::text[]) as r(bucket, object_path)");
    expect(sql).toContain("r.bucket = a.bucket");
    expect(sql).toContain("r.object_path = a.object_path");
    expect(sql).toContain("m.user_id = $1");
    expect(sql).toContain("p.archived_at is null");
    // No cartesian widening: the pair is matched, never the bucket set against
    // the path set.
    expect(sql).not.toContain("any($3");
    expect(sql).not.toContain("in (select");
    expect(sql).not.toContain(OBJECT_PATH);
  });

  it("case 10: a half-empty ref fails loud instead of being sent as a lookup key", async () => {
    const emptyBucket = createHarness(() => [ASSET_ROW]);
    await expect(
      repositoryFor(emptyBucket).listReadableCanvasAssets({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
        refs: [{ bucket: "", objectPath: OBJECT_PATH }],
      }),
    ).rejects.toBeInstanceOf(CanvasReadError);
    expect(emptyBucket.connectAttempts()).toBe(0);

    const emptyPath = createHarness(() => [ASSET_ROW]);
    const error = await repositoryFor(emptyPath)
      .listReadableCanvasAssets({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
        refs: [{ bucket: BUCKET, objectPath: "" }],
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CanvasReadError);
    expect((error as CanvasReadError).operation).toBe(LIST_READABLE_CANVAS_ASSETS);
    expect(emptyPath.connectAttempts()).toBe(0);
  });

  it("case 11: two rows for one exact pair fail loud rather than letting one silently win", async () => {
    const harness = createHarness(() => [ASSET_ROW, { ...ASSET_ROW, id: "another" }]);

    await expect(
      repositoryFor(harness).listReadableCanvasAssets({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
        refs: [{ bucket: BUCKET, objectPath: OBJECT_PATH }],
      }),
    ).rejects.toBeInstanceOf(CanvasReadError);
  });
});

describe("canvas-read-repository: failure classification", () => {
  it("case 12: connect, SQL and shape failures all become CanvasReadError with a fixed message", async () => {
    const connect = createHarness(() => [], {
      connectError: new Error("ECONNREFUSED postgres://user:secret@10.210.134.37:5432/db"),
    });
    const connectError = await repositoryFor(connect)
      .findReadableCanvasContent({ actorId: ACTOR_ID, canvasId: CANVAS_ID })
      .catch((reason: unknown) => reason);

    expect(connectError).toBeInstanceOf(CanvasReadError);
    expect((connectError as CanvasReadError).operation).toBe(
      FIND_READABLE_CANVAS_CONTENT,
    );
    expect((connectError as CanvasReadError).message).toBe(
      `canvas read failed (${FIND_READABLE_CANVAS_CONTENT})`,
    );
    expect((connectError as CanvasReadError).message).not.toMatch(
      /select|public\.|join|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    expect(((connectError as CanvasReadError).cause as Error).message).toContain(
      "ECONNREFUSED",
    );

    // A real database answer (invalid uuid) carries the same fixed message under
    // the operation that failed.
    const sqlFailure = createHarness(() => {
      throw new Error("invalid input syntax for type uuid: \"not-a-uuid\"");
    });
    const sqlError = await repositoryFor(sqlFailure)
      .listReadableSucceededImageJobs({
        actorId: ACTOR_ID,
        canvasId: INVALID_ID,
      })
      .catch((reason: unknown) => reason);

    expect(sqlError).toBeInstanceOf(CanvasReadError);
    expect((sqlError as CanvasReadError).operation).toBe(
      LIST_READABLE_SUCCEEDED_IMAGE_JOBS,
    );
    expect((sqlError as CanvasReadError).message).not.toContain("uuid");

    const shapeFailure = createHarness(() => [{ id: "", created_at: CREATED_AT }]);
    await expect(
      repositoryFor(shapeFailure).listReadableSucceededImageJobs({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toBeInstanceOf(CanvasReadError);
  });

  it("case 13: every read runs privileged for the actor, and no read invents one", async () => {
    const harness = createHarness(() => []);

    await repositoryFor(harness).listReadableSucceededImageJobs({
      actorId: OTHER_ACTOR_ID,
      canvasId: CANVAS_ID,
    });

    const actorSetting = contextParams(harness.queries).find(
      (params) => params[0] === TRANSACTION_SETTING_NAMES.userId,
    );
    expect(actorSetting).toEqual([
      TRANSACTION_SETTING_NAMES.userId,
      OTHER_ACTOR_ID,
    ]);
    expect(domainCalls(harness.queries)[0]?.params).toEqual([
      OTHER_ACTOR_ID,
      CANVAS_ID,
    ]);
  });

  it("case 14: building the repository touches no pool, reads no env and connects to nothing", async () => {
    let getterCalls = 0;
    const repository = createCanvasReadRepository({
      getTransactionPool: () => {
        getterCalls += 1;
        throw new Error("the pool must not be required to build the repository");
      },
    });

    expect(getterCalls).toBe(0);

    // The one path that answers without a connection: an empty ref list.
    await expect(
      repository.listReadableCanvasAssets({
        actorId: ACTOR_ID,
        canvasId: CANVAS_ID,
        refs: [],
      }),
    ).resolves.toEqual([]);
    expect(getterCalls).toBe(0);
  });
});
