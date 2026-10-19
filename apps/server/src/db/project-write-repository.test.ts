import { describe, expect, it } from "vitest";

import {
  ARCHIVE_OWN_PROJECT,
  SET_OWN_PROJECT_THUMBNAIL,
  UPDATE_OWN_PROJECT,
  ProjectWriteError,
  createProjectWriteRepository,
} from "./project-write-repository.js";
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
 * - every method issues EXACTLY ONE domain statement, whose authorisation is
 *   INSIDE the statement — `created_by = $1::uuid` plus the membership `exists` —
 *   because a privileged connection bypasses row level security and the statement's
 *   own predicate is the only gate there is;
 * - no statement carries an administrator clause or an archive filter, because
 *   `projects_update_owner` has neither;
 * - the parameters are in the documented order, with the uuid / boolean casts on
 *   the binds and never in the SQL text;
 * - the UPDATE is FIXED SQL: three different patches produce byte-identical
 *   statements and only different parameters, so no column list and no SET clause
 *   is ever assembled at run time;
 * - a refusal (a project that is not the actor's) comes back as `{updated: 0}` and
 *   NOT as a throw, because that is the shape the service maps onto the success it
 *   published before the migration;
 * - an unusable argument throws WITHOUT connecting.
 *
 * Statement-sequence assertions look only at the DOMAIN statements (the ones naming
 * `public.`), never at how many `set_config` calls the transaction helper makes or
 * how it shapes them — that belongs to `db/transaction.ts` and its own tests.
 *
 * The PGlite file beside this one
 * (`test-support/db/project-write-repository-db.test.ts`) proves PostgreSQL parses
 * and executes these statements and that they refuse exactly what the policy
 * refuses, for the same identities.
 */

const ACTOR_ID = "00000000-0000-0000-0000-0000000000a1";
const OTHER_ACTOR_ID = "00000000-0000-0000-0000-0000000000a2";

const PROJECT_ONE = "00000000-0000-0000-0000-0000000000c1";
const PROJECT_TWO = "00000000-0000-0000-0000-0000000000c2";

const BRAND_KIT_ID = "00000000-0000-0000-0000-0000000000e1";
const THUMBNAIL_PATH = "00000000-0000-0000-0000-00000000000f/project/thumbnail.webp";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

/** A pool whose single connection records every statement and answers `respond`. */
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
  return createProjectWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/**
 * The membership half of `projects_update_owner`, as the statement writes it. This
 * is the body of `private.is_workspace_member` with the actor bound as `$1`.
 */
const MEMBER_CLAUSE = `exists (select 1 from public.workspace_members m
                where m.workspace_id = p.workspace_id
                  and m.user_id = $1::uuid)`;

/** The author half plus the membership half, the whole of the policy. */
function expectOwnerAndMemberPredicate(sql: string): void {
  expect(sql).toContain("p.created_by = $1::uuid");
  expect(sql).toContain(MEMBER_CLAUSE);
  // An administrator may READ somebody else's project; the write policy does not
  // admit one, so no statement here may mention the role.
  expect(sql).not.toMatch(/admin|owner_user_id|\bm\.role\b/i);
  // The policy has no archive term: adding one would change what a re-archive does.
  expect(sql).not.toContain("archived_at is null");
  expect(sql).not.toContain(";");
}

/** Exactly one statement about `public.projects`, and it is the one asked for. */
function singleProjectStatement(harness: Harness): QueryRecord {
  const calls = domainCalls(harness.queries);
  expect(calls).toHaveLength(1);

  const call = calls[0];
  if (call === undefined) throw new Error("expected one domain statement");

  return call;
}

describe("project-write-repository: archiveOwnProject", () => {
  it("case 1: ONE update, the archive timestamp from the database clock, owner+member in the statement", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await expect(
      repositoryFor(harness).archiveOwnProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
      }),
    ).resolves.toEqual({ updated: 1 });

    const call = singleProjectStatement(harness);
    expect(call.sql).toContain("update public.projects p");
    // The timestamp is the statement's own `now()`, and no JavaScript date is bound:
    // two parameters, the actor and the project, and nothing else.
    expect(call.sql).toContain("set archived_at = now()");
    expect(call.params).toEqual([ACTOR_ID, PROJECT_ONE]);
    expect(call.sql).not.toContain(ACTOR_ID);
    expect(call.sql).not.toContain(PROJECT_ONE);
    expectOwnerAndMemberPredicate(call.sql);
  });

  it("case 2: zero rows is {updated: 0}, not a throw", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).archiveOwnProject({
        actorId: OTHER_ACTOR_ID,
        projectId: PROJECT_ONE,
      }),
    ).resolves.toEqual({ updated: 0 });

    expect(domainCalls(harness.queries)).toHaveLength(1);
  });

  it("case 3: the row id is the second bind, and the statement is exactly one write", async () => {
    const harness = createHarness(() => [{ id: PROJECT_TWO }]);

    await repositoryFor(harness).archiveOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_TWO,
    });

    const call = singleProjectStatement(harness);
    expect(call.sql).toContain("where p.id = $2::uuid");
    expect(call.sql).toContain("returning p.id");
    expect(call.params?.[1]).toBe(PROJECT_TWO);
  });
});

describe("project-write-repository: setOwnProjectThumbnail", () => {
  it("case 4: ONE update of thumbnail_path, the path bound as $3::text", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await expect(
      repositoryFor(harness).setOwnProjectThumbnail({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        thumbnailPath: THUMBNAIL_PATH,
      }),
    ).resolves.toEqual({ updated: 1 });

    const call = singleProjectStatement(harness);
    expect(call.sql).toContain("set thumbnail_path = $3::text");
    expect(call.params).toEqual([ACTOR_ID, PROJECT_ONE, THUMBNAIL_PATH]);
    expect(call.sql).not.toContain(THUMBNAIL_PATH);
    expectOwnerAndMemberPredicate(call.sql);
  });

  it("case 5: zero rows is {updated: 0}, not a throw", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).setOwnProjectThumbnail({
        actorId: OTHER_ACTOR_ID,
        projectId: PROJECT_ONE,
        thumbnailPath: THUMBNAIL_PATH,
      }),
    ).resolves.toEqual({ updated: 0 });
  });
});

describe("project-write-repository: updateOwnProject", () => {
  it("case 6: a name-only patch binds [actor, project, true, name, false, null]", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await expect(
      repositoryFor(harness).updateOwnProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        patch: { name: "Renamed" },
      }),
    ).resolves.toEqual({ updated: 1 });

    const call = singleProjectStatement(harness);
    expect(call.params).toEqual([ACTOR_ID, PROJECT_ONE, true, "Renamed", false, null]);
    expect(call.sql).toContain(
      "set name = case when $3::boolean then $4::text else p.name end",
    );
    expect(call.sql).toContain(
      "brand_kit_id = case when $5::boolean then $6::uuid else p.brand_kit_id end",
    );
    expectOwnerAndMemberPredicate(call.sql);
  });

  it("case 7: a brand-kit-only patch binds [actor, project, false, null, true, id]", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await repositoryFor(harness).updateOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      patch: { brand_kit_id: BRAND_KIT_ID },
    });

    const call = singleProjectStatement(harness);
    expect(call.params).toEqual([
      ACTOR_ID,
      PROJECT_ONE,
      false,
      null,
      true,
      BRAND_KIT_ID,
    ]);
  });

  it("case 8: three different patches produce BYTE-IDENTICAL SQL", async () => {
    const patches = [
      { name: "One" },
      { brand_kit_id: BRAND_KIT_ID },
      { name: "Two", brand_kit_id: null },
    ] as const;

    const statements: string[] = [];

    for (const patch of patches) {
      const harness = createHarness(() => [{ id: PROJECT_ONE }]);
      await repositoryFor(harness).updateOwnProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        patch,
      });
      statements.push(singleProjectStatement(harness).sql);
    }

    // This is the whole point of the flags: no SET clause is ever assembled, so the
    // three are the same statement and only the binds differ.
    expect(statements[0]).toBe(statements[1]);
    expect(statements[1]).toBe(statements[2]);
  });

  it("case 9: an explicit null brand_kit_id and an absent one differ in the FLAG, not the SQL", async () => {
    const withNull = createHarness(() => [{ id: PROJECT_ONE }]);
    const absent = createHarness(() => [{ id: PROJECT_ONE }]);

    await repositoryFor(withNull).updateOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      patch: { brand_kit_id: null },
    });
    await repositoryFor(absent).updateOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      patch: { name: "Kept" },
    });

    const cleared = singleProjectStatement(withNull);
    const untouched = singleProjectStatement(absent);

    expect(cleared.sql).toBe(untouched.sql);
    // "clear the binding" is the flag being TRUE with a null value …
    expect(cleared.params).toEqual([ACTOR_ID, PROJECT_ONE, false, null, true, null]);
    // … and "leave it alone" is the flag being false.
    expect(untouched.params).toEqual([
      ACTOR_ID,
      PROJECT_ONE,
      true,
      "Kept",
      false,
      null,
    ]);
  });

  it("case 10: an empty patch is a well-defined no-op write with both flags false", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await repositoryFor(harness).updateOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      patch: {},
    });

    const call = singleProjectStatement(harness);
    expect(call.params).toEqual([ACTOR_ID, PROJECT_ONE, false, null, false, null]);
  });

  it("case 11: zero rows is {updated: 0}, not a throw", async () => {
    const harness = createHarness(() => []);

    await expect(
      repositoryFor(harness).updateOwnProject({
        actorId: OTHER_ACTOR_ID,
        projectId: PROJECT_ONE,
        patch: { name: "Nope" },
      }),
    ).resolves.toEqual({ updated: 0 });
  });
});

describe("project-write-repository: unusable arguments never connect", () => {
  it("case 12: an empty actorId throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    const error = await repositoryFor(harness)
      .archiveOwnProject({ actorId: "", projectId: PROJECT_ONE })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectWriteError);
    expect((error as ProjectWriteError).operation).toBe(ARCHIVE_OWN_PROJECT);
    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toEqual([]);
  });

  it("case 13: an empty projectId throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);
    const repository = repositoryFor(harness);

    for (const call of [
      () => repository.archiveOwnProject({ actorId: ACTOR_ID, projectId: "" }),
      () =>
        repository.setOwnProjectThumbnail({
          actorId: ACTOR_ID,
          projectId: "",
          thumbnailPath: THUMBNAIL_PATH,
        }),
      () =>
        repository.updateOwnProject({
          actorId: ACTOR_ID,
          projectId: "",
          patch: { name: "x" },
        }),
    ]) {
      const error = await call().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ProjectWriteError);
    }

    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 14: an empty thumbnailPath throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    const error = await repositoryFor(harness)
      .setOwnProjectThumbnail({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        thumbnailPath: "",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectWriteError);
    expect((error as ProjectWriteError).operation).toBe(SET_OWN_PROJECT_THUMBNAIL);
    expect(harness.connectAttempts()).toBe(0);
  });

  it("case 15: an empty name in the patch throws without opening a connection", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    const error = await repositoryFor(harness)
      .updateOwnProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        patch: { name: "" },
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectWriteError);
    expect((error as ProjectWriteError).operation).toBe(UPDATE_OWN_PROJECT);
    expect(harness.connectAttempts()).toBe(0);
  });
});

describe("project-write-repository: failures are classified and name nothing", () => {
  it("case 16: a SQL failure is a ProjectWriteError naming the operation, with the driver error as cause", async () => {
    const driver = Object.assign(new Error("invalid input syntax for type uuid"), {
      code: "22P02",
    });
    const harness = createHarness(() => [], { sqlError: driver });

    const error = await repositoryFor(harness)
      .archiveOwnProject({ actorId: ACTOR_ID, projectId: "not-a-uuid" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectWriteError);
    expect((error as ProjectWriteError).operation).toBe(ARCHIVE_OWN_PROJECT);
    expect((error as ProjectWriteError).cause).toBe(driver);
    // The message names the operation and nothing else: no SQL, no host, no id.
    expect((error as ProjectWriteError).message).toBe(
      "project write failed (archiveOwnProject)",
    );
    expect((error as ProjectWriteError).message).not.toMatch(
      /public\.|created_by|postgres:\/\//i,
    );
  });

  it("case 17: a connect failure is classified the same way, and the transaction never begins", async () => {
    const driver = new Error("Connection terminated unexpectedly");
    const harness = createHarness(() => [], { connectError: driver });

    const error = await repositoryFor(harness)
      .updateOwnProject({
        actorId: ACTOR_ID,
        projectId: PROJECT_ONE,
        patch: { name: "x" },
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProjectWriteError);
    expect((error as ProjectWriteError).operation).toBe(UPDATE_OWN_PROJECT);
    expect((error as ProjectWriteError).cause).toBe(driver);
    expect(harness.queries).toEqual([]);
  });

  it("case 18: the actor rides along in the transaction context, so a privileged write is not anonymous", async () => {
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);

    await repositoryFor(harness).archiveOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
    });

    // The context statement is the transaction helper's; the actor has to be in it.
    const settings = harness.queries.find(
      (entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting,
    );
    expect(settings?.params).toContain(ACTOR_ID);
  });

  it("case 19: no method of this module can reach PostgREST", async () => {
    // A structural guard: the fake pool below has no table-accessor surface at all,
    // so a call that tried would not compile — and the SQL is the only way out.
    const harness = createHarness(() => [{ id: PROJECT_ONE }]);
    const repository = repositoryFor(harness);

    await repository.archiveOwnProject({ actorId: ACTOR_ID, projectId: PROJECT_ONE });
    await repository.setOwnProjectThumbnail({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      thumbnailPath: THUMBNAIL_PATH,
    });
    await repository.updateOwnProject({
      actorId: ACTOR_ID,
      projectId: PROJECT_ONE,
      patch: { name: "x" },
    });

    expect(domainCalls(harness.queries)).toHaveLength(3);
  });
});
