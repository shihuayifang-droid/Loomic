// @credits-system — GN-01 询价接口：只报价，不执行、不扣费、不写流水
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  DEFAULT_IMAGE_MODEL_ID,
  DEFAULT_TOOL_SEARCH_KEY,
  DEFAULT_VIDEO_MODEL_ID,
  TOOL_MODEL_ID_PREFIX,
  applicationErrorResponseSchema,
  pricingQuoteRequestSchema,
  pricingQuoteResponseSchema,
  unauthenticatedErrorResponseSchema,
  type EntryPoint,
  type PricingQuoteErrorCode,
  type PricingQuoteItemRequest,
  type PricingQuoteItemResponse,
  type PricingQuoteRequest,
} from "@loomic/shared";

import type { PoolBalanceReadRepository } from "../db/pool-balance-read-repository.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import { toCreditBalanceResponse } from "../features/credits/balance-response.js";
import {
  CreditServiceError,
  type BalanceInfo,
  type CreditService,
} from "../features/credits/credit-service.js";
import type { BillingGuardSpec } from "../features/credits/with-billing.js";
import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import { billingSearchKey } from "../features/pricing/search-key.js";
import { TOOL_DEFINITIONS } from "../features/tools/tool-definitions.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/**
 * `POST /api/pricing/quote` — GN-01 的询价接口（工单31D）。
 *
 * 它回答一个问题：「这一批请求各要花多少积分」，并在同一次响应里带上余额。
 * 它**不做**的事和它做的事一样重要：
 *
 * - 不执行、不扣费、不写流水（GN-01 验收 3）。这不是靠代码里「记得别调」保证的，
 *   而是靠**依赖列表**：`registerPricingRoutes` 只收 auth / creditService /
 *   priceQuoter / viewerService，拿不到 ledger、jobService、deduct 也就不可能
 *   碰它们（裁决 8）。
 * - 不做 tier 检查和并发检查（裁决 5）：那是提交时的事，与「多少钱」无关；
 *   在这里做还会让前端在工具条一出现时就被 403/409 打脸。
 * - 不收 `quote_id`、也不在提交时校验报价（GN-23，见 T-77）：一期只报价。
 * - 不让客户端指定入口（裁决 2）：图片 / 视频按提交路径的口径算
 *   `canvas_generator`，工具算 `tool`。让客户端自选就是让它挑最便宜的规则。
 *
 * 结果逐条返回、HTTP 200（裁决 6）：一个未登记的模型不该让同一批里能报的十九条
 * 一起失败。只有**请求体本身**不合法（空、超过 20 条、某条没通过 schema）才是
 * 整个请求 400。
 */
export async function registerPricingRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    priceQuoter: PriceQuoter;
    viewerService: ViewerService;
    /**
     * GN-05: the tool table a quote reads. The shipped table is the default, and a
     * test may hand in its own so "swapping a tool's execution model is a config
     * change" can be proved without editing the table the site ships.
     */
    tools?: typeof TOOL_DEFINITIONS;
    /**
     * BL-45 / workorder 39D: optional on purpose, exactly as on
     * `registerCreditRoutes`. Omitted → the quote's balance is the pre-pools
     * payload with no `pools` key at all. Injected (workorder 38I wires it only
     * while `LOOMIC_CREDIT_POOLS=on`) → the balance carries the caller's three
     * pools, read from the same repository `GET /api/credits` reads them from,
     * so "询价返回的余额与 GET /api/credits 同结构" (ruling 7) holds for the
     * pools too.
     */
    poolBalanceReadRepository?: PoolBalanceReadRepository;
  },
) {
  // POST /api/pricing/quote — quote a batch, no side effects
  app.post("/api/pricing/quote", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return sendUnauthenticated(reply);

    // Ruling 6, the 400 half: the body is validated before ANY read, so an
    // ill-formed request cannot even cause a balance query.
    let payload: PricingQuoteRequest;
    try {
      payload = pricingQuoteRequestSchema.parse(request.body);
    } catch {
      return reply.code(400).send(
        applicationErrorResponseSchema.parse({
          error: {
            code: "invalid_request",
            message: "Invalid request body.",
          },
        }),
      );
    }

    try {
      const viewer = await options.viewerService.ensureViewer(user);

      // Ruling 4: the plan comes from the balance we have to read anyway. Calling
      // `getSubscription` as well would be a second read of the same fact and a
      // second chance for the two to disagree inside one response.
      const balanceInfo = await options.creditService.getBalance(
        viewer.workspace.id,
      );

      // BL-45 / workorder 39D: the same three branches `http/credits.ts` uses,
      // so the quote's `balance` and `GET /api/credits` cannot disagree about the
      // pools any more than they can about the four fields above.
      //
      // - no reader (switch off) → `undefined`, i.e. no `pools` key at all;
      // - reader but no team workspace → `null`, because the pools are bookkept
      //   per TEAM workspace (37M / 37N) and an all-zero pool would be a lie;
      // - otherwise → this member's pools of that team workspace.
      //
      // A failed read is NOT swallowed: it falls into the catch below and answers
      // the existing 500, because a balance with half its pools is worse than no
      // balance at all. The QUOTE (the items) is untouched by all of this.
      const poolBalanceReadRepository = options.poolBalanceReadRepository;
      const pools =
        poolBalanceReadRepository === undefined
          ? undefined
          : viewer.teamWorkspace
            ? await poolBalanceReadRepository.readPoolBalances({
                workspaceId: viewer.teamWorkspace.id,
                userId: user.id,
              })
            : null;

      // ONE clock reading for the whole batch: `at` decides which rules are in
      // force, so reading it per item could price two lines of the same response
      // against two different rule versions across an activation boundary.
      const at = new Date();

      const items: PricingQuoteItemResponse[] = [];
      for (const item of payload.items) {
        items.push(
          await quoteItem({
            item,
            plan: balanceInfo.plan,
            priceQuoter: options.priceQuoter,
            at,
            ...(options.tools ? { tools: options.tools } : {}),
          }),
        );
      }

      return reply.code(200).send(
        pricingQuoteResponseSchema.parse({
          items,
          // Same helper, same schema as GET /api/credits: "与 GET /api/credits
          // 同结构" is a shared function, not a coincidence (ruling 7). The pools
          // ride through the very same second argument (workorder 39D).
          balance: toCreditBalanceResponse(balanceInfo, pools),
        }),
      );
    } catch (error) {
      return sendPricingError(error, reply);
    }
  });
}

/** 一条询价要问价目表的三个坐标（模型 / 入口 / 档位）。 */
type QuoteTarget = {
  modelId: string;
  entryPoint: EntryPoint;
  searchKey: string;
};

/**
 * 把一条请求翻成「问价目表哪一行」，再问一次。
 *
 * 入口和档位的口径必须与提交路径**逐字一致**，否则报价和实际扣费会报出两个数：
 *
 * - 图片 / 视频 → `canvas_generator`（与 `http/generate.ts` 相同），档位由
 *   `billingSearchKey` 推导（与 `withBilling` 同一个函数，31D 裁决 3）；
 * - 工具 → `tool`，`model_id` 是 `tool:<工具 id>`，档位缺省 `*` 即默认行。
 */
async function quoteItem(args: {
  item: PricingQuoteItemRequest;
  plan: BalanceInfo["plan"];
  priceQuoter: PriceQuoter;
  at: Date;
  /** GN-05: the tool table to read; defaults to the shipped one. */
  tools?: typeof TOOL_DEFINITIONS;
}): Promise<PricingQuoteItemResponse> {
  const { item, plan, priceQuoter, at, tools = TOOL_DEFINITIONS } = args;

  if (item.kind === "tool") {
    const tool = tools.find((candidate) => candidate.id === item.tool_id);

    // Not a 400: the request is well-formed, this one line just cannot be priced.
    if (!tool) {
      return errorItem(
        "invalid_request",
        `Unknown tool id "${item.tool_id}".`,
      );
    }

    // A free tool has no price to report, and inventing 0 here would make
    // "free" and "not configured yet" indistinguishable on the wire
    // (`pricing === null` IS the definition of a free tool, ED-00k).
    if (tool.pricing === null) {
      return errorItem(
        "invalid_request",
        `Tool "${tool.id}" is free (its definition carries no pricing); the client should render it as free instead of quoting it.`,
      );
    }

    const quoted = await askPriceTable(
      priceQuoter,
      {
        modelId: `${TOOL_MODEL_ID_PREFIX}${tool.id}`,
        entryPoint: "tool",
        searchKey: item.search_key ?? DEFAULT_TOOL_SEARCH_KEY,
      },
      at,
    );

    // GN-05: a tool row may name the model that runs it; the quote echoes it back
    // so the client keeps no tool -> model table of its own (swap the model =
    // edit the definition). The priced key (`tool:<id>`) and `price_detail` are
    // untouched: which model runs a tool does not move the price of the tool.
    if (quoted.status === "ok" && tool.execution_model) {
      return { ...quoted, model: tool.execution_model };
    }

    return quoted;
  }

  if (item.kind === "image_generation") {
    // `quality ?? "hd"` is generate.ts's own default: a quote for a request whose
    // quality was left out must price the tier that request will actually run at.
    const guard: BillingGuardSpec = {
      jobType: "image_generation",
      quality: item.request.quality ?? "hd",
    };

    return await askPriceTable(
      priceQuoter,
      {
        modelId: item.request.model ?? DEFAULT_IMAGE_MODEL_ID,
        entryPoint: "canvas_generator",
        searchKey: billingSearchKey(guard, plan).searchKey,
      },
      at,
    );
  }

  const videoGuard: BillingGuardSpec = {
    jobType: "video_generation",
    ...(item.request.resolution
      ? { resolution: item.request.resolution }
      : {}),
  };

  return await askPriceTable(
    priceQuoter,
    {
      modelId: item.request.model ?? DEFAULT_VIDEO_MODEL_ID,
      entryPoint: "canvas_generator",
      searchKey: billingSearchKey(videoGuard, plan).searchKey,
    },
    at,
  );
}

/** 问一次价目表；未登记 / 无可用行是这一条的错，不是整批的错。 */
async function askPriceTable(
  priceQuoter: PriceQuoter,
  target: QuoteTarget,
  at: Date,
): Promise<PricingQuoteItemResponse> {
  const outcome = await priceQuoter.quote({
    modelId: target.modelId,
    entryPoint: target.entryPoint,
    searchKey: target.searchKey,
    at,
  });

  if (!outcome.ok) {
    return errorItem(
      outcome.code,
      `Model "${target.modelId}" is not available for generation.`,
    );
  }

  return { status: "ok", price_detail: outcome.detail };
}

function errorItem(
  code: PricingQuoteErrorCode,
  message: string,
): PricingQuoteItemResponse {
  return { status: "error", code, message };
}

function sendUnauthenticated(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function sendPricingError(error: unknown, reply: FastifyReply) {
  if (error instanceof CreditServiceError) {
    return reply.code(error.statusCode).send(
      applicationErrorResponseSchema.parse({
        error: { code: error.code, message: error.message },
      }),
    );
  }

  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "An unexpected error occurred.",
      },
    }),
  );
}
