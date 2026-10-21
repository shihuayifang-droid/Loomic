import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import type { PoolBalanceReadRepository } from "../db/pool-balance-read-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { JobService } from "../features/jobs/job-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

/**
 * GN-03 / workorder 38D - `GET /api/jobs/:jobId` also carries the caller's three
 * pools and the ONE available-credit figure.
 *
 * What is pinned here is the ROUTE's half, with a stand-in repository and no
 * database: the pools are read for the TEAM workspace of the authenticated user
 * and for that user, `available` is the shared rule (15250 for this literal),
 * `monthlyCapRemaining` is the personal cap minus what the member already used,
 * `job` itself is untouched, a caller without a team workspace reads as `null`,
 * a failed read is logged and answered as `null` instead of failing the status,
 * and without a repository the body has no `balance` key at all.
 */

const TOKEN = "job-status-balance-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "job-status-balance@hahart.test",
  id: "00000000-0000-0000-0000-0000000000f1",
  userMetadata: {},
};
const PERSONAL_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000f2";
const TEAM_WORKSPACE_ID = "00000000-0000-0000-0000-0000000000f3";
// A real uuid: the response body is parsed against `jobResponseSchema`, whose ids
// are `z.string().uuid()`, so a short placeholder would fail the 200 path on the
// response rather than on the rule under test.
const JOB_ID = "00000000-0000-0000-0000-0000000000f4";

const POOLS = {
  daily: 50,
  teamRemaining: 30000,
  personalTeamUsed: 5000,
  personalCap: 20000,
  topup: 200,
};

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

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

function buildViewerService(
  teamWorkspace: boolean,
): ViewerService & { ensureViewer: ReturnType<typeof vi.fn> } {
  const ensureViewer = vi.fn(async () => ({
    profile: {
      id: USER.id,
      email: USER.email,
      displayName: "Job Status Balance",
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
  }));

  return { ensureViewer } as unknown as ViewerService & {
    ensureViewer: ReturnType<typeof vi.fn>;
  };
}

function buildJobService(): JobService {
  return {
    cancelJob: vi.fn(),
    createJob: vi.fn(),
    findRecentJobByClientRequestId: vi.fn(),
    getJob: vi.fn(async () => makeJob()),
    getJobAdmin: vi.fn(),
    listJobs: vi.fn(),
    setCreditsInfo: vi.fn(),
  } as unknown as JobService;
}

let apps: FastifyInstance[] = [];

async function buildApp(options: {
  viewerService: ViewerService;
  repository?: Pick<PoolBalanceReadRepository, "readPoolBalances">;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await registerJobRoutes(app, {
    auth,
    jobService: buildJobService(),
    viewerService: options.viewerService,
    ...(options.repository
      ? { poolBalanceReadRepository: options.repository }
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

function readStatus(app: FastifyInstance) {
  return app.inject({
    method: "GET",
    url: `/api/jobs/${JOB_ID}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("GET /api/jobs/:jobId - GN-03 balance", () => {
  it("GN-03: the job status carries the member's available credits", async () => {
    const readPoolBalances = vi.fn(async () => POOLS);
    const viewerService = buildViewerService(true);
    const app = await buildApp({
      viewerService,
      repository: { readPoolBalances },
    });

    const response = await readStatus(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // 50 daily + min(30000 team remaining, 20000 - 5000 cap left) 15000 + 200 topup.
    expect(body.balance.available).toBe(15250);
    expect(body.balance.monthlyCapRemaining).toBe(15000);
    expect(body.balance.balances).toEqual({
      daily: 50,
      teamRemaining: 30000,
      personalTeamUsed: 5000,
      personalCap: 20000,
      topup: 200,
    });
    // The pools are the TEAM workspace's, and the member is the authenticated user.
    expect(readPoolBalances).toHaveBeenCalledTimes(1);
    expect(readPoolBalances).toHaveBeenCalledWith({
      workspaceId: TEAM_WORKSPACE_ID,
      userId: USER.id,
    });
  });

  it("GN-03: the job itself is unchanged", async () => {
    const withRepository = await buildApp({
      viewerService: buildViewerService(true),
      repository: { readPoolBalances: vi.fn(async () => POOLS) },
    });
    const withoutRepository = await buildApp({
      viewerService: buildViewerService(true),
    });

    const carried = await readStatus(withRepository);
    const plain = await readStatus(withoutRepository);

    expect(carried.statusCode).toBe(200);
    expect(plain.statusCode).toBe(200);
    expect(carried.json().job).toEqual(makeJob());
    expect(carried.json().job).toEqual(plain.json().job);
  });

  it("GN-03: no team workspace means balance null", async () => {
    const readPoolBalances = vi.fn(async () => POOLS);
    const app = await buildApp({
      viewerService: buildViewerService(false),
      repository: { readPoolBalances },
    });

    const response = await readStatus(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.balance).toBeNull();
    expect(body.job).toEqual(makeJob());
    // Nothing to read for a caller with no team workspace, so nothing is read.
    expect(readPoolBalances).toHaveBeenCalledTimes(0);
  });

  it("GN-03: a failed balance read does not fail the status", async () => {
    const readPoolBalances = vi.fn(async () => {
      throw new Error("pool balance read failed (readPoolBalances)");
    });
    const app = await buildApp({
      viewerService: buildViewerService(true),
      repository: { readPoolBalances },
    });

    const response = await readStatus(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.balance).toBeNull();
    expect(body.job).toEqual(makeJob());
    expect(readPoolBalances).toHaveBeenCalledTimes(1);
  });

  it("GN-03: without the repository the response is as before", async () => {
    const viewerService = buildViewerService(true);
    const app = await buildApp({ viewerService });

    const response = await readStatus(app);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect("balance" in body).toBe(false);
    expect(body.job).toEqual(makeJob());
    // Not injected means no pool read and no extra viewer lookup either.
    expect(viewerService.ensureViewer).toHaveBeenCalledTimes(0);
  });
});
