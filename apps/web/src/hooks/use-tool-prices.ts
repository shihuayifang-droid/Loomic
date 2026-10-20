"use client";

import { useEffect, useMemo, useState } from "react";

import type { ToolDefinition } from "@loomic/shared";

import type { PriceState } from "@/lib/price-display";
import { priceStateFromQuote } from "@/lib/price-display";
import { fetchPriceQuote } from "@/lib/server-api";
import { toolPriceKey, toolQuoteTiers } from "@/lib/tool-price-tooltip";

/**
 * ED-00c / ED-00f · 付费工具的询价（工单 36M：工具条出现即询价**全部档位**）
 *
 * 菜单项右侧的 `⚡N` 与工具条 tooltip 的价格行都只能来自询价（BL-14 验收 1：
 * 前端不算价），所以「哪些工具要问价」完全由工具定义决定，本文件不出现任何具体工具 id：
 * 可用的（`availability === "enabled"`）+ 花额度的（`consumes === true`）
 * + 带计价规则的（`pricing !== null`）。
 *
 * ED-00c：「选中图片、工具条渲染时，**并发询价所有付费工具的全部档位**，不等打开面板」。
 * 所以本文件不再按 `default_slot` / `form` 挑工具（那是 35L 只给「更多」菜单标价时的口径），
 * 一个工具询价几项由 `pricing.tiers` 决定：有档位就每档一项，没档位就一项（不带 `search_key`）。
 *
 * 一次请求报完整批（GN-01 的 `POST /api/pricing/quote` 支持 1~20 条），而不是每个工具
 * 各发一次 —— 工具条一渲染就打二十个请求，用户看到的就是二十个「估算中」慢慢变成价格。
 *
 * 三种状态对应标价的三种样子（`priceStateFromQuote` 负责映射，这里不解读价格）：
 * - 请求在飞：每个 key 都是 `estimating`（ED-00l：没返回时显示「估算中」，不能留空）
 * - 成功：第 i 条结果喂给第 i 个 key（响应与请求同序，见 GN-01 契约）
 * - 失败：整批都是 `error`（ED-00c：「价格获取失败，点击重试」）
 */

/**
 * 单次询价的条数上限（GN-01 裁决 1：`items` 1~20）。
 *
 * 超过 20 项时只问前 20 项：超限请求会被服务端整单 400，那样一个价格都拿不到；
 * 截断只会让第 21 项之后停在「估算中」，而工具定义表的档位总数离 20 还有距离。
 */
export const MAX_TOOL_QUOTE_ITEMS = 20;

/** key 规则（`toolId` / `toolId:tier`）定义在 tooltip 那一侧，两处必须同一份。 */
export { toolPriceKey };

/** 一个询价槽位：`tier === undefined` = 该工具没有档位（询价项不带 `search_key`）。 */
type QuoteSlot = {
  /** 结果里的 key（`toolPriceKey`） */
  readonly key: string;
  readonly toolId: string;
  readonly tier?: string;
};

/** 依赖比较用的编码：一份工具定义拼出来的槽位串（数组每次渲染都是新对象，不能直接当依赖）。 */
const SLOT_FIELD_SEPARATOR = "|";

function encodeSlot(slot: QuoteSlot): string {
  return slot.tier === undefined
    ? slot.toolId
    : `${slot.toolId}${SLOT_FIELD_SEPARATOR}${slot.tier}`;
}

function decodeSlot(encoded: string): QuoteSlot {
  const index = encoded.indexOf(SLOT_FIELD_SEPARATOR);
  if (index < 0) return { key: encoded, toolId: encoded };
  const toolId = encoded.slice(0, index);
  const tier = encoded.slice(index + 1);
  return { key: toolPriceKey(toolId, tier), toolId, tier };
}

/**
 * 要询价的槽位（顺序即请求顺序，响应按同序回来）。
 *
 * 每个工具：`pricing.tiers` 去掉 `"*"` 后非空 → 每档一个槽位；为空 → 一个不带档位的槽位。
 * 总数截到 `MAX_TOOL_QUOTE_ITEMS`（工具之间、同一工具的多档之间都算进去）。
 */
function quotedSlots(tools: readonly ToolDefinition[]): QuoteSlot[] {
  const slots: QuoteSlot[] = [];
  for (const tool of tools) {
    if (tool.availability !== "enabled") continue;
    // ED-00c「所有付费工具」：花额度才算付费，`consumes: false` 的（面板类 / 免费工具）不询价。
    if (tool.consumes !== true) continue;
    if (tool.pricing === null) continue;

    const tiers = toolQuoteTiers(tool);
    const keys: Array<string | undefined> = tiers.length === 0 ? [undefined] : [...tiers];
    for (const tier of keys) {
      if (slots.length >= MAX_TOOL_QUOTE_ITEMS) return slots;
      slots.push(
        tier === undefined
          ? { key: toolPriceKey(tool.id), toolId: tool.id }
          : { key: toolPriceKey(tool.id, tier), toolId: tool.id, tier },
      );
    }
  }
  return slots;
}

/** 请求还没回来时，每个 key 都只能是「估算中」。 */
function everyKey(slots: readonly QuoteSlot[], state: PriceState): Record<string, PriceState> {
  const next: Record<string, PriceState> = {};
  for (const slot of slots) next[slot.key] = state;
  return next;
}

/**
 * ED-00c: quote every enabled paying tool (every tier) once per token, keyed by tool id / tool id + tier.
 *
 * 依赖只有 token 与槽位串（数组每次渲染都是新对象，直接放进依赖会让 effect 每帧重跑）。
 * 卸载后迟到的响应直接丢弃，不再 setState。
 */
export function useToolPrices(
  accessToken: string | null | undefined,
  tools: readonly ToolDefinition[],
): Readonly<Record<string, PriceState>> {
  /**
   * 槽位拼成一串：它是 token 之外唯一的依赖。
   * 用 `,` 分隔（工具 id 的字符集是 `[a-z0-9_]`、档位名不含逗号，见 `toolDefinitionSchema`）。
   */
  const slotsKey = useMemo(() => quotedSlots(tools).map(encodeSlot).join(","), [tools]);

  const [prices, setPrices] = useState<Readonly<Record<string, PriceState>>>({});

  useEffect(() => {
    const slots = slotsKey === "" ? [] : slotsKey.split(",").map(decodeSlot);

    // 没登录 / 没有要询价的槽位：不请求，也不残留上一个 token 的价格。
    if (!accessToken || slots.length === 0) {
      setPrices({});
      return;
    }

    let cancelled = false;
    setPrices(everyKey(slots, { status: "estimating" }));

    fetchPriceQuote(accessToken, {
      // 无档位槽位不带 `search_key`（缺省 = `"*"` 默认行，与旧行为逐字段相同）。
      items: slots.map((slot) =>
        slot.tier === undefined
          ? { kind: "tool" as const, tool_id: slot.toolId }
          : { kind: "tool" as const, tool_id: slot.toolId, search_key: slot.tier },
      ),
    }).then(
      (response) => {
        if (cancelled) return;
        const next: Record<string, PriceState> = {};
        for (let index = 0; index < slots.length; index += 1) {
          const slot = slots[index];
          if (slot === undefined) continue;
          // 响应与请求同序（GN-01 契约）；缺条目时 `priceStateFromQuote` 给「估算中」。
          next[slot.key] = priceStateFromQuote(response.items[index]);
        }
        setPrices(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error("[tool-prices] quote failed:", error);
        setPrices(everyKey(slots, { status: "error" }));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accessToken, slotsKey]);

  return prices;
}
