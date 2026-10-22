import { describe, expect, it } from "vitest";

import {
  CLAIM_DUE_REFUND_COMPENSATIONS,
  FINISH_REFUND_COMPENSATION,
  RECORD_REFUND_COMPENSATION,
  RefundCompensationError,
  createRefundCompensationRepository,
  type RefundCompensationRepository,
} from "./refund-compensation-repository.js";
import {
  TRANSACTION_SETTING_NAMES,
  TRANSACTION_STATEMENTS,
  type TransactionConnection,
  type TransactionPool,
} from "./transaction.js";

/**
 * The repository is driven against a recording fake pool: no database, no
 * `DATABASE_URL`. The PGlite file beside it
 * (`test-support/db/refund-compensations-db.test.ts`) proves the SQL functions
 * really behave; this file proves which statements are sent, with which
 * parameters, in which transaction mode, and how failures are wrapped.
 */

const ID = "00000000-0000-0000-0000-0000000000c1";
const JOB_ID = "00000000-0000-0000-0000-0000000000c2";
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000c3";
const USER_ID = "00000000-0000-0000-0000-0000000000c4";
const TX_ID = "00000000-0000-0000-0000-0000000000c5";

type QueryRecord = { sql: string; params?: readonly unknown[] };

type Harness = {
  pool: TransactionPool;
  queries: QueryRecord[];
  connectAttempts: () => number;
};

function createHarness(
  respond: (sql: string) => unknown[] | Promise<unknown[]>,
  options: { connectError?: Error } = {},
): Harness {
  const queries: QueryRecord[] = [];
  let connectAttempts = 0;

  const connection: TransactionConnection = {
    async query(sql: string, params?: readonly unknown[]) {
      queries.push({ sql, ...(params === undefined ? {} : { params }) });

      if (
        sql === TRANSACTION_STATEMENTS.setLocalSetting ||
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

function domainCalls(queries: readonly QueryRecord[]): QueryRecord[] {
  return queries.filter((entry) => entry.sql.includes("public."));
}

function repositoryFor(harness: Harness): RefundCompensationRepository {
  return createRefundCompensationRepository({
    getTransactionPool: () => harness.pool,
  });
}

function recordInput(overrides: Record<string, unknown> = {}) {
  return {
    jobId: JOB_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    amount: 7,
    description: "refund for job",
    markLinkRefunded: true,
    error: "boom",
    ...overrides,
  } as Parameters<RefundCompensationRepository["record"]>[0];
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    job_id: JOB_ID,
    workspace_id: WORKSPACE_ID,
    user_id: USER_ID,
    amount: 7,
    description: "refund for job",
    mark_link_refunded: true,
    attempts: 3,
    max_attempts: 12,
    ...overrides,
  };
}

describe("refund-compensation-repository", () => {
  it("record sends the seven values in order inside one privileged transaction with no actor", async () => {
    const harness = createHarness(() => [{ id: ID }]);

    await expect(repositoryFor(harness).record(recordInput())).resolves.toBe(ID);

    const statements = harness.queries.map((entry) => entry.sql);
    expect(statements[0]).toBe(TRANSACTION_STATEMENTS.begin);
    expect(statements.at(-1)).toBe(TRANSACTION_STATEMENTS.commit);

    const calls = domainCalls(harness.queries);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("public.record_refund_compensation");
    expect(calls[0]?.params).toEqual([
      JOB_ID,
      WORKSPACE_ID,
      USER_ID,
      7,
      "refund for job",
      true,
      "boom",
    ]);
    expect(calls[0]?.sql).not.toContain(JOB_ID);

    const settings = harness.queries
      .filter((entry) => entry.sql === TRANSACTION_STATEMENTS.setLocalSetting)
      .flatMap((entry) => [...(entry.params ?? [])]);
    expect(settings).toContain(TRANSACTION_SETTING_NAMES.executionMode);
    expect(settings).toContain("privileged");
  });

  it("claimDue sends the limit and maps each row to camelCase", async () => {
    const harness = createHarness(() => [dueRow()]);

    const rows = await repositoryFor(harness).claimDue(5);

    expect(domainCalls(harness.queries)[0]?.params).toEqual([5]);
    expect(domainCalls(harness.queries)[0]?.sql).toContain(
      "public.claim_refund_compensations",
    );
    expect(rows).toEqual([
      {
        id: ID,
        jobId: JOB_ID,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        amount: 7,
        description: "refund for job",
        markLinkRefunded: true,
        attempts: 3,
        maxAttempts: 12,
      },
    ]);
  });

  it("claimDue returns an empty list when nothing is due", async () => {
    const harness = createHarness(() => []);

    await expect(repositoryFor(harness).claimDue(5)).resolves.toEqual([]);
  });

  it("claimDue wraps a row of the wrong shape", async () => {
    const harness = createHarness(() => [dueRow({ amount: "7" })]);

    const error = await repositoryFor(harness)
      .claimDue(5)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RefundCompensationError);
    expect((error as RefundCompensationError).operation).toBe(
      CLAIM_DUE_REFUND_COMPENSATIONS,
    );
  });

  it("finish sends the four values in order and returns the status", async () => {
    for (const status of ["pending", "done", "exhausted"] as const) {
      const harness = createHarness(() => [{ status }]);

      await expect(
        repositoryFor(harness).finish({
          id: ID,
          ok: false,
          refundTransactionId: TX_ID,
          error: "boom",
        }),
      ).resolves.toBe(status);

      expect(domainCalls(harness.queries)[0]?.params).toEqual([ID, false, TX_ID, "boom"]);
      expect(domainCalls(harness.queries)[0]?.sql).toContain(
        "public.finish_refund_compensation",
      );
    }
  });

  it("finish refuses a status the database does not define", async () => {
    const harness = createHarness(() => [{ status: "weird" }]);

    const error = await repositoryFor(harness)
      .finish({ id: ID, ok: true, refundTransactionId: TX_ID, error: null })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RefundCompensationError);
    expect((error as RefundCompensationError).operation).toBe(FINISH_REFUND_COMPENSATION);
  });

  it("a SQL failure rolls back, keeps its cause and leaks nothing in the message", async () => {
    const failure = new Error(
      "select public.record_refund_compensation failed: postgres://loomic:secret@10.210.134.37:5432/loomic",
    );
    const harness = createHarness(() => {
      throw failure;
    });

    const error = await repositoryFor(harness)
      .record(recordInput())
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RefundCompensationError);
    const wrapped = error as RefundCompensationError;
    expect(wrapped.operation).toBe(RECORD_REFUND_COMPENSATION);
    expect(wrapped.message).toBe("refund compensation failed (record)");
    expect(wrapped.cause).toBe(failure);
    expect(wrapped.message).not.toMatch(/public\.|postgres:\/\/|secret|10\.210\.134\.37/);
    expect(harness.queries.map((entry) => entry.sql).at(-1)).toBe(
      TRANSACTION_STATEMENTS.rollback,
    );
  });

  it("a connect failure is wrapped for every method and issues no statement", async () => {
    const cause = new Error("connect ECONNREFUSED 10.210.134.37:5432");
    const calls: Array<[string, (r: RefundCompensationRepository) => Promise<unknown>]> = [
      [RECORD_REFUND_COMPENSATION, (r) => r.record(recordInput())],
      [CLAIM_DUE_REFUND_COMPENSATIONS, (r) => r.claimDue(3)],
      [
        FINISH_REFUND_COMPENSATION,
        (r) => r.finish({ id: ID, ok: true, refundTransactionId: TX_ID, error: null }),
      ],
    ];

    for (const [operation, run] of calls) {
      const harness = createHarness(() => [], { connectError: cause });

      const error = await run(repositoryFor(harness)).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(RefundCompensationError);
      expect((error as RefundCompensationError).operation).toBe(operation);
      expect((error as RefundCompensationError).cause).toBe(cause);
      expect((error as RefundCompensationError).message).not.toMatch(/ECONNREFUSED|10\.210/);
      expect(harness.queries).toHaveLength(0);
    }
  });

  it("unusable arguments are refused before any connection is opened", async () => {
    const harness = createHarness(() => [{ id: ID }]);
    const repository = repositoryFor(harness);

    const attempts: Array<Promise<unknown>> = [
      repository.record(recordInput({ jobId: "" })),
      repository.record(recordInput({ amount: 0 })),
      repository.record(recordInput({ amount: 1.5 })),
      repository.record(recordInput({ markLinkRefunded: "yes" })),
      repository.record(recordInput({ error: 5 })),
      repository.claimDue(0),
      repository.claimDue(Number.NaN),
      repository.finish({ id: "", ok: true, refundTransactionId: null, error: null }),
      repository.finish({
        id: ID,
        ok: "yes",
        refundTransactionId: null,
        error: null,
      } as unknown as Parameters<RefundCompensationRepository["finish"]>[0]),
    ];

    for (const attempt of attempts) {
      const error = await attempt.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RefundCompensationError);
    }

    expect(harness.connectAttempts()).toBe(0);
    expect(harness.queries).toHaveLength(0);
  });

  it("building never resolves a pool; a missing pool fails on the call", async () => {
    let resolutions = 0;
    const repository = createRefundCompensationRepository({
      getTransactionPool: () => {
        resolutions += 1;
        throw new Error("DATABASE_URL is required");
      },
    });

    expect(resolutions).toBe(0);

    const error = await repository.claimDue(1).catch((reason: unknown) => reason);

    expect(resolutions).toBe(1);
    expect(error).toBeInstanceOf(RefundCompensationError);
    expect((error as RefundCompensationError).message).not.toMatch(/DATABASE_URL/);
  });
});
