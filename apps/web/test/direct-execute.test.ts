import { describe, expect, it } from "vitest";

import {
  directExecuteBlockReason,
  directExecuteTooltip,
  inFlightKey,
} from "../src/lib/direct-execute";
import { isPriceClickable } from "../src/lib/price-display";
import type { PriceState } from "../src/lib/price-display";

/**
 * ED-00m 前端 · 防护纯函数（工单 30M T1）
 *
 * 裁决 1（不可点的原因）与裁决 2（可点时的 tooltip）都是**表格驱动**的：
 * 工单 §2 的两张表一行一条用例，改口径时改表就够，不用在断言里翻。
 *
 * 判据的关键两条：
 *   - 余额不足的文案**逐字**为 `积分不足：需要 9，当前 8`（全角冒号 + 全角逗号）；
 *   - `available === null`（额度未知，BL-45 未做）**不拦**，交给服务端 402。
 */

const PRICED_9: PriceState = { status: "priced", amount: 9 };

type BlockCase = {
  name: string;
  price: PriceState;
  available: number | null;
  reason: string | null;
};

/** 裁决 1 的表：estimating / error / pending / free 四态 + priced 的三种余额。 */
const BLOCK_CASES: BlockCase[] = [
  // 价格不可见 → 一律不可点（规格第 1 条）
  {
    name: "estimating（额度未知）→ 不可点，原因「价格获取中」",
    price: { status: "estimating" },
    available: null,
    reason: "价格获取中",
  },
  {
    name: "estimating（额度充足也拦：价格还没回来）→ 原因「价格获取中」",
    price: { status: "estimating" },
    available: 1000,
    reason: "价格获取中",
  },
  {
    name: "error（额度未知）→ 不可点，原因「价格获取失败」",
    price: { status: "error" },
    available: null,
    reason: "价格获取失败",
  },
  {
    name: "error（额度充足也拦）→ 原因「价格获取失败」",
    price: { status: "error" },
    available: 1000,
    reason: "价格获取失败",
  },
  // priced：只有「余额已知且不够」才拦
  {
    name: "priced 9 / available 8 → 不可点，原因逐字「积分不足：需要 9，当前 8」",
    price: PRICED_9,
    available: 8,
    reason: "积分不足：需要 9，当前 8",
  },
  {
    name: "priced 9 / available 0 → 不可点，原因「积分不足：需要 9，当前 0」",
    price: PRICED_9,
    available: 0,
    reason: "积分不足：需要 9，当前 0",
  },
  {
    name: "priced 9 / available 9 → 正好够，可点",
    price: PRICED_9,
    available: 9,
    reason: null,
  },
  {
    name: "priced 9 / available 100 → 可点",
    price: PRICED_9,
    available: 100,
    reason: null,
  },
  {
    name: "priced 9 / available null → 不拦（额度未知，服务端 402 兜底）",
    price: PRICED_9,
    available: null,
    reason: null,
  },
  // 待定价与免费都可点
  { name: "pending → 可点", price: { status: "pending" }, available: 0, reason: null },
  { name: "free → 可点", price: { status: "free" }, available: 0, reason: null },
  { name: "free / available null → 可点", price: { status: "free" }, available: null, reason: null },
];

describe("directExecuteBlockReason：裁决 1 的表格", () => {
  it.each(BLOCK_CASES)("$name", ({ price, available, reason }) => {
    expect(directExecuteBlockReason({ price, available })).toBe(reason);
  });

  it("余额不足的文案逐字一致（全角冒号与全角逗号，不能是半角）", () => {
    const reason = directExecuteBlockReason({ price: PRICED_9, available: 8 });
    expect(reason).toBe("积分不足：需要 9，当前 8");
    // 行内编码：U+FF1A 全角冒号、U+FF0C 全角逗号
    expect(reason).toContain("：");
    expect(reason).toContain("，");
    expect(reason).not.toContain(":");
    expect(reason).not.toContain(",");
  });

  it("优先级：estimating / error 先于余额判断 —— 价格不可见时原因与余额无关", () => {
    const poor = 0;
    const rich = 10_000;
    expect(directExecuteBlockReason({ price: { status: "estimating" }, available: poor })).toBe(
      directExecuteBlockReason({ price: { status: "estimating" }, available: rich }),
    );
    expect(directExecuteBlockReason({ price: { status: "error" }, available: poor })).toBe(
      directExecuteBlockReason({ price: { status: "error" }, available: rich }),
    );
  });
});

type TooltipCase = { name: string; price: PriceState; tooltip: string | null };

/** 裁决 2 的表：可点三态各一句，不可点两态为 null。 */
const TOOLTIP_CASES: TooltipCase[] = [
  {
    name: "priced 9 → 「点击即扣 9 分」",
    price: PRICED_9,
    tooltip: "点击即扣 9 分",
  },
  {
    name: "priced 0 → 「点击即扣 0 分」（数字来自询价，不由前端判断）",
    price: { status: "priced", amount: 0 },
    tooltip: "点击即扣 0 分",
  },
  { name: "free → 「免费，点击即执行」", price: { status: "free" }, tooltip: "免费，点击即执行" },
  {
    name: "pending → 「待定价，点击即执行」",
    price: { status: "pending" },
    tooltip: "待定价，点击即执行",
  },
  { name: "estimating → null（不可点，用 reason 当 title）", price: { status: "estimating" }, tooltip: null },
  { name: "error → null（不可点，用 reason 当 title）", price: { status: "error" }, tooltip: null },
];

describe("directExecuteTooltip：裁决 2 的表格", () => {
  it.each(TOOLTIP_CASES)("$name", ({ price, tooltip }) => {
    expect(directExecuteTooltip(price)).toBe(tooltip);
  });

  it("与裁决 1 的前两条对齐：价格本身不可用（estimating / error）时 tooltip 为 null", () => {
    // 注意：tooltip 只看 price，看不到 available —— 余额不足那一档的 tooltip 仍然有字，
    // 但按钮的 title 会先取 reason（见 T3 的 `reason ?? tooltip`），所以用户看到的是原因。
    const allStates: PriceState[] = [
      { status: "estimating" },
      { status: "error" },
      { status: "free" },
      { status: "pending" },
      PRICED_9,
    ];
    for (const price of allStates) {
      const priceUsable = isPriceClickable(price);
      expect(
        directExecuteTooltip(price) === null,
        `${price.status} 的 tooltip 与 price-display 的可点性不一致`,
      ).toBe(!priceUsable);
    }
  });
});

describe("inFlightKey：裁决 3 的锁键", () => {
  it("同一个 (sourceId, toolId) 得到同一个键", () => {
    expect(inFlightKey("img-1", "vectorize")).toBe(inFlightKey("img-1", "vectorize"));
  });

  it("换素材或换工具都换键", () => {
    const base = inFlightKey("img-1", "vectorize");
    expect(inFlightKey("img-2", "vectorize")).not.toBe(base);
    expect(inFlightKey("img-1", "remove-bg")).not.toBe(base);
  });

  it("键里两段都完整保留，不会因为顺序串味而撞", () => {
    expect(inFlightKey("a", "b")).not.toBe(inFlightKey("b", "a"));
    expect(inFlightKey("img-1", "vectorize")).toContain("img-1");
    expect(inFlightKey("img-1", "vectorize")).toContain("vectorize");
  });

  it("工具条与「更多」菜单的两个入口共用同一个键（工单 §2 裁决 3 的前提）", () => {
    // 两个入口的差别在 UI 上，锁键里没有「哪个组件点的」这一维
    const rows = ["vectorize", "remove-bg", "upscale-2x", "split"];
    const keys = rows.map((toolId) => inFlightKey("asset-7", toolId));
    expect(new Set(keys).size).toBe(rows.length);
  });
});
