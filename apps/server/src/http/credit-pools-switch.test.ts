import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

/**
 * 工单38I (BL-45 / T-108) —— 三池读写全部随 `LOOMIC_CREDIT_POOLS` 开关。
 *
 * This file pins the WIRING of `buildApp`, not the routes: 37Q / 37R / 38D
 * already prove what the routes do with and without a repository. What was
 * missing is that the app handed them a repository whatever the switch said, so
 * a switched-off server answered a second "available" figure beside the old
 * single balance and wrote a daily grant into the pools whose spends it never
 * charged. Here the real `buildApp` is built with the switch on and off and the
 * two pool repositories are stand-ins that RECORD every call, so "no pools key",
 * "no balance key", "no daily grant" and "the read is on the team workspace" are
 * observed rather than asserted in prose.
 *
 * `vi.mock` is used because `buildApp` takes no pool-repository options; the two
 * factories it imports are the only way in. Nothing below reaches a database:
 * the stand-in read answers a fixed pool, and `DATABASE_URL` is a literal that
 * only has to satisfy the lazy pool construction of the wrapper.
 */

const poolProbe = vi.hoisted(() => ({
  /** Every `readPoolBalances` the app performed. */
  poolReads: [] as Array<{ workspaceId: string; userId: string }>,
  /** Every `grantDailyCredits` the app performed. */
  dailyGrants: [] as Array<{ workspaceId: string; userId: string }>,
}));

vi.mock("../db/pool-balance-read-repository.js", () => ({
  createPoolBalanceReadRepository: () => ({
    async readPoolBalances(input: { userId: string; workspaceId: string }) {
      poolProbe.poolReads.push(input);
      return {
        daily: 50,
        teamRemaining: 30000,
        personalTeamUsed: 5000,
        personalCap: 20000,
        topup: 200,
      };
    },
  }),
}));

vi.mock("../db/pool-grant-write-repository.js", () => ({
  createPoolGrantWriteRepository: () => ({
    async grantDailyCredits(input: { userId: string; workspaceId: string }) {
      poolProbe.dailyGrants.push(input);
      return true;
    },
    async grantTeamCycle() {
      throw new Error(
        "the server must not place the team cycle grant: the worker owns it",
      );
    },
  }),
}));

// Imported after the mocks: `buildApp` pulls in the two factories above.
import { buildApp } from "../app.js";

const SWITCH_KEY = "LOOMIC_CREDIT_POOLS";

/** Only the lazy `pg.Pool` construction sees this; no connection is opened. */
const TEST_DATABASE_URL = "postgres://hahart:hahart@127.0.0.1:5432/hahart_test";

const TOKEN = "credit-pools-switch-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "credit-pools-switch@hahart.test",
  id: "00000000-0000-0000-0000-0000000001a1",
  userMetadata: {},
};
const PERSONAL_WORKSPACE_ID = "00000000-0000-0000-0000-0000000001a2";
const TEAM_WORKSPACE_ID = "00000000-0000-0000-0000-0000000001a3";
const JOB_ID = "00000000-0000-0000-0000-0000000001a4";

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
          displayName: "Credit Pools Switch",
          avatarUrl: null,
        },
        workspace: {
          id: PERSONAL_WORKSPACE_ID,
          name: "Personal",
          type: "personal" as const,
        },
        membership: { role: "owner" as const },
        teamWorkspace: teamWorkspace
          ? { id: TEAM_WORKSPACE_ID, name: "Team", type: "team" as const }
          : null,
        teamMembership: teamWorkspace ? { role: "owner" as const } : null,
      };
    },
  } as unknown as ViewerService;
}

function buildCreditService(): CreditService {
  return {
    async getBalance() {
      return { balance: 1234, dailyClaimed: false, plan: "free" as const };
    },
  } as unknown as CreditService;
}

function makeJob(): BackgroundJob {
  return {
    id: JOB_ID,
    workspace_id: PERSONAL_WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation",
    job_type: "image_generation",
    status: "running",
    payload: { prompt: "a red panda in a raincoat" },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: USER.id,
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:02.000Z",
    started_at: "2026-10-21T00:00:01.000Z",
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

function buildJobService(): JobService {
  return {
    getJob: vi.fn(async () => makeJob()),
  } as unknown as JobService;
}

/**
 * `buildApp` registers the AD-08 member gate before every `/api/` route, and the
 * gate answers 503 when the membership lookup throws (fail-closed). The real
 * service reads `identity_read`, which no test here may touch, so the gate is
 * handed a member of the team workspace instead: every request below reaches the
 * route it is about.
 */
function buildTeamMembershipService(): TeamMembershipService {
  return {
    async get() {
      return {
        role: "owner" as const,
        workspace: {
          id: TEAM_WORKSPACE_ID,
          name: "Team",
          ownerUserId: USER.id,
          type: "team" as const,
        },
      };
    },
    invalidate() {},
  };
}

let apps: FastifyInstance[] = [];
let previousSwitch: string | undefined;

/** The real composition root, with every database path replaced by a double. */
async function buildTheApp(): Promise<FastifyInstance> {
  const app = buildApp({
    auth,
    creditService: buildCreditService(),
    viewerService: buildViewerService(true),
    jobService: buildJobService(),
    teamMembershipService: buildTeamMembershipService(),
    env: { databaseUrl: TEST_DATABASE_URL },
  });
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(() => {
  previousSwitch = process.env[SWITCH_KEY];
  delete process.env[SWITCH_KEY];
});

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
  poolProbe.poolReads.length = 0;
  poolProbe.dailyGrants.length = 0;
  if (previousSwitch === undefined) {
    delete process.env[SWITCH_KEY];
  } else {
    process.env[SWITCH_KEY] = previousSwitch;
  }
});

function readBalance(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: "/api/credits",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function readJobStatus(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: `/api/jobs/${JOB_ID}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("workorder 38I — the app wiring follows LOOMIC_CREDIT_POOLS", () => {
  it("T-108: with the switch off the balance has no pools and no daily grant is written", async () => {
    // `beforeEach` left the switch unset, which is the deployment default.
    const app = await buildTheApp();

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty("pools");
    // ... and nothing was written to the pools either: no daily grant, no read.
    expect(poolProbe.dailyGrants).toEqual([]);
    expect(poolProbe.poolReads).toEqual([]);
  });

  it("T-108: with the switch off the job status has no balance", async () => {
    const app = await buildTheApp();

    const response = await readJobStatus(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty("balance");
    expect(body.job.id).toBe(JOB_ID);
    expect(poolProbe.poolReads).toEqual([]);
  });

  it("T-108: with the switch on the balance carries pools", async () => {
    process.env[SWITCH_KEY] = "on";
    const app = await buildTheApp();

    const response = await readBalance(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("pools");
    expect(typeof body.pools).toBe("object");
    // The pools are the TEAM workspace's, and the member is the caller.
    expect(poolProbe.poolReads).toEqual([
      { workspaceId: TEAM_WORKSPACE_ID, userId: USER.id },
    ]);
    expect(poolProbe.dailyGrants).toEqual([
      { workspaceId: TEAM_WORKSPACE_ID, userId: USER.id },
    ]);
  });
});
