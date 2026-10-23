import { z } from "zod";

/**
 * BL-14 / GN-01 — `price_detail` 契约（工单 31A）。
 *
 * 这个文件是**价格唯一的对外形状**：询价接口（GN-01，另开单）与扣费路径
 * （下一张单）都从这里取类型。它刻意只描述「一条报价长什么样」，不含任何
 * 计算、默认值或价格常量 —— BL-14 第 1 条：价格只存在于价目表，
 * 前端代码、后端业务代码、工具定义、文档里都不出现具体价格数字。
 *
 * 字段清单来自 GN-01（`GN-生成链路与MD-模型配置.md` L84-98 / 契约 §2.5.3）：
 * `base_price · unit_name · unit_count · unit_price · total_price ·
 *  search_key · search_key_matched · time_variant_period · disable_unlimited ·
 *  entry_point · extras[] · price_status`。验收判据是**key 集合完全一致**，
 * 所以这里每个字段都必须出现，且不许顺手改名成 camelCase。
 *
 * 三个取值口径（口径出处写在字段旁边，改之前先回去读那一节）：
 * - `search_key` 命中兜底（默认行）时是字符串 `"unknown"`，且
 *   `search_key_matched` 为 null（GN-01 验收 2）；命中具体档位时两者都等于档位。
 * - `time_variant_period` 一期恒为 `"normal"`（GN-09b）。
 * - `price_status = "pending"`（待定价）时三个价格字段都是 0，单位数仍是 1：
 *   「待定价」可以执行、按 0 扣，与「未登记 / 无规则」严格区分（GN-07）。
 */

/** 一条规则的价格状态（AD-07 / BL-14）：`pending` = 待定价，`active` = 已定价。 */
export const priceStatusSchema = z.enum(["pending", "active"]);
export type PriceStatus = z.infer<typeof priceStatusSchema>;

/**
 * 入口（GN-09）。`*` 是通配：规则行可以写 `*` 表示「任何入口都适用」。
 * 与迁移 `pricing_rules.entry_point` 的 CHECK 列表逐字一致。
 */
export const entryPointSchema = z.enum([
  "*",
  "agent",
  "agent_generator",
  "canvas_generator",
  "tool",
]);
export type EntryPoint = z.infer<typeof entryPointSchema>;

/**
 * 时段（GN-09b）。一期规则只写 `normal`；`*` 留给将来「按时段变价」，
 * 匹配时可以当通配用。与迁移 `pricing_rules.time_period` 的 CHECK 一致。
 */
export const timePeriodSchema = z.enum(["*", "normal"]);
export type TimePeriod = z.infer<typeof timePeriodSchema>;

/**
 * 附加项（GN-28）。结构还没定，这里只要求「一条附加项是一个对象」，
 * 不预设字段 —— 定了之后改这里，别在调用点各自发明形状。
 */
export const priceExtraSchema = z.record(z.string(), z.unknown());
export type PriceExtra = z.infer<typeof priceExtraSchema>;

/**
 * 一条报价明细。
 *
 * 金额一律是**整数积分**（AD-07）：小数、负数、NaN 都是上游错了，
 * `parse()` 直接失败而不是四舍五入成一个看起来正常的数字。
 */
export const priceDetailSchema = z.object({
  /** 规则本身的价格（一条规则的单价），待定价时为 0。 */
  base_price: z.number().int().nonnegative(),
  /** 计价单位名（「次」「秒」…），来自规则行，不在这里换算。 */
  unit_name: z.string().nonempty(),
  /** 本次计价用掉几个单位：张数等线性乘数；默认 1。 */
  unit_count: z.number().int().positive(),
  /** 单位价，等于规则价格；待定价时为 0。 */
  unit_price: z.number().int().nonnegative(),
  /** 合计 = unit_price × unit_count。 */
  total_price: z.number().int().nonnegative(),
  /** 生效的档位名；命中默认行时是 `"unknown"`（GN-01 验收 2）。 */
  search_key: z.string().nonempty(),
  /** 真正命中的规则档位；命中默认行时是 null（GN-07 验收 3）。 */
  search_key_matched: z.string().nonempty().nullable(),
  /** GN-09b：一期恒为 `"normal"`，字段必须出现。 */
  time_variant_period: z.literal("normal"),
  /** 一期恒为 false（无限量档位还没开放）。 */
  disable_unlimited: z.boolean(),
  /** 调用方请求的入口，原样回传（GN-01 契约字段）。 */
  entry_point: entryPointSchema,
  /** GN-28 附加项，一期为空数组。 */
  extras: z.array(priceExtraSchema),
  /** 命中规则的价格状态：`pending` 时上面三个价格字段都是 0。 */
  price_status: priceStatusSchema,
});
export type PriceDetail = z.infer<typeof priceDetailSchema>;
