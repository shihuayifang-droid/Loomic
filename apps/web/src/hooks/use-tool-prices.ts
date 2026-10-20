"use client";

import { useEffect, useMemo, useState } from "react";

import type { ToolDefinition } from "@loomic/shared";

import type { PriceState } from "@/lib/price-display";
import { priceStateFromQuote } from "@/lib/price-display";
import { fetchPriceQuote } from "@/lib/server-api";

/**
 * ED-00f · 「更多」菜单里直接执行类工具的询价（工单 35L，前端第 3 步）
 *
 * 菜单项右侧的 `⚡N` 只能来自询价（BL-14 验收 1：前端不算价），所以「哪些工具要问价」
 * 完全由工具定义决定，本文件不出现任何具体工具 id：
 * 可用的（`availability === "enabled"`）+ 在「更多」里的（`default_slot === "more"`）
 * + 直接执行的（`form === "direct"`）+ 带计价规则的（`pricing !== null`）。
 *
 * 一次请求报完整批（GN-01 的 `POST /api/pricing/quote` 支持 1~20 条），而不是每个工具
 * 各发一次 —— 菜单一打开就打二十个请求，用户看到的就是二十个「估算中」慢慢变成价格。
 *
 * 三种状态对应菜单上的三种标价（`priceStateFromQuote` 负责映射，这里不解读价格）：
 * - 请求在飞：每个 id 都是 `estimating`（ED-00l：没返回时显示「估算中」，不能留空）
 * - 成功：第 i 条结果喂给第 i 个 id（响应与请求同序，见 GN-01 契约）
 * - 失败：整批都是 `error`（ED-00c：「价格获取失败，点击重试」）
 */

/**
 * 单次询价的条数上限（GN-01 裁决 1：`items` 1~20）。
 *
 * 超过 20 个可询价工具时只问前 20 个：超限请求会被服务端整单 400，那样一个价格都拿不到；
 * 截断只会让第 21 个之后的菜单项停在「估算中」，而工具定义表离 20 个还有距离。
 */
export const MAX_TOOL_QUOTE_ITEMS = 20;

/** 要询价的工具 id（顺序即请求顺序，响应按同序回来）。 */
function quotedToolIds(tools: readonly ToolDefinition[]): string[] {
  return tools
    .filter(
      (tool) =>
        tool.availability === "enabled" &&
        tool.default_slot === "more" &&
        tool.form === "direct" &&
        tool.pricing !== null,
    )
    .map((tool) => tool.id)
    .slice(0, MAX_TOOL_QUOTE_ITEMS);
}

/** 请求还没回来时，每个 id 都只能是「估算中」。 */
function everyId(ids: readonly string[], state: PriceState): Record<string, PriceState> {
  const next: Record<string, PriceState> = {};
  for (const id of ids) next[id] = state;
  return next;
}

/**
 * ED-00f: quote every enabled direct-execute tool in the more menu once per token, keyed by tool id.
 *
 * 依赖只有 token 与工具 id 列表（拼成字符串比较，数组每次渲染都是新对象，
 * 直接放进依赖会让 effect 每帧重跑）。卸载后迟到的响应直接丢弃，不再 setState。
 */
export function useToolPrices(
  accessToken: string | null | undefined,
  tools: readonly ToolDefinition[],
): Readonly<Record<string, PriceState>> {
  /**
   * 工具 id 拼成一串：它是 token 之外唯一的依赖。
   * 用 `,` 分隔（工具 id 的字符集是 `[a-z0-9_]`，不含逗号，见 `toolDefinitionSchema`）。
   */
  const idsKey = useMemo(() => quotedToolIds(tools).join(","), [tools]);

  const [prices, setPrices] = useState<Readonly<Record<string, PriceState>>>({});

  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split(",");

    // 没登录 / 没有要询价的工具：不请求，也不残留上一个 token 的价格。
    if (!accessToken || ids.length === 0) {
      setPrices({});
      return;
    }

    let cancelled = false;
    setPrices(everyId(ids, { status: "estimating" }));

    fetchPriceQuote(accessToken, {
      items: ids.map((id) => ({ kind: "tool" as const, tool_id: id })),
    }).then(
      (response) => {
        if (cancelled) return;
        const next: Record<string, PriceState> = {};
        for (let index = 0; index < ids.length; index += 1) {
          const id = ids[index];
          if (id === undefined) continue;
          // 响应与请求同序（GN-01 契约）；缺条目时 `priceStateFromQuote` 给「估算中」。
          next[id] = priceStateFromQuote(response.items[index]);
        }
        setPrices(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.error("[tool-prices] quote failed:", error);
        setPrices(everyId(ids, { status: "error" }));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accessToken, idsKey]);

  return prices;
}
