import { describe, expect, it } from "vitest";

import {
  CREATE_ACCEPTED_RUN,
  AgentRunWriteError,
  UPDATE_RUN,
  createAgentRunWriteRepository,
  type AgentRunWriteRepository,
} from "./agent-run-write-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the two statements
 * the repository issues, the actor context they carry (none), which columns each
 * may write, and how it classifies every way they can answer.
 *
 * The unit tests here prove WHICH statements are built — an insert with no
 * conflict clause and a fixed `accepted` status, an update whose assignment list
 * is exactly the patch the replaced service built, and a zero-row answer that is
 * legal for one statement and impossible for the other. The PGlite file beside
 * them (`test-support/db/agent-run-write-repository-db.test.ts`) proves PostgreSQL
 * actually parses, executes and rolls those statements back against the real
 * `agent_runs` table, its primary key, its foreign key and its four-state CHECK.
 */

const RUN_ID = "00000000-0000-0000-0000-0000000000a1";
const SESSION_ID = "00000000-0000-0000-0000-0000000000a2";
const THREAD_ID = "thread-21g";

/** A row shaped the way `RETURNING id` answers. */
const INSERTED_ROW = { id: RUN_ID };

/**
 * A uuid-position bind carrying SQL. It is a bind parameter, so it can only ever
 * be a (malformed) uuid literal — if it were ever concatenated it would rewrite
 * the statement. This value exists to prove it does not.
 */
const INJECTION_ID = "' or status is not null --";

/** The same idea in a value-position bind: it must never become statement text. */
const INJECTION_VALUE = "x'; update public.agent_runs set status = 'failed";

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

/**
 * The repository's own statements, and only them: BEGIN/COMMIT/set_config carry
 * no schema-qualified name, so anything naming `public.` is a domain statement. A
 * second one would mean a write was split (a read first, then a write).
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statementOf(harness: Harness): QueryRecord | undefined {
  return domainCalls(harness.queries)[0];
}

function statementText(harness: Harness): string {
  return statementOf(harness)?.sql ?? "";
}

/** The `set` list of an UPDATE, one entry per assignment, trimmed. */
function assignmentsOf(sql: string): string[] {
  const body = /set([\s\S]*?)where/i.exec(sql)?.[1] ?? "";
  return body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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

function repositoryFor(harness: Harness): AgentRunWriteRepository {
  return createAgentRunWriteRepository({
    getTransactionPool: () => harness.pool,
  });
}

/** The accepted-run call every insert case below makes, with the argument named once. */
function createAccepted(
  repository: AgentRunWriteRepository,
  overrides: Partial<{ model: string }> = {},
) {
  return repository.createAcceptedRun({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    ...overrides,
  });
}

function update(
  repository: AgentRunWriteRepository,
  input: Parameters<AgentRunWriteRepository["updateRun"]>[0],
) {
  return repository.updateRun(input);
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

describe("agent-run-write-repository: the accepted insert", () => {
  it("case 1: writes inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [INSERTED_ROW]);

    await createAccepted(repositoryFor(harness));

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
    // Exactly one domain statement: no read-back, no existence check, no second
    // insert and no cleanup.
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);

    // Bookkeeping for a run has no acting user. Every actor setting stays empty —
    // forging one from the caller would put a person on an audit trail they had
    // nothing to do with — and the mode is the explicit privileged one.
    expect(contextParams(harness.queries)).toEqual([
      [TRANSACTION_SETTING_NAMES.userId, ""],
      [TRANSACTION_SETTING_NAMES.workspaceId, ""],
      [TRANSACTION_SETTING_NAMES.role, ""],
      [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
    ]);
  });

  it("case 2: binds every value as a parameter, never as statement text", async () => {
    const harness = createHarness(() => [INSERTED_ROW]);

    await createAccepted(repositoryFor(harness));

    const statement = statementOf(harness);
    expect(statement?.params).toEqual([
      RUN_ID,
      null,
      SESSION_ID,
      THREAD_ID,
    ]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$3::uuid");
    expect(statement?.sql).not.toContain(RUN_ID);
    expect(statement?.sql).not.toContain(SESSION_ID);
    expect(statement?.sql).not.toContain(THREAD_ID);
    expect(statement?.sql).not.toContain("${");
  });

  it("case 3: names exactly the five columns of the replaced insert, with the status pinned", async () => {
    const harness = createHarness(() => [INSERTED_ROW]);

    await createAccepted(repositoryFor(harness));

    const sql = statementText(harness);
    expect(sql).toContain("insert into public.agent_runs");

    const columns = /insert into public\.agent_runs\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? "";
    expect(columns.split(",").map((part) => part.trim())).toEqual([
      "id",
      "model",
      "session_id",
      "status",
      "thread_id",
    ]);

    // `accepted` is statement text, not a bind, so no caller can steer this
    // statement to another status; and the columns the replaced insert did not
    // name — created_at above all — are still not named.
    expect(sql).toContain("'accepted'");
    expect(sql).not.toContain("created_at");
    expect(sql).toContain("returning id");
    // One statement, one table, never a batch.
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.agent_runs"]);
  });

  it("case 4: has no conflict clause and no generated id, so a duplicate runId stays a real error", async () => {
    const harness = createHarness(() => [INSERTED_ROW]);

    await createAccepted(repositoryFor(harness));

    const sql = statementText(harness).toLowerCase();
    // The id is the CALLER's, and the service replays this insert after a lost
    // response. `on conflict do nothing` would turn that replay's primary-key
    // error into a silent success — which is the failure mode this ticket must
    // not introduce. The clause is therefore absent, not merely unused.
    expect(sql).not.toContain("conflict");
    expect(sql).not.toContain("do nothing");
    expect(sql).not.toContain("gen_random_uuid");
    expect(sql).not.toContain("default");
  });

  it("case 5: an absent model stores NULL, an empty model stays an empty string", async () => {
    const absent = createHarness(() => [INSERTED_ROW]);
    await createAccepted(repositoryFor(absent));
    expect(statementOf(absent)?.params?.[1]).toBeNull();

    const empty = createHarness(() => [INSERTED_ROW]);
    await createAccepted(repositoryFor(empty), { model: "" });
    expect(statementOf(empty)?.params?.[1]).toBe("");

    const named = createHarness(() => [INSERTED_ROW]);
    await createAccepted(repositoryFor(named), { model: "deepseek:deepseek-chat" });
    expect(statementOf(named)?.params?.[1]).toBe("deepseek:deepseek-chat");
  });

  it("case 6: zero rows is a fixed write failure, not a silent success", async () => {
    const harness = createHarness(() => []);

    const error = await createAccepted(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    // A successful INSERT ... RETURNING always answers one row, so anything else
    // is a statement/mapper disagreement and nobody may be told the run landed.
    expect(error).toBeInstanceOf(AgentRunWriteError);
    expect((error as AgentRunWriteError).operation).toBe(CREATE_ACCEPTED_RUN);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("agent-run-write-repository: the run update", () => {
  it("case 7: a status-only update names one assignment and one predicate", async () => {
    const harness = createHarness(() => []);

    await update(repositoryFor(harness), { runId: RUN_ID, status: "running" });

    const statement = statementOf(harness);
    const sql = statement?.sql ?? "";
    expect(sql).toContain("update public.agent_runs");
    expect(assignmentsOf(sql)).toEqual(["status = $2::text"]);
    // The ONLY predicate is the id: no status predicate, no workspace predicate
    // and no transition rule, exactly like the replaced statement.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).not.toMatch(/and\s+status/i);
    expect(statement?.params).toEqual([RUN_ID, "running"]);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.agent_runs"]);
  });

  it("case 8: an optional column is named only when its field carries a value", async () => {
    const harness = createHarness(() => []);

    await update(repositoryFor(harness), {
      runId: RUN_ID,
      status: "failed",
      completedAt: "2026-10-14T00:00:00.000Z",
      errorCode: "run_failed",
      errorMessage: "boom",
    });

    const statement = statementOf(harness);
    expect(assignmentsOf(statement?.sql ?? "")).toEqual([
      "status = $2::text",
      "completed_at = $3::timestamptz",
      "error_code = $4::text",
      "error_message = $5::text",
    ]);
    expect(statement?.params).toEqual([
      RUN_ID,
      "failed",
      "2026-10-14T00:00:00.000Z",
      "run_failed",
      "boom",
    ]);

    // …and a caller that names only one of them gets only that one, so the other
    // two columns are not merely written with their old value: they are not in the
    // statement at all.
    const partial = createHarness(() => []);
    await update(repositoryFor(partial), {
      runId: RUN_ID,
      status: "failed",
      errorCode: "run_failed",
    });
    expect(assignmentsOf(statementText(partial))).toEqual([
      "status = $2::text",
      "error_code = $3::text",
    ]);
    expect(statementOf(partial)?.params).toEqual([RUN_ID, "failed", "run_failed"]);
  });

  it("case 9: an absent OR empty optional field leaves its column out of the statement", async () => {
    for (const input of [
      { runId: RUN_ID, status: "completed" },
      { runId: RUN_ID, status: "completed", completedAt: "" },
      { runId: RUN_ID, status: "completed", errorCode: "" },
      { runId: RUN_ID, status: "completed", errorMessage: "" },
      {
        runId: RUN_ID,
        status: "completed",
        completedAt: "",
        errorCode: "",
        errorMessage: "",
      },
    ] as const) {
      const harness = createHarness(() => []);

      await update(repositoryFor(harness), input);

      const sql = statementText(harness);
      // The replaced patch object spread a key in only when its value was truthy,
      // so the empty string meant "say nothing about this column" too. A bind of
      // the empty string, or of null, would have CLEARED the column instead.
      expect(assignmentsOf(sql)).toEqual(["status = $2::text"]);
      expect(statementOf(harness)?.params).toEqual([RUN_ID, "completed"]);
    }
  });

  it("case 10: the columns come from this module, never from a value", async () => {
    const harness = createHarness(() => []);

    await update(repositoryFor(harness), {
      runId: INJECTION_ID,
      status: "failed",
      errorMessage: INJECTION_VALUE,
    });

    const statement = statementOf(harness);
    const sql = statement?.sql ?? "";
    // Values are binds and nothing else: neither one reached the statement text.
    expect(sql).not.toContain(INJECTION_ID);
    expect(sql).not.toContain(INJECTION_VALUE);
    expect(statement?.params).toEqual([INJECTION_ID, "failed", INJECTION_VALUE]);
    // One statement, one table, and no assignment the fixed table does not name.
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.agent_runs"]);
    for (const assignment of assignmentsOf(sql)) {
      const column = assignment.split("=")[0]?.trim() ?? "";
      expect(["status", "completed_at", "error_code", "error_message"]).toContain(
        column,
      );
    }
  });

  it("case 11: zero rows resolves and the transaction commits", async () => {
    const harness = createHarness(() => []);

    // Unlike the insert above, an unknown runId is a LEGAL answer here: the
    // replaced PostgREST chain asked for no row back, so "nothing matched" and
    // "one row matched" were the same resolved promise. Making it a failure now
    // would be a new refusal the caller never had.
    await expect(
      update(repositoryFor(harness), { runId: RUN_ID, status: "completed" }),
    ).resolves.toBeUndefined();

    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(harness.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 12: the run id keeps parameter $1 however many columns are named", async () => {
    const inputs = [
      { runId: RUN_ID, status: "running" },
      { runId: RUN_ID, status: "running", errorCode: "e" },
      { runId: RUN_ID, status: "running", errorCode: "e", errorMessage: "m" },
      {
        runId: RUN_ID,
        status: "running",
        completedAt: "2026-10-14T00:00:00.000Z",
        errorCode: "e",
        errorMessage: "m",
      },
    ] as const;

    for (const input of inputs) {
      const harness = createHarness(() => []);

      await update(repositoryFor(harness), input);

      const statement = statementOf(harness);
      const sql = statement?.sql ?? "";
      const params = statement?.params ?? [];

      expect(sql).toContain("where id = $1::uuid");
      expect(params[0]).toBe(RUN_ID);

      // Every placeholder is used exactly once and the numbering has no gap: a
      // duplicate or a skipped index would bind a value into the wrong column.
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(new Set(placeholders).size).toBe(placeholders.length);
      expect(Math.max(...placeholders)).toBe(params.length);
      expect(placeholders).toContain(1);

      // The number of assignments is exactly the number of binds after the id.
      expect(assignmentsOf(sql)).toHaveLength(params.length - 1);
    }
  });
});

describe("agent-run-write-repository: refusals and wiring", () => {
  it("case 13: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "insert into public.agent_runs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await createAccepted(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(AgentRunWriteError);
    const writeError = error as AgentRunWriteError;
    expect(writeError.cause).toBe(failure);
    expect(writeError.message).toBe(
      `agent run write failed (${CREATE_ACCEPTED_RUN})`,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(writeError.message).not.toMatch(
      /public\.|agent_runs|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The run id never reaches the message either: a failure is not a lookup.
    expect(writeError.message).not.toContain(RUN_ID);
  });

  it("case 14: a connect failure is a fixed write failure and issues no statement", async () => {
    const harness = createHarness(() => [], {
      connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
    });

    const error = await update(repositoryFor(harness), {
      runId: RUN_ID,
      status: "running",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AgentRunWriteError);
    expect((error as AgentRunWriteError).operation).toBe(UPDATE_RUN);
    expect((error as AgentRunWriteError).message).not.toMatch(
      /ECONNREFUSED|10\.210\.134\.37/,
    );
    expect(harness.queries).toHaveLength(0);
  });

  it("case 15: an unusable argument is refused before any connection is opened", async () => {
    const badRunInputs: unknown[] = [
      { runId: undefined, sessionId: SESSION_ID, threadId: THREAD_ID },
      { runId: "", sessionId: SESSION_ID, threadId: THREAD_ID },
      { runId: 7, sessionId: SESSION_ID, threadId: THREAD_ID },
      { runId: RUN_ID, sessionId: "", threadId: THREAD_ID },
      { runId: RUN_ID, sessionId: null, threadId: THREAD_ID },
      { runId: RUN_ID, sessionId: SESSION_ID, threadId: "" },
      { runId: RUN_ID, sessionId: SESSION_ID, threadId: {}, model: 42 },
    ];

    for (const input of badRunInputs) {
      const harness = createHarness(() => [INSERTED_ROW]);
      const error = await repositoryFor(harness)
        .createAcceptedRun(
          input as Parameters<AgentRunWriteRepository["createAcceptedRun"]>[0],
        )
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AgentRunWriteError);
      expect((error as AgentRunWriteError).operation).toBe(CREATE_ACCEPTED_RUN);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }

    const badUpdateInputs: unknown[] = [
      { runId: "", status: "running" },
      { runId: RUN_ID, status: "" },
      { runId: RUN_ID, status: 7 },
      { runId: RUN_ID, status: "running", errorCode: 42 },
      { runId: RUN_ID, status: "running", errorMessage: {} },
      { runId: RUN_ID, status: "running", completedAt: 42 },
    ];

    for (const input of badUpdateInputs) {
      const harness = createHarness(() => []);
      const error = await repositoryFor(harness)
        .updateRun(
          input as Parameters<AgentRunWriteRepository["updateRun"]>[0],
        )
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AgentRunWriteError);
      expect((error as AgentRunWriteError).operation).toBe(UPDATE_RUN);
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 16: the repository exposes the two writes and nothing else", async () => {
    const harness = createHarness(() => [INSERTED_ROW]);
    const repository = repositoryFor(harness);

    // Requirement 1 of workorder 21G, as a shape rather than a promise: there is
    // no third method, no access token, no actor, no table parameter and no
    // generic patch entry point a caller could widen either write with.
    expect(Object.keys(repository)).toEqual([
      CREATE_ACCEPTED_RUN,
      UPDATE_RUN,
    ]);
    expect(repository.createAcceptedRun).toHaveLength(1);
    expect(repository.updateRun).toHaveLength(1);

    await createAccepted(repository);

    expect(statementOf(harness)?.params).toEqual([
      RUN_ID,
      null,
      SESSION_ID,
      THREAD_ID,
    ]);
  });

  it("case 17: building never resolves a pool; a missing DATABASE_URL fails on the write", async () => {
    let resolutions = 0;
    const repository = createAgentRunWriteRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const error = await createAccepted(repository).catch(
      (reason: unknown) => reason,
    );

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(AgentRunWriteError);
    expect((error as AgentRunWriteError).operation).toBe(CREATE_ACCEPTED_RUN);
    // The fixed message is the only thing a caller may surface: no connection
    // string, no environment variable name.
    expect((error as AgentRunWriteError).message).not.toMatch(
      /DATABASE_URL|postgres:\/\//,
    );
  });
});
