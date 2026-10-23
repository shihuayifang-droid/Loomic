import { afterEach, describe, expect, it, vi } from "vitest";

import { PLAN_CONFIGS, type SubscriptionPlan } from "@loomic/shared";

import {
  createCreditReadRepository,
  type BalanceSnapshotReadRow,
  type CreditReadRepository,
  type CreditTransactionReadRow,
  type SubscriptionReadRow,
} from "../../db/credit-read-repository.js";
import type { CreditLedgerFunctionRepository } from "../../db/credit-ledger-function-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  CreditServiceError,
  INSUFFICIENT_CREDITS_SQLSTATE,
  createCreditService,
  type CreditService,
  type SubscriptionInfo,
} from "./credit-service.js";

/**
 * Workorders 21K, 21P and 21Q: the reads of `CreditService` that moved to the
 * pure `pg` repository — the transaction list, the subscription row, the
 * balance snapshot behind `getBalance`, and the two reads `claimDailyCredits`
 * makes around the daily claim (the plan BEFORE it, the updated balance AFTER
 * it). This file tests THOSE METHODS and nothing else.
 *
 * The service is driven with a recording fake repository, so what is asserted is
 * the contract between the two modules: the clamped limit the service computes
 * and hands down, the untouched rows it hands back, the camelCase projection of
 * the subscription with its `free` + six-null default, the `claimDate` the
 * balance read computes from the system clock (JS UTC, never the local day), the
 * `0`/`free` defaults of a workspace with no rows at all, and the single failure
 * code all three methods answer with. The `getAdminClient` stub THROWS on
 * contact, so no case below can pass while a read still reaches PostgREST — the
 * claim cases use their own stub, which allows the ONE RPC of that method and
 * records every other property read as a forbidden one.
 *
 * The database side of the same contract lives in
 * `test-support/db/credit-read-repository-db.test.ts` (real SQL over PGlite) and
 * in `db/credit-read-repository.test.ts` (the statements against a fake pool).
 */

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000021d1";

const TRANSACTION_ROW: CreditTransactionReadRow = {
  id: "00000000-0000-0000-0000-0000000021e1",
  transaction_type: "generation_deduct",
  amount: -12,
  balance_after: 88,
  job_id: "00000000-0000-0000-0000-0000000021e2",
  description: "image generation",
  created_at: "2026-04-05T06:07:08.901Z",
};

const SUBSCRIPTION_ROW: SubscriptionReadRow = {
  plan: "pro",
  billing_period: "yearly",
  stripe_customer_id: "cus_21k",
  stripe_subscription_id: "sub_21k",
  current_period_start: "2026-04-01T00:00:00.000Z",
  current_period_end: "2027-04-01T00:00:00.000Z",
  canceled_at: "2026-04-15T12:30:45.678Z",
};

type ListCall = { workspaceId: string; limit: number };

/** One balance snapshot request, exactly as the service computed it. */
type SnapshotCall = { workspaceId: string; claimDate: string };

/** The row a workspace with a balance, a plan and no claim of the day answers. */
const BALANCE_SNAPSHOT_ROW: BalanceSnapshotReadRow = {
  balance: 42,
  plan: "pro",
  daily_claimed: false,
};

/** The ONE shape the real repository binds, mirrored so a fake cannot lie. */
const CLAIM_DATE_GUARD = /^\d{4}-\d{2}-\d{2}$/;

type FakeRepository = {
  repository: CreditReadRepository;
  listCalls: ListCall[];
  subscriptionCalls: string[];
  snapshotCalls: SnapshotCall[];
};

/**
 * A recording repository whose limit rule mirrors the real one: a limit that is
 * not an integer inside 1..100 is refused before the pool is touched. Without
 * that mirror a fake would happily answer a `NaN` limit, and the service's
 * `NaN` path would look green while the real chain answers 500.
 *
 * The claim date is mirrored the same way: the real repository binds
 * `YYYY-MM-DD` and refuses every other shape before it opens a connection, so a
 * service that started passing a localized or timestamped date would fail HERE
 * rather than look healthy against a fake that accepts anything.
 */
function createFakeRepository(
  options: {
    transactions?: CreditTransactionReadRow[];
    subscription?: SubscriptionReadRow | null;
    snapshot?: BalanceSnapshotReadRow;
    failWith?: Error;
  } = {},
): FakeRepository {
  const listCalls: ListCall[] = [];
  const subscriptionCalls: string[] = [];
  const snapshotCalls: SnapshotCall[] = [];

  return {
    listCalls,
    subscriptionCalls,
    snapshotCalls,
    repository: {
      async listTransactions(input) {
        listCalls.push({ workspaceId: input.workspaceId, limit: input.limit });

        if (options.failWith) throw options.failWith;
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 100
        ) {
          throw new Error(
            "credit transaction read needs an integer limit between 1 and 100",
          );
        }

        return options.transactions ?? [];
      },
      async readSubscription(input) {
        subscriptionCalls.push(input.workspaceId);

        if (options.failWith) throw options.failWith;

        return options.subscription ?? null;
      },
      async readBalanceSnapshot(input) {
        snapshotCalls.push({
          workspaceId: input.workspaceId,
          claimDate: input.claimDate,
        });

        if (options.failWith) throw options.failWith;
        if (!CLAIM_DATE_GUARD.test(input.claimDate)) {
          throw new Error(
            'credit balance snapshot read needs a "claimDate" of the form YYYY-MM-DD',
          );
        }

        return options.snapshot ?? BALANCE_SNAPSHOT_ROW;
      },
    },
  };
}

/**
 * The service under test. `getAdminClient` is a SPY: it counts how many times it
 * was resolved and records every property read on the client it hands back, so
 * "these two methods never touch PostgREST" is measured rather than assumed —
 * a fallback would show up as a resolved getter or a recorded property. The
 * repository is omitted entirely for the fail-closed cases, which is exactly how
 * `worker.ts` builds this service today.
 */
function createService(
  options: { repository?: CreditReadRepository } = {},
): {
  service: CreditService;
  client: AdminSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  adminResolutions: number[];
  adminReads: string[];
} {
  const adminResolutions: number[] = [];
  const adminReads: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        adminReads.push(String(property));
        return undefined;
      },
    },
  ) as unknown as AdminSupabaseClient;

  const getAdminClient = () => {
    adminResolutions.push(adminResolutions.length);
    return client;
  };

  const service = createCreditService({
    getAdminClient,
    ...(options.repository ? { creditReadRepository: options.repository } : {}),
  });

  return { service, client, getAdminClient, adminResolutions, adminReads };
}

/** Shorthand for a service with no repository at all (the worker's wiring). */
function buildService(
  options: { repository?: CreditReadRepository } = {},
): CreditService {
  return createService(options).service;
}

/** The service call with its refusal captured instead of thrown. */
async function refusal(call: () => Promise<unknown>): Promise<CreditServiceError> {
  const error = await call().catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(CreditServiceError);
  return error as CreditServiceError;
}

describe("credit-service getTransactions: the limit contract", () => {
  it("case 1: the default limit is 20, and 20 is what the repository is asked for", async () => {
    const fake = createFakeRepository({ transactions: [TRANSACTION_ROW] });
    const service = buildService({ repository: fake.repository });

    await expect(service.getTransactions(WORKSPACE_ID)).resolves.toEqual([
      TRANSACTION_ROW,
    ]);

    expect(fake.listCalls).toEqual([{ workspaceId: WORKSPACE_ID, limit: 20 }]);
  });

  it("case 2: limit 0 is clamped up to 1 and the repository receives 1", async () => {
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    await service.getTransactions(WORKSPACE_ID, 0);

    expect(fake.listCalls).toEqual([{ workspaceId: WORKSPACE_ID, limit: 1 }]);
  });

  it("case 3: limit 500 is clamped down to 100 and the repository receives 100", async () => {
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    await service.getTransactions(WORKSPACE_ID, 500);

    expect(fake.listCalls).toEqual([{ workspaceId: WORKSPACE_ID, limit: 100 }]);
  });

  it("case 4: the clamp keeps its exact boundaries and its arithmetic", async () => {
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    for (const [given, expected] of [
      [1, 1],
      [20, 20],
      [100, 100],
      [101, 100],
      [-5, 1],
      [0.5, 1],
      [1e9, 100],
    ] as const) {
      await service.getTransactions(WORKSPACE_ID, given);

      expect(fake.listCalls.at(-1)).toEqual({
        workspaceId: WORKSPACE_ID,
        limit: expected,
      });
    }
  });

  it("case 5: a NaN limit stays NaN through the clamp, and the repository's refusal is the existing 500", async () => {
    const fake = createFakeRepository({ transactions: [TRANSACTION_ROW] });
    const service = buildService({ repository: fake.repository });

    const error = await refusal(() =>
      service.getTransactions(WORKSPACE_ID, Number.NaN),
    );

    // The clamp is `Math.min(Math.max(NaN, 1), 100)` — NaN, not 1 and not 100.
    // That is the current behaviour and it is deliberately unchanged: the NaN
    // becomes an error, exactly as it did when it reached the old read.
    const call = fake.listCalls.at(-1);
    expect(call?.limit).toBeNaN();
    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query transactions.");
  });

  it("case 6: a NaN limit against the REAL repository is a 500 before any connection", async () => {
    let connections = 0;
    const repository = createCreditReadRepository({
      getTransactionPool: () => {
        connections += 1;
        throw new Error("the pool must not be resolved for a NaN limit");
      },
    });
    const service = buildService({ repository });

    const error = await refusal(() =>
      service.getTransactions(WORKSPACE_ID, Number.NaN),
    );

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query transactions.");
    // The refusal happened inside the repository, before the pool was reached —
    // so this is the same 500 the old read produced, without a query.
    expect(connections).toBe(0);
  });
});

describe("credit-service getTransactions: rows, failures and the missing dependency", () => {
  it("case 7: the repository's rows are returned unchanged, in order", async () => {
    const second: CreditTransactionReadRow = {
      ...TRANSACTION_ROW,
      id: "00000000-0000-0000-0000-0000000021e3",
      amount: 100,
      job_id: null,
      description: null,
      created_at: "2026-04-05T06:00:00.000Z",
    };
    const fake = createFakeRepository({ transactions: [TRANSACTION_ROW, second] });
    const service = buildService({ repository: fake.repository });

    const rows = await service.getTransactions(WORKSPACE_ID, 3);

    expect(rows).toEqual([TRANSACTION_ROW, second]);
    expect(rows.map((row) => row.created_at)).toEqual([
      TRANSACTION_ROW.created_at,
      second.created_at,
    ]);
    // An empty ledger is an answer, not a failure.
    const empty = createFakeRepository({ transactions: [] });
    await expect(
      buildService({ repository: empty.repository }).getTransactions(WORKSPACE_ID),
    ).resolves.toEqual([]);
  });

  it("case 8: the workspace id is passed through untouched", async () => {
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    await service.getTransactions("00000000-0000-0000-0000-0000000021ff", 5);

    expect(fake.listCalls).toEqual([
      { workspaceId: "00000000-0000-0000-0000-0000000021ff", limit: 5 },
    ]);
  });

  it("case 9: a repository failure is the existing credit_query_failed 500", async () => {
    const failure = new Error(
      "connect ECONNREFUSED 10.210.134.37:5432 postgres://loomic:secret@host/db",
    );
    const fake = createFakeRepository({ failWith: failure });
    const service = buildService({ repository: fake.repository });

    const error = await refusal(() => service.getTransactions(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query transactions.");
    // The driver's message — host, port, credentials — stays out of the
    // response; the repository already reduced it to a fixed text plus `cause`.
    expect(error.message).not.toMatch(/ECONNREFUSED|10\.210\.134\.37|secret/i);
  });

  it("case 10: with no repository the read fails closed instead of falling back", async () => {
    const service = buildService();

    const error = await refusal(() => service.getTransactions(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query transactions.");
  });
});

describe("credit-service getSubscription: mapping, defaults and failures", () => {
  it("case 11: a row is mapped field by field into the published camelCase shape", async () => {
    const fake = createFakeRepository({ subscription: SUBSCRIPTION_ROW });
    const service = buildService({ repository: fake.repository });

    const result = await service.getSubscription(WORKSPACE_ID);

    expect(result).toEqual({
      plan: "pro",
      billingPeriod: "yearly",
      stripeCustomerId: "cus_21k",
      stripeSubscriptionId: "sub_21k",
      currentPeriodStart: "2026-04-01T00:00:00.000Z",
      currentPeriodEnd: "2027-04-01T00:00:00.000Z",
      canceledAt: "2026-04-15T12:30:45.678Z",
    } satisfies SubscriptionInfo);
    // The exact key set: no snake_case leaked, no `id` or `created_at` added.
    expect(Object.keys(result)).toEqual([
      "plan",
      "billingPeriod",
      "stripeCustomerId",
      "stripeSubscriptionId",
      "currentPeriodStart",
      "currentPeriodEnd",
      "canceledAt",
    ]);
    expect(fake.subscriptionCalls).toEqual([WORKSPACE_ID]);
  });

  it("case 12: a row whose nullable columns are NULL maps to six nulls, not to defaults", async () => {
    const fake = createFakeRepository({
      subscription: {
        plan: "free",
        billing_period: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        current_period_start: null,
        current_period_end: null,
        canceled_at: null,
      },
    });
    const service = buildService({ repository: fake.repository });

    await expect(service.getSubscription(WORKSPACE_ID)).resolves.toEqual({
      plan: "free",
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    });
  });

  it("case 13: no subscription row is the free plan with six nulls", async () => {
    const fake = createFakeRepository({ subscription: null });
    const service = buildService({ repository: fake.repository });

    const result = await service.getSubscription(WORKSPACE_ID);

    expect(result).toEqual({
      plan: "free",
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    });
    // The default is applied HERE, on the way out — the repository reports the
    // absence as a null row rather than inventing one.
    expect(fake.subscriptionCalls).toEqual([WORKSPACE_ID]);
  });

  it("case 14: a repository failure is the existing credit_query_failed 500", async () => {
    const failure = new Error("timeout while reading public.subscriptions");
    const fake = createFakeRepository({ failWith: failure });
    const service = buildService({ repository: fake.repository });

    const error = await refusal(() => service.getSubscription(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query subscription.");
    expect(error.message).not.toMatch(/public\.|subscriptions|timeout/i);
  });

  it("case 15: with no repository the read fails closed instead of falling back", async () => {
    const service = buildService();

    const error = await refusal(() => service.getSubscription(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query subscription.");
  });
});

describe("credit-service: neither migrated read touches the admin client", () => {
  it("case 16: both success paths run without resolving the admin client once", async () => {
    const fake = createFakeRepository({
      transactions: [TRANSACTION_ROW],
      subscription: SUBSCRIPTION_ROW,
    });
    const built = createService({ repository: fake.repository });

    await expect(built.service.getTransactions(WORKSPACE_ID)).resolves.toEqual([
      TRANSACTION_ROW,
    ]);
    await expect(
      built.service.getSubscription(WORKSPACE_ID),
    ).resolves.toMatchObject({ plan: "pro" });

    // Measured, not assumed: the getter was never called and no property of the
    // client it would have returned was ever read.
    expect(built.adminResolutions).toEqual([]);
    expect(built.adminReads).toEqual([]);
  });

  it("case 17: neither failure path nor the missing-dependency path resolves it either", async () => {
    const failing = createFakeRepository({
      failWith: new Error("repository exploded"),
    });
    const broken = createService({ repository: failing.repository });

    await expect(
      refusal(() => broken.service.getTransactions(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    await expect(
      refusal(() => broken.service.getSubscription(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    expect(broken.adminResolutions).toEqual([]);
    expect(broken.adminReads).toEqual([]);

    // No repository at all — the fail-closed path must not quietly become the
    // admin client it used to hold.
    const bare = createService();
    await expect(
      refusal(() => bare.service.getTransactions(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    await expect(
      refusal(() => bare.service.getSubscription(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    expect(bare.adminResolutions).toEqual([]);
    expect(bare.adminReads).toEqual([]);
  });

  it("case 18: the spy is not vacuous — resolving the getter and reading the client both show up", () => {
    // A guard for this file's own premise. If the spy could not record
    // anything, cases 16 and 17 would pass for the wrong reason; this proves
    // that resolving the getter and touching the client are both observable.
    const built = createService();

    expect(built.adminResolutions).toEqual([]);
    expect(built.adminReads).toEqual([]);

    built.getAdminClient();
    expect(built.adminResolutions).toHaveLength(1);

    void (built.client as unknown as Record<string, unknown>)["someTable"];
    expect(built.adminReads).toEqual(["someTable"]);
  });
});

describe("credit-service getBalance: the snapshot, its date and its defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("case 19: the row's three answers are passed through, month and day included", async () => {
    const fake = createFakeRepository({
      snapshot: { balance: 7, plan: "ultra", daily_claimed: true },
    });
    const service = buildService({ repository: fake.repository });

    const result = await service.getBalance(WORKSPACE_ID);

    expect(result).toEqual({
      balance: 7,
      plan: "ultra",
      dailyClaimed: true,
    });
    // Exactly the published key set, and the workspace id travels untouched.
    expect(Object.keys(result)).toEqual(["balance", "plan", "dailyClaimed"]);
    expect(fake.snapshotCalls).toHaveLength(1);
    expect(fake.snapshotCalls[0]?.workspaceId).toBe(WORKSPACE_ID);

    const other = createFakeRepository({
      snapshot: { balance: 0, plan: "free", daily_claimed: false },
    });
    await expect(
      buildService({ repository: other.repository }).getBalance(
        "00000000-0000-0000-0000-0000000021ff",
      ),
    ).resolves.toEqual({ balance: 0, plan: "free", dailyClaimed: false });
    expect(other.snapshotCalls[0]?.workspaceId).toBe(
      "00000000-0000-0000-0000-0000000021ff",
    );
  });

  it("case 20: an absent balance and an absent plan become 0 and free — the nulls are not published", async () => {
    const fake = createFakeRepository({
      snapshot: { balance: null, plan: null, daily_claimed: false },
    });
    const service = buildService({ repository: fake.repository });

    const result = await service.getBalance(WORKSPACE_ID);

    expect(result).toEqual({ balance: 0, plan: "free", dailyClaimed: false });
    // The DEFAULTS are applied here, on the way out: the repository reports the
    // absence as nulls rather than inventing values.
    expect(result.balance).not.toBeNull();
    expect(result.plan).not.toBeNull();
    // A row that exists with a zero balance is indistinguishable at this
    // boundary — which is the behaviour the three-read version had too.
    const zero = createFakeRepository({
      snapshot: { balance: 0, plan: "free", daily_claimed: false },
    });
    await expect(
      buildService({ repository: zero.repository }).getBalance(WORKSPACE_ID),
    ).resolves.toEqual(result);
  });

  it("case 21: the date handed down is the JS UTC date, not the local one", async () => {
    vi.useFakeTimers();
    // 23:30 on the 16th at UTC-8 is 07:30 on the 17th UTC: the LOCAL day and the
    // UTC day disagree, so only one of them can be the answer.
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));

    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    await service.getBalance(WORKSPACE_ID);

    expect(fake.snapshotCalls).toEqual([
      { workspaceId: WORKSPACE_ID, claimDate: "2026-10-17" },
    ]);
    expect(new Date().toISOString()).toBe("2026-10-17T07:30:00.000Z");

    // The other direction: 00:30 on the 5th at UTC+9 is still the 4th in UTC, so
    // a local-date implementation would answer "2026-01-05" here.
    vi.setSystemTime(new Date("2026-01-05T00:30:00+09:00"));

    await service.getBalance(WORKSPACE_ID);

    expect(fake.snapshotCalls.at(-1)).toEqual({
      workspaceId: WORKSPACE_ID,
      claimDate: "2026-01-04",
    });
    // Whatever the instant, what reaches the repository is the ONE shape its
    // statement binds.
    for (const call of fake.snapshotCalls) {
      expect(CLAIM_DATE_GUARD.test(call.claimDate)).toBe(true);
    }
  });

  it("case 22: the date asked about is the day of the call, never a fixed one", async () => {
    vi.useFakeTimers();
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    vi.setSystemTime(new Date("2026-03-04T12:00:00.000Z"));
    await service.getBalance(WORKSPACE_ID);
    vi.setSystemTime(new Date("2026-03-05T00:00:00.000Z"));
    await service.getBalance(WORKSPACE_ID);

    expect(fake.snapshotCalls.map((call) => call.claimDate)).toEqual([
      "2026-03-04",
      "2026-03-05",
    ]);
  });

  it("case 23: a repository failure is the existing credit_query_failed 500", async () => {
    const failure = new Error(
      "connect ECONNREFUSED 10.210.134.37:5432 postgres://loomic:secret@host/db",
    );
    const fake = createFakeRepository({ failWith: failure });
    const service = buildService({ repository: fake.repository });

    const error = await refusal(() => service.getBalance(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query credit balance.");
    // The driver's message — host, port, credentials — stays out of the
    // response; the repository already reduced it to a fixed text plus `cause`.
    expect(error.message).not.toMatch(/ECONNREFUSED|10\.210\.134\.37|secret/i);
    // The refusal happened on the snapshot read, not before it.
    expect(fake.snapshotCalls).toHaveLength(1);
  });

  it("case 24: with no repository the read fails closed instead of falling back", async () => {
    const service = buildService();

    const error = await refusal(() => service.getBalance(WORKSPACE_ID));

    expect(error.code).toBe("credit_query_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query credit balance.");
  });

  it("case 25: getBalance resolves the admin client zero times on every path", async () => {
    // The spy records both the getter and every property read on the client it
    // would have returned, so a fallback to the three PostgREST reads this
    // method used to make could not pass unnoticed.
    const fake = createFakeRepository({
      snapshot: { balance: 5, plan: "pro", daily_claimed: true },
    });
    const built = createService({ repository: fake.repository });

    await expect(built.service.getBalance(WORKSPACE_ID)).resolves.toEqual({
      balance: 5,
      plan: "pro",
      dailyClaimed: true,
    });
    expect(built.adminResolutions).toEqual([]);
    expect(built.adminReads).toEqual([]);

    const failing = createFakeRepository({
      failWith: new Error("repository exploded"),
    });
    const broken = createService({ repository: failing.repository });
    await expect(
      refusal(() => broken.service.getBalance(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    expect(broken.adminResolutions).toEqual([]);
    expect(broken.adminReads).toEqual([]);

    const bare = createService();
    await expect(
      refusal(() => bare.service.getBalance(WORKSPACE_ID)),
    ).resolves.toBeInstanceOf(CreditServiceError);
    expect(bare.adminResolutions).toEqual([]);
    expect(bare.adminReads).toEqual([]);
  });

  it("case 26: the balance read asks the repository once and touches nothing else", async () => {
    const fake = createFakeRepository();
    const service = buildService({ repository: fake.repository });

    await service.getBalance(WORKSPACE_ID);

    // ONE call, and the other two reads of the same repository stay untouched:
    // this method must not become a second query surface.
    expect(fake.snapshotCalls).toHaveLength(1);
    expect(fake.listCalls).toEqual([]);
    expect(fake.subscriptionCalls).toEqual([]);
  });
});

// ── claimDailyCredits (workorder 21Q) ────────────────────────────────────────

/** One call the ledger-function stand-in was asked to make, with its arguments. */
type ClaimLedgerCall = { method: string; args: Record<string, unknown> };

/** The daily amount `PLAN_CONFIGS.free` grants — the one plan that grants any. */
const FREE_DAILY_CREDITS = 50;

/**
 * The credit ledger function repository stand-in of `claimDailyCredits`
 * (workorder 44K). The ONE method it answers is `claimDailyCredits`; every other
 * property is recorded in `forbiddenReads` and, were it ever CALLED, throws. So
 * a call left behind on another ledger function cannot pass quietly, and
 * `forbiddenReads` staying empty is the measurement behind "this method touches
 * the claim function only".
 */
function createClaimLedger(
  options: { claimed?: boolean; error?: { message: string } } = {},
): {
  repository: CreditLedgerFunctionRepository;
  calls: ClaimLedgerCall[];
  forbiddenReads: string[];
} {
  const calls: ClaimLedgerCall[] = [];
  const forbiddenReads: string[] = [];

  const repository = new Proxy(
    {},
    {
      get(_target, property) {
        // Symbols and `then` are the runtime's own probes (inspection, awaiting):
        // they are not repository methods and must not be recorded as reads.
        if (typeof property === "symbol" || property === "then") {
          return undefined;
        }

        if (property === "claimDailyCredits") {
          return async (args: Record<string, unknown>) => {
            calls.push({ method: "claimDailyCredits", args });
            if (options.error) throw new Error(options.error.message);

            return options.claimed ?? true;
          };
        }

        forbiddenReads.push(String(property));

        return () => {
          throw new Error(
            `claimDailyCredits reached the ledger repository's "${String(property)}"`,
          );
        };
      },
    },
  ) as unknown as CreditLedgerFunctionRepository;

  return { repository, calls, forbiddenReads };
}

/**
 * The claim path's repository, with the two reads recorded SEPARATELY: a case
 * can tell "the plan was read" from "the balance was read", and the failure of
 * one can be injected without failing the other.
 */
function createClaimRepository(
  options: {
    subscription?: SubscriptionReadRow | null;
    subscriptionFails?: Error;
    snapshot?: BalanceSnapshotReadRow;
    snapshotFails?: Error;
  } = {},
): {
  repository: CreditReadRepository;
  subscriptionCalls: string[];
  snapshotCalls: SnapshotCall[];
} {
  const subscriptionCalls: string[] = [];
  const snapshotCalls: SnapshotCall[] = [];

  return {
    subscriptionCalls,
    snapshotCalls,
    repository: {
      async listTransactions() {
        // This method has no business reading the ledger: the case fails loud
        // instead of quietly answering an unrelated read.
        throw new Error("claimDailyCredits must not read the transaction list");
      },
      async readSubscription(input) {
        subscriptionCalls.push(input.workspaceId);
        if (options.subscriptionFails) throw options.subscriptionFails;

        return options.subscription ?? null;
      },
      async readBalanceSnapshot(input) {
        snapshotCalls.push({
          workspaceId: input.workspaceId,
          claimDate: input.claimDate,
        });
        if (options.snapshotFails) throw options.snapshotFails;
        if (!CLAIM_DATE_GUARD.test(input.claimDate)) {
          throw new Error(
            'credit balance snapshot read needs a "claimDate" of the form YYYY-MM-DD',
          );
        }

        return (
          options.snapshot ?? { balance: 0, plan: "free", daily_claimed: true }
        );
      },
    },
  };
}

/** The claim path's service: both repositories are optional. */
function buildClaimService(options: {
  repository?: CreditReadRepository;
  ledger?: CreditLedgerFunctionRepository;
}): CreditService {
  return createCreditService({
    ...(options.repository ? { creditReadRepository: options.repository } : {}),
    ...(options.ledger
      ? { creditLedgerFunctionRepository: options.ledger }
      : {}),
  });
}

/** The plans whose `PLAN_CONFIGS` entry grants no daily credits at all. */
const ZERO_DAILY_PLANS: SubscriptionPlan[] = [
  "starter",
  "pro",
  "ultra",
  "business",
];

describe("credit-service claimDailyCredits: the plan read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("case 27: no subscription row is the free plan, and the RPC gets its daily amount", async () => {
    // The premise, pinned: `free` is the ONE plan that still grants a daily
    // amount, and it is the amount the RPC must be asked for.
    expect(PLAN_CONFIGS.free.dailyCredits).toBe(FREE_DAILY_CREDITS);

    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscription: null,
      snapshot: { balance: 12, plan: "free", daily_claimed: true },
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
      success: true,
      balance: 12,
    });

    expect(fake.subscriptionCalls).toEqual([WORKSPACE_ID]);
    expect(ledger.calls).toEqual([
      {
        method: "claimDailyCredits",
        args: { workspaceId: WORKSPACE_ID, amount: FREE_DAILY_CREDITS },
      },
    ]);
    expect(ledger.forbiddenReads).toEqual([]);
  });

  it("case 28: a failed plan read is the existing credit_claim_failed 500 and no RPC", async () => {
    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscriptionFails: new Error(
        "connect ECONNREFUSED 203.0.113.9:5432 postgres://loomic:secret@db.example/db",
      ),
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    const error = await refusal(() => service.claimDailyCredits(WORKSPACE_ID));

    expect(error.code).toBe("credit_claim_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query subscription.");
    // The driver's message — host, port, credentials — stays out of the
    // response; the repository already reduced it to a fixed text plus `cause`.
    expect(error.message).not.toMatch(/ECONNREFUSED|203\.0\.113\.9|secret/i);
    // The claim was never attempted, and neither was the balance read.
    expect(ledger.calls).toEqual([]);
    expect(fake.snapshotCalls).toEqual([]);
    expect(ledger.forbiddenReads).toEqual([]);
  });

  it("case 29: with no repository the claim fails closed instead of falling back", async () => {
    const ledger = createClaimLedger({ claimed: true });
    const service = buildClaimService({ ledger: ledger.repository });

    const error = await refusal(() => service.claimDailyCredits(WORKSPACE_ID));

    expect(error.code).toBe("credit_claim_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe("Failed to query subscription.");
    expect(ledger.calls).toEqual([]);
    // Measured, not assumed: the client it used to read the plan through was
    // never reached.
    expect(ledger.forbiddenReads).toEqual([]);
  });

  it("case 30: a stored plan of free is read as free and still claims", async () => {
    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscription: { ...SUBSCRIPTION_ROW, plan: "free" },
      snapshot: { balance: 3, plan: "free", daily_claimed: true },
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
      success: true,
      balance: 3,
    });

    expect(fake.subscriptionCalls).toEqual([WORKSPACE_ID]);
    expect(fake.snapshotCalls).toHaveLength(1);
    expect(ledger.calls.map((call) => call.method)).toEqual([
      "claimDailyCredits",
    ]);
  });
});

describe("credit-service claimDailyCredits: the plans that grant no daily credits", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [offset, plan] of ZERO_DAILY_PLANS.entries()) {
    it(`case ${31 + offset}: the ${plan} plan grants nothing, so the claim stops before the RPC`, async () => {
      // The premise is pinned PER PLAN rather than assumed: this case is only
      // meaningful while that plan really grants zero daily credits.
      expect(PLAN_CONFIGS[plan].dailyCredits).toBe(0);

      const ledger = createClaimLedger({ claimed: true });
      const fake = createClaimRepository({
        subscription: { ...SUBSCRIPTION_ROW, plan },
        snapshot: { balance: 99, plan, daily_claimed: false },
      });
      const service = buildClaimService({
        repository: fake.repository,
        ledger: ledger.repository,
      });

      await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
        success: false,
      });
      expect(ledger.calls).toEqual([]);
      // Nothing was claimed, so not even the balance was read.
      expect(fake.snapshotCalls).toEqual([]);
      expect(ledger.forbiddenReads).toEqual([]);
    });
  }
});

describe("credit-service claimDailyCredits: the claim and the balance read", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("case 35: an already-claimed day answers success false and never reads a balance", async () => {
    const ledger = createClaimLedger({ claimed: false });
    const fake = createClaimRepository({
      subscription: null,
      snapshot: { balance: 42, plan: "free", daily_claimed: true },
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    const result = await service.claimDailyCredits(WORKSPACE_ID);

    expect(result).toEqual({ success: false });
    // Exactly the published key set on this branch: no `balance` key at all.
    expect(Object.keys(result)).toEqual(["success"]);
    expect(fake.snapshotCalls).toEqual([]);
    expect(ledger.forbiddenReads).toEqual([]);
  });

  it("case 36: a granted claim publishes the snapshot's balance, asked for the JS UTC day", async () => {
    vi.useFakeTimers();
    // 23:30 on the 16th at UTC-8 is 07:30 on the 17th UTC: the LOCAL day and the
    // UTC day disagree, so only one of them can be the day asked about.
    vi.setSystemTime(new Date("2026-10-16T23:30:00-08:00"));

    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscription: null,
      snapshot: { balance: 37, plan: "free", daily_claimed: true },
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
      success: true,
      balance: 37,
    });

    expect(fake.snapshotCalls).toEqual([
      { workspaceId: WORKSPACE_ID, claimDate: "2026-10-17" },
    ]);
    expect(ledger.forbiddenReads).toEqual([]);
  });

  it("case 37: a balance read that FAILS after a granted claim is success true, balance 0, one warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscription: null,
      snapshotFails: new Error(
        "connect ECONNREFUSED 203.0.113.9:5432 postgres://loomic:secret@db.example/db",
      ),
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    // The credits ARE granted by this point: a 500 here would tell the client the
    // claim failed while the balance really moved, and its retry would then be
    // answered "already claimed today".
    await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
      success: true,
      balance: 0,
    });

    expect(ledger.calls.map((call) => call.method)).toEqual([
      "claimDailyCredits",
    ]);
    expect(fake.snapshotCalls).toHaveLength(1);

    // Exactly ONE log line, and it carries the fixed text only — the driver's
    // host and credentials stay out of it.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toMatch(/claimDailyCredits/);
    expect(logged).not.toMatch(/ECONNREFUSED|203\.0\.113\.9|secret/i);
  });

  it("case 38: a workspace with no balance row publishes 0 and warns about nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ledger = createClaimLedger({ claimed: true });
    const fake = createClaimRepository({
      subscription: null,
      snapshot: { balance: null, plan: null, daily_claimed: true },
    });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    await expect(service.claimDailyCredits(WORKSPACE_ID)).resolves.toEqual({
      success: true,
      balance: 0,
    });

    // An absent balance row is a legal answer, NOT the failure case 37 covers:
    // it must not be logged as one.
    expect(warn).not.toHaveBeenCalled();
  });

  it("case 39: a failing claim function keeps its message verbatim and never reads a balance", async () => {
    const ledger = createClaimLedger({ error: { message: "deadlock detected" } });
    const fake = createClaimRepository({ subscription: null });
    const service = buildClaimService({
      repository: fake.repository,
      ledger: ledger.repository,
    });

    const error = await refusal(() => service.claimDailyCredits(WORKSPACE_ID));

    expect(error.code).toBe("credit_claim_failed");
    expect(error.statusCode).toBe(500);
    // Pinned word for word: this migration does NOT touch this message, which
    // still carries the driver's own text.
    expect(error.message).toBe(
      "Failed to claim daily credits: deadlock detected",
    );
    expect(fake.snapshotCalls).toEqual([]);
  });

  it("case 40: every branch leaves the ledger repository's other methods unread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const branches: Array<{
      ledger: ReturnType<typeof createClaimLedger>;
      call: () => Promise<unknown>;
    }> = [];

    const push = (
      ledgerOptions: Parameters<typeof createClaimLedger>[0],
      repositoryOptions: Parameters<typeof createClaimRepository>[0] | null,
    ) => {
      const ledger = createClaimLedger(ledgerOptions);
      const fake =
        repositoryOptions === null
          ? null
          : createClaimRepository(repositoryOptions);
      const service = buildClaimService({
        ...(fake ? { repository: fake.repository } : {}),
        ledger: ledger.repository,
      });

      branches.push({
        ledger,
        call: () => service.claimDailyCredits(WORKSPACE_ID),
      });
    };

    // Every branch of the method: a granted claim, a plan that grants nothing,
    // an already-claimed day, a failing RPC, a failing balance read, and no
    // repository at all.
    push({ claimed: true }, { subscription: null });
    push({ claimed: true }, { subscription: { ...SUBSCRIPTION_ROW, plan: "pro" } });
    push({ claimed: false }, { subscription: null });
    push({ error: { message: "boom" } }, { subscription: null });
    push(
      { claimed: true },
      { subscription: null, snapshotFails: new Error("the read failed") },
    );
    push({ claimed: true }, null);

    for (const branch of branches) {
      await branch.call().catch(() => undefined);

      // The ledger repository's OTHER methods are read ZERO times on every branch —
      // measured on the client itself, not inferred from the repository's calls.
      expect(branch.ledger.forbiddenReads).toEqual([]);
      expect(branch.ledger.forbiddenReads).not.toContain("from");

      for (const call of branch.ledger.calls) {
        expect(call.method).toBe("claimDailyCredits");
      }
    }

    // The spy is not vacuous: the claim function really was reached where it should be, and
    // not at all where the plan or the repository stopped the call.
    expect(branches[0]?.ledger.calls).toHaveLength(1);
    expect(branches[2]?.ledger.calls).toHaveLength(1);
    expect(branches[5]?.ledger.calls).toEqual([]);
    // ...and the one failing balance read really did produce its log line.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("case 41: the claim stand-in is not vacuous — a forbidden read and its throw both show up", () => {
    // A guard for this file's own premise. If the stand-in could not record a
    // forbidden read, case 40 would pass for the wrong reason; this proves that
    // reaching one is both observable and fatal.
    const ledger = createClaimLedger({ claimed: true });

    expect(ledger.forbiddenReads).toEqual([]);

    const forbidden = (
      ledger.repository as unknown as Record<string, () => unknown>
    )["from"];
    expect(ledger.forbiddenReads).toEqual(["from"]);
    expect(() => forbidden?.()).toThrow(/reached the ledger repository's "from"/);
  });
});

/**
 * 工单33D · X-40 §4 —— 余额不足只按 SQLSTATE 识别。
 *
 * 这三个用例钉住的是「认码不认文案」：同一个 `deduct_credits` 调用，回答里
 * 有 `P0402` 就是 402 insufficient_credits（文案随便改也一样），没有这个码
 * 就绝不是余额不足 —— 哪怕 message 里还留着旧的那串 `INSUFFICIENT_CREDITS`。
 * 仓储桩只有 `deductCredits` 这一个方法，除这一条函数之外的接触都不可能发生。
 */
describe("credit-service deductCredits: insufficient balance is recognised by SQLSTATE (X-40 §4)", () => {
  const DEDUCT_USER_ID = "00000000-0000-0000-0000-0000000033d1";

  /** 最小仓储桩：只有 `deductCredits` 这一个方法，按给定的结果回答（error 则抛出）。 */
  function deductServiceWith(answer: {
    data: unknown;
    error: unknown;
  }): CreditService {
    const ledger = {
      deductCredits: async () => {
        if (answer.error) throw answer.error;

        return answer.data as string;
      },
    } as unknown as CreditLedgerFunctionRepository;

    return createCreditService({ creditLedgerFunctionRepository: ledger });
  }

  it("X-40: code P0402 is a 402 insufficient_credits whatever the message says", async () => {
    // 前提钉住：判据是这个常量，而不是任何一段文案。
    expect(INSUFFICIENT_CREDITS_SQLSTATE).toBe("P0402");

    const service = deductServiceWith({
      data: null,
      error: { code: "P0402", message: "余额不够了（文案随便改）" },
    });

    const error = await refusal(() =>
      service.deductCredits(WORKSPACE_ID, DEDUCT_USER_ID, 5),
    );

    expect(error.code).toBe("insufficient_credits");
    expect(error.statusCode).toBe(402);
  });

  it("X-40: the old message text without the code is NOT read as insufficient credits", async () => {
    const service = deductServiceWith({
      data: null,
      error: { code: "P0001", message: "INSUFFICIENT_CREDITS: have 1, need 5" },
    });

    const error = await refusal(() =>
      service.deductCredits(WORKSPACE_ID, DEDUCT_USER_ID, 5),
    );

    expect(error.code).toBe("credit_deduct_failed");
    expect(error.statusCode).toBe(500);
  });

  it("X-40: a successful deduction returns the transaction id", async () => {
    const service = deductServiceWith({ data: "tx-1", error: null });

    await expect(
      service.deductCredits(WORKSPACE_ID, DEDUCT_USER_ID, 5),
    ).resolves.toBe("tx-1");
  });

  it("44K: with no credit ledger function repository the deduction fails as credit_deduct_failed 500", async () => {
    const service = createCreditService({});

    const error = await refusal(() =>
      service.deductCredits(WORKSPACE_ID, DEDUCT_USER_ID, 5),
    );

    expect(error.code).toBe("credit_deduct_failed");
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe(
      "Failed to deduct credits: no credit ledger function repository",
    );
  });
});
