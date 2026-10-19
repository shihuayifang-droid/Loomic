import { describe, expect, it } from "vitest";

import { type ToolDefinition, toolListResponseSchema } from "@loomic/shared";

import {
  ED_00K_CLAIMED_TOOL_COUNT,
  TOOL_DEFINITIONS,
} from "./tool-definitions.js";

/**
 * ED-00k's static tool table (workorder 21AB).
 *
 * The table is configuration, so what has to be pinned is not behaviour but the
 * SHAPE and the SPEC REFERENCES: the count, the order, the slots, who is
 * enabled, who is billable, who an Agent may call, and which ETAs came from the
 * spec. Everything asserted here is quoted from the ED sections — a change to
 * any of it must be a deliberate change to both the table and this file.
 *
 * The last three cases are the negative half: a table that breaks the contract
 * must be REJECTED, otherwise the load-time self-check in `tool-definitions.ts`
 * could pass on a broken table and the whole file would be decoration.
 */

const ED_ORDER = [
  "adjust", // ED-01
  "crop", // ED-02
  "flip_rotate", // ED-03
  "mockup", // ED-04
  "download", // ED-05
  "quick_edit", // ED-06
  "remove_background", // ED-07
  "upscale", // ED-08
  "layer_split_auto", // ED-09
  "layer_split_custom", // ED-10
  "edit_text", // ED-11
  "multi_angle", // ED-12
  "erase", // ED-13
  "expand", // ED-14
  "move_object", // ED-15
  "vectorize", // ED-16
  "motion", // ED-17
];

/**
 * ED-00g's "默认固定 7 个": 放大、去背景、橡皮、图层拆分、编辑文字、多角度、
 * 动态图片. 「图层拆分」 is ONE toolbar button that ED-09 and ED-10 fill with two
 * entries, so the seven names expand to eight rows here.
 */
const ED_00G_DEFAULT_PINNED = [
  "upscale",
  "remove_background",
  "erase",
  "layer_split_auto",
  "layer_split_custom",
  "edit_text",
  "multi_angle",
  "motion",
];

/** ED-00f's default "more" menu: 移动对象 · 扩展 · 调整 · 裁剪 · 矢量 · 翻转与旋转. */
const ED_00F_DEFAULT_MORE = [
  "move_object",
  "expand",
  "adjust",
  "crop",
  "vectorize",
  "flip_rotate",
];

/** ED-00k / Kiro's ruling: exactly these five are usable today. */
const ENABLED = ["adjust", "crop", "flip_rotate", "download", "quick_edit"];

/** ED-00g: 快捷编辑和下载固定不可移除. */
const NOT_REMOVABLE = ["quick_edit", "download"];

/**
 * SK-13: "为真则注册成 Agent 工具：去背景、放大、图层拆分、多角度、编辑文字等；
 * 橡皮为 false". 「图层拆分」 is again ED-09 + ED-10.
 */
const AGENT_CALLABLE = [
  "remove_background",
  "upscale",
  "layer_split_auto",
  "layer_split_custom",
  "edit_text",
  "multi_angle",
];

/** ETAs the spec states as a number (Lovart's measurements); nothing else has one. */
const STATED_ETA_SECONDS: Record<string, number> = {
  upscale: 30, // ED-00k example row + ED-08 (约 30 秒)
  remove_background: 12, // ED-07 (Lovart 约 12 秒)
  layer_split_auto: 9, // ED-09 (耗时约 9 秒)
  erase: 15, // ED-13 (面板显示「约 15 秒」)
};

function ids(where: (tool: ToolDefinition) => boolean): string[] {
  return TOOL_DEFINITIONS.filter(where)
    .map((tool) => tool.id)
    .sort((left, right) => left.localeCompare(right));
}

function byId(id: string): ToolDefinition {
  const found = TOOL_DEFINITIONS.find((tool) => tool.id === id);

  if (!found) {
    throw new Error(`the tool table has no ${id}`);
  }

  return found;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe("ED-00k tool table: the wire contract", () => {
  it("case 1: the table satisfies toolListResponseSchema", () => {
    const parsed = toolListResponseSchema.parse({ tools: TOOL_DEFINITIONS });

    expect(parsed.tools).toHaveLength(TOOL_DEFINITIONS.length);
    // Nothing is dropped or coerced on the way through the schema: the payload
    // the route sends is the table itself.
    expect(parsed.tools).toEqual(TOOL_DEFINITIONS);
  });

  it("case 2: there are 17 tools — ED-00k's prose says 18, the sections say 17", () => {
    // ED-00k's prose ("18 项工具") predates the D-4 ruling that dropped 评论
    // (ED-18); ED-01..ED-17 are the tools, ED-11a..d are sub-tasks of ED-11.
    expect(ED_00K_CLAIMED_TOOL_COUNT).toBe(18);
    expect(TOOL_DEFINITIONS).toHaveLength(17);
    expect(ED_00K_CLAIMED_TOOL_COUNT - TOOL_DEFINITIONS.length).toBe(1);
  });

  it("case 3: the rows are in ED number order", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.id)).toEqual(ED_ORDER);
  });
});

describe("ED-00k tool table: identifiers", () => {
  it("case 4: every id is unique", () => {
    const seen = new Set(TOOL_DEFINITIONS.map((tool) => tool.id));

    expect(seen.size).toBe(TOOL_DEFINITIONS.length);
  });

  it("case 5: every testid is image-toolbar-{id with _ replaced by -}", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.testid).toBe(`image-toolbar-${tool.id.replaceAll("_", "-")}`);
    }
  });
});

describe("ED-00k tool table: the spec's rulings", () => {
  it("case 6: exactly the five ruled tools are enabled, and everything else ships unavailable", () => {
    expect(ids((tool) => tool.availability === "enabled")).toEqual(sorted(ENABLED));
    // 去背景 is P0 but still unavailable: the capability gap T-ED4 is open.
    expect(byId("remove_background").availability).toBe("unavailable");
    expect(ids((tool) => tool.availability === "unavailable")).toHaveLength(
      TOOL_DEFINITIONS.length - ENABLED.length,
    );
  });

  it("case 7: 快捷编辑 and 下载 are the only non-removable tools", () => {
    expect(ids((tool) => !tool.removable)).toEqual(sorted(NOT_REMOVABLE));
  });

  it("case 8: the default toolbar row is ED-00g's seven plus 快捷编辑 and 下载", () => {
    expect(ids((tool) => tool.default_slot === "main")).toEqual(
      sorted([...ED_00G_DEFAULT_PINNED, ...NOT_REMOVABLE]),
    );
  });

  it("case 9: the default 'more' menu is ED-00f's six, with Mockup as the one extra row", () => {
    // ED-00f lists 移动对象 · 扩展 · 调整 · 裁剪 · 矢量 · 翻转与旋转 and adds that
    // Mockup is not in the menu in phase one (ED-04 is unscheduled). Mockup is
    // therefore excluded from the comparison by the workorder, and it is the
    // ONLY row besides those six — asserted here so the gap is visible rather
    // than invisible. `default_slot` has no third value; with availability
    // "unavailable" the row is never rendered either way.
    const more = ids((tool) => tool.default_slot === "more");

    expect(more.filter((id) => id !== "mockup")).toEqual(sorted(ED_00F_DEFAULT_MORE));
    expect(more).toContain("mockup");
    expect(more).toHaveLength(ED_00F_DEFAULT_MORE.length + 1);
    // Together the two slots partition the table: no tool may be in both.
    expect(more).toHaveLength(
      TOOL_DEFINITIONS.length - ids((tool) => tool.default_slot === "main").length,
    );
  });

  it("case 10: consumes and pricing agree on every row", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect([tool.id, tool.consumes]).toEqual([tool.id, tool.pricing !== null]);
    }
  });

  it("case 11: every paying tool quotes under its own id, and the stated tier lists are kept", () => {
    // ED-00k's example row is `{generator: upscale, tiers: [2k,4k,8k]}` with
    // id `upscale`: the generator IS the tool id, which is what makes one row
    // enough to ask ED-00c for a price.
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.pricing === null) continue;

      expect(tool.pricing.generator).toBe(tool.id);
    }

    expect(byId("upscale").pricing?.tiers).toEqual(["2k", "4k", "8k"]);
    // ED-11: ≤1024 → 1K, ≤2048 → 2K, otherwise 4K.
    expect(byId("edit_text").pricing?.tiers).toEqual(["1k", "2k", "4k"]);
    // No other section enumerates price tiers, so no other row may invent one.
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.id === "upscale" || tool.id === "edit_text") continue;

      expect([tool.id, tool.pricing?.tiers ?? []]).toEqual([tool.id, []]);
    }
  });

  it("case 12: only SK-13's tools are Agent-callable, and 橡皮 is explicitly not", () => {
    expect(ids((tool) => tool.agent_callable)).toEqual(sorted(AGENT_CALLABLE));
    // ED-13: an Agent cannot draw a mask (list L594).
    expect(byId("erase").agent_callable).toBe(false);
  });

  it("case 13: only the four ETAs the spec states as numbers are filled in", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const stated = STATED_ETA_SECONDS[tool.id];

      expect([tool.id, tool.eta_seconds]).toEqual([tool.id, stated ?? null]);
    }
  });
});

describe("ED-00k tool table: a broken table is rejected", () => {
  it("case 14: two rows with the same id are rejected", () => {
    const duplicated = [byId("upscale"), { ...byId("upscale") }];

    expect(() => toolListResponseSchema.parse({ tools: duplicated })).toThrow(
      /duplicate tool id upscale/,
    );
  });

  it("case 15: a paying tool without pricing is rejected", () => {
    const unpriced: ToolDefinition = { ...byId("upscale"), pricing: null };

    expect(() => toolListResponseSchema.parse({ tools: [unpriced] })).toThrow(
      /consumes credits but has no pricing/,
    );
  });

  it("case 16: a free tool carrying pricing is rejected", () => {
    const mispriced: ToolDefinition = {
      ...byId("adjust"),
      pricing: { generator: "adjust", tiers: [] },
    };

    expect(() => toolListResponseSchema.parse({ tools: [mispriced] })).toThrow(
      /does not consume credits but carries pricing/,
    );
  });
});
