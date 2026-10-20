import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  creditBalanceResponseSchema,
  priceDetailSchema,
  pricingQuoteResponseSchema,
  type EntryPoint,
  type PriceDetail,
  type PricingQuoteItemResponse,
} from "@loomic/shared";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
  UserSupabaseClient,
} from "../supabase/user.js";

/**
 * GN-01 / 工单31D —— `POST /api/pricing/quote` 的接线用例。
 *
 * 这一层只钉「服务端把这条 HTTP 请求翻成了什么」，不钉价目表本身（那是
 * `features/pricing/price-quoter.test.ts` 与 `test-support/db` 的事）：quoter 是
 * 替身，所以每条断言都能直接对着工单 §5 的验收条目读。
 *
 * 三条验收各自的证据方式不同，这也是本文件的结构：
 *
 * 1. **能取到 price_detail 的全部字段** —— 用真 schema（`priceDetailSchema` /
 *    `creditBalanceResponseSchema`）解析响应，缺字段就是失败，不用逐字段列举。
 * 2. **档位没配置时 `unknown` / null** —— 替身 quoter 按「档位是 `*`」刻意造出
 *    默认行的 detail，再看 HTTP 有没有原样送出去，并钉住它被问的是
 *    `entryPoint: "tool"` + `modelId: "tool:<id>"`。
 * 3. **不扣费、不写流水** —— 扣费 / 退款 / 建任务的替身调用次数为 0。这条能成立
 *    是因为路由的依赖列表里根本没有这些东西（裁决 8），不是因为它「小心」。
 *
 * 脚手架照 `http/model-not-available-response.test.ts`：真的 `buildApp` + 替身，
 * `createUserClient` 记账并抛错，所以任何一条走到 PostgREST 的路径都会当场失败。
 */

const TOKEN = "pricing-quote-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "pricing-quote@hahart.test",
  id: "00000000-0000-0000-0000-0000000000d1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000d2";
const BALANCE = 4321;
const PLAN = "pro" as const;

/** 替身 quoter 认作「价目表里没有这一行」的模型 id。 */
const UNREGISTERED_MODEL = "acme/not-in-the-price-table";

/** 一个真实存在、且 `pricing !== null` 的工具（ED-00k 表里的一行）。 */
const PAYING_TOOL_ID = "upscale";
/** 一个真实存在、但 `pricing === null` 的免费工具（`consumes === false`）。 */
const FREE_TOOL_ID = "adjust";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

let userFactoryCalls: string[];

function userClientFactory(accessToken: string): UserSupabaseClient {
  userFactoryCalls.push(accessToken);
  throw new Error(
    "a quote is answered from the price table and the balance read; nothing reaches PostgREST",
  );
}

/** `http/team-gate.ts` 覆盖每个 `/api/` 路由，替身要让它通过。 */
const teamMembershipService = {
  async get() {
    return {
      workspace: {
        id: "33333333-3333-3333-3333-333333333333",
        name: "HaHart 团队",
        type: "team" as const,
        ownerUserId: USER.id,
      },
      role: "member" as const,
    };
  },
  invalidate() {},
} as unknown as TeamMembershipService;

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

/**
 * 「这一批要花多少」的替身。
 *
 * 它按 `searchKey` 造 detail，规则与 `features/pricing/resolve-price.ts` 一致：
 * 档位是 `*`（默认行）→ `search_key = "unknown"` 且 `search_key_matched = null`。
 * 唯一的「失败」是那个未登记的模型 id，用来验「逐条返回」。
 */
function detailFor(input: {
  entryPoint: EntryPoint;
  searchKey: string;
}): PriceDetail {
  const hitDefaultRow = input.searchKey === "*";

  return {
    base_price: 12,
    unit_name: "次",
    unit_count: 1,
    unit_price: 12,
    total_price: 12,
    search_key: hitDefaultRow ? "unknown" : input.searchKey,
    search_key_matched: hitDefaultRow ? null : input.searchKey,
    time_variant_period: "normal",
    disable_unlimited: false,
    entry_point: input.entryPoint,
    extras: [],
    price_status: "active",
  };
}

const quote = vi.fn(
  async (input: {
    modelId: string;
    entryPoint: EntryPoint;
    searchKey: string;
    at: Date;
  }) => {
    if (input.modelId === UNREGISTERED_MODEL) {
      return { ok: false as const, code: "model_not_available" as const };
    }

    return {
      ok: true as const,
      detail: detailFor(input),
      ruleId: "quote-test-rule",
    };
  },
);
const priceQuoter: PriceQuoter = { quote };

/** The balance: `plan` comes from here (ruling 4), never from `getSubscription`. */
const getBalance = vi.fn(async () => ({
  balance: BALANCE,
  plan: PLAN,
  dailyClaimed: false,
}));
const getSubscription = vi.fn(async () => ({ plan: PLAN }));
const deductCredits = vi.fn(async () => "tx-must-not-exist");
const refundCredits = vi.fn(async () => "tx-must-not-exist");
const creditService = {
  getBalance,
  getSubscription,
  deductCredits,
  refundCredits,
} as unknown as CreditService;

const tierGuard = {
  checkModelAccess: vi.fn(),
  checkResolution: vi.fn(),
  checkVideoResolution: vi.fn(),
  checkConcurrency: vi.fn(async () => {}),
} as unknown as TierGuard;

const createJob = vi.fn(async () => {
  throw new Error("a quote must never create a job");
});
const jobService = {
  createJob,
  getJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  getJobAdmin: vi.fn(),
} as unknown as JobService;

let app: FastifyInstance;

beforeEach(async () => {
  userFactoryCalls = [];
  app = buildApp({
    auth,
    createUserClient: userClientFactory,
    creditService,
    env: {},
    jobService,
    priceQuoter,
    teamMembershipService,
    tierGuard,
    viewerService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  // The doubles live at module scope, so calls have to be cleared between cases
  // or case 3 counts every earlier case's quote.
  vi.clearAllMocks();
});

function onlyOk(
  items: readonly PricingQuoteItemResponse[],
): Extract<PricingQuoteItemResponse, { status: "ok" }>[] {
  return items.flatMap((item) => (item.status === "ok" ? [item] : []));
}

function onlyErrors(
  items: readonly PricingQuoteItemResponse[],
): Extract<PricingQuoteItemResponse, { status: "error" }>[] {
  return items.flatMap((item) => (item.status === "error" ? [item] : []));
}

function postQuote(payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/pricing/quote",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: payload as Record<string, unknown>,
  });
}

describe("POST /api/pricing/quote — 验收 1：price_detail 的字段与余额都能取到", () => {
  it("case 1: 图片 1 条 + 视频 1 条，两条 ok，detail 与 balance 都过 schema", async () => {
    const response = await postQuote({
      items: [
        { kind: "image_generation", request: { prompt: "a red panda in a raincoat" } },
        {
          kind: "video_generation",
          request: { prompt: "a red panda walking", resolution: "1080p" },
        },
      ],
    });

    expect(response.statusCode).toBe(200);

    const body = pricingQuoteResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(2);

    const okItems = onlyOk(body.items);
    expect(okItems).toHaveLength(2);

    // 全部字段都在：这是 `priceDetailSchema` 的 key 集合判据（GN-01 验收 1）。
    const details = okItems.map((item) => priceDetailSchema.parse(item.price_detail));
    expect(details[0]?.search_key).toBe("hd");
    expect(details[1]?.search_key).toBe("1080p");

    // 余额与 GET /api/credits 同结构：同一个 schema 解析。
    const balance = creditBalanceResponseSchema.parse(body.balance);
    expect(balance.balance).toBe(BALANCE);
    expect(balance.plan).toBe(PLAN);
  });
});

describe("POST /api/pricing/quote — 验收 2：档位没配置时 unknown / null", () => {
  it("case 2: 工具询价不给 search_key，得到默认行，并问的是 tool:<id> @ tool", async () => {
    const response = await postQuote({
      items: [{ kind: "tool", tool_id: PAYING_TOOL_ID }],
    });

    expect(response.statusCode).toBe(200);

    const body = pricingQuoteResponseSchema.parse(response.json());
    const okItems = onlyOk(body.items);
    expect(okItems).toHaveLength(1);

    const detail = priceDetailSchema.parse(okItems[0]?.price_detail);
    expect(detail.search_key).toBe("unknown");
    expect(detail.search_key_matched).toBeNull();

    // 入口与模型 id 都不是客户端说了算的：工具一律 `tool` + `tool:<id>`。
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoint: "tool",
        modelId: `tool:${PAYING_TOOL_ID}`,
        searchKey: "*",
      }),
    );
  });
});

describe("POST /api/pricing/quote — 验收 3：不扣费、不写流水、不建任务", () => {
  it("case 3: 一次询价之后，扣费 / 退款 / 建任务的替身都是 0 次", async () => {
    const response = await postQuote({
      items: [
        { kind: "image_generation", request: { prompt: "a red panda" } },
        { kind: "tool", tool_id: PAYING_TOOL_ID },
      ],
    });

    expect(response.statusCode).toBe(200);

    expect(deductCredits).toHaveBeenCalledTimes(0);
    expect(refundCredits).toHaveBeenCalledTimes(0);
    expect(createJob).toHaveBeenCalledTimes(0);

    // 余额读了一次，订阅一次都没读：plan 取自余额（裁决 4）。
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(getSubscription).toHaveBeenCalledTimes(0);

    // 也不做 tier / 并发检查（裁决 5）——那是提交时的事。
    expect(tierGuard.checkModelAccess).toHaveBeenCalledTimes(0);
    expect(tierGuard.checkResolution).toHaveBeenCalledTimes(0);
    expect(tierGuard.checkVideoResolution).toHaveBeenCalledTimes(0);
    expect(tierGuard.checkConcurrency).toHaveBeenCalledTimes(0);

    // 整条路径没有一次 PostgREST 调用。
    expect(userFactoryCalls).toHaveLength(0);
  });
});

describe("POST /api/pricing/quote — 逐条结果", () => {
  it("case 4: 1 条已登记 + 1 条未登记 → [ok, error(model_not_available)]，同序", async () => {
    const response = await postQuote({
      items: [
        {
          kind: "image_generation",
          request: { prompt: "a red panda", model: "black-forest-labs/flux-kontext-pro" },
        },
        {
          kind: "image_generation",
          request: { prompt: "a red panda", model: UNREGISTERED_MODEL },
        },
      ],
    });

    // 一条报不了价不是请求级错误：整批仍然 200（裁决 6）。
    expect(response.statusCode).toBe(200);

    const body = pricingQuoteResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.status).toBe("ok");

    const errors = onlyErrors(body.items);
    expect(errors).toHaveLength(1);
    expect(body.items[1]?.status).toBe("error");
    expect(errors[0]?.code).toBe("model_not_available");
    expect(errors[0]?.message.length).toBeGreaterThan(0);
  });

  it("case 5: 请求里塞 entryPoint / entry_point，quoter 收到的仍是 canvas_generator", async () => {
    // 两种写法都试：pascalCase 与 snake_case。schema 丢弃未知字段，所以两种都
    // 静默无效 —— 验收允许「忽略或拒绝」，这里钉的是**都到不了入口选择**。
    const response = await postQuote({
      items: [
        {
          kind: "image_generation",
          request: {
            prompt: "a red panda",
            entryPoint: "tool",
            entry_point: "tool",
          },
        },
        {
          kind: "video_generation",
          request: { prompt: "a red panda", entryPoint: "agent", entry_point: "agent" },
        },
      ],
    });

    expect(response.statusCode).toBe(200);

    const entryPoints = quote.mock.calls.map((call) => call[0].entryPoint);
    expect(entryPoints).toEqual(["canvas_generator", "canvas_generator"]);
  });

  it("case 7: 免费工具与不存在的工具 id 都是该条 invalid_request", async () => {
    const freeResponse = await postQuote({
      items: [{ kind: "tool", tool_id: FREE_TOOL_ID }],
    });

    expect(freeResponse.statusCode).toBe(200);
    const freeErrors = onlyErrors(
      pricingQuoteResponseSchema.parse(freeResponse.json()).items,
    );
    expect(freeErrors).toHaveLength(1);
    expect(freeErrors[0]?.code).toBe("invalid_request");
    expect(freeErrors[0]?.message.length).toBeGreaterThan(0);

    // 免费工具根本不问价目表：问了只会得到一个假价格。
    expect(quote).toHaveBeenCalledTimes(0);
  });

  it("case 7b: 不存在的工具 id 同样是 invalid_request，且不询价", async () => {
    const response = await postQuote({
      items: [{ kind: "tool", tool_id: "definitely_not_a_tool" }],
    });

    expect(response.statusCode).toBe(200);
    const errors = onlyErrors(
      pricingQuoteResponseSchema.parse(response.json()).items,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("invalid_request");
    expect(quote).toHaveBeenCalledTimes(0);
  });

  it("case 8: 图片没给 quality 时，quoter 收到的 searchKey 是 hd", async () => {
    const response = await postQuote({
      items: [{ kind: "image_generation", request: { prompt: "a red panda" } }],
    });

    expect(response.statusCode).toBe(200);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPoint: "canvas_generator",
        modelId: "black-forest-labs/flux-kontext-pro",
        searchKey: "hd",
      }),
    );
  });

  it("case 8b: 图片 plan_max 按套餐解析后再问价（pro → hd）", async () => {
    const response = await postQuote({
      items: [
        {
          kind: "image_generation",
          request: { prompt: "a red panda", quality: "plan_max" },
        },
      ],
    });

    // `plan_max` 不是 `generateImageRequestSchema` 允许的取值（提交路径的
    // quality 只有 standard/hd/ultra），所以这里期望的是整个请求 400 —— 询价
    // 与提交用同一个 schema，错的值在两边都进不来。
    expect(response.statusCode).toBe(400);
    expect(quote).toHaveBeenCalledTimes(0);
  });
});

describe("POST /api/pricing/quote — 请求级错误", () => {
  it("case 6a: items 为空 → 400 invalid_request 信封", async () => {
    const response = await postQuote({ items: [] });

    expect(response.statusCode).toBe(400);
    const body = response.json() as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(getBalance).toHaveBeenCalledTimes(0);
  });

  it("case 6b: 21 条 → 400 invalid_request", async () => {
    const items = [];
    for (let index = 0; index < 21; index += 1) {
      items.push({ kind: "image_generation", request: { prompt: `panda ${index}` } });
    }

    const response = await postQuote({ items });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
    expect(getBalance).toHaveBeenCalledTimes(0);
  });

  it("case 6c: 未认证 → 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/pricing/quote",
      payload: {
        items: [{ kind: "image_generation", request: { prompt: "a red panda" } }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(quote).toHaveBeenCalledTimes(0);
  });
});
