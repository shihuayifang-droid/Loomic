import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CREATE_ACCEPTED_RUN,
  AgentRunWriteError,
  UPDATE_RUN,
  createAgentRunWriteRepository,
  type AgentRunWriteRepository,
} from "../../db/agent-run-write-repository.js";
import type {
  TransactionConnection,
  TransactionPool,
} from "../../db/transaction.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "./pglite-db.js";

/**
 * Real-SQL integration for the agent run metadata repository (workorder 21G).
 *
 * The unit tests beside the repository prove WHICH two statements are built. This
 * file proves PostgreSQL actually parses and executes them against the real
 * `agent_runs` table, and that the semantics of the two replaced PostgREST writes
 * survive the move:
 *
 *   - the accepted insert lands with exactly the five columns the replaced insert
 *     sent, and the columns it did not name keep their defaults;
 *   - the caller-supplied id really is the PRIMARY KEY, so replaying an insert
 *     (which the service does after a lost response) is a real duplicate-key
 *     error and never a second run;
 *   - a malformed uuid and a missing session (the foreign key) are real SQL
 *     errors whose ROLLBACK leaves the pool usable, and a broken answer rolls a
 *     really-executed insert back;
 *   - the update moves a run through all four states the CHECK accepts, refuses a
 *     fifth, and keeps moving a row that is already terminal — there is no
 *     transition predicate;
 *   - the update writes each optional column only when the caller supplied it,
 *     and NEVER clears one it was not given, including when the caller passes the
 *     empty string the replaced patch object treated as "say nothing";
 *   - an unknown run id updates zero rows, and that is a legal answer: the call
 *     resolves and nothing in the table moves;
 *   - the transaction context is a privileged one with NO actor, and none of the
 *     four settings survives the call.
 *
 * The database is PGlite: in-process, in-repo, no server, no socket, no
 * `DATABASE_URL`, no connection to any host. Its session is the database OWNER,
 * so it BYPASSES RLS — which is exactly the point: every duplicate-key, foreign
 * key and CHECK refusal below happens although RLS is not the thing deciding, so
 * what is being measured is the schema and the statements, not a policy.
 *
 * One instance is migrated in `beforeAll`, the fixture is built through the real
 * signup trigger and the real tables, and `afterAll` closes it. PGlite holds ONE
 * session, so nothing here runs concurrently and no case may leave a transaction
 * open for the next one.
 */

const OWNER_ID = "00000000-0000-0000-0000-0000000007a1";

const TEAM_NAME = "HaHart Agent Run Write Repository Team";
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

const PROJECT_ID = "aa7a0000-0000-4000-8000-000000000001";
const CANVAS_ID = "bb7a0000-0000-4000-8000-000000000001";
const SESSION_ID = "cc7a0000-0000-4000-8000-000000000001";

/** Not a uuid: PostgreSQL itself must reject this bind parameter. */
const INVALID_ID = "not-a-uuid";

/** A uuid-position bind carrying SQL. It can only ever be a malformed uuid. */
const INJECTION_ID = "' or '1'='1";

const INSERTED_RUN = "dd7a0000-0000-4000-8000-000000000001";
const DUPLICATE_RUN = "dd7a0000-0000-4000-8000-000000000002";
const FOREIGN_KEY_RUN = "dd7a0000-0000-4000-8000-000000000003";
const INVALID_ID_RUN = "dd7a0000-0000-4000-8000-000000000004";
const ROLLBACK_RUN = "dd7a0000-0000-4000-8000-000000000005";
const SHAPE_RUN = "dd7a0000-0000-4000-8000-000000000006";
const STATE_RUN = "dd7a0000-0000-4000-8000-000000000007";
const OPTIONAL_RUN = "dd7a0000-0000-4000-8000-000000000008";
const CONTEXT_RUN = "dd7a0000-0000-4000-8000-000000000009";
const OBSERVED_RUN = "dd7a0000-0000-4000-8000-00000000000c";
const MISSING_SESSION = "cc7a0000-0000-4000-8000-00000000000f";

const MISSING_RUN = "dd7a0000-0000-4000-8000-0000000000ff";

const READ_SETTINGS_SQL = `
select
  current_setting('app.user_id', true) as user_id,
  current_setting('app.workspace_id', true) as workspace_id,
  current_setting('app.role', true) as role,
  current_setting('app.execution_mode', true) as execution_mode
`;

const SETTINGS_GONE_SQL = `
select
  nullif(current_setting('app.user_id', true), '') is null as user_id,
  nullif(current_setting('app.workspace_id', true), '') is null as workspace_id,
  nullif(current_setting('app.role', true), '') is null as role,
  nullif(current_setting('app.execution_mode', true), '') is null as execution_mode
`;

type AgentRunRecord = Record<string, unknown> & {
  id: string;
  session_id: string;
  thread_id: string;
  status: string;
  model: string | null;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

type SettingsRow = {
  user_id: string;
  workspace_id: string;
  role: string;
  execution_mode: string;
};

type SettingsGoneRow = {
  user_id: boolean;
  workspace_id: boolean;
  role: boolean;
  execution_mode: boolean;
};

let db: PGlite;
let pool: TransactionPool;
let repository: AgentRunWriteRepository;
let teamWorkspaceId = "";

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function runRow(runId: string): Promise<AgentRunRecord | null> {
  const rows = (
    await db.query<AgentRunRecord>(
      "select * from public.agent_runs where id = $1",
      [runId],
    )
  ).rows;
  return rows[0] ?? null;
}

async function requiresRunRow(runId: string): Promise<AgentRunRecord> {
  const row = await runRow(runId);
  if (row === null) throw new Error(`agent run ${runId} is missing`);
  return row;
}

async function runStatus(runId: string): Promise<string> {
  return (await requiresRunRow(runId)).status;
}

/** Every run's status, for "the table did not move" assertions. */
async function allRuns(): Promise<Array<{ id: string; status: string }>> {
  return (
    await db.query<{ id: string; status: string }>(
      "select id, status from public.agent_runs order by id",
    )
  ).rows;
}

async function rowsOf(sql: string): Promise<number> {
  return firstRow((await db.query<{ n: number }>(sql)).rows).n;
}

/** Seed a session the accepted insert may reference. */
async function seedSession(id: string): Promise<void> {
  await db.query(
    `insert into public.chat_sessions (
       id, canvas_id, title, created_by, created_at, updated_at
     )
     values ($1, $2, 'agent run session', $3, $4, $4)`,
    [id, CANVAS_ID, OWNER_ID, SEEDED_AT],
  );
}

function acceptedInput(
  overrides: Partial<
    Parameters<AgentRunWriteRepository["createAcceptedRun"]>[0]
  > = {},
) {
  return {
    runId: INSERTED_RUN,
    sessionId: SESSION_ID,
    threadId: "thread-21g",
    ...overrides,
  };
}

/** The repository call, with the refusal captured instead of thrown. */
async function refusal(
  operation: "create" | "update",
  input: Record<string, unknown>,
): Promise<AgentRunWriteError> {
  const call =
    operation === "create"
      ? repository.createAcceptedRun(
          input as Parameters<AgentRunWriteRepository["createAcceptedRun"]>[0],
        )
      : repository.updateRun(
          input as Parameters<AgentRunWriteRepository["updateRun"]>[0],
        );

  const error = await call.catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(AgentRunWriteError);
  const writeError = error as AgentRunWriteError;
  expect(writeError.operation).toBe(
    operation === "create" ? CREATE_ACCEPTED_RUN : UPDATE_RUN,
  );
  expect(writeError.message).toBe(
    `agent run write failed (${
      operation === "create" ? CREATE_ACCEPTED_RUN : UPDATE_RUN
    })`,
  );
  return writeError;
}

beforeAll(async () => {
  const created = await createMigratedDb();
  db = created.db;
  pool = createPGliteTransactionPool(db);
  repository = createAgentRunWriteRepository({ getTransactionPool: () => pool });

  // Real signup path: the trigger builds the profile, the personal workspace and
  // the owner membership.
  await createUser(db, OWNER_ID, "agent-run-write@hahart.test");

  teamWorkspaceId = firstRow(
    (
      await db.query<{ id: string }>(
        `insert into public.workspaces (type, name, owner_user_id)
         values ('team', $1, $2) returning id`,
        [TEAM_NAME, OWNER_ID],
      )
    ).rows,
  ).id;

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner')`,
    [teamWorkspaceId, OWNER_ID],
  );

  // `chat_sessions` needs a canvas and a canvas needs a project: the accepted
  // insert's foreign key is exercised through the real chain, not a stub.
  await db.query(
    `insert into public.projects (
       id, workspace_id, name, slug, description, created_by, created_at, updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      PROJECT_ID,
      teamWorkspaceId,
      "Agent run project",
      // `slug` is text and `id` is a uuid, so they need separate bind parameters:
      // one position cannot be deduced as both.
      PROJECT_ID,
      "fixture",
      OWNER_ID,
      SEEDED_AT,
    ],
  );
  await db.query(
    `insert into public.canvases (id, project_id, name, is_primary, created_by, content, version)
     values ($1, $2, 'Agent run canvas', false, $3,
             '{"elements":[],"appState":{},"files":{}}'::jsonb, 1)`,
    [CANVAS_ID, PROJECT_ID, OWNER_ID],
  );
  await seedSession(SESSION_ID);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("agent run write repository: the schema and the fixture it measures", () => {
  it("case 1: the CHECK, the primary key and the session foreign key are the ones under test", async () => {
    // A guard against silently measuring an old schema: the update's four legal
    // states and the insert's duplicate answer are decided by exactly these
    // constraints, so they are read from the catalogue rather than assumed.
    const checks = (
      await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.agent_runs'::regclass and contype = 'c'`,
      )
    ).rows.map((row) => row.def);
    expect(checks).toHaveLength(1);
    for (const state of ["accepted", "running", "completed", "failed"]) {
      expect(checks[0]).toContain(state);
    }

    const keys = (
      await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.agent_runs'::regclass and contype in ('p', 'f')`,
      )
    ).rows.map((row) => row.def);

    expect(keys.some((def) => /PRIMARY KEY \(id\)/.test(def))).toBe(true);
    expect(keys.some((def) => /FOREIGN KEY \(session_id\)/.test(def))).toBe(true);

    // The fixture starts with no run at all, so every case below states its own.
    expect(await rowsOf("select count(*)::int as n from public.agent_runs")).toBe(
      0,
    );
  });
});

describe("agent run write repository: the accepted insert", () => {
  it("case 2: the accepted row lands with exactly the columns the replaced insert sent", async () => {
    await repository.createAcceptedRun(
      acceptedInput({ model: "deepseek:deepseek-chat" }),
    );

    const row = await requiresRunRow(INSERTED_RUN);
    expect(row.session_id).toBe(SESSION_ID);
    expect(row.thread_id).toBe("thread-21g");
    expect(row.status).toBe("accepted");
    expect(row.model).toBe("deepseek:deepseek-chat");
    // The three columns the replaced insert never named keep the values the
    // schema gives them, and `created_at` keeps its default.
    expect(row.completed_at).toBeNull();
    expect(row.error_code).toBeNull();
    expect(row.error_message).toBeNull();
    expect(row.created_at).not.toBeNull();
  });

  it("case 3: an absent model is NULL while an empty model stays an empty string", async () => {
    const noModel = "dd7a0000-0000-4000-8000-00000000000a";
    const emptyModel = "dd7a0000-0000-4000-8000-00000000000b";

    await repository.createAcceptedRun(acceptedInput({ runId: noModel }));
    await repository.createAcceptedRun(
      acceptedInput({ runId: emptyModel, model: "" }),
    );

    expect((await requiresRunRow(noModel)).model).toBeNull();
    expect((await requiresRunRow(emptyModel)).model).toBe("");
  });

  it("case 4: the same runId twice is a real primary-key error, and the first row is untouched", async () => {
    await repository.createAcceptedRun(
      acceptedInput({ runId: DUPLICATE_RUN, threadId: "thread-21g-dup" }),
    );
    const before = await requiresRunRow(DUPLICATE_RUN);

    // The replay the service performs after a lost response lands here. `on
    // conflict do nothing` would have answered success instead; the statement has
    // no such clause, so the duplicate is the real error the caller must see.
    const error = await refusal("create", {
      runId: DUPLICATE_RUN,
      sessionId: SESSION_ID,
      threadId: "thread-21g-dup-replay",
    });

    expect((error.cause as Error).message).toMatch(
      /duplicate key value violates unique constraint|agent_runs_pkey/i,
    );
    // Nothing about the first row moved — not the thread, not the status.
    expect(await requiresRunRow(DUPLICATE_RUN)).toEqual(before);
  });

  it("case 5: a missing session is a real foreign-key error and the table does not move", async () => {
    const before = await allRuns();

    const error = await refusal("create", {
      runId: FOREIGN_KEY_RUN,
      sessionId: MISSING_SESSION,
      threadId: "thread-21g-fk",
    });

    expect((error.cause as Error).message).toMatch(
      /violates foreign key constraint/i,
    );
    // The failed transaction rolled back, so no half-accepted run was left behind.
    expect(await allRuns()).toEqual(before);
  });

  it("case 6: a malformed uuid is a real SQL error, wrapped, and the pool stays usable", async () => {
    const before = await allRuns();

    // Independent of the repository: the server itself rejects the bind.
    await expect(
      db.query("select id from public.agent_runs where id = $1::uuid", [
        INVALID_ID,
      ]),
    ).rejects.toThrow(/invalid input syntax for type uuid/);

    const error = await refusal("create", {
      runId: INVALID_ID,
      sessionId: SESSION_ID,
      threadId: "thread-21g-bad-id",
    });

    // The fixed message carries no SQL, no host and no existence answer.
    expect(error.message).not.toMatch(/public\.|agent_runs|invalid input|postgres:\/\//i);
    expect((error.cause as Error).message).toMatch(
      /invalid input syntax for type uuid/,
    );
    expect(await allRuns()).toEqual(before);

    // The failed transaction rolled back, so the very same pool still works.
    await repository.createAcceptedRun(
      acceptedInput({ runId: INVALID_ID_RUN, threadId: "thread-21g-after-bad" }),
    );
    expect(await runStatus(INVALID_ID_RUN)).toBe("accepted");
  });

  it("case 7: ids and thread ids carrying SQL are only binds", async () => {
    const before = await allRuns();

    for (const runId of [INJECTION_ID, `' or id is not null --`]) {
      const error = await refusal("create", {
        runId,
        sessionId: SESSION_ID,
        threadId: "thread-21g-injection",
      });
      expect(error.cause).toBeInstanceOf(Error);
    }

    // If an id had been concatenated, the values above would have inserted or
    // selected something instead of failing as malformed uuids.
    expect(await allRuns()).toEqual(before);
  });
});

describe("agent run write repository: the run update", () => {
  it("case 8: a run moves through all four states, and a fifth is refused by the CHECK", async () => {
    await repository.createAcceptedRun(
      acceptedInput({ runId: STATE_RUN, threadId: "thread-21g-state" }),
    );
    expect(await runStatus(STATE_RUN)).toBe("accepted");

    for (const status of ["running", "completed", "failed", "accepted"] as const) {
      await repository.updateRun({ runId: STATE_RUN, status });
      expect(await runStatus(STATE_RUN)).toBe(status);
    }

    // `failed` -> `accepted` above is the point: there is NO transition
    // predicate, so a terminal run still moves, exactly as the replaced statement
    // allowed. The four-state rule is the CHECK's, and a value outside it is the
    // database's refusal, not this module's.
    const error = await refusal("update", {
      runId: STATE_RUN,
      status: "succeeded",
    });
    expect((error.cause as Error).message).toMatch(/violates check constraint/i);
    expect(await runStatus(STATE_RUN)).toBe("accepted");
  });

  it("case 9: an optional column is written only when it is given, and never cleared", async () => {
    await repository.createAcceptedRun(
      acceptedInput({ runId: OPTIONAL_RUN, threadId: "thread-21g-optional" }),
    );

    // 1. All three optional fields supplied: all three land.
    await repository.updateRun({
      runId: OPTIONAL_RUN,
      status: "failed",
      completedAt: "2026-10-14T01:02:03.000Z",
      errorCode: "run_failed",
      errorMessage: "boom",
    });
    const patched = await requiresRunRow(OPTIONAL_RUN);
    expect(patched.status).toBe("failed");
    expect(new Date(patched.completed_at ?? "").toISOString()).toBe(
      "2026-10-14T01:02:03.000Z",
    );
    expect(patched.error_code).toBe("run_failed");
    expect(patched.error_message).toBe("boom");

    // 2. A subsequent status-only update must not clear any of them. This is the
    //    case a naive port breaks: a bind of NULL, or of the empty string the
    //    replaced patch object treated as "say nothing", would wipe the columns.
    await repository.updateRun({ runId: OPTIONAL_RUN, status: "completed" });

    const afterStatusOnly = await requiresRunRow(OPTIONAL_RUN);
    expect(afterStatusOnly.status).toBe("completed");
    expect(afterStatusOnly.completed_at).toEqual(patched.completed_at);
    expect(afterStatusOnly.error_code).toBe("run_failed");
    expect(afterStatusOnly.error_message).toBe("boom");

    // The whole row, column by column: the status is the only thing that moved.
    const moved = Object.keys(afterStatusOnly).filter(
      (column) =>
        JSON.stringify(afterStatusOnly[column]) !==
        JSON.stringify(patched[column]),
    );
    expect(moved).toEqual(["status"]);

    // 3. The empty string says nothing too, for every optional field.
    await repository.updateRun({
      runId: OPTIONAL_RUN,
      status: "running",
      completedAt: "",
      errorCode: "",
      errorMessage: "",
    });

    const afterEmptyStrings = await requiresRunRow(OPTIONAL_RUN);
    expect(afterEmptyStrings.status).toBe("running");
    expect(afterEmptyStrings.completed_at).toEqual(patched.completed_at);
    expect(afterEmptyStrings.error_code).toBe("run_failed");
    expect(afterEmptyStrings.error_message).toBe("boom");
  });

  it("case 10: an unknown run id updates zero rows and still succeeds", async () => {
    await repository.createAcceptedRun(
      acceptedInput({ runId: CONTEXT_RUN, threadId: "thread-21g-context" }),
    );
    const before = await allRuns();

    // Zero rows is a LEGAL answer here, unlike the 21D profile write and the 21E1
    // settings write: the replaced PostgREST chain asked for no row back, so
    // "nothing matched" resolved exactly like "one row matched". Folding it into
    // an error would be a new refusal the caller never had.
    await expect(
      repository.updateRun({
        runId: MISSING_RUN,
        status: "completed",
        completedAt: "2026-10-14T01:02:03.000Z",
      }),
    ).resolves.toBeUndefined();

    expect(await allRuns()).toEqual(before);
  });

  it("case 11: the update writes only the named columns on the named row", async () => {
    const before = await requiresRunRow(CONTEXT_RUN);

    await repository.updateRun({
      runId: CONTEXT_RUN,
      status: "failed",
      errorCode: "executor_error",
    });

    const after = await requiresRunRow(CONTEXT_RUN);

    // `where id = $1` is the only predicate, so the row is reachable whatever its
    // status; and the columns the patch did not name are untouched.
    expect(after.status).toBe("failed");
    expect(after.error_code).toBe("executor_error");
    expect(after.completed_at).toBe(before.completed_at);
    expect(after.error_message).toBe(before.error_message);
    expect(after.model).toBe(before.model);
    expect(after.session_id).toBe(before.session_id);
    expect(after.thread_id).toBe(before.thread_id);
    expect(after.created_at).toEqual(before.created_at);

    const moved = Object.keys(after).filter(
      (column) =>
        JSON.stringify(after[column]) !== JSON.stringify(before[column]),
    );
    expect(moved.sort()).toEqual(["error_code", "status"]);
  });
});

describe("agent run write repository: rollback, context and the fixture", () => {
  it("case 12: a SQL failure rolls back and leaves the same pool usable", async () => {
    // A real statement-level failure: the projection names a column that does not
    // exist, so PostgreSQL rejects the statement (SQLSTATE 42703) inside the
    // transaction.
    const brokenPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            if (sql.includes("public.agent_runs")) {
              return inner.query(
                sql.replace("returning id", "returning id, no_such_column"),
                params,
              );
            }
            return inner.query(sql, params);
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const error = await createAgentRunWriteRepository({
      getTransactionPool: () => brokenPool,
    })
      .createAcceptedRun(
        acceptedInput({ runId: ROLLBACK_RUN, threadId: "thread-21g-rollback" }),
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentRunWriteError);
    expect((error as AgentRunWriteError).message).not.toMatch(
      /public\.|agent_runs|no_such_column/i,
    );
    expect(((error as AgentRunWriteError).cause as Error).message).toMatch(
      /no_such_column/,
    );
    expect(await runRow(ROLLBACK_RUN)).toBeNull();

    // Same pool, next call: works.
    await repository.createAcceptedRun(
      acceptedInput({ runId: ROLLBACK_RUN, threadId: "thread-21g-rollback-2" }),
    );
    expect(await runStatus(ROLLBACK_RUN)).toBe("accepted");
  });

  it("case 13: a broken answer rolls back a real insert, and the pool stays usable", async () => {
    // The statement really runs and really inserts; only the ANSWER is mangled to
    // zero rows, which this module treats as a statement/mapper disagreement. The
    // rollback is therefore doing visible work.
    const manglingPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.agent_runs")) return { rows: [] };
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const error = await createAgentRunWriteRepository({
      getTransactionPool: () => manglingPool,
    })
      .createAcceptedRun(
        acceptedInput({ runId: SHAPE_RUN, threadId: "thread-21g-shape" }),
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentRunWriteError);
    expect((error as AgentRunWriteError).operation).toBe(CREATE_ACCEPTED_RUN);
    // The INSERT was undone, so no run was left behind for a caller who was told
    // the write failed.
    expect(await runRow(SHAPE_RUN)).toBeNull();

    await repository.createAcceptedRun(
      acceptedInput({ runId: SHAPE_RUN, threadId: "thread-21g-shape-2" }),
    );
    expect(await runStatus(SHAPE_RUN)).toBe("accepted");
  });

  it("case 14: a privileged write with NO actor, and none of the settings survives", async () => {
    const observed: SettingsRow[] = [];

    // A pool that reads the four settings through the SAME connection, right
    // after the repository's own statement: whatever it sees is the state of the
    // transaction the write ran in, not a reconstruction.
    const observingPool: TransactionPool = {
      async connect(): Promise<TransactionConnection> {
        const inner = await pool.connect();
        return {
          async query(sql: string, params?: readonly unknown[]) {
            const result = await inner.query(sql, params);
            if (sql.includes("public.agent_runs")) {
              observed.push(
                firstRow((await inner.query(READ_SETTINGS_SQL)).rows) as SettingsRow,
              );
            }
            return result;
          },
          release(error?: Error | boolean) {
            inner.release(error);
          },
        };
      },
    };

    const observing = createAgentRunWriteRepository({
      getTransactionPool: () => observingPool,
    });

    await observing.createAcceptedRun(
      acceptedInput({ runId: OBSERVED_RUN, threadId: "thread-21g-observed" }),
    );
    await observing.updateRun({ runId: OBSERVED_RUN, status: "completed" });

    expect(observed).toHaveLength(2);
    // No forged user: a run row records the run, so every actor setting is empty
    // and the mode is the explicit privileged label.
    for (const settings of observed) {
      expect(settings).toEqual({
        user_id: "",
        workspace_id: "",
        role: "",
        execution_mode: "privileged",
      });
    }

    // And immediately after COMMIT the same four settings are gone, so the
    // context of this write cannot become the context of the next one.
    const gone = firstRow((await db.query<SettingsGoneRow>(SETTINGS_GONE_SQL)).rows);
    expect(gone).toEqual({
      user_id: true,
      workspace_id: true,
      role: true,
      execution_mode: true,
    });

    // The same pool is still usable after both kinds of write.
    expect(await runStatus(OBSERVED_RUN)).toBe("completed");
  });

  it("case 15: the two writes are the only way this repository can touch the table", async () => {
    // A shape check against the module, not a promise: there is no third method
    // and no parameter through which a caller could address another table.
    expect(Object.keys(repository).sort()).toEqual(
      [CREATE_ACCEPTED_RUN, UPDATE_RUN].sort(),
    );

    const before = await allRuns();
    await expect(
      repository.updateRun({ runId: SESSION_ID, status: "running" }),
    ).resolves.toBeUndefined();
    expect(await allRuns()).toEqual(before);
  });
});
