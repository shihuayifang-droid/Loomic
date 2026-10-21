import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PoolBalanceReadRepository } from "../db/pool-balance-read-repository.js";
import type { PoolGrantWriteRepository } from "../db/pool-grant-write-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerCreditRoutes } from "./credits.js";

/**
 * BL-45 / workorder 37Q — the three pools on `GET /api/credits`.
 *
 * What is pinned here is the ROUTE's half, with a stand-in repository and no
 * database: the pools are read for the TEAM workspace of the authenticated
 * user, the ONE available figure comes from the shared rule (not re-derived
 * here), a caller without a team workspace reads as `null` instead of a fake
 * all-zero pool, a failed pool read is a 500 rather than a half-filled balance,
 * and without a repository the payload is exactly what it was before.
 */

const TOKEN = "credits-pools-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "credits-pools@hahart.test",
  id: "00000000-0000-0000-0000-0000000000e1",
  userMetadata: {},
};
const PERSONAL_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e2";
const TEAM_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e3";

/** "Pro" is not used: the free plan keeps the limits literals small and known. */
const BALANCE = {
  balance: 1234,
  plan: "free" as const,
  dailyClaimed: false,
};

const FREE_LIMITS = {
  maxConcurrentJobs: 1,
  maxResolution: "standard",
  monthlyCredits: 0,
  dailyCredits: 50,
};

const POOLS = {
  daily: 50,
  teamRemaining: 30000,
  personalTeamUsed: 5000,
  personalCap: 20000,
  topup: 200,
};

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

function buildViewerService(teamWorkspace: boolean): ViewerService {
  return {
    async ensureViewer() {
      return {
        profile: {
          id: USER.id,
          email: USER.email,
          displayName: "Credits Pools",
          avatarUrl: null,
        },
        workspace: {
          id: PERSONAL_WORKSPACE_ID,
          name: "Personal",
          type: "personal",
        },
        membership: { role: "owner" },
        teamWorkspace: teamWorkspace
          ? { id: TEAM_WORKSPACE_ID, name: "Team", type: "team" }
          : null,
        teamMembership: teamWorkspace ? { role: "owner" } : null,
      };
    },
  } as unknown as ViewerService;
}

function buildCreditService(): CreditService {
  return {
    getBalance: vi.fn(async () => BALANCE),
  } as unknown as CreditService;
}

let apps: FastifyInstance[] = [];

async function buildApp(options: {
  teamWorkspace?: boolean;
  repository?: PoolBalanceReadRepository;
  grantRepository?: Pick<PoolGrantWriteRepository, "grantDailyCredits">;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await registerCreditRoutes(app, {
    auth,
    creditService: buildCreditService(),
    viewerService: buildViewerService(options.teamWorkspace ?? true),
    ...(options.repository
      ? { poolBalanceReadRepository: options.repository }
      : {}),
    ...(options.grantRepository
      ? { poolGrantWriteRepository: options.grantRepository }
      : {}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
  vi.clearAllMocks();
});

function readBalance(
  app: FastifyInstance,
  options: { authenticated?: boolean } = {},
) {
  return app.inject({
    method: "GET",
    url: "/api/credits",
    ...(options.authenticated === false
      ? {}
      : { headers: { authorization: `Bearer ${TOKEN}` } }),
  });
}

describe("GET /api/credits — BL-45 pools", () => {
  it("BL-45: the balance carries the three pools and one available figure", async () => {
    const readPoolBalances = vi.fn(async () => POOLS);
    const app = await buildApp({
      teamWorkspace: true,
      repository: { readPoolBalances },
    });

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pools.balances).toEqual({
      daily: 50,
      teamRemaining: 30000,
      personalTeamUsed: 5000,
      personalCap: 20000,
      topup: 200,
    });
    // 50 daily + min(30000 team remaining, 20000 - 5000 cap left) 15000 + 200 topup.
    expect(body.pools.available).toBe(15250);
    // The pools are the TEAM workspace's, and the member is the authenticated user.
    expect(readPoolBalances).toHaveBeenCalledTimes(1);
    expect(readPoolBalances).toHaveBeenCalledWith({
      workspaceId: TEAM_WORKSPACE_ID,
      userId: USER.id,
    });
  });

  it("BL-45: the old fields are unchanged", async () => {
    const readPoolBalances = vi.fn(async () => POOLS);
    const withRepository = await buildApp({
      teamWorkspace: true,
      repository: { readPoolBalances },
    });
    const withoutRepository = await buildApp({ teamWorkspace: true });

    const withBody = (await readBalance(withRepository)).json();
    const withoutBody = (await readBalance(withoutRepository)).json();

    expect(withBody.balance).toBe(1234);
    expect(withBody.plan).toBe("free");
    expect(withBody.dailyClaimed).toBe(false);
    expect(withBody.limits).toEqual(FREE_LIMITS);
    expect({
      balance: withBody.balance,
      plan: withBody.plan,
      dailyClaimed: withBody.dailyClaimed,
      limits: withBody.limits,
    }).toEqual({
      balance: withoutBody.balance,
      plan: withoutBody.plan,
      dailyClaimed: withoutBody.dailyClaimed,
      limits: withoutBody.limits,
    });
  });

  it("BL-45: no team workspace reads as no pools", async () => {
    const readPoolBalances = vi.fn(async () => POOLS);
    const app = await buildApp({
      teamWorkspace: false,
      repository: { readPoolBalances },
    });

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pools).toBeNull();
    expect(readPoolBalances).toHaveBeenCalledTimes(0);
  });

  it("BL-45: a failed pool read fails closed", async () => {
    const readPoolBalances = vi.fn(async () => {
      throw new Error("pool read exploded");
    });
    const app = await buildApp({
      teamWorkspace: true,
      repository: { readPoolBalances },
    });

    const response = await readBalance(app);

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe("credit_query_failed");
    expect("pools" in body).toBe(false);
    expect(body.balance).toBeUndefined();
  });

  it("BL-45: without the repository the response is as before", async () => {
    const app = await buildApp({ teamWorkspace: true });

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect("pools" in body).toBe(false);
    expect(body).toEqual({
      balance: 1234,
      plan: "free",
      dailyClaimed: false,
      limits: FREE_LIMITS,
    });
  });

  // ── workorder 37R: the daily grant placed before the read ──

  it("BL-45: reading the balance grants today's daily credits first", async () => {
    // One shared log of what happened in which order: the grant must be placed
    // BEFORE the pools are read, or the caller reads yesterday's balance.
    const order: string[] = [];
    const grantDailyCredits = vi.fn(async () => {
      order.push("grant");
      return true;
    });
    const readPoolBalances = vi.fn(async () => {
      order.push("read");
      return POOLS;
    });

    const app = await buildApp({
      teamWorkspace: true,
      repository: { readPoolBalances },
      grantRepository: { grantDailyCredits },
    });

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    // The TEAM workspace's pool, granted to the authenticated member.
    expect(grantDailyCredits).toHaveBeenCalledTimes(1);
    expect(grantDailyCredits).toHaveBeenCalledWith({
      userId: USER.id,
      workspaceId: TEAM_WORKSPACE_ID,
    });
    expect(order).toEqual(["grant", "read"]);
  });

  it("BL-45: a failed daily grant does not fail the balance", async () => {
    const grantDailyCredits = vi.fn(async () => {
      throw new Error("daily grant exploded");
    });
    const readPoolBalances = vi.fn(async () => POOLS);
    const app = await buildApp({
      teamWorkspace: true,
      repository: { readPoolBalances },
      grantRepository: { grantDailyCredits },
    });

    const response = await readBalance(app);

    // Logged and skipped, not rethrown: the balance is still answered, and the
    // pools are still the ones the read repository returned.
    expect(response.statusCode).toBe(200);
    expect(grantDailyCredits).toHaveBeenCalledTimes(1);
    const body = response.json();
    expect(body.pools.balances).toEqual(POOLS);
    expect(body.pools.available).toBe(15250);
  });
});

// ── BL-06 / workorder 38U: the member's three-pool ledger lines ──
//
// The three-pool charges and refunds are bookkept per TEAM workspace, while
// `GET /api/credits/transactions` listed the caller's PERSONAL workspace. What is
// pinned below is the ROUTE's half, with a stand-in repository and no database:
// with the repository injected and a team workspace the list is read for the TEAM
// workspace and for THIS member, the pool columns reach the payload and
// `entry_type` is still the shared rule's, a caller without a team workspace keeps
// the old ledger, and without the repository the payload is exactly what it was
// before 38U.

/** The one pool line the stand-in repository answers. */
const POOL_LEDGER_ROW = {
  id: "00000000-0000-0000-0000-0000000000f1",
  transaction_type: "generation_deduct" as const,
  amount: -12,
  balance_after: 88,
  job_id: null,
  description: "image generation",
  created_at: "2026-10-21T00:00:01.001Z",
  pool: "team" as const,
  pool_breakdown: { daily: 0, team: 12, topup: 0 },
};

/** The route's own option type, so no import has to be added for the stand-in. */
type PoolLedgerRepository = NonNullable<
  Parameters<typeof registerCreditRoutes>[1]["poolTransactionReadRepository"]
>;

/**
 * A credit service whose `getTransactions` is a spy, so "the old ledger was used"
 * is a call count rather than an inference from an empty list.
 */
async function buildLedgerApp(options: {
  teamWorkspace: boolean;
  ledger?: PoolLedgerRepository;
}) {
  const getTransactions = vi.fn(async () => []);
  const creditService = {
    getBalance: vi.fn(async () => BALANCE),
    getTransactions,
  } as unknown as CreditService;

  const app = Fastify();
  await registerCreditRoutes(app, {
    auth,
    creditService,
    viewerService: buildViewerService(options.teamWorkspace),
    ...(options.ledger
      ? { poolTransactionReadRepository: options.ledger }
      : {}),
  });
  await app.ready();
  apps.push(app);
  return { app, getTransactions };
}

function readTransactions(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: "/api/credits/transactions",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("GET /api/credits/transactions — BL-06 pools", () => {
  it("BL-06: with pools on, a member's ledger comes from the team workspace with pools", async () => {
    const listMemberPoolTransactions = vi.fn(async () => [POOL_LEDGER_ROW]);
    const { app, getTransactions } = await buildLedgerApp({
      teamWorkspace: true,
      ledger: { listMemberPoolTransactions },
    });

    const response = await readTransactions(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.transactions).toHaveLength(1);
    // The two pool columns the requirement (BL-06) names ride along untouched.
    expect(body.transactions[0].pool).toBe("team");
    expect(body.transactions[0].pool_breakdown.team).toBe(12);
    expect(body.transactions[0].pool_breakdown).toEqual({
      daily: 0,
      team: 12,
      topup: 0,
    });
    // `entry_type` is still the one shared translation of the ledger type.
    expect(body.transactions[0].entry_type).toBe("consume");
    expect(body.transactions[0].amount).toBe(-12);

    // The TEAM workspace, THIS member, and the route's own default limit of 20.
    expect(listMemberPoolTransactions).toHaveBeenCalledTimes(1);
    expect(listMemberPoolTransactions).toHaveBeenCalledWith({
      workspaceId: TEAM_WORKSPACE_ID,
      userId: USER.id,
      limit: 20,
    });
    // The personal ledger is not read at all on this path.
    expect(getTransactions).toHaveBeenCalledTimes(0);
  });

  it("BL-06: without a team workspace the old ledger is used", async () => {
    const listMemberPoolTransactions = vi.fn(async () => [POOL_LEDGER_ROW]);
    const { app, getTransactions } = await buildLedgerApp({
      teamWorkspace: false,
      ledger: { listMemberPoolTransactions },
    });

    const response = await readTransactions(app);

    expect(response.statusCode).toBe(200);
    // A caller with no team workspace has no pool lines to see: the pool read is
    // not consulted, and the personal ledger answers as it did before 38U.
    expect(listMemberPoolTransactions).toHaveBeenCalledTimes(0);
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(getTransactions).toHaveBeenCalledWith(PERSONAL_WORKSPACE_ID, 20);
  });

  it("BL-06: without the repository the response is unchanged", async () => {
    const { app, getTransactions } = await buildLedgerApp({
      teamWorkspace: true,
    });

    const response = await readTransactions(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ transactions: [] });
    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(getTransactions).toHaveBeenCalledWith(PERSONAL_WORKSPACE_ID, 20);
  });
});
