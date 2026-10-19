import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type PriceState,
  type PriceVariant,
  formatPrice,
  isPriceClickable,
} from "../src/lib/price-display";

/**
 * BL-14 前端 · 价格展示五态（ED-00l 口径）
 *
 * 验收对应的三件事：
 *   1) 5 状态 × 3 variant 的文案逐条钉死；
 *   2) 「待定价可点、估算中不可点、获取失败走重试」；
 *   3) 前端不算价 —— 非法 amount 抛错 + 源码里除 0 外没有数字字面量。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

/** 五种状态各一份样本。`12` 只是占位，代表「询价返回了 N」；本仓不许写死真实价格。 */
const ESTIMATING: PriceState = { status: "estimating" };
const PRICED: PriceState = { status: "priced", amount: 12 };
const FREE: PriceState = { status: "free" };
const PENDING: PriceState = { status: "pending" };
const ERROR: PriceState = { status: "error" };

const VARIANTS: PriceVariant[] = ["button", "badge", "plain"];

type FormatCase = {
  status: string;
  state: PriceState;
  variant: PriceVariant;
  expected: string;
};

const FORMAT_CASES: FormatCase[] = [
  // button：「生成 · N」/「生成 · 待定价」/「生成 · 免费」/「生成 · 估算中」（BL-14 §3）
  { status: "estimating", state: ESTIMATING, variant: "button", expected: "生成 · 估算中" },
  { status: "priced", state: PRICED, variant: "button", expected: "生成 · 12" },
  { status: "free", state: FREE, variant: "button", expected: "生成 · 免费" },
  { status: "pending", state: PENDING, variant: "button", expected: "生成 · 待定价" },
  { status: "error", state: ERROR, variant: "button", expected: "价格获取失败，点击重试" },
  // badge：「⚡N」/「⚡待定价」/「免费」/「估算中」（ED-00f）
  { status: "estimating", state: ESTIMATING, variant: "badge", expected: "估算中" },
  { status: "priced", state: PRICED, variant: "badge", expected: "⚡12" },
  { status: "free", state: FREE, variant: "badge", expected: "免费" },
  { status: "pending", state: PENDING, variant: "badge", expected: "⚡待定价" },
  { status: "error", state: ERROR, variant: "badge", expected: "价格获取失败，点击重试" },
  // plain：「N」/「待定价」/「免费」/「估算中」
  { status: "estimating", state: ESTIMATING, variant: "plain", expected: "估算中" },
  { status: "priced", state: PRICED, variant: "plain", expected: "12" },
  { status: "free", state: FREE, variant: "plain", expected: "免费" },
  { status: "pending", state: PENDING, variant: "plain", expected: "待定价" },
  { status: "error", state: ERROR, variant: "plain", expected: "价格获取失败，点击重试" },
];

describe("formatPrice：5 状态 × 3 variant", () => {
  it.each(FORMAT_CASES)("$status 的 $variant 文案是「$expected」", ({ state, variant, expected }) => {
    expect(formatPrice(state, variant)).toBe(expected);
  });

  it("variant 只换前缀，正文一致：三种 variant 的同样状态都包含同一段正文", () => {
    for (const variant of VARIANTS) {
      expect(formatPrice(ESTIMATING, variant)).toContain("估算中");
      expect(formatPrice(PENDING, variant)).toContain("待定价");
      expect(formatPrice(FREE, variant)).toContain("免费");
      expect(formatPrice(ERROR, variant)).toContain("价格获取失败，点击重试");
    }
  });

  it("错误文案三种 variant 完全一样（ED-00c）", () => {
    const texts = VARIANTS.map((variant) => formatPrice(ERROR, variant));
    expect(texts).toEqual([
      "价格获取失败，点击重试",
      "价格获取失败，点击重试",
      "价格获取失败，点击重试",
    ]);
  });

  it("unit 只是留字段：本单不实现 GN-08 的单位格式，文案与不带 unit 时一致", () => {
    const withUnit: PriceState = { status: "priced", amount: 12, unit: "秒" };
    for (const variant of VARIANTS) {
      expect(formatPrice(withUnit, variant)).toBe(formatPrice(PRICED, variant));
    }
  });

  it("金额原样输出：不做四舍五入、不做换算（含 0）", () => {
    expect(formatPrice({ status: "priced", amount: 0 }, "plain")).toBe("0");
    expect(formatPrice({ status: "priced", amount: 7 }, "button")).toBe("生成 · 7");
    expect(formatPrice({ status: "priced", amount: 123456 }, "badge")).toBe("⚡123456");
  });
});

describe("isPriceClickable（BL-14 §3 + ED-00c）", () => {
  it.each<{ status: string; state: PriceState; clickable: boolean }>([
    { status: "pending", state: PENDING, clickable: true },
    { status: "priced", state: PRICED, clickable: true },
    { status: "free", state: FREE, clickable: true },
    { status: "estimating", state: ESTIMATING, clickable: false },
    { status: "error", state: ERROR, clickable: false },
  ])("$status 可点 = $clickable", ({ state, clickable }) => {
    expect(isPriceClickable(state)).toBe(clickable);
  });

  it("待定价可点（BL-14 §3 明写「可以点」）", () => {
    expect(isPriceClickable({ status: "pending" })).toBe(true);
  });

  it("估算中不可点（价格没回来就不该让用户点）", () => {
    expect(isPriceClickable({ status: "estimating" })).toBe(false);
  });

  it("获取失败不可点，走重试（ED-00c）", () => {
    expect(isPriceClickable({ status: "error" })).toBe(false);
  });
});

describe("非法 amount 一律抛错（前端不算价，BL-14 验收 1）", () => {
  it.each<{ label: string; amount: number }>([
    { label: "负数", amount: -1 },
    { label: "小数", amount: 1.5 },
    { label: "NaN", amount: Number.NaN },
    { label: "Infinity", amount: Number.POSITIVE_INFINITY },
  ])("$label 的 amount 会抛错", ({ amount }) => {
    const state: PriceState = { status: "priced", amount };
    expect(() => formatPrice(state, "plain")).toThrow();
    expect(() => isPriceClickable(state)).toThrow();
  });

  it("非整数的负数 / 小数同时出现在 button 与 badge 也抛错", () => {
    expect(() => formatPrice({ status: "priced", amount: -3 }, "button")).toThrow();
    expect(() => formatPrice({ status: "priced", amount: 0.5 }, "badge")).toThrow();
  });
});

describe("ED-00l 验收：估算中不是空串", () => {
  it("三种 variant 的「估算中」都有字，且不是只有尺寸没有价格", () => {
    for (const variant of VARIANTS) {
      const text = formatPrice({ status: "estimating" }, variant);
      expect(text.length).toBeGreaterThan(0);
      expect(text.trim()).not.toBe("");
      expect(text).toContain("估算中");
    }
  });
});

/** 去掉注释再扫数字：注释里写规格出处（BL-14 / ED-00l）不算价格常量。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * 价格常量守卫（BL-14 验收 1 的前端部分）：
 * `price-display.ts` 与 `price-tag.tsx` 的源码里不许出现除 0 以外的数字字面量。
 * 允许 0 是因为 `amount < 0` 这种边界比较必须写出来。
 */
const GUARDED_FILES = ["src/lib/price-display.ts", "src/components/ui/price-tag.tsx"];

describe("BL-14 验收 1 前端部分：价格展示代码里没有价格常量", () => {
  it.each(GUARDED_FILES)("%s 里除 0 以外没有数字字面量", (relativePath) => {
    const source = fs.readFileSync(path.join(WEB_ROOT, relativePath), "utf8");
    const digits = stripComments(source).match(/\d+/g) ?? [];
    const offenders = digits.filter((value) => value !== "0");
    expect(offenders, `${relativePath} 里出现数字字面量：${offenders.join("、")}`).toEqual([]);
  });

  it("守卫本身有效：伪造的源码里出现 9 会被检出", () => {
    const fake = ['export function f() {', "  return 9;", "}"].join("\n");
    const offenders = (stripComments(fake).match(/\d+/g) ?? []).filter((value) => value !== "0");
    expect(offenders).toEqual(["9"]);
  });
});
