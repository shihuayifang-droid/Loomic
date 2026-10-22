"use client";

import { useEffect, useState } from "react";

import type { GenerateImageRequest, GenerateVideoRequest } from "@loomic/shared";

import type { PriceState } from "@/lib/price-display";
import { priceStateFromQuote } from "@/lib/price-display";
import { fetchPriceQuote } from "@/lib/server-api";

/**
 * BL-45 / T-109 · 生成器面板提交前的询价与额度预检
 *
 * 面板在「点提交之前」要能回答两个问题：**这次要花多少**（GN-01 询价）和
 * **够不够**（`useCredits().balance` = 三池可用额度）。两件事必须同一口径，
 * 所以放在同一个 hook 里：`price` 只来自询价（BL-14 验收 1：前端不算价），
 * `precheck` 只是把两个数字比一下。
 *
 * 询价是**逐次输入**的：面板上每改一次 prompt / 模型 / 档位，价格都可能变，
 * 所以按 `JSON.stringify(input)` 作依赖键。输入键一变就立刻回到「估算中」，
 * 让人看得出「这个价格不是当前参数的」，而不是让上一个参数的价格继续挂着。
 */

/**
 * 防抖窗口（毫秒）。
 *
 * 面板上打字会连续改动 `input`，逐键询价等于逐键打接口；300ms 是「停手就出价」
 * 的常见取值，也短于用户从打字到点提交的动作时间。
 */
export const GENERATION_QUOTE_DEBOUNCE_MS = 300;

/** 一次询价的输入：与提交路由的两个请求体同构（GN-01 裁决 1）。 */
export type GenerationQuoteInput =
  | { kind: "image_generation"; request: GenerateImageRequest }
  | { kind: "video_generation"; request: GenerateVideoRequest };

/**
 * 提交前的额度预检结果。
 *
 * 只有「已经拿到确定价格」且「知道余额」且「余额不够」才拦（T-109）。估算中 /
 * 出错 / 待定价 / 免费一律放行 —— 拦不住的那几种由服务端（38E）兜底，
 * 前端不该因为「还不知道多少钱」就不让人点。
 */
export type GenerationPrecheck =
  | { ok: true }
  | { ok: false; reason: "insufficient"; required: number; available: number };

/** 请求在飞（或还没有可询价的输入）时唯一的合法状态（ED-00l：不能留空）。 */
const ESTIMATING: PriceState = { status: "estimating" };

/**
 * 询价 + 预检。
 *
 * @param accessToken 没登录就不询价（不发请求）。
 * @param input 本次要提交的参数；`null` = 还不能询价（如 prompt 为空）→ 不发请求。
 * @param available 调用方传 `useCredits().balance`；`null` = 余额未知 → 不拦。
 */
export function useGenerationQuote(
  accessToken: string | null | undefined,
  input: GenerationQuoteInput | null,
  available: number | null,
): { price: PriceState; precheck: GenerationPrecheck } {
  /**
   * 依赖键：`input` 每次渲染都是新对象，直接当依赖会让 effect 每帧重跑；
   * 序列化后同一个输入得到同一个字符串，比较的是「参数有没有变」。
   */
  const inputKey = input === null ? null : JSON.stringify(input);

  const [price, setPrice] = useState<PriceState>(ESTIMATING);

  useEffect(() => {
    // 没登录 / 还不能询价：不发请求，也不残留上一次输入的价格。
    if (!accessToken || inputKey === null) {
      setPrice(ESTIMATING);
      return;
    }

    // 输入一变就先回到「估算中」：防抖窗口里显示的不能是上一个参数的价格。
    setPrice(ESTIMATING);

    let cancelled = false;

    const timer = setTimeout(() => {
      // 用依赖键还原请求体：闭包里不必再捕获 `input`，也就不会引用过期的对象。
      const quotedInput = JSON.parse(inputKey) as GenerationQuoteInput;
      fetchPriceQuote(accessToken, { items: [quotedInput] }).then(
        (response) => {
          // 输入已经变了（本 effect 已卸载）：这份答案属于旧参数，丢弃。
          if (cancelled) return;
          // 响应与请求同序（GN-01 契约），本次只问了一项。
          setPrice(priceStateFromQuote(response.items[0]));
        },
        (error: unknown) => {
          if (cancelled) return;
          console.error("[generation-quote] quote failed:", error);
          setPrice({ status: "error" });
        },
      );
    }, GENERATION_QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accessToken, inputKey]);

  return { price, precheck: precheckOf(price, available) };
}

/** 拿确定的数字比一下；任何一个数字不确定都放行（见 `GenerationPrecheck`）。 */
function precheckOf(price: PriceState, available: number | null): GenerationPrecheck {
  if (price.status !== "priced") return { ok: true };
  if (available === null) return { ok: true };
  if (available >= price.amount) return { ok: true };
  return { ok: false, reason: "insufficient", required: price.amount, available };
}
