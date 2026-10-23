import type { PricingQuoteItemResponse } from "@loomic/shared";

/**
 * BL-14 前端 · 价格展示五态（ED-00l 口径）
 *
 * 前端不算价（BL-14 验收 1）：本文件里没有一个价格常量，也不做任何四舍五入 / 换算。
 * 所有数字只有一个来源 —— 询价结果（GN-01 落地后接入）；`amount` 在这里只做合法性校验。
 *
 * 五种状态：估算中 / 数字 / 免费 / 待定价 / 获取失败。
 * 文案来源：
 *   - 待定价：BL-14 §3「按钮和档位分别显示『生成 · 待定价』『⚡待定价』，可以点」
 *   - 免费：「更多」菜单里免费的直接执行项标「免费」（ED-00f R9）
 *   - 估算中：价格没返回时有文案，不能留空（ED-00l）
 *   - 获取失败：「价格获取失败，点击重试」（ED-00c 前端要点）
 *   - 数字：按钮「生成 · N」、菜单项「⚡N」「N」（N 来自询价，ED-00c / ED-00f）
 */

export type PriceState =
  | { status: "estimating" }
  | { status: "priced"; amount: number; unit?: string }
  | { status: "free" }
  | { status: "pending" }
  | { status: "error" };

/** button：工具条 / 面板上的执行按钮　badge：「更多」菜单右侧的标价　plain：纯文本 */
export type PriceVariant = "button" | "badge" | "plain";

/** ED-00c：获取失败的文案三种 variant 一样。 */
export const RETRY_TEXT = "价格获取失败，点击重试";
/** ED-00l：估算中必须有字，不能留空、也不能只显示尺寸。 */
export const ESTIMATING_TEXT = "估算中";
/** ED-00f：免费的直接执行项标「免费」。 */
export const FREE_TEXT = "免费";
/** BL-14 §3：待定价。 */
export const PENDING_TEXT = "待定价";
/** BL-14 §3：按钮上写成「生成 · N」。 */
const BUTTON_PREFIX = "生成 · ";
/** ED-00f：菜单 / 档位上的 ⚡ 标价。 */
const BADGE_PREFIX = "⚡";

/**
 * 询价结果是整数（BL-14：价格只存在于价目表，单位换算等 GN-08 再定）。
 * 负数、小数、NaN、Infinity 都说明上游或调用方错了，这里直接抛错，
 * 不让它静默变成一个看起来正常的字符串 —— 这也是「前端不算价」的另一半。
 */
function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`价格必须是询价返回的非负整数，收到：${String(amount)}`);
  }
}

/** 把状态渲染成一段文案。同一条调用在三种 variant 下只差前缀，正文一致。 */
export function formatPrice(state: PriceState, variant: PriceVariant): string {
  switch (state.status) {
    case "estimating":
      return variant === "button" ? `${BUTTON_PREFIX}${ESTIMATING_TEXT}` : ESTIMATING_TEXT;
    case "priced": {
      assertAmount(state.amount);
      const amount = String(state.amount);
      if (variant === "button") return `${BUTTON_PREFIX}${amount}`;
      if (variant === "badge") return `${BADGE_PREFIX}${amount}`;
      return amount;
    }
    case "free":
      return variant === "button" ? `${BUTTON_PREFIX}${FREE_TEXT}` : FREE_TEXT;
    case "pending":
      // BL-14 §3：待定价既可以显示、也可以点开
      if (variant === "button") return `${BUTTON_PREFIX}${PENDING_TEXT}`;
      if (variant === "badge") return `${BADGE_PREFIX}${PENDING_TEXT}`;
      return PENDING_TEXT;
    case "error":
      return RETRY_TEXT;
  }
}

/** ED-00f: one quote answer → what a price tag shows. */
export function priceStateFromQuote(
  item: PricingQuoteItemResponse | undefined,
): PriceState {
  // 没有这一条结果 = 询价还没回来（或这一项没进请求），只能显示「估算中」。
  if (item === undefined) return { status: "estimating" };
  // 这一条报错（模型未登记 / 工具不存在）：走 ED-00c 的「获取失败」文案。
  if (item.status === "error") return { status: "error" };
  // 命中规则的档位本身待定价（BL-14 §3）：即使合计是 0 也不是「免费」。
  if (item.price_detail.price_status === "pending") return { status: "pending" };
  // 规则已定价但合计 0 = 免费的直接执行项（ED-00f R9）。
  if (item.price_detail.total_price === 0) return { status: "free" };
  // 其余原样取询价的合计，不做任何换算或四舍五入。
  return { status: "priced", amount: item.price_detail.total_price };
}

/**
 * 能不能点。
 *
 * - 待定价：**可点**（BL-14 §3）
 * - 估算中：不可点（价格还没回来，点了也不知道扣多少）
 * - 获取失败：不走本条，走重试（ED-00c）
 */
export function isPriceClickable(state: PriceState): boolean {
  switch (state.status) {
    case "priced":
      assertAmount(state.amount);
      return true;
    case "free":
    case "pending":
      return true;
    case "estimating":
    case "error":
      return false;
  }
}
