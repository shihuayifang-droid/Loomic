import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@loomic/shared";

import { applyToolbarConfig, fitToolbar } from "../src/lib/toolbar-config";
import type { ToolbarConfig } from "../src/lib/toolbar-config";

/**
 * 工单 30N T1 · ED-00g 的两个纯函数。
 *
 * 夹具只写关心的字段，其余按 21AB `toolDefinitionSchema` 的最小合法值补齐 ——
 * 这样定义表加字段时这里会因为 `ToolDefinition` 少字段而 typecheck 报错，
 * 而不是静默拿一份过期的假数据继续跑（与 30F 的 `image-toolbar.test.tsx` 同一口径）。
 */
function tool(id: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const base: ToolDefinition = {
    id,
    label: id,
    icon: id,
    testid: `image-toolbar-${id.replace(/_/g, "-")}`,
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  };
  return Object.assign(base, overrides);
}

/**
 * 一张缩到最小的定义表：两个不可移除（快捷编辑 / 下载）+ 三个可移除 + 一个
 * 「不可移除但默认在 more」的边界工具（21AB 的真实表里没有这一行，规则要求它保持原样，
 * 所以必须造一条出来测，否则「保持原 default_slot」只验证了 main 那一半）。
 */
function toolDefinitions(): ToolDefinition[] {
  return [
    tool("quick_edit", { label: "快捷编辑", default_slot: "main", removable: false }),
    tool("download", { label: "下载", default_slot: "main", removable: false }),
    tool("adjust", { label: "调整", default_slot: "more" }),
    tool("crop", { label: "裁剪", default_slot: "more" }),
    tool("flip_rotate", { label: "翻转与旋转", default_slot: "more" }),
    tool("pinned_more", { label: "默认在更多但不可移除", default_slot: "more", removable: false }),
  ];
}

function config(pinned: string[], showLabels = false): ToolbarConfig {
  return { pinned, show_labels: showLabels };
}

/** id → default_slot，用来一次性断言整张表被改写成了什么。 */
function slotsById(tools: readonly ToolDefinition[]): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const tool of tools) slots[tool.id] = tool.default_slot;
  return slots;
}

describe("applyToolbarConfig（ED-00g 裁决 3）", () => {
  it("pinned 决定 main 或 more：在 pinned 里进 main，不在的进 more", () => {
    const result = applyToolbarConfig(toolDefinitions(), config(["crop", "flip_rotate"]));

    expect(slotsById(result)).toEqual({
      quick_edit: "main",
      download: "main",
      // 可移除、未 pinned → more
      adjust: "more",
      // 可移除、pinned → main
      crop: "main",
      flip_rotate: "main",
      // 不可移除 → 保持原 slot
      pinned_more: "more",
    });
  });

  it("main 区的顺序按 pinned 数组的顺序（不是 defined 顺序）", () => {
    const result = applyToolbarConfig(toolDefinitions(), config(["flip_rotate", "crop", "adjust"]));

    // 返回数组的前半段就是 pinned 依次对应的工具 —— ImageToolbar 按数组顺序渲染编辑动作组，
    // 所以它那边的过滤逻辑一行都不用改，顺序自然跟着 pinned。
    expect(result.slice(0, 3).map((tool) => tool.id)).toEqual([
      "flip_rotate",
      "crop",
      "adjust",
    ]);
    // 换个顺序写 pinned，main 区就跟着换（证明是 pinned 决定顺序，不是 id 的字母序）。
    const swapped = applyToolbarConfig(toolDefinitions(), config(["adjust", "crop", "flip_rotate"]));
    expect(swapped.slice(0, 3).map((tool) => tool.id)).toEqual([
      "adjust",
      "crop",
      "flip_rotate",
    ]);
  });

  it("不可移除的工具不受影响：pinned 里写它的 id 也不会把它从原 slot 挪走", () => {
    const result = applyToolbarConfig(
      toolDefinitions(),
      // 两个不可移除工具一个原本在 main、一个原本在 more，都塞进 pinned
      config(["pinned_more", "quick_edit", "crop"]),
    );

    expect(slotsById(result)).toMatchObject({ quick_edit: "main", pinned_more: "more" });
    // pinned 块里只有 crop：未知 id 与不可移除 id 都被丢弃（裁决 3 第三条）
    expect(result.slice(0, 1).map((tool) => tool.id)).toEqual(["crop"]);
    expect(result.filter((tool) => tool.default_slot === "main")).toHaveLength(3);
  });

  it("未知 id 与不可移除工具的 id 被丢弃，不抛错也不改变结果条数", () => {
    const definitions = toolDefinitions();
    const result = applyToolbarConfig(definitions, config(["nope", "quick_edit", "download", "crop"]));

    expect(result).toHaveLength(definitions.length);
    expect(result.filter((tool) => tool.id === "crop")[0]?.default_slot).toBe("main");
    // 一个可移除工具都没 pinned 时，所有可移除工具都在 more
    const empty = applyToolbarConfig(definitions, config(["nope"]));
    expect(
      empty.filter((tool) => tool.removable && tool.default_slot === "main"),
    ).toHaveLength(0);
  });

  it("不修改入参：定义数组、数组里的对象、config.pinned 都原样", () => {
    const definitions = toolDefinitions();
    const before = JSON.stringify(definitions);
    const userConfig = config(["crop"]);
    const pinnedBefore = [...userConfig.pinned];

    const result = applyToolbarConfig(definitions, userConfig);

    expect(JSON.stringify(definitions)).toBe(before);
    expect(userConfig.pinned).toEqual(pinnedBefore);
    // 返回的是新数组 + 新对象，改结果不会回写到入参
    expect(result).not.toBe(definitions);
    expect(result[0]).not.toBe(definitions[0]);
    expect(result.map((tool) => tool.id)).not.toBe(definitions.map((tool) => tool.id));
    result[0]!.label = "改过";
    expect(definitions.find((tool) => tool.id === "crop")?.label).toBe("裁剪");
  });
});

describe("fitToolbar（ED-00g 裁决 5 / 规格验收 3 的纯函数半边）", () => {
  const GEOMETRY = { gap: 4, paddingX: 6 } as const;

  it("放得下时 visibleCount 等于总数（此时没有「更多」，间隙是 n−1 个）", () => {
    // 2×6 + 3×88 + 2×4 = 284 ≤ 1000
    expect(
      fitToolbar({ itemWidths: [88, 88, 88], moreWidth: 32, maxWidth: 1000, ...GEOMETRY }),
    ).toEqual({ visibleCount: 3 });
  });

  it("放不下时从末尾开始挤出，并把「更多」按钮的宽度算进去", () => {
    // 4×88：全放 2×6 + 352 + 3×4 = 376。
    // maxWidth 300 时放不下 → k 项 + 更多：2×6 + 88k + 32 + 4k = 44 + 92k
    //   k=3 → 320 > 300（不放「更多」的话 3 项只要 284，但溢出就得多一个按钮）
    //   k=2 → 228 ≤ 300  → visibleCount = 2
    expect(
      fitToolbar({
        itemWidths: [88, 88, 88, 88],
        moreWidth: 32,
        maxWidth: 300,
        ...GEOMETRY,
      }),
    ).toEqual({ visibleCount: 2 });
  });

  it("「更多」更宽时可见项更少（moreWidth 确实参与计算）", () => {
    const widths = Array.from({ length: 14 }, () => 88);
    // 同一条工具条、同一份宽度，只把「更多」从 32 加到 120：
    //   32  → 44 + 92k ≤ 1232 → k = 12
    //   120 → 132 + 92k ≤ 1232 → k = 11
    expect(
      fitToolbar({ itemWidths: widths, moreWidth: 32, maxWidth: 1232, ...GEOMETRY }),
    ).toEqual({ visibleCount: 12 });
    expect(
      fitToolbar({ itemWidths: widths, moreWidth: 120, maxWidth: 1232, ...GEOMETRY }),
    ).toEqual({ visibleCount: 11 });
  });

  it("边界值恰好相等时算放得下（判据是 <= 不是 <）", () => {
    // 2×6 + 2×100 + 1×4 = 216
    expect(
      fitToolbar({ itemWidths: [100, 100], moreWidth: 30, maxWidth: 216, ...GEOMETRY }),
    ).toEqual({ visibleCount: 2 });
    // 少 1px 就溢出 → 走「k 项 + 更多」那一支：2×6 + 100 + 30 + 4 = 146 ≤ 215 → 1
    expect(
      fitToolbar({ itemWidths: [100, 100], moreWidth: 30, maxWidth: 215, ...GEOMETRY }),
    ).toEqual({ visibleCount: 1 });
  });

  it("验收 3 的数值版：14 项 / 每项 88 / gap 4 / paddingX 6 / 更多 32 / maxWidth 1232", () => {
    /**
     * 手算（算式与回传里贴的是同一份）：
     *
     *   全部可见   = 2×6 + 14×88 + 13×4 = 12 + 1232 + 52 = 1296 > 1232  → 溢出
     *   可见 k 项 + 「更多」 = 2×6 + 88k + 32 + 4k = 44 + 92k ≤ 1232
     *     k = 13 → 44 + 1196 = 1240 > 1232 ✗
     *     k = 12 → 44 + 1104 = 1148 ≤ 1232 ✓
     *   → visibleCount = 12，末尾 2 项进「更多」
     *
     * 顺带钉住「更多」的宽度真的算了：13 项**不带**「更多」只要 12 + 1144 + 48 = 1204 ≤ 1232，
     * 但溢出必须多出那一个 32 宽（且不多一个 88 的槽位），所以只能显示 12 项。
     */
    const itemWidths = Array.from({ length: 14 }, () => 88);
    expect(
      fitToolbar({ itemWidths, moreWidth: 32, maxWidth: 1232, ...GEOMETRY }),
    ).toEqual({ visibleCount: 12 });

    // 同样是 88 宽、同样的间隙，13 项时全部放得下（不需要「更多」）→ 13，不进溢出分支。
    const thirteen = Array.from({ length: 13 }, () => 88);
    expect(
      fitToolbar({ itemWidths: thirteen, moreWidth: 32, maxWidth: 1232, ...GEOMETRY }),
    ).toEqual({ visibleCount: 13 });
  });

  it("空工具条 / 一项都放不下：都返回 0（不返回负数）", () => {
    expect(
      fitToolbar({ itemWidths: [], moreWidth: 32, maxWidth: 1232, ...GEOMETRY }),
    ).toEqual({ visibleCount: 0 });
    // 一项 100：全放 12 + 100 = 112 > 20；连「更多」都放不下 12 + 32 = 44 > 20
    expect(
      fitToolbar({ itemWidths: [100], moreWidth: 32, maxWidth: 20, ...GEOMETRY }),
    ).toEqual({ visibleCount: 0 });
  });

  it("宽度不一时丢的是末尾那几项，不是最宽的那项", () => {
    // [10, 10, 200]：maxWidth 120 时 k=2（2×6 + 20 + 32 + 2×4 = 72 ≤ 120），末尾的 200 被挤进「更多」
    expect(
      fitToolbar({ itemWidths: [10, 10, 200], moreWidth: 32, maxWidth: 120, ...GEOMETRY }),
    ).toEqual({ visibleCount: 2 });
  });
});
