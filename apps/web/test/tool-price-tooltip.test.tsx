import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@loomic/shared";

import type { PriceState } from "../src/lib/price-display";
import { toolPriceTooltip } from "../src/lib/tool-price-tooltip";

/**
 * 工单 36M T4 · ED-00c「hover 工具图标时 tooltip 显示价格或区间」。
 *
 * 纯函数用例：夹具自造（不 import 后端定义表），价格一律从 `PriceState` 进、字符串出。
 * 数字只来自询价 —— 这里断言的就是「给什么状态、出什么文案」，不验算价格。
 */

/** 一份工具定义：只写本例关心的字段，其余照 `toolDefinitionSchema` 的默认形态。 */
function makeTool(
  overrides: Partial<ToolDefinition> & { id: string; label: string },
): ToolDefinition {
  return {
    icon: overrides.id,
    testid: `image-toolbar-${overrides.id.replace(/_/g, "-")}`,
    form: "direct",
    default_slot: "more",
    removable: true,
    consumes: true,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
    ...overrides,
  };
}

/** ED-00a 的定义表里放大就是三档：`2k` / `4k` / `8k`。 */
const UPSCALE = makeTool({
  id: "upscale",
  label: "放大",
  default_slot: "main",
  pricing: { generator: "upscale", tiers: ["2k", "4k", "8k"] },
});

/** 没有档位的付费工具：`tiers: ["*"]` = 只问默认行，结果 key 就是 toolId。 */
const VECTORIZE = makeTool({
  id: "vectorize",
  label: "矢量",
  pricing: { generator: "vectorize", tiers: ["*"] },
});

const priced = (amount: number): PriceState => ({ status: "priced", amount });

describe("toolPriceTooltip（ED-00c 价格行）", () => {
  it("ED-00c: a tiered tool lists every tier", () => {
    expect(
      toolPriceTooltip(UPSCALE, {
        "upscale:2k": priced(12),
        "upscale:4k": priced(24),
        "upscale:8k": priced(48),
      }),
    ).toBe("放大：2K 12 · 4K 24 · 8K 48");
  });

  it("ED-00c: an untiered tool shows one price", () => {
    // `*` 不是真实档位：文案里不出现档位名，只有一个数字，key 就是 toolId。
    expect(toolPriceTooltip(VECTORIZE, { vectorize: priced(5) })).toBe("矢量：5");
  });

  it("ED-00c: a tier still being quoted says so", () => {
    const text = toolPriceTooltip(UPSCALE, {
      "upscale:2k": priced(12),
      "upscale:4k": { status: "estimating" },
      "upscale:8k": priced(48),
    });

    expect(text).toContain("4K 估算中");
    // 缺失的条目同样只能是「估算中」（ED-00l：没返回时不能留空）。
    expect(toolPriceTooltip(UPSCALE, {})).toBe("放大：2K 估算中 · 4K 估算中 · 8K 估算中");
  });

  it("ED-00c: a failed quote invites a retry", () => {
    const ok = {
      "upscale:2k": priced(12),
      "upscale:4k": priced(24),
      "upscale:8k": priced(48),
    };
    // 任一档失败 = 整句重试文案（ED-00c 前端要点），不是局部「这一档失败」。
    for (const tier of ["2k", "4k", "8k"]) {
      expect(
        toolPriceTooltip(UPSCALE, { ...ok, [`upscale:${tier}`]: { status: "error" } }),
      ).toBe("价格获取失败，点击重试");
    }
  });

  it("ED-00c: free tools carry no price line", () => {
    const crop = makeTool({ id: "crop", label: "裁剪", consumes: false, form: "panel" });

    expect(toolPriceTooltip(crop, {})).toBeNull();
    // 传了别的价格也不会凭空冒出一行。
    expect(toolPriceTooltip(crop, { crop: priced(9) })).toBeNull();
  });

  it("ED-00c: unpriced tiers say 待定价", () => {
    const layerSplit = makeTool({
      id: "layer_split",
      label: "图层拆分",
      pricing: { generator: "layer_split", tiers: ["自动", "自定义"] },
    });

    expect(
      toolPriceTooltip(layerSplit, {
        "layer_split:自动": priced(8),
        "layer_split:自定义": { status: "pending" },
      }),
    ).toBe("图层拆分：自动 8 · 自定义 待定价");
  });
});
