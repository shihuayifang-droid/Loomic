/**
 * ED-00m 前端 · 直接执行类工具的防护（工单 30M T1，纯函数）
 *
 * 「直接执行」= 去背景、放大各档、自动拆分、矢量：点一下就开始花钱跑任务，
 * 没有参数面板可以停下来想一想。所以入口必须先满足三条：
 *   1. 点之前价格可见（规格第 1 条）
 *   2. 余额不足时禁用，并写明原因（ED-00m）
 *   3. 防止连点（规格第 2 条）
 *
 * 本文件只做「能不能点 / 说什么话」，不含 React、不发请求、不算价 ——
 * 价格数字一律来自传进来的 `PriceState`（BL-14：前端不算价）。
 * 锁与副作用在 `hooks/use-direct-execute.ts`，DOM 在 `components/canvas/direct-execute-button.tsx`。
 */

import type { PriceState } from "@/lib/price-display";

/** 裁决 1：价格还没回来，点了也不知道扣多少。 */
const BLOCKED_ESTIMATING = "价格获取中";
/** 裁决 1：价格失败时入口关掉，重试走 PriceTag 自己的 onRetry（ED-00c）。 */
const BLOCKED_PRICE_ERROR = "价格获取失败";

/** 裁决 2：可点时的提示，三态各一句。 */
const TOOLTIP_FREE = "免费，点击即执行";
const TOOLTIP_PENDING = "待定价，点击即执行";

/** 裁决 1 的余额不足文案（逐字，含全角冒号与全角逗号）。 */
function insufficientReason(amount: number, available: number): string {
  return `积分不足：需要 ${amount}，当前 ${available}`;
}

/** 裁决 2 的扣费提示（逐字）。 */
function pricedTooltip(amount: number): string {
  return `点击即扣 ${amount} 分`;
}

/**
 * 裁决 1 · 不可点的原因（按优先级）。
 *
 * | 价格状态 | 结果 | 文案 |
 * |---|---|---|
 * | `estimating` | 不可点 | `价格获取中` |
 * | `error` | 不可点 | `价格获取失败` |
 * | `priced` 且 `available !== null && available < amount` | 不可点 | `积分不足：需要 {amount}，当前 {available}` |
 * | `pending`、`free` | 可点 | — |
 * | `priced` 且余额足够 | 可点 | — |
 *
 * `available === null`（可用额度未知，BL-45 还没做）**不拦截** —— 由服务端兜底返回 402。
 * 拦在客户端只是省一次往返，钱的事最终以服务端为准。
 *
 * 判据是规格第 1 条「点击前价格必须已可见」：`estimating` / `error` 两种状态下
 * 价格本来就没拿到，让人点下去等于盲扣。
 */
export function directExecuteBlockReason(input: {
  price: PriceState;
  available: number | null;
}): string | null {
  const { price, available } = input;

  switch (price.status) {
    case "estimating":
      return BLOCKED_ESTIMATING;
    case "error":
      return BLOCKED_PRICE_ERROR;
    case "priced":
      // 余额未知时不拦：拦了会让「还没接 BL-45」的环境里所有按量工具都点不动。
      if (available !== null && available < price.amount) {
        return insufficientReason(price.amount, available);
      }
      return null;
    case "free":
    case "pending":
      return null;
  }
}

/**
 * 裁决 2 · 可点时的 tooltip 文案。
 *
 * 不可点的三种状态返回 `null`（那时按钮的 `title` 用 `reason`，见 T3）。
 * 两种文案都只是描述「点了会发生什么」，不承诺结果 —— 真正的扣费以服务端为准。
 */
export function directExecuteTooltip(price: PriceState): string | null {
  switch (price.status) {
    case "priced":
      return pricedTooltip(price.amount);
    case "free":
      return TOOLTIP_FREE;
    case "pending":
      return TOOLTIP_PENDING;
    case "estimating":
    case "error":
      return null;
  }
}

/**
 * 分隔符：素材 id 与工具 id 都不含 `::`（素材是 uuid / Excalidraw element id，
 * 工具 id 是 `vectorize`、`upscale-2x` 这类短横线串），所以拼出来不会撞。
 * 用可读的分隔符而不是 `\u0000`，是为了锁泄漏时能在日志里直接看出是哪一格。
 */
const KEY_SEPARATOR = "::";

/**
 * 裁决 3 · 提交锁的键：**按 `(sourceId, toolId)`**，不是按按钮实例。
 *
 * 同一张图、同一个工具在工具条和「更多」菜单各有一个入口，两个入口必须互斥 ——
 * 所以键里不能有「哪个组件点的」这一维。
 */
export function inFlightKey(sourceId: string, toolId: string): string {
  return `${sourceId}${KEY_SEPARATOR}${toolId}`;
}
