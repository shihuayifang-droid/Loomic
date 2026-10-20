import type { ToolDefinition } from "@loomic/shared";

import type { PriceState } from "@/lib/price-display";
import { formatPrice } from "@/lib/price-display";

/**
 * ED-00c 前端 · 工具条 tooltip 的价格行（工单 36M）
 *
 * 「放大：2K 12 · 4K 24 · 8K 48」这类文案。数字**只**来自询价结果
 * （BL-14 验收 1：前端不算价），本文件里没有价格常量、也不做换算或四舍五入 ——
 * 取值与文案一律复用 `price-display.ts` 的 `formatPrice`（五态的唯一出口）。
 *
 * 一个工具在询价结果里有「槽位」：有档位的工具有 N 个槽位（每档一个 key），
 * 没有档位的工具只有一个槽位（key 就是 toolId）。key 的拼法在这里定义，
 * `use-tool-prices` 与工具条共用同一份规则，避免两处各写一遍导致对不上。
 */

/** 询价项不带 `search_key` 时服务端命中的档位（GN-01 验收 2）。 */
const DEFAULT_TIER = "*";

/** 档位内的连接符（工具 id 的字符集是 `[a-z0-9_]`，不含 `:`）。 */
const KEY_SEPARATOR = ":";

/** 片段之间的分隔符（ED-00c 原文「放大：2K {N1} · 4K {N2} · 8K {N3}」）。 */
const FRAGMENT_SEPARATOR = " · ";

/** ED-00c：获取失败时整句就是这句话，不带档位前缀。 */
const RETRY_TEXT = "价格获取失败，点击重试";

/**
 * 询价结果的 key：无档位 = `toolId`（旧 key 不变），有档位 = `toolId:tier`。
 *
 * `tier === undefined` 表示「这个工具没有档位」，不是「默认档位」——
 * 后者的 key 也是 `*`，但询价项本身不带 `search_key`。
 */
export function toolPriceKey(toolId: string, tier?: string): string {
  return tier === undefined ? toolId : `${toolId}${KEY_SEPARATOR}${tier}`;
}

/**
 * 要询价的档位列表：`pricing.tiers` 去掉 `"*"`。
 *
 * `"*"` 是「默认行」的标记（GN-01），不是真实档位：留着它就会对同一行问两次价，
 * 而且 `2K`/`4K` 这类展示文案里也不该出现一个叫 `*` 的档位。
 * 返回空数组 = 该工具没有档位 → 询价项不带 `search_key`（与旧行为逐字段相同）。
 */
export function toolQuoteTiers(tool: ToolDefinition): readonly string[] {
  if (tool.pricing === null) return [];
  return tool.pricing.tiers.filter((tier) => tier !== DEFAULT_TIER);
}

/** 一个槽位的片段：有档位时前缀档位名（大写），无档位时只有价格本身。 */
function tierFragment(tier: string | undefined, state: PriceState | undefined): string {
  // 没有这一条结果 = 询价还没回来（ED-00l：没返回时显示「估算中」，不能留空）。
  const text = formatPrice(state ?? { status: "estimating" }, "plain");
  return tier === undefined ? text : `${tier.toUpperCase()} ${text}`;
}

/**
 * ED-00c: "放大：2K 12 · 4K 24 · 8K 48" / "图层拆分：自动 8 / 次"; prices come only from quotes.
 *
 * - 免费工具（`pricing === null`）→ `null`：tooltip 只有工具名，没有价格行。
 * - 任一档位 `error` → 整句「价格获取失败，点击重试」（ED-00c：不是局部失败）。
 * - 其余按槽位拼片段，档位内文案走 `formatPrice(…, "plain")`：
 *   估算中 / 数字 / 待定价 / 免费。
 */
export function toolPriceTooltip(
  tool: ToolDefinition,
  prices: Readonly<Record<string, PriceState>>,
): string | null {
  if (tool.pricing === null) return null;

  const tiers = toolQuoteTiers(tool);
  // 无档位工具只有一个槽位；`undefined` 在这里是「没有档位」的意思（key 就是 toolId）。
  const slots: Array<string | undefined> = tiers.length === 0 ? [undefined] : [...tiers];

  for (const tier of slots) {
    if (prices[toolPriceKey(tool.id, tier)]?.status === "error") return RETRY_TEXT;
  }

  const fragments = slots.map((tier) => tierFragment(tier, prices[toolPriceKey(tool.id, tier)]));
  return `${tool.label}：${fragments.join(FRAGMENT_SEPARATOR)}`;
}
