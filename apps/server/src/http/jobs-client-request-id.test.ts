import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundJob, PriceDetail } from "@loomic/shared";

import { createChargedJobWriteRepository } from "../db/charged-job-write-repository.js";
import type { TransactionPool } from "../db/transaction.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import { creditPoolsEnabled } from "../features/credits/credit-pools-billing.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import { createJobService } from "../features/jobs/job-service.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { PgmqClient } from "../queue/pgmq-client.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerJobRoutes } from "./jobs.js";

/**
 * ED-00m — `client_request_id` on the two job-creation routes.
 *
 * What these cases pin is the ROUTE's half of the contract: the field is accepted
 * by the request schema, it reaches `withBilling` as `job.clientRequestId` (not
 * inside the generation payload, and not as a column on the insert), and a
 * repeat submission is answered with the SAME job and a 201.
 *
 * The deduplication itself lives in `withBilling` (workorder 34U) and is the job
 * service's lookup, so this file's `jobService` double is what makes a "hit" —
 * there is deliberately no database here. `createJob` is counted instead: "one
 * submission is one job" is exactly the `createJob` call count.
 *
 * Billing is OFF in this harness (no `creditService` / `tierGuard`, so no
 * `priceQuoter` either): that is the branch where the route's own wiring is what
 * is under test, and it keeps the doubles down to the two services named below.
 */

const TOKEN = "client-request-id-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "client-request-id@hahart.test",
  id: "00000000-0000-0000-0000-0000000000a1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000a2";

const CLIENT_REQUEST_ID = "req-12345678";

function makeJob(overrides: Partial<BackgroundJob>): BackgroundJob {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    workspace_id: WORKSPACE_ID,
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation",
    job_type: "image_generation",
    status: "queued",
    payload: { prompt: "a red panda in a raincoat" },
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
    ...overrides,
  };
}

const IMAGE_JOB = makeJob({
  id: "00000000-0000-0000-0000-0000000000b1",
  job_type: "image_generation",
  queue_name: "image_generation",
});

const VIDEO_JOB = makeJob({
  id: "00000000-0000-0000-0000-0000000000b2",
  job_type: "video_generation",
  queue_name: "video_generation",
});

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

const createJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);
const findRecentJobByClientRequestId = vi.fn(
  async (..._args: unknown[]): Promise<BackgroundJob | null> => null,
);
const setCreditsInfo = vi.fn(async (..._args: unknown[]) => {});
const cancelJob = vi.fn(async (..._args: unknown[]) => IMAGE_JOB);

const jobService = {
  createJob,
  setCreditsInfo,
  cancelJob,
  findRecentJobByClientRequestId,
  getJob: vi.fn(),
  getJobAdmin: vi.fn(),
  listJobs: vi.fn(),
} as unknown as JobService;

let app: FastifyInstance;

beforeEach(async () => {
  // The doubles are module scope, so case 2 would count case 1's createJob.
  vi.clearAllMocks();
  createJob.mockResolvedValue(IMAGE_JOB);
  findRecentJobByClientRequestId.mockResolvedValue(null);

  app = Fastify();
  await registerJobRoutes(app, {
    auth,
    jobService,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function submitImage(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/jobs/image-generation",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: body,
  });
}

describe("POST /api/jobs/image-generation with a client_request_id", () => {
  it("ED-00m: the same client_request_id twice yields one job", async () => {
    // First submission: nothing stored under this id yet, so it becomes a job.
    // Second submission of the SAME id: the lookup answers with that job.
    findRecentJobByClientRequestId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(IMAGE_JOB);

    const first = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: CLIENT_REQUEST_ID,
    });
    const second = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: CLIENT_REQUEST_ID,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().job.id).toBe(IMAGE_JOB.id);
    expect(second.json().job.id).toBe(IMAGE_JOB.id);

    // One submission = one job, even though the button was pressed twice.
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ clientRequestId: CLIENT_REQUEST_ID }),
    );
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(2);
    expect(findRecentJobByClientRequestId).toHaveBeenCalledWith(
      USER,
      CLIENT_REQUEST_ID,
    );
  });

  it("ED-00m: without client_request_id every submission is its own job", async () => {
    const first = await submitImage({ prompt: "a red panda in a raincoat" });
    const second = await submitImage({ prompt: "a red panda in a raincoat" });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(createJob).toHaveBeenCalledTimes(2);
    // No id, no lookup: the path is exactly what it was before ED-00m.
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(0);
    expect(createJob.mock.calls[0]?.[1]).not.toHaveProperty("clientRequestId");
  });

  it("ED-00m: a client_request_id shorter than 8 characters is a 400", async () => {
    const response = await submitImage({
      prompt: "a red panda in a raincoat",
      client_request_id: "short",
    });

    expect(response.statusCode).toBe(400);
    expect(createJob).toHaveBeenCalledTimes(0);
    expect(findRecentJobByClientRequestId).toHaveBeenCalledTimes(0);
  });
});

describe("POST /api/jobs/video-generation with a client_request_id", () => {
  it("ED-00m: the video route takes the same field", async () => {
    createJob.mockResolvedValue(VIDEO_JOB);

    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/video-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        prompt: "a red panda in a raincoat",
        client_request_id: CLIENT_REQUEST_ID,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().job.id).toBe(VIDEO_JOB.id);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        clientRequestId: CLIENT_REQUEST_ID,
        jobType: "video_generation",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Workorder 45Y: credit pools ON -> the charged-job path (`createChargedJob`).
//
// With the pools on, `withBilling` creates the job through the one-transaction
// `createChargedJob`, whose repository reads the row back with its own SQL. The
// job service here is the REAL one over the REAL charged-job repository; only the
// database connection is a fake. The fake answers like node-postgres does: a
// bare `timestamptz` column comes back as a native `Date`, while a column the
// statement turned into text (`to_jsonb(col) #>> '{}'`) comes back as a string.
// So these cases fail if the read-back SQL lets a `Date` through to the
// response schema, and they pass without a database.
// ---------------------------------------------------------------------------

describe("POST /api/jobs/image-generation with the credit pools ON (45Y)", () => {
  const CHARGED_JOB_ID = "00000000-0000-0000-0000-0000000000c1";
  const TIME_COLUMNS = [
    "created_at",
    "updated_at",
    "started_at",
    "completed_at",
    "failed_at",
    "canceled_at",
  ] as const;

  type Harness = {
    pooledApp: FastifyInstance;
    charges: Array<readonly unknown[]>;
    deductCredits: ReturnType<typeof vi.fn>;
  };

  function priceDetail(): PriceDetail {
    return {
      base_price: 10,
      unit_name: "次",
      unit_count: 1,
      unit_price: 10,
      total_price: 10,
      search_key: "hd",
      search_key_matched: "hd",
      time_variant_period: "normal",
      disable_unlimited: false,
      entry_point: "canvas_generator",
      extras: [],
      price_status: "active",
    };
  }

  async function buildPooledApp(
    env: Record<string, string | undefined>,
  ): Promise<Harness> {
    const charges: Array<readonly unknown[]> = [];
    // The row as the database holds it: real `Date`s for the time columns.
    const storedAt = new Date("2026-02-03T04:05:06.789Z");
    let stored: Record<string, unknown> | null = null;

    const pool: TransactionPool = {
      async connect() {
        return {
          release() {},
          async query(sql: string, params: readonly unknown[] = []) {
            if (sql.includes("public.create_charged_job")) {
              charges.push(params);
              stored = {
                id: CHARGED_JOB_ID,
                workspace_id: params[0],
                project_id: null,
                canvas_id: null,
                session_id: null,
                thread_id: null,
                queue_name: "image_generation",
                job_type: "image_generation",
                status: "queued",
                payload: { prompt: "a red panda in a raincoat" },
                result: null,
                error_code: null,
                error_message: null,
                attempt_count: 0,
                max_attempts: 3,
                created_by: params[1],
                created_at: storedAt,
                updated_at: storedAt,
                started_at: null,
                completed_at: null,
                failed_at: null,
                canceled_at: null,
              };
              return {
                rows: [{ job_id: CHARGED_JOB_ID, transaction_id: "tx-45y" }],
              };
            }
            if (sql.includes("from public.background_jobs")) {
              if (!stored) return { rows: [] };
              const row: Record<string, unknown> = { ...stored };
              for (const column of TIME_COLUMNS) {
                // Same rule node-postgres applies: text stays text, and a bare
                // timestamptz column is parsed into a `Date`.
                const asText = sql.includes(
                  `to_jsonb(${column}) #>> '{}' as ${column}`,
                );
                const value = stored[column];
                row[column] =
                  asText && value instanceof Date ? value.toISOString() : value;
              }
              return { rows: [row] };
            }
            return { rows: [] };
          },
        };
      },
    };

    const chargedJobWriteRepository = createChargedJobWriteRepository({
      getTransactionPool: () => pool,
    });

    const realJobService = createJobService({
      createUserClient: () => {
        throw new Error("the user client must not be used");
      },
      getAdminClient: () => {
        throw new Error("the admin client must not be used");
      },
      pgmq: {
        send: async () => {
          throw new Error("pgmq must not be used");
        },
      } as unknown as PgmqClient,
      chargedJobWriteRepository,
      // The replay lookup: a stored row for this caller answers the repeat.
      jobOwnerReadRepository: {
        async findOwnJobByClientRequestId() {
          if (!stored) return null;
          const row: Record<string, unknown> = { ...stored };
          for (const column of TIME_COLUMNS) {
            const value = stored[column];
            row[column] = value instanceof Date ? value.toISOString() : value;
          }
          return row;
        },
      } as never,
    });

    const poolsOn = creditPoolsEnabled(env);
    const deductCredits = vi.fn(async () => "tx-should-not-be-used");
    const creditService = {
      getBalance: vi.fn(async () => ({
        balance: 1000,
        plan: "free",
        dailyClaimed: false,
      })),
      deductCredits,
      refundCredits: vi.fn(async () => "tx-refund"),
      getSubscription: vi.fn(async () => ({ plan: "free" })),
      chargeTarget: vi.fn(async (workspaceId: string) => ({
        workspaceId,
        usePools: poolsOn,
      })),
      availableFor: vi.fn(async () => 1000),
    } as unknown as CreditService;

    const tierGuard = {
      checkModelAccess() {},
      checkResolution() {},
      checkVideoResolution() {},
      async checkConcurrency() {},
    } as unknown as TierGuard;

    const priceQuoter = {
      quote: vi.fn(async () => ({
        ok: true as const,
        detail: priceDetail(),
        ruleId: "rule-45y",
      })),
    } as unknown as PriceQuoter;

    const pooledApp = Fastify();
    await registerJobRoutes(pooledApp, {
      auth,
      jobService: realJobService,
      viewerService,
      creditService,
      tierGuard,
      priceQuoter,
    });
    await pooledApp.ready();

    return { pooledApp, charges, deductCredits };
  }

  function submit(harness: Harness, body: Record<string, unknown>) {
    return harness.pooledApp.inject({
      method: "POST",
      url: "/api/jobs/image-generation",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: body,
    });
  }

  it("45Y: pools on -> 201, and the time fields are parseable strings", async () => {
    const harness = await buildPooledApp({ HAHART_CREDIT_POOLS: "on" });
    try {
      const response = await submit(harness, {
        prompt: "a red panda in a raincoat",
      });

      expect(response.statusCode).toBe(201);
      const job = response.json().job;
      expect(job.id).toBe(CHARGED_JOB_ID);
      expect(typeof job.created_at).toBe("string");
      expect(typeof job.updated_at).toBe("string");
      expect(Number.isNaN(new Date(job.created_at).getTime())).toBe(false);
      expect(Number.isNaN(new Date(job.updated_at).getTime())).toBe(false);

      // The pools switch really reached the charge: one atomic call, pooled.
      expect(harness.charges).toHaveLength(1);
      // create_charged_job's 13th argument is `usePools`.
      expect(harness.charges[0]?.[12]).toBe(true);
      expect(harness.deductCredits).toHaveBeenCalledTimes(0);
    } finally {
      await harness.pooledApp.close();
    }
  });

  it("45Y: replaying the same client_request_id returns the same job and charges once", async () => {
    const harness = await buildPooledApp({ HAHART_CREDIT_POOLS: "on" });
    try {
      const first = await submit(harness, {
        prompt: "a red panda in a raincoat",
        client_request_id: CLIENT_REQUEST_ID,
      });
      const second = await submit(harness, {
        prompt: "a red panda in a raincoat",
        client_request_id: CLIENT_REQUEST_ID,
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.json().job.id).toBe(CHARGED_JOB_ID);
      expect(second.json().job.id).toBe(CHARGED_JOB_ID);

      // One submission = one charge, even though the button was pressed twice.
      expect(harness.charges).toHaveLength(1);
      expect(harness.deductCredits).toHaveBeenCalledTimes(0);
    } finally {
      await harness.pooledApp.close();
    }
  });
});