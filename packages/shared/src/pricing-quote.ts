import { z } from "zod";

// 询价响应里带余额（GN-01 验收 1 的前端需求）。`index.ts` 里 `credits.js` 在
// `pricing.js` 之前导出，且 `credits.ts` 不引用本文件，所以这里只可能是单向依赖。
import { creditBalanceResponseSchema } from "./credits.js";
import { priceDetailSchema } from "./pricing.js";

/**
 * GN-01 询价接口（工单31D）的契约：提交请求体 schema 与询价请求 / 响应 schema。
 *
 * 为什么单独一个文件、而不是并进 `pricing.ts`（工单31D-v2）：`pricing.ts` 受
 * BL-14 守卫（`apps/server/src/features/pricing/resolve-price.test.ts` case 19）保护，
 * 该守卫要求那个文件正文里除 `0` 外不出现任何数字字面量 —— 它是「价格只存在于
 * 价目表」这条红线的机器判据。而两个提交 schema 的枚举值本身就是数字串
 * （`1:1 / 16:9 / 9:16 / 4:3 / 3:4`、`720p / 1080p / 4k`、`min(3) / max(16) / max(3)`），
 * 询价 schema 还带 `min(1) / max(20)`。把这些数字塞进 `pricing.ts` 只有两条路：
 * 放宽守卫（等于让红线失效），或者改 schema 字段（裁决禁止）。所以契约搬到本文件，
 * `pricing.ts` 保持逐字不变，守卫不需要任何改动。
 *
 * 依赖方向是单向的：本文件引 `pricing.js`（要 `priceDetailSchema`）和 `credits.js`
 * （要 `creditBalanceResponseSchema`），而这两个文件都不引本文件，所以不会形成循环
 * import（工单31D §7 第二条）。
 */

// ── 提交接口的请求体 schema（工单31D，从 generate.ts 原样挪来）─────────────
//
// 询价接口（GN-01）要保证「请求体与提交完全同构」。唯一能证明这件事的不是两份
// 长得一样的拷贝，而是**同一个对象**：所以这两个 schema 从
// `apps/server/src/http/generate.ts` 原样挪到这里并导出，提交路由改为从这里取。
// 字段、可选性、枚举值和默认值一个字都没改（工单31D 裁决 1 / §7 第一条）。

/** `POST /api/agent/generate-image` 的请求体。 */
export const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
});
export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;

/** `POST /api/agent/generate-video` 的请求体。 */
export const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
});
export type GenerateVideoRequest = z.infer<typeof generateVideoRequestSchema>;

/**
 * 请求没给 `model` 时的默认模型。询价（`http/pricing.ts`）与三处提交路径
 * （`http/generate.ts` 图片/视频、`http/jobs.ts` 图片、job executor
 * `image-generation.ts`）都引用这里，只此一份（工单31D 提出，S-001 收口）。
 */
export const DEFAULT_IMAGE_MODEL_ID = "black-forest-labs/flux-kontext-pro";
export const DEFAULT_VIDEO_MODEL_ID = "google-official/veo-3.1-generate-preview";

/**
 * 工具行的模型 id 前缀：价目表里工具行是 `model_id = "tool:<工具 id>"`。
 * 工具定义表的 `id` 是裸名（`adjust`、`upscale`…），所以拼装只在这一处发生。
 */
export const TOOL_MODEL_ID_PREFIX = "tool:";

/** 工具询价没给 `search_key` 时的档位：`*` = 命中默认行（GN-01 验收 2）。 */
export const DEFAULT_TOOL_SEARCH_KEY = "*";

// ── 询价接口 POST /api/pricing/quote（GN-01 / 工单31D）────────────────────

/**
 * 一条询价请求（工单31D 裁决 1）。
 *
 * 图片 / 视频这两支的 `request` 就是提交路由的那两个 schema 对象本身 —— 客户端把
 * 准备提交的请求体原样放进来，服务端按同一条规则校验，于是「能不能提交」与
 * 「能不能报价」不会因为两份 schema 而分叉。
 *
 * **入口（entryPoint）刻意不在请求体里**（裁决 2）：入口由服务端按条目种类决定，
 * 客户端不能自选，否则它总能挑最便宜的那条规则。`z.object` 默认丢弃未知字段，
 * 所以客户端塞进来的 `entryPoint` / `entry_point` 会被忽略，不会生效。
 */
export const pricingQuoteItemRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image_generation"),
    request: generateImageRequestSchema,
  }),
  z.object({
    kind: z.literal("video_generation"),
    request: generateVideoRequestSchema,
  }),
  z.object({
    kind: z.literal("tool"),
    tool_id: z.string().min(1),
    /** 缺省 = `"*"`，即命中默认行（GN-01 验收 2 要的形状）。 */
    search_key: z.string().min(1).optional(),
  }),
]);
export type PricingQuoteItemRequest = z.infer<typeof pricingQuoteItemRequestSchema>;

/**
 * 一次询价的请求体：1 ~ 20 条（裁决 1）。
 *
 * 条数超限或某条不合法是**整个请求** 400，不是逐条 error —— 逐条 error 只用于
 * 「这条请求本身合法，但报价答不了」（模型未登记 / 工具不存在 / 免费工具）。
 */
export const pricingQuoteRequestSchema = z.object({
  items: z.array(pricingQuoteItemRequestSchema).min(1).max(20),
});
export type PricingQuoteRequest = z.infer<typeof pricingQuoteRequestSchema>;

/** 逐条报价失败的两个原因（裁决 6）。 */
export const pricingQuoteErrorCodeSchema = z.enum([
  "model_not_available",
  "invalid_request",
]);
export type PricingQuoteErrorCode = z.infer<typeof pricingQuoteErrorCodeSchema>;

/**
 * 一条询价结果（裁决 6）：要么带完整 `price_detail`，要么带错误码和原因。
 *
 * 逐条返回而不是整单失败：一批里有一个未登记的模型，不该把另外十九条能报的
 * 价格一起丢掉 —— 那个模型是「这张图多少钱」这个问题的一部分，不是请求级错误。
 */
export const pricingQuoteItemResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    price_detail: priceDetailSchema,
    /**
     * GN-05: the model that will run this line, echoed from the tool definition's
     * `execution_model`. Only tool items carry it (an image / video request names
     * its own model), so it stays optional. It is not part of `price_detail`: the
     * price detail describes the priced row, this describes who does the work.
     */
    model: z.string().min(1).optional(),
  }),
  z.object({
    status: z.literal("error"),
    code: pricingQuoteErrorCodeSchema,
    message: z.string().min(1),
  }),
]);
export type PricingQuoteItemResponse = z.infer<
  typeof pricingQuoteItemResponseSchema
>;

/**
 * 询价响应（裁决 6）：`items` 与请求的 `items` 一一对应、同序；`balance` 与
 * `GET /api/credits` 同结构（判据是两者用同一个 schema）。
 */
export const pricingQuoteResponseSchema = z.object({
  items: z.array(pricingQuoteItemResponseSchema),
  balance: creditBalanceResponseSchema,
});
export type PricingQuoteResponse = z.infer<typeof pricingQuoteResponseSchema>;
