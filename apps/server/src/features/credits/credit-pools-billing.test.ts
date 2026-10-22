// Workorder 37T: the three-pool switch. Stand-in tests for the wrapper and the
// pre-check, plus one real-SQL round trip on PGlite.
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PriceDetail } from "@loomic/shared";

import { createCreditPoolWriteRepository } from "../../db/credit-pool-write-repository.js";
import {
  createMigratedDb,
  createPGliteTransactionPool,
  createUser,
} from "../../test-support/db/pglite-db.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import type { PriceQuoter } from "../pricing/price-quoter.js";
import {
  POOL_SQLSTATE,
  creditPoolsEnabled,
  withCreditPools,
  type CreditPoolsDeps,
} from "./credit-pools-billing.js";
import type { CreditService } from "./credit-service.js";
import type { TierGuard } from "./tier-guard.js";
import { withBilling } from "./with-billing.js";

const POOL_BALANCES = {
  daily: 50,
  teamRemaining: 30000,
  personalTeamUsed: 5000,
  personalCap: 20000,
  topup: 200,
};

function makeBase() {
  return {
    getBalance: vi.fn(async () => ({
      balance: 1000,
      plan: "pro" as const,
      dailyClaimed: false,
    })),
    getSubscription: vi.fn(async () => ({
      plan: "pro" as const,
      billingPeriod: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    })),
    deductCredits: vi.fn(async () => "base-deduct"),
    refundCredits: vi.fn(async () => "base-refund"),
    claimDailyCredits: vi.fn(async () => ({ success: true })),
    getTransactions: vi.fn(async () => []),
    updatePlan: vi.fn(async () => {}),
  } as unknown as CreditService & Record<string, ReturnType<typeof vi.fn>>;
}

function makeDeps(overrides: Partial<CreditPoolsDeps> = {}) {
  return {
    resolveTeamWorkspaceId: vi.fn(async () => "t1" as string | null),
    deductFromPools: vi.fn(async () => "pool-deduct"),
    refundToPools: vi.fn(async () => "r1" as string | null),
    readPoolBalances: vi.fn(async () => POOL_BALANCES),
    ...overrides,
  } as CreditPoolsDeps & Record<string, ReturnType<typeof vi.fn>>;
}

function sqlError(code: string): Error {
  return Object.assign(new Error("database said no"), { code });
}

describe("creditPoolsEnabled", () => {
  it("only the lowercase value on turns the pools on", () => {
    expect(creditPoolsEnabled({})).toBe(false);
    expect(creditPoolsEnabled({ LOOMIC_CREDIT_POOLS: "off" })).toBe(false);
    expect(creditPoolsEnabled({ LOOMIC_CREDIT_POOLS: "ON" })).toBe(false);
    expect(creditPoolsEnabled({ LOOMIC_CREDIT_POOLS: "on" })).toBe(true);
  });
});

describe("withCreditPools", () => {
  it("deduct goes to the team pools", async () => {
    const base = makeBase();
    const deps = makeDeps();
    const service = withCreditPools(base, deps);

    await expect(service.deductCredits("ws", "u", 12, "j", "d")).resolves.toBe(
      "pool-deduct",
    );

    expect(deps.deductFromPools).toHaveBeenCalledWith({
      workspaceId: "t1",
      userId: "u",
      amount: 12,
      jobId: "j",
      description: "d",
    });
    expect(base.deductCredits).toHaveBeenCalledTimes(0);
  });

  it("no team workspace falls back to the old deduct", async () => {
    const base = makeBase();
    const deps = makeDeps({ resolveTeamWorkspaceId: vi.fn(async () => null) });
    const service = withCreditPools(base, deps);

    await expect(service.deductCredits("ws", "u", 12, "j", "d")).resolves.toBe(
      "base-deduct",
    );

    expect(base.deductCredits).toHaveBeenCalledTimes(1);
    expect(deps.deductFromPools).toHaveBeenCalledTimes(0);
  });

  it("P0403 becomes personal_cap_reached (402)", async () => {
    const service = withCreditPools(
      makeBase(),
      makeDeps({
        deductFromPools: vi.fn(async () => {
          throw sqlError(POOL_SQLSTATE.personalCap);
        }),
      }),
    );

    await expect(service.deductCredits("ws", "u", 12)).rejects.toMatchObject({
      code: "personal_cap_reached",
      statusCode: 402,
    });
  });

  it("P0404 becomes team_pool_exhausted (402)", async () => {
    const service = withCreditPools(
      makeBase(),
      makeDeps({
        deductFromPools: vi.fn(async () => {
          throw sqlError(POOL_SQLSTATE.teamPool);
        }),
      }),
    );

    await expect(service.deductCredits("ws", "u", 12)).rejects.toMatchObject({
      code: "team_pool_exhausted",
      statusCode: 402,
    });
  });

  it("P0402 becomes insufficient_credits (402)", async () => {
    const service = withCreditPools(
      makeBase(),
      makeDeps({
        deductFromPools: vi.fn(async () => {
          throw sqlError(POOL_SQLSTATE.insufficient);
        }),
      }),
    );

    await expect(service.deductCredits("ws", "u", 12)).rejects.toMatchObject({
      code: "insufficient_credits",
      statusCode: 402,
    });
  });

  it("any other error becomes credit_deduct_failed (500)", async () => {
    const service = withCreditPools(
      makeBase(),
      makeDeps({
        deductFromPools: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );

    await expect(service.deductCredits("ws", "u", 12)).rejects.toMatchObject({
      code: "credit_deduct_failed",
      statusCode: 500,
    });
  });

  it("refund with a job goes back through the pools", async () => {
    const base = makeBase();
    const deps = makeDeps();
    const service = withCreditPools(base, deps);

    await expect(service.refundCredits("ws", "u", 12, "j", "d")).resolves.toBe(
      "r1",
    );

    expect(deps.refundToPools).toHaveBeenCalledWith({
      jobId: "j",
      description: "d",
    });
    expect(base.refundCredits).toHaveBeenCalledTimes(0);
  });

  it("a job charged the old way is refunded the old way", async () => {
    const base = makeBase();
    const deps = makeDeps({ refundToPools: vi.fn(async () => null) });
    const service = withCreditPools(base, deps);

    await expect(service.refundCredits("ws", "u", 12, "j", "d")).resolves.toBe(
      "base-refund",
    );

    expect(base.refundCredits).toHaveBeenCalledTimes(1);
  });

  it("a refund without a job uses the old path", async () => {
    const base = makeBase();
    const deps = makeDeps();
    const service = withCreditPools(base, deps);

    await expect(
      service.refundCredits("ws", "u", 12, undefined, "d"),
    ).resolves.toBe("base-refund");

    expect(deps.refundToPools).toHaveBeenCalledTimes(0);
    expect(base.refundCredits).toHaveBeenCalledTimes(1);
  });

  it("other methods are untouched", async () => {
    const base = makeBase();
    const service = withCreditPools(base, makeDeps());

    await expect(service.getBalance("ws")).resolves.toEqual({
      balance: 1000,
      plan: "pro",
      dailyClaimed: false,
    });
    await expect(service.getTransactions("ws", 5)).resolves.toEqual([]);
    expect(base.getBalance).toHaveBeenCalledWith("ws");
    expect(base.getTransactions).toHaveBeenCalledWith("ws", 5);
  });

  it("availableFor reads the pools", async () => {
    const service = withCreditPools(makeBase(), makeDeps());
    await expect(
      service.availableFor?.({ workspaceId: "ws", userId: "u" }),
    ).resolves.toBe(15250);

    const noTeam = withCreditPools(
      makeBase(),
      makeDeps({ resolveTeamWorkspaceId: vi.fn(async () => null) }),
    );
    await expect(
      noTeam.availableFor?.({ workspaceId: "ws", userId: "u" }),
    ).resolves.toBeNull();
  });
});

// ── with-billing pre-check ────────────────────────────────────

const USER: AuthenticatedUser = {
  id: "user-1",
  accessToken: "token",
  email: "a@b.c",
  userMetadata: {},
};

function makeQuoter(total: number) {
  const detail: PriceDetail = {
    base_price: total,
    unit_name: "次",
    unit_count: 1,
    unit_price: total,
    total_price: total,
    search_key: "hd",
    search_key_matched: "hd",
    time_variant_period: "normal",
    disable_unlimited: false,
    entry_point: "canvas_generator",
    extras: [],
    price_status: "active",
  };
  return {
    quote: vi.fn(async () => ({ ok: true as const, detail, ruleId: "rule-1" })),
  } as unknown as PriceQuoter;
}

function makeTierGuard() {
  return {
    checkModelAccess: vi.fn(),
    checkResolution: vi.fn(),
    checkVideoResolution: vi.fn(),
    checkConcurrency: vi.fn(async () => {}),
  } as unknown as TierGuard;
}

const IMAGE_REQUEST = {
  user: USER,
  workspaceId: "ws-1",
  modelId: "kwjm/gpt-image-2",
  entryPoint: "canvas_generator" as const,
  guard: { jobType: "image_generation" as const, quality: "hd" as const },
  description: "test image",
};

describe("withBilling pre-check with the pools", () => {
  it("the pre-check uses the pool figure when it is there", async () => {
    const creditService = makeBase();
    (creditService as CreditService).availableFor = vi.fn(async () => 10);
    const work = vi.fn(async () => "done");

    await expect(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        IMAGE_REQUEST,
        work,
      ),
    ).rejects.toMatchObject({ code: "insufficient_credits" });

    expect(creditService.getBalance).toHaveBeenCalledTimes(0);
    expect(creditService.deductCredits).toHaveBeenCalledTimes(0);
    expect(work).toHaveBeenCalledTimes(0);
  });

  it("without availableFor the pre-check is unchanged", async () => {
    const creditService = makeBase();
    const work = vi.fn(async () => "done");

    await withBilling(
      {
        creditService,
        tierGuard: makeTierGuard(),
        priceQuoter: makeQuoter(12),
      },
      IMAGE_REQUEST,
      work,
    );

    expect(creditService.getBalance).toHaveBeenCalledTimes(1);
    expect(creditService.deductCredits).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
  });
});

// ── PGlite end to end ─────────────────────────────────────────

const MONTH_SQL = "date_trunc('month', now() at time zone 'Asia/Shanghai')::date";

let db: PGlite;
let teamId: string;
let userA: string;
let userB: string;
let jobId: string;
let repo: ReturnType<typeof createCreditPoolWriteRepository>;

function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row, got none");
  return row;
}

async function poolUsed(): Promise<number> {
  return firstRow(
    (
      await db.query<{ pool_used: number }>(
        `select pool_used from public.team_credit_pools
          where workspace_id = $1 and period_month = ${MONTH_SQL}`,
        [teamId],
      )
    ).rows,
  ).pool_used;
}

describe("a pool charge on a real database", () => {
  beforeAll(async () => {
    const created = await createMigratedDb();
    db = created.db;
    repo = createCreditPoolWriteRepository({
      getTransactionPool: () => createPGliteTransactionPool(db),
    });

    userA = "00000000-0000-0000-0000-000000037a01";
    userB = "00000000-0000-0000-0000-000000037a02";
    const userC = "00000000-0000-0000-0000-000000037a03";
    await createUser(db, userA, "user-37t-a@hahart.test");
    await createUser(db, userB, "user-37t-b@hahart.test");
    await createUser(db, userC, "user-37t-c@hahart.test");

    teamId = firstRow(
      (
        await db.query<{ id: string }>(
          `insert into public.workspaces (type, name, owner_user_id)
           values ('team', 'HaHart Team', $1) returning id`,
          [userA],
        )
      ).rows,
    ).id;
    for (const [id, role] of [
      [userA, "owner"],
      [userB, "member"],
      [userC, "member"],
    ] as const) {
      await db.query(
        `insert into public.workspace_members (workspace_id, user_id, role)
         values ($1, $2, $3) on conflict do nothing`,
        [teamId, id, role],
      );
    }
    await db.query("select public.grant_team_cycle($1, null, null)", [teamId]);

    jobId = firstRow(
      (
        await db.query<{ id: string }>(
          `insert into public.background_jobs (workspace_id, queue_name, job_type, created_by)
           values ($1, 'image_generation', 'image_generation', $2) returning id`,
          [teamId, userA],
        )
      ).rows,
    ).id;
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it("a pool charge and its refund round-trip", async () => {
    await expect(repo.resolveTeamWorkspaceId()).resolves.toBe(teamId);

    const chargeId = await repo.deductFromPools({
      workspaceId: teamId,
      userId: userA,
      amount: 12,
      jobId,
      description: "d",
    });
    expect(typeof chargeId).toBe("string");
    expect(await poolUsed()).toBe(12);

    const refundId = await repo.refundToPools({ jobId, description: "d" });
    expect(typeof refundId).toBe("string");
    expect(await poolUsed()).toBe(0);

    // The personal cap refusal reaches the caller with its SQLSTATE intact.
    await db.query(
      `update public.team_credit_pools set pool_used = 19990
        where workspace_id = $1 and period_month = ${MONTH_SQL}`,
      [teamId],
    );
    await db.query(
      `insert into public.member_team_usage (workspace_id, user_id, period_month, personal_cap, used)
       values ($1, $2, ${MONTH_SQL}, 20000, 19990)`,
      [teamId, userB],
    );
    const failure = await repo
      .deductFromPools({ workspaceId: teamId, userId: userB, amount: 12 })
      .then(
        () => null,
        (error: unknown) => error as { code?: unknown },
      );
    expect(failure?.code).toBe("P0403");
  });
});

// ── withBilling pre-check: the precise refusal (workorder 38E / BL-45) ──

type RefusalError = {
  code?: unknown;
  statusCode?: unknown;
  message?: unknown;
};

function refusalOf(promise: Promise<unknown>): Promise<RefusalError | null> {
  return promise.then(
    () => null,
    (error: unknown) => error as RefusalError,
  );
}

describe("withBilling pre-check: the precise refusal (BL-45)", () => {
  it("BL-45: a member at 19990 of the cap is refused with personal_cap_reached before any charge", async () => {
    const base = makeBase();
    const deps = makeDeps({
      readPoolBalances: vi.fn(async () => ({
        daily: 0,
        teamRemaining: 50000,
        personalTeamUsed: 19990,
        personalCap: 20000,
        topup: 0,
      })),
    });
    const creditService = withCreditPools(base, deps);

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        IMAGE_REQUEST,
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("personal_cap_reached");
    expect(error?.statusCode).toBe(402);
    expect(String(error?.message)).toContain("上限 20000");
    expect(deps.deductFromPools).toHaveBeenCalledTimes(0);
    expect(base.deductCredits).toHaveBeenCalledTimes(0);
  });

  it("BL-45: an empty team pool is refused with team_pool_exhausted", async () => {
    const base = makeBase();
    const deps = makeDeps({
      readPoolBalances: vi.fn(async () => ({
        daily: 0,
        teamRemaining: 0,
        personalTeamUsed: 0,
        personalCap: 20000,
        topup: 0,
      })),
    });
    const creditService = withCreditPools(base, deps);

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        IMAGE_REQUEST,
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("team_pool_exhausted");
    expect(error?.statusCode).toBe(402);
    expect(String(error?.message)).toBe("团队本月额度已用完");
    expect(deps.deductFromPools).toHaveBeenCalledTimes(0);
  });

  it("BL-45: someone with nothing is refused with insufficient_credits", async () => {
    const base = makeBase();
    const deps = makeDeps({
      readPoolBalances: vi.fn(async () => ({
        daily: 0,
        teamRemaining: 0,
        personalTeamUsed: 0,
        personalCap: 0,
        topup: 0,
      })),
    });
    const creditService = withCreditPools(base, deps);

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        IMAGE_REQUEST,
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("insufficient_credits");
    expect(error?.statusCode).toBe(402);
    expect(deps.deductFromPools).toHaveBeenCalledTimes(0);
  });

  it("BL-45: enough credits passes the pre-check and charges the pools", async () => {
    const base = makeBase();
    const deps = makeDeps();
    const creditService = withCreditPools(base, deps);

    const result = await withBilling(
      {
        creditService,
        tierGuard: makeTierGuard(),
        priceQuoter: makeQuoter(12),
      },
      IMAGE_REQUEST,
      vi.fn(async () => "done"),
    );

    expect(result).toBe("done");
    expect(deps.deductFromPools).toHaveBeenCalledTimes(1);
    expect(base.deductCredits).toHaveBeenCalledTimes(0);
  });

  it("refusalFor without a team workspace is undefined, and the old pre-check runs", async () => {
    const base = makeBase();
    const deps = makeDeps({
      resolveTeamWorkspaceId: vi.fn(async () => null),
    });
    const creditService = withCreditPools(base, deps);

    await expect(
      creditService.refusalFor?.({
        workspaceId: "ws",
        userId: "u",
        amount: 12,
      }),
    ).resolves.toBeUndefined();

    await withBilling(
      {
        creditService,
        tierGuard: makeTierGuard(),
        priceQuoter: makeQuoter(12),
      },
      IMAGE_REQUEST,
      vi.fn(async () => "done"),
    );

    expect(base.getBalance).toHaveBeenCalledTimes(1);
  });
});

// ── the rejection EVENT carries the precise pool code (workorder 39H / T-107) ──

describe("withBilling rejection event: the precise pool code (39H)", () => {
  it("BL-45: a pool cap refusal is reported as pool_refusal with the cap sentence", async () => {
    const base = makeBase();
    const deps = makeDeps({
      readPoolBalances: vi.fn(async () => ({
        daily: 0,
        teamRemaining: 50000,
        personalTeamUsed: 19990,
        personalCap: 20000,
        topup: 0,
      })),
    });
    const creditService = withCreditPools(base, deps);
    const onRejected = vi.fn();

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        { ...IMAGE_REQUEST, onRejected },
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("personal_cap_reached");
    expect(onRejected).toHaveBeenCalledTimes(1);
    const rejection = onRejected.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(rejection).toMatchObject({
      kind: "pool_refusal",
      code: "personal_cap_reached",
      message: "本月额度已用完（上限 20000），可联系管理员调整",
      requiredAmount: 12,
    });
    expect(typeof rejection.currentBalance).toBe("number");
    expect(rejection).not.toHaveProperty("plan");
    expect(rejection).not.toHaveProperty("dailyClaimed");
  });

  it("BL-45: an empty team pool is reported as team_pool_exhausted", async () => {
    const base = makeBase();
    const deps = makeDeps({
      readPoolBalances: vi.fn(async () => ({
        daily: 0,
        teamRemaining: 0,
        personalTeamUsed: 0,
        personalCap: 20000,
        topup: 0,
      })),
    });
    const creditService = withCreditPools(base, deps);
    const onRejected = vi.fn();

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        { ...IMAGE_REQUEST, onRejected },
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("team_pool_exhausted");
    expect(onRejected).toHaveBeenCalledTimes(1);
    const rejection = onRejected.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(rejection).toMatchObject({
      kind: "pool_refusal",
      code: "team_pool_exhausted",
      message: "团队本月额度已用完",
      requiredAmount: 12,
    });
    expect(typeof rejection.currentBalance).toBe("number");
    expect(rejection).not.toHaveProperty("plan");
    expect(rejection).not.toHaveProperty("dailyClaimed");
  });

  it("BL-45: pooled credits short of the price are pool_refusal insufficient_credits", async () => {
    const creditService = makeBase();
    (creditService as CreditService).availableFor = vi.fn(async () => 10);
    const onRejected = vi.fn();

    const error = await refusalOf(
      withBilling(
        {
          creditService,
          tierGuard: makeTierGuard(),
          priceQuoter: makeQuoter(12),
        },
        { ...IMAGE_REQUEST, onRejected },
        vi.fn(async () => "done"),
      ),
    );

    expect(error?.code).toBe("insufficient_credits");
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected.mock.calls[0]?.[0]).toEqual({
      kind: "pool_refusal",
      code: "insufficient_credits",
      message: "Insufficient credits: 10 available, 12 required.",
      currentBalance: 10,
      requiredAmount: 12,
    });
  });
});
