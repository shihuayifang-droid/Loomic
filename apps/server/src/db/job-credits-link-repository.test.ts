import { describe, expect, it } from "vitest";

import {
  CLAIM_UNLINKED_CHARGE,
  CREDITS_LINK_REFUNDED_ERROR_CODE,
  CREDITS_LINK_REFUNDED_MESSAGE,
  CREDITS_REFUND_PENDING_ERROR_CODE,
  CREDITS_REFUND_PENDING_MESSAGE,
  JobCreditsLinkError,
  LINK_CREDITS,
  MARK_CHARGE_REFUNDED,
  createJobCreditsLinkRepository,
  type JobCreditsLinkRepository,
} from "./job-credits-link-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * These tests drive the real repository against a recording fake pool. No
 * database and no `DATABASE_URL` are involved: the point is the three statements
 * the repository issues, the actor context they carry (none), which columns each
 * write may touch, and how every way those statements can answer is classified.
 *
 * The unit tests prove WHICH statements are built — one predicate-guarded UPDATE
 * per method, with the whole rule in the `where` clause and no read-then-write
 * pair anywhere. The PGlite file beside them
 * (`test-support/db/job-credits-link-repository-db.test.ts`) proves PostgreSQL
 * actually parses, executes and rolls them back, and that the predicates really
 * are the atomic rules this module claims they are.
 */

const JOB_ID = "00000000-0000-0000-0000-0000000000b1";
const TRANSACTION_ID = "00000000-0000-0000-0000-0000000000b2";
const CREDITS_COST = 10;

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
 * no schema-qualified name, so anything naming `public.` is a domain statement.
 * A second one would mean a method split its work into a read and a write.
 */
function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function statementText(queries: readonly QueryRecord[]): string {
  return domainCalls(queries)[0]?.sql ?? "";
}

/** The `set ... where` clause of a statement, verbatim. */
function setClause(sql: string): string {
  return /set([\s\S]*?)where/i.exec(sql)?.[1] ?? "";
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

function repositoryFor(harness: Harness): JobCreditsLinkRepository {
  return createJobCreditsLinkRepository({
    getTransactionPool: () => harness.pool,
  });
}

function lastStatement(harness: Harness): string | undefined {
  return harness.queries.map((entry) => entry.sql).at(-1);
}

/** The link call every link case makes, with its arguments named once. */
function link(
  repository: JobCreditsLinkRepository,
  overrides: Partial<{
    jobId: unknown;
    creditsCost: unknown;
    transactionId: unknown;
  }> = {},
) {
  return repository.linkCredits({
    jobId: JOB_ID,
    creditsCost: CREDITS_COST,
    transactionId: TRANSACTION_ID,
    ...overrides,
  } as { jobId: string; creditsCost: number; transactionId: string | null });
}

function claim(repository: JobCreditsLinkRepository, jobId: unknown = JOB_ID) {
  return repository.claimUnlinkedCharge({ jobId } as { jobId: string });
}

function mark(repository: JobCreditsLinkRepository, jobId: unknown = JOB_ID) {
  return repository.markChargeRefunded({ jobId } as { jobId: string });
}

/**
 * The context assertions are identical for all three methods, so they are
 * written once: a system bookkeeping statement has no acting user, every actor
 * setting stays empty, and the mode is the explicit privileged one.
 */
function expectNoActorInPrivilegedMode(harness: Harness): void {
  const statements = harness.queries.map((entry) => entry.sql);
  expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
  expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);
  expect(contextParams(harness.queries)).toEqual([
    [TRANSACTION_SETTING_NAMES.userId, ""],
    [TRANSACTION_SETTING_NAMES.workspaceId, ""],
    [TRANSACTION_SETTING_NAMES.role, ""],
    [TRANSACTION_SETTING_NAMES.executionMode, "privileged"],
  ]);
}

/** Every column the three writes must never touch. */
const UNREACHABLE_COLUMNS = [
  "attempt_count",
  "max_attempts",
  "payload",
  "result",
  "started_at",
  "completed_at",
  "canceled_at",
  "workspace_id",
  "created_by",
  "created_at",
  "project_id",
  "canvas_id",
  "session_id",
  "thread_id",
  "queue_name",
  "job_type",
];

describe("job-credits-link-repository: the shape of the module", () => {
  it("case 1: exposes the three methods and nothing else", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const repository = repositoryFor(harness);

    // Requirement T1 as a shape rather than a promise: there is no fourth
    // method, no access token, no workspace parameter, no table argument and no
    // generic patch entry point a caller could widen a statement with.
    expect(Object.keys(repository)).toEqual([
      LINK_CREDITS,
      CLAIM_UNLINKED_CHARGE,
      MARK_CHARGE_REFUNDED,
    ]);
    expect(repository.linkCredits).toHaveLength(1);
    expect(repository.claimUnlinkedCharge).toHaveLength(1);
    expect(repository.markChargeRefunded).toHaveLength(1);

    await link(repository);
    await claim(repository);
    await mark(repository);

    // One statement per method: no read-back, no second select, no write pair.
    expect(domainCalls(harness.queries)).toHaveLength(3);
  });

  it("case 2: the three failure messages are fixed text, distinct, and carry no SQL", async () => {
    // The message is derived from the operation name only. All three are checked
    // verbatim so a later change to one of them has to change this file.
    expect(`job credits link failed (${LINK_CREDITS})`).toBe(
      "job credits link failed (linkCredits)",
    );
    expect(`job credits link failed (${CLAIM_UNLINKED_CHARGE})`).toBe(
      "job credits link failed (claimUnlinkedCharge)",
    );
    expect(`job credits link failed (${MARK_CHARGE_REFUNDED})`).toBe(
      "job credits link failed (markChargeRefunded)",
    );

    const failures = [
      new JobCreditsLinkError(LINK_CREDITS, new Error("x")),
      new JobCreditsLinkError(CLAIM_UNLINKED_CHARGE, new Error("x")),
      new JobCreditsLinkError(MARK_CHARGE_REFUNDED, new Error("x")),
    ];
    for (const failure of failures) {
      expect(failure.name).toBe("JobCreditsLinkError");
      for (const column of UNREACHABLE_COLUMNS) {
        expect(failure.message).not.toContain(column);
      }
    }
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(3);
    expect(failures[0]?.operation).toBe(LINK_CREDITS);
    expect(failures[1]?.operation).toBe(CLAIM_UNLINKED_CHARGE);
    expect(failures[2]?.operation).toBe(MARK_CHARGE_REFUNDED);
  });

  it("case 3: the two error_code contracts are constants of this module", () => {
    // These strings are SQL literals in the statements below, so they are
    // checked here as values: a typo would silently make the claim and the mark
    // stop recognising each other.
    expect(CREDITS_REFUND_PENDING_ERROR_CODE).toBe("credits_refund_pending");
    expect(CREDITS_LINK_REFUNDED_ERROR_CODE).toBe("credits_link_refunded");
    expect(CREDITS_REFUND_PENDING_MESSAGE).toMatch(/refund is pending/);
    expect(CREDITS_LINK_REFUNDED_MESSAGE).toMatch(/refunded/);
    // No apostrophe: the messages are embedded in SQL single-quoted literals.
    for (const message of [
      CREDITS_REFUND_PENDING_MESSAGE,
      CREDITS_LINK_REFUNDED_MESSAGE,
    ]) {
      expect(message).not.toContain("'");
    }
  });
});

describe("job-credits-link-repository: linkCredits", () => {
  it("case 4: writes inside one privileged transaction with NO actor", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(link(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
  });

  it("case 5: binds the job id, the cost and the transaction, and never carries them as text", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await link(repositoryFor(harness));

    const statement = domainCalls(harness.queries)[0];
    expect(statement?.params).toEqual([JOB_ID, CREDITS_COST, TRANSACTION_ID]);
    expect(statement?.sql).toContain("$1::uuid");
    expect(statement?.sql).toContain("$2::integer");
    expect(statement?.sql).toContain("$3::uuid");
    expect(statement?.sql).not.toContain(JOB_ID);
    expect(statement?.sql).not.toContain(TRANSACTION_ID);
    expect(statement?.sql).not.toContain(String(CREDITS_COST));
    expect(statement?.sql).not.toContain("${");
  });

  it("case 6: binds a NULL transaction id, which is the free path's honest value", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(
      link(repositoryFor(harness), { creditsCost: 0, transactionId: null }),
    ).resolves.toBe(true);

    // `null::uuid` is NULL: the free path records "confirmed, costs nothing"
    // (workorder 21H1) and there is no transaction to name.
    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID, 0, null]);
  });

  it("case 7: the whole rule is in the predicate, and it is one UPDATE", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await link(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    // The two predicates ARE the atomicity — `credits_cost is null` is what
    // makes this statement exclusive with the worker's 21H1 timeout claim, and
    // `status in (...)` is what keeps the money off a job that already left the
    // pre-execution states.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("status in ('queued', 'retrying')");
    expect(sql).toContain("credits_cost is null");
    expect(sql).toContain("returning id");
    // No read first: a check-then-write pair in JavaScript would re-open exactly
    // the window against a charge that is landing right now.
    expect(sql).not.toMatch(/^\s*select/im);
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
  });

  it("case 8: set names exactly the three columns the link owns", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await link(repositoryFor(harness));

    const assignments = setClause(statementText(harness.queries));
    expect(assignments.split(",").map((part) => part.trim())).toEqual([
      "credits_cost = $2::integer",
      "credits_transaction_id = $3::uuid",
      "updated_at = now()",
    ]);

    // Everything else on the row — the status, the stamps, the attempt counter —
    // is not reachable from this statement. In particular `status` is only ever
    // READ here (as a predicate): recording what a job cost must not move the
    // job through its state machine.
    for (const column of [
      ...UNREACHABLE_COLUMNS,
      "status",
      "error_code",
      "error_message",
      "failed_at",
    ]) {
      expect(assignments).not.toContain(column);
    }
  });

  it("case 9: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(link(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // Zero rows is the predicate answering "this row is not mine": the job was
    // already billed, cancelled or finished, or does not exist. Folding it into
    // an error would turn a normal race into a failed request.
    const unchanged = createHarness(() => []);
    await expect(link(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(unchanged.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 10: more than one changed row is a fixed failure, not true", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }, { id: JOB_ID }]);

    const error = await link(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobCreditsLinkError);
    expect((error as JobCreditsLinkError).operation).toBe(LINK_CREDITS);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("job-credits-link-repository: claimUnlinkedCharge", () => {
  it("case 11: writes inside one privileged transaction with NO actor, binding only the job id", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(claim(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
    const statement = domainCalls(harness.queries)[0];
    // The claim has no caller-supplied state at all: not an amount, not a code.
    expect(statement?.params).toEqual([JOB_ID]);
    expect(statement?.sql).not.toContain(JOB_ID);
  });

  it("case 12: status and failed_at are preserved by a CASE, and the whole rule is in the predicate", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await claim(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");

    // `canceled` must not become `failed`: the user's own action is not rewritten
    // by a compensation pass. Only the two not-yet-started states move, and a
    // terminal row keeps its own failed_at.
    expect(sql).toContain(
      "status = case when status in ('queued', 'retrying') then 'failed' else status end",
    );
    expect(sql).toContain(
      "failed_at = case when status in ('queued', 'retrying') then now() else failed_at end",
    );

    // The ownership rule, all of it re-checked by the database at write time.
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain("credits_cost is null");
    expect(sql).toContain(
      "status in ('queued', 'retrying', 'canceled', 'failed', 'dead_letter')",
    );
    expect(sql).toContain(
      `error_code is distinct from '${CREDITS_REFUND_PENDING_ERROR_CODE}'`,
    );
    expect(sql).toContain(
      `error_code is distinct from '${CREDITS_LINK_REFUNDED_ERROR_CODE}'`,
    );
    expect(sql).toContain("returning id");
    expect(sql).not.toMatch(/^\s*select/im);
    // Exactly one statement, and nothing after the projection. The `;` inside the
    // fixed message literal is text, not a statement separator — so the check is
    // "the statement ends where it should", not "there is no semicolon at all".
    expect(sql.trim().endsWith("returning id")).toBe(true);
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);
  });

  it("case 13: set names exactly the five columns a claim owns, and never credits_cost", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await claim(repositoryFor(harness));

    const assignments = setClause(statementText(harness.queries));
    expect(assignments).toContain(
      "status = case when status in ('queued', 'retrying') then 'failed' else status end",
    );
    expect(assignments).toContain(
      "failed_at = case when status in ('queued', 'retrying') then now() else failed_at end",
    );
    expect(assignments).toContain(
      `error_code = '${CREDITS_REFUND_PENDING_ERROR_CODE}'`,
    );
    expect(assignments).toContain(
      `error_message = '${CREDITS_REFUND_PENDING_MESSAGE}'`,
    );
    expect(assignments).toContain("updated_at = now()");

    // The claim must not write the cost: the whole point is that this job was
    // never billed, and inventing a cost here would create a charge the worker
    // would then refund a second time. `credits_cost` is only ever a predicate.
    for (const column of [
      ...UNREACHABLE_COLUMNS,
      "credits_cost",
      "credits_transaction_id",
      "canceled_at",
    ]) {
      expect(assignments).not.toContain(column);
    }
  });

  it("case 14: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(claim(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    const unchanged = createHarness(() => []);
    await expect(claim(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(unchanged.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 15: more than one changed row is a fixed failure, not true", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }, { id: JOB_ID }]);

    const error = await claim(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobCreditsLinkError);
    expect((error as JobCreditsLinkError).operation).toBe(
      CLAIM_UNLINKED_CHARGE,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("job-credits-link-repository: markChargeRefunded", () => {
  it("case 16: writes inside one privileged transaction with NO actor, binding only the job id", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await expect(mark(repositoryFor(harness))).resolves.toBe(true);

    expectNoActorInPrivilegedMode(harness);
    expect(domainCalls(harness.queries)).toHaveLength(1);
    expect(harness.connectAttempts()).toBe(1);
    expect(domainCalls(harness.queries)[0]?.params).toEqual([JOB_ID]);
  });

  it("case 17: it can only confirm the state the claim wrote", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }]);

    await mark(repositoryFor(harness));

    const sql = statementText(harness.queries);
    expect(sql).toContain("update public.background_jobs");
    expect(sql).toContain("where id = $1::uuid");
    expect(sql).toContain(
      `error_code = '${CREDITS_REFUND_PENDING_ERROR_CODE}'`,
    );
    expect(sql).toContain("credits_cost is null");
    expect(sql).toContain("returning id");
    expect(sql).not.toMatch(/^\s*select/im);
    expect(sql).not.toContain(";");
    expect(sql.match(/public\.[a-z_]+/g)).toEqual(["public.background_jobs"]);

    const assignments = setClause(sql);
    expect(assignments.split(",").map((part) => part.trim())).toEqual([
      `error_code = '${CREDITS_LINK_REFUNDED_ERROR_CODE}'`,
      `error_message = '${CREDITS_LINK_REFUNDED_MESSAGE}'`,
      "updated_at = now()",
    ]);
    // The mark confirms a refund; it must not move the job, rewrite its cost or
    // replace the timestamp the claim wrote.
    for (const column of [
      ...UNREACHABLE_COLUMNS,
      "credits_cost",
      "credits_transaction_id",
      "status",
      "failed_at",
    ]) {
      expect(assignments).not.toContain(column);
    }
  });

  it("case 18: one changed row is true, zero rows is false, and both COMMIT", async () => {
    const changed = createHarness(() => [{ id: JOB_ID }]);
    await expect(mark(repositoryFor(changed))).resolves.toBe(true);
    expect(lastStatement(changed)).toBe(TRANSACTION_STATEMENTS.commit);

    // Zero rows here is what stops a second compensation pass from refunding
    // again: the job is no longer `credits_refund_pending`.
    const unchanged = createHarness(() => []);
    await expect(mark(repositoryFor(unchanged))).resolves.toBe(false);
    expect(lastStatement(unchanged)).toBe(TRANSACTION_STATEMENTS.commit);
    expect(unchanged.queries.map((entry) => entry.sql)).not.toContain(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("case 19: more than one changed row is a fixed failure, not true", async () => {
    const harness = createHarness(() => [{ id: JOB_ID }, { id: JOB_ID }]);

    const error = await mark(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobCreditsLinkError);
    expect((error as JobCreditsLinkError).operation).toBe(
      MARK_CHARGE_REFUNDED,
    );
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
  });
});

describe("job-credits-link-repository: refusals", () => {
  it("case 20: a SQL failure rolls back, keeps its cause and leaks no statement text", async () => {
    const failure = new Error(
      "update public.background_jobs failed: " +
        "postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await claim(repositoryFor(harness)).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(JobCreditsLinkError);
    const linkError = error as JobCreditsLinkError;
    expect(linkError.operation).toBe(CLAIM_UNLINKED_CHARGE);
    expect(linkError.message).toBe(
      `job credits link failed (${CLAIM_UNLINKED_CHARGE})`,
    );
    expect(linkError.cause).toBe(failure);
    expect(lastStatement(harness)).toBe(TRANSACTION_STATEMENTS.rollback);
    expect(linkError.message).not.toMatch(
      /public\.|background_jobs|credits_cost|postgres:\/\/|10\.210\.134\.37|secret/i,
    );
    // The job id never reaches the message either: a failure is not a lookup.
    expect(linkError.message).not.toContain(JOB_ID);
  });

  it("case 21: a connect failure is a fixed failure and issues no statement", async () => {
    const calls = [
      { operation: LINK_CREDITS, run: (r: JobCreditsLinkRepository) => link(r) },
      {
        operation: CLAIM_UNLINKED_CHARGE,
        run: (r: JobCreditsLinkRepository) => claim(r),
      },
      {
        operation: MARK_CHARGE_REFUNDED,
        run: (r: JobCreditsLinkRepository) => mark(r),
      },
    ];

    for (const call of calls) {
      const harness = createHarness(() => [], {
        connectError: new Error("connect ECONNREFUSED 10.210.134.37:5432"),
      });

      const error = await call.run(repositoryFor(harness)).catch(
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(JobCreditsLinkError);
      expect((error as JobCreditsLinkError).operation).toBe(call.operation);
      expect((error as JobCreditsLinkError).message).not.toMatch(
        /ECONNREFUSED|10\.210\.134\.37/,
      );
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 22: an unusable job id is refused before any connection is opened", async () => {
    const jobIds: unknown[] = [undefined, "", 7, null, {}];

    for (const jobId of jobIds) {
      const harness = createHarness(() => [{ id: JOB_ID }]);
      const repository = repositoryFor(harness);
      const input = { jobId } as { jobId: string };

      const errors = await Promise.all(
        [
          // The calls are spelled out rather than routed through the helpers:
          // those default their argument, and a default would silently turn
          // `undefined` back into a usable id.
          repository.linkCredits({
            jobId,
            creditsCost: CREDITS_COST,
            transactionId: TRANSACTION_ID,
          } as unknown as { jobId: string; creditsCost: number; transactionId: string | null }),
          repository.claimUnlinkedCharge(input),
          repository.markChargeRefunded(input),
        ].map((call) => call.catch((reason: unknown) => reason)),
      );

      for (const error of errors) {
        expect(error).toBeInstanceOf(JobCreditsLinkError);
      }
      expect(harness.connectAttempts()).toBe(0);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("case 23: an unusable cost or transaction id is refused before any connection is opened", async () => {
    const costs: unknown[] = [
      undefined,
      null,
      "10",
      1.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    const transactions: unknown[] = [undefined, "", 7, {}, []];
    const harness = createHarness(() => [{ id: JOB_ID }]);
    const repository = repositoryFor(harness);

    for (const creditsCost of costs) {
      const error = await link(repository, { creditsCost }).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(JobCreditsLinkError);
      expect((error as JobCreditsLinkError).operation).toBe(LINK_CREDITS);
      // The refusal names the FIELD, never the value: the message must not
      // become a channel for whatever the caller passed in.
      expect((error as JobCreditsLinkError).message).toBe(
        `job credits link failed (${LINK_CREDITS})`,
      );
    }

    for (const transactionId of transactions) {
      const error = await link(repository, { transactionId }).catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(JobCreditsLinkError);
      expect((error as JobCreditsLinkError).cause).toBeInstanceOf(Error);
      expect(((error as JobCreditsLinkError).cause as Error).message).not.toContain(
        "undefined",
      );
    }

    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });

  it("case 24: building never resolves a pool; a missing DATABASE_URL fails on the call", async () => {
    let resolutions = 0;
    const repository = createJobCreditsLinkRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error(
          "DATABASE_URL is required to open a PostgreSQL pool (ADR-0001 self-hosted backend).",
        );
      },
    });

    expect(resolutions).toBe(0);

    const errors = await Promise.all(
      [link(repository), claim(repository), mark(repository)].map((call) =>
        call.catch((reason: unknown) => reason),
      ),
    );

    expect(resolutions).toBe(3);
    for (const error of errors) {
      expect(error).toBeInstanceOf(JobCreditsLinkError);
      // The fixed message is the only thing a caller may surface: no connection
      // string, no environment variable name.
      expect((error as JobCreditsLinkError).message).not.toMatch(
        /DATABASE_URL|postgres:\/\//,
      );
    }
  });
});
