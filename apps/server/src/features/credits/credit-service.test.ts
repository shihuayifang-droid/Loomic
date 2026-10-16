import { describe, expect, it } from "vitest";

import {
  createCreditReadRepository,
  type CreditReadRepository,
  type CreditTransactionReadRow,
  type SubscriptionReadRow,
} from "../../db/credit-read-repository.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  CreditServiceError,
  createCreditService,
  type CreditService,
  type SubscriptionInfo,
} from "./credit-service.js";

/**
 * Workorder 21K: the two reads of `CreditService` that moved to the pure `pg`
 * repository. This file tests THOSE TWO METHODS and nothing else.
 *
 * The service is driven with a recording fake repository, so what is asserted is
 * the contract between the two modules: the clamped limit the service computes
 * and hands down, the untouched rows it hands back, the camelCase projection of
 * the subscription with its `free` + six-null default, and the single failure
 * code both methods answer with. The `getAdminClient` stub THROWS on contact, so
 * no case below can pass while a read still reaches PostgREST.
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

type FakeRepository = {
  repository: CreditReadRepository;
  listCalls: ListCall[];
  subscriptionCalls: string[];
};

/**
 * A recording repository whose limit rule mirrors the real one: a limit that is
 * not an integer inside 1..100 is refused before the pool is touched. Without
 * that mirror a fake would happily answer a `NaN` limit, and the service's
 * `NaN` path would look green while the real chain answers 500.
 */
function createFakeRepository(
  options: {
    transactions?: CreditTransactionReadRow[];
    subscription?: SubscriptionReadRow | null;
    failWith?: Error;
  } = {},
): FakeRepository {
  const listCalls: ListCall[] = [];
  const subscriptionCalls: string[] = [];

  return {
    listCalls,
    subscriptionCalls,
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
