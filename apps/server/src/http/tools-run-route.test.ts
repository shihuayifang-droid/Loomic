import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TOOL_SEARCH_KEY,
  type BackgroundJob,
  type ToolDefinition,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
// `vi.mock` below is hoisted above every import, so this binding is already the
// replacement when the module graph loads.
import { watchJob } from "../features/jobs/job-watcher.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import { TOOL_DEFINITIONS } from "../features/tools/tool-definitions.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerToolRoutes } from "./tools.js";

/**
 * ED-00m / GN-05 - `POST /api/tools/:toolId/run`.
 *
 * What these cases pin is the ROUTE's half: the submission becomes one charged
 * job under its `client_request_id`, the price is asked of the table with the
 * triple the quote route uses, an empty wallet refuses before any job exists,
 * and the job carries the tool's execution model. The deduplication itself is
 * `withBilling`'s lookup; the `jobService` double below stores what `createJob`
 * made, keyed by the `clientRequestId` it was created under, and answers the
 * lookup by that same id, so "three clicks" is a real sequence and
 * `createJob` / `deductCredits` call counts are the observable.
 *
 * `watchJob` is replaced: in production it is a detached poll loop.
 */

vi.mock("../features/jobs/job-watcher.js");

const TOKEN = "tools-run-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "tools-run@hahart.test",
  id: "00000000-0000-0000-0000-0000000000d1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000d2";
const CLIENT_REQUEST_ID = "click-12345678";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

const viewerService = {
  async ensureViewer() {
    return {
      workspace: {
        id: WORKSPACE_ID,
        name: "Personal",
        type: "personal" as const,
        ownerUserId: USER.id,
      },
    };
  },
} as unknown as ViewerService;

const quickEdit = TOOL_DEFINITIONS.find((tool) => tool.id === "quick_edit");
if (!quickEdit) throw new Error("quick_edit is missing from the tool table");

/** The real `quick_edit` row, with a configured execution model (GN-05). */
const TOOL_WITH_MODEL: ToolDefinition = { ...quickEdit, execution_model: "m-x" };
/** A real row that is still `availability: "unavailable"` (upscale). */
const UNAVAILABLE_TOOL = TOOL_DEFINITIONS.find(
  (tool) => tool.id === "upscale",
) as ToolDefinition;

const PRICE = 5;

/** Jobs the double below made, keyed by the `clientRequestId` they were made under. */
const jobs = new Map<string, BackgroundJob>();
let jobSequence = 0;

function makeJob(input: Record<string, unknown>): BackgroundJob {
  jobSequence += 1;
  return {
    id: `job-tool-${jobSequence}`,
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "tool_execution",
    job_type: input.jobType,
    status: "queued",
    payload: input.payload,
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: USER.id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  } as unknown as BackgroundJob;
}

const createJob = vi.fn(async (_user: unknown, input: Record<string, unknown>) => {
  const job = makeJob(input);
  jobs.set(String(input.clientRequestId), job);
  return job;
});
const findRecentJobByClientRequestId = vi.fn(
  async (_user: unknown, clientRequestId: string) =>
    jobs.get(clientRequestId) ?? null,
);
const setCreditsInfo = vi.fn(async (..._args: unknown[]) => {});
const cancelJob = vi.fn(async (..._args: unknown[]) => null);

const jobService = {
  createJob,
  setCreditsInfo,
  cancelJob,
  findRecentJobByClientRequestId,
  getJob: vi.fn(),
  getJobAdmin: vi.fn(),
  listJobs: vi.fn(),
} as unknown as JobService;

let balance = 100;
const deductCredits = vi.fn(async (..._args: unknown[]) => "tx-1");

const creditService = {
  getSubscription: async () => ({ plan: "free" }),
  getBalance: async () => ({ balance, plan: "free", dailyClaimed: false }),
  deductCredits,
  refundCredits: vi.fn(),
} as unknown as CreditService;

const tierGuard: TierGuard = {
  checkModelAccess() {},
  checkResolution() {},
  checkVideoResolution() {},
  async checkConcurrency() {},
};

const quote = vi.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  ruleId: "rule-1",
  detail: { price_status: "active" as const, total_price: PRICE },
}));
const priceQuoter = { quote } as unknown as PriceQuoter;

let app: FastifyInstance;

async function build(tools: readonly ToolDefinition[]) {
  const instance = Fastify();
  await registerToolRoutes(instance, {
    auth,
    creditService,
    tierGuard,
    priceQuoter,
    jobService,
    viewerService,
    tools,
  });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  vi.clearAllMocks();
  jobs.clear();
  jobSequence = 0;
  balance = 100;
  findRecentJobByClientRequestId.mockImplementation(
    async (_user: unknown, clientRequestId: string) =>
      jobs.get(clientRequestId) ?? null,
  );
  app = await build([TOOL_WITH_MODEL, UNAVAILABLE_TOOL]);
});

afterEach(async () => {
  await app.close();
});

function run(
  toolId: string,
  body: Record<string, unknown>,
  token: string | null = TOKEN,
) {
  return app.inject({
    method: "POST",
    url: `/api/tools/${toolId}/run`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: body,
  });
}

const BODY = { artifact_id: "art-1", client_request_id: CLIENT_REQUEST_ID };

describe("POST /api/tools/:toolId/run", () => {
  it("ED-00m: three clicks with one client_request_id make one job and one charge", async () => {
    const first = await run("quick_edit", BODY);
    const second = await run("quick_edit", BODY);
    const third = await run("quick_edit", BODY);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(202);
    expect(first.json().jobId).toBe("job-tool-1");
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(third.json().jobId).toBe(first.json().jobId);

    expect(createJob).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(
      WORKSPACE_ID,
      USER.id,
      PRICE,
      "job-tool-1",
      "快捷编辑",
    );
  });

  it("ED-00m: two different client_request_ids make two jobs and two charges", async () => {
    const first = await run("quick_edit", BODY);
    const second = await run("quick_edit", {
      ...BODY,
      client_request_id: "click-87654321",
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).not.toBe(first.json().jobId);

    expect(createJob).toHaveBeenCalledTimes(2);
    expect(deductCredits).toHaveBeenCalledTimes(2);
  });

  it("ED-00m: not enough credits refuses before any job exists", async () => {
    balance = PRICE - 1;

    const response = await run("quick_edit", BODY);

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("insufficient_credits");
    expect(createJob).toHaveBeenCalledTimes(0);
    expect(deductCredits).toHaveBeenCalledTimes(0);
  });

  it("the charge asks the price table exactly what the quote asks", async () => {
    const response = await run("quick_edit", BODY);

    expect(response.statusCode).toBe(202);
    expect(DEFAULT_TOOL_SEARCH_KEY).toBe("*");
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "tool:quick_edit",
        entryPoint: "tool",
        searchKey: "*",
      }),
    );

    // A different `client_request_id`, so the double finds no duplicate and the
    // second submission quotes again.
    jobs.clear();
    await run("quick_edit", {
      ...BODY,
      client_request_id: "click-other-001",
      search_key: "2k",
    });
    expect(quote).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchKey: "2k" }),
    );
  });

  it("GN-05: the job carries the tool's execution model", async () => {
    const response = await run("quick_edit", {
      ...BODY,
      project_id: "proj-1",
      params: { prompt: "make it blue" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      jobId: "job-tool-1",
      status: "queued",
      model: "m-x",
    });

    expect(createJob).toHaveBeenCalledTimes(1);
    const created = createJob.mock.calls[0]?.[1] as {
      jobType?: string;
      payload?: Record<string, unknown>;
      projectId?: string;
      clientRequestId?: string;
    };
    expect(created.jobType).toBe("tool_execution");
    expect(created.projectId).toBe("proj-1");
    expect(created.clientRequestId).toBe(CLIENT_REQUEST_ID);
    expect(created.payload).toEqual({
      tool_id: "quick_edit",
      artifact_id: "art-1",
      model: "m-x",
      params: { prompt: "make it blue" },
      file_prefix: "quick_edit",
    });

    const watched = vi.mocked(watchJob).mock.calls;
    expect(watched).toHaveLength(1);
    expect(watched[0]?.[1]).toMatchObject({
      jobId: "job-tool-1",
      jobType: "tool_execution",
    });
  });

  it("an unknown tool is 404, an unavailable tool is 409, a bad body is 400, no token is 401", async () => {
    const unknown = await run("no_such_tool", BODY);
    expect(unknown.statusCode).toBe(404);

    const unavailable = await run("upscale", BODY);
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().error.code).toBe("tool_disabled");

    const shortId = await run("quick_edit", {
      artifact_id: "art-1",
      client_request_id: "short",
    });
    expect(shortId.statusCode).toBe(400);
    expect(shortId.json().error.code).toBe("invalid_request");

    const noArtifact = await run("quick_edit", {
      client_request_id: CLIENT_REQUEST_ID,
    });
    expect(noArtifact.statusCode).toBe(400);

    const anonymous = await run("quick_edit", BODY, null);
    expect(anonymous.statusCode).toBe(401);

    // None of the refusals reached the price table or created anything.
    expect(quote).toHaveBeenCalledTimes(0);
    expect(createJob).toHaveBeenCalledTimes(0);
  });
});
