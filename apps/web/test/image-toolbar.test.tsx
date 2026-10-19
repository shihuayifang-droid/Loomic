import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ToolDefinition } from "@loomic/shared";

import {
  ImageToolbar,
  TOOLBAR_BUTTON,
  TOOLBAR_HEIGHT,
  tooltipLabel,
} from "../src/components/canvas/image-toolbar";

/**
 * 工单 30F T2 · ED-00 / ED-00a 逐图工具条（纯展示）。
 *
 * 夹具照抄 21AB 的 `TOOL_DEFINITIONS` 行（server 的
 * `src/features/tools/tool-definitions.ts`），**不改字段名也不补默认值**：
 * 这样定义表加字段时，这里 typecheck 会先报错（`ToolDefinition` 是 shared 的类型），
 * 而不是静默拿一份过期的假数据继续跑。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup。
 */
afterEach(() => {
  cleanup();
});

/** 5 个 enabled（adjust / crop / flip_rotate / download / quick_edit）+ 2 个 unavailable。 */
function toolDefinitions(): ToolDefinition[] {
  return [
    {
      id: "adjust",
      label: "调整",
      icon: "adjust",
      testid: "image-toolbar-adjust",
      form: "panel",
      default_slot: "more",
      removable: true,
      consumes: false,
      pricing: null,
      output_kind: "image",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [{ id: "no_adjustment", message: "未做任何调整" }],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    },
    {
      id: "crop",
      label: "裁剪",
      icon: "crop",
      testid: "image-toolbar-crop",
      form: "panel",
      default_slot: "more",
      removable: true,
      consumes: false,
      pricing: null,
      output_kind: "image",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [{ id: "no_crop", message: "未做裁剪" }],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    },
    {
      id: "flip_rotate",
      label: "翻转与旋转",
      icon: "flip_rotate",
      testid: "image-toolbar-flip-rotate",
      form: "subbar",
      default_slot: "more",
      removable: true,
      consumes: false,
      pricing: null,
      output_kind: "none",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    },
    {
      id: "download",
      label: "下载",
      icon: "download",
      testid: "image-toolbar-download",
      form: "direct",
      default_slot: "main",
      removable: false,
      consumes: false,
      pricing: null,
      output_kind: "none",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    },
    {
      id: "quick_edit",
      label: "快捷编辑",
      icon: "quick_edit",
      testid: "image-toolbar-quick-edit",
      form: "panel",
      default_slot: "main",
      removable: false,
      consumes: true,
      pricing: { generator: "quick_edit", tiers: [] },
      output_kind: "image",
      output_format: null,
      file_prefix: null,
      event_type: "quick_edit",
      disabled_rules: [{ id: "empty_prompt", message: "请先描述要怎么改" }],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    },
    {
      id: "upscale",
      label: "放大",
      icon: "upscale",
      testid: "image-toolbar-upscale",
      form: "dropdown",
      default_slot: "main",
      removable: true,
      consumes: true,
      pricing: { generator: "upscale", tiers: ["2k", "4k", "8k"] },
      output_kind: "image",
      output_format: "同源图",
      file_prefix: "upscale",
      event_type: "upscale",
      disabled_rules: [{ id: "source_at_target", message: "原图已达该分辨率" }],
      eta_seconds: 30,
      agent_callable: true,
      availability: "unavailable",
    },
    {
      id: "motion",
      label: "动态图片",
      icon: "motion",
      testid: "image-toolbar-motion",
      form: "panel",
      default_slot: "main",
      removable: true,
      consumes: true,
      pricing: { generator: "motion", tiers: [] },
      output_kind: "video",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [],
      eta_seconds: null,
      agent_callable: false,
      availability: "unavailable",
    },
  ];
}

function renderToolbar(tools: ToolDefinition[] = toolDefinitions()) {
  const onToolSelect = vi.fn();
  render(<ImageToolbar tools={tools} onToolSelect={onToolSelect} />);
  return { onToolSelect, tools };
}

/** 工具条上按文档顺序排的按钮 testid。 */
function buttonTestids(): Array<string | null> {
  return screen.getAllByRole("button").map((button) => button.getAttribute("data-testid"));
}

/**
 * 当前展开的 tooltip 文案。
 *
 * 不能用 `image-toolbar-tooltip` 一个 testid 查全部：工具按钮的 tooltip 是本组件写的
 * （带那个 testid），而「更多」的 tooltip 由 30A 的 `AppDropdown` 渲染、不接受 testid
 * （`ui/*` 本单只许 import）。两者都走 `ui/tooltip.tsx` 的 `TooltipContent`，它固定写
 * `data-slot="tooltip-content"`，所以按这个属性收口。
 */
function visibleTooltips(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map(
    (element) => element.textContent ?? "",
  );
}

describe("ImageToolbar（ED-00 / ED-00a，纯展示）", () => {
  it("验收4：分隔线数量 = 2（三组：入口 ｜ 编辑动作 ｜ 导出）", () => {
    renderToolbar();
    expect(screen.getAllByTestId("image-toolbar-separator")).toHaveLength(2);
  });

  it("按钮 = enabled 的 main 工具 + 「更多」，顺序为 入口 ｜ 编辑动作 ｜ 导出", () => {
    renderToolbar();
    expect(buttonTestids()).toEqual([
      "image-toolbar-quick-edit",
      "image-toolbar-more",
      "image-toolbar-download",
    ]);
  });

  it("unavailable 的工具不渲染（放大 / 动态图片都不出现）", () => {
    renderToolbar();
    expect(screen.queryByTestId("image-toolbar-upscale")).toBeNull();
    expect(screen.queryByTestId("image-toolbar-motion")).toBeNull();
  });

  it("实际渲染的 testid 等于 image-toolbar-{id}（定义字段，`_` → `-`）", () => {
    const tools = toolDefinitions();
    renderToolbar(tools);

    const rendered = buttonTestids();
    for (const tool of tools) {
      const expected = `image-toolbar-${tool.id.replace(/_/g, "-")}`;
      // 定义里的 testid 字段本身也必须守这条规则（21AB 的契约）。
      expect(tool.testid).toBe(expected);
      if (tool.availability !== "enabled") continue;
      if (tool.default_slot !== "main") continue;
      expect(rendered).toContain(expected);
    }
  });

  it("每个按钮都有 aria-label（含「更多」与「下载」）", () => {
    renderToolbar();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "快捷编辑",
      "更多",
      "下载",
    ]);
  });

  it("尺寸：容器高 44px、按钮 32×32（常量写在 style 上）", () => {
    renderToolbar();

    expect(screen.getByTestId("image-toolbar")).toHaveStyle({ height: `${TOOLBAR_HEIGHT}px` });
    for (const button of screen.getAllByRole("button")) {
      // 「更多」的触发器由 AppDropdown 渲染，尺寸由工具条给的 32×32 槽位决定，
      // 所以这里只断言带 style 的工具按钮（入口/导出）。
      if (button.getAttribute("data-testid") === "image-toolbar-more") continue;
      expect(button).toHaveStyle({ width: `${TOOLBAR_BUTTON}px`, height: `${TOOLBAR_BUTTON}px` });
    }
  });

  it("验收2：Tab 依次聚焦每个按钮都出 tooltip，内容含工具名；快捷编辑含「Tab」", async () => {
    const user = userEvent.setup();
    renderToolbar();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);

    for (const button of buttons) {
      const label = button.getAttribute("aria-label");
      expect(label).not.toBeNull();

      // Tab 走真实键盘路径：第 n 次 Tab 落到第 n 个按钮（工具条上没有别的可聚焦元素）。
      await user.tab();
      expect(button).toHaveFocus();

      await waitFor(() => {
        // 内容含工具名（快捷编辑还带快捷键，所以用 includes 而不是全等）。
        expect(visibleTooltips().some((text) => text.includes(label as string))).toBe(true);
      });

      // 快捷编辑的 tooltip 是「工具名 + 快捷键」（ED-00a 原文「快捷编辑 Tab」）。
      if (button.getAttribute("data-testid") === "image-toolbar-quick-edit") {
        expect(visibleTooltips()).toContain("快捷编辑 Tab");
        // 本组件自己的 tooltip 还带 testid，供后续 E2E 直接定位。
        expect(
          screen.queryAllByTestId("image-toolbar-tooltip").map((element) => element.textContent),
        ).toContain("快捷编辑 Tab");
      }
    }
  });

  it("tooltipLabel：有快捷键时拼上快捷键，没有时只有工具名（且不含价格）", () => {
    const [adjust, , , download, quickEdit] = toolDefinitions();

    expect(tooltipLabel(quickEdit as ToolDefinition)).toBe("快捷编辑 Tab");
    expect(tooltipLabel(download as ToolDefinition)).toBe("下载");
    expect(tooltipLabel(adjust as ToolDefinition)).toBe("调整");
    // 价格要等 ED-00c，本单不显示也不留占位：任何 tooltip 都不许出现货币/数字占位。
    for (const tool of [adjust, download, quickEdit] as ToolDefinition[]) {
      expect(tooltipLabel(tool)).not.toMatch(/[¥$]|N1|N2|N3|待定价|估算中/);
    }
  });

  it("点击某个按钮：onToolSelect 调用 1 次，参数是对应的 id", async () => {
    const { onToolSelect } = renderToolbar();

    await userEvent.click(screen.getByTestId("image-toolbar-quick-edit"));

    expect(onToolSelect).toHaveBeenCalledTimes(1);
    expect(onToolSelect).toHaveBeenCalledWith("quick_edit");

    await userEvent.click(screen.getByTestId("image-toolbar-download"));

    expect(onToolSelect).toHaveBeenCalledTimes(2);
    expect(onToolSelect).toHaveBeenLastCalledWith("download");
  });

  it("反向：把 upscale 改成 enabled 后按钮出现（没有写死工具清单）", () => {
    const tools = toolDefinitions().map((tool) =>
      tool.id === "upscale" ? { ...tool, availability: "enabled" as const } : tool,
    );
    renderToolbar(tools);

    expect(buttonTestids()).toEqual([
      "image-toolbar-quick-edit",
      "image-toolbar-upscale",
      "image-toolbar-more",
      "image-toolbar-download",
    ]);
    // 分隔线仍然是 2 条：新工具进的是编辑动作组，不是新的一组。
    expect(screen.getAllByTestId("image-toolbar-separator")).toHaveLength(2);
  });

  it("入口组没有 enabled 工具时：省略这一组和它那一侧的分隔线（剩 1 条）", () => {
    const tools = toolDefinitions().map((tool) =>
      tool.id === "quick_edit" ? { ...tool, availability: "unavailable" as const } : tool,
    );
    renderToolbar(tools);

    expect(screen.queryByTestId("image-toolbar-quick-edit")).toBeNull();
    expect(buttonTestids()).toEqual(["image-toolbar-more", "image-toolbar-download"]);
    expect(screen.getAllByTestId("image-toolbar-separator")).toHaveLength(1);
  });

  it("导出组没有 enabled 工具时：省略这一组和它那一侧的分隔线（剩 1 条）", () => {
    const tools = toolDefinitions().map((tool) =>
      tool.id === "download" ? { ...tool, availability: "unavailable" as const } : tool,
    );
    renderToolbar(tools);

    expect(screen.queryByTestId("image-toolbar-download")).toBeNull();
    expect(buttonTestids()).toEqual(["image-toolbar-quick-edit", "image-toolbar-more"]);
    expect(screen.getAllByTestId("image-toolbar-separator")).toHaveLength(1);
  });

  it("一个 enabled 工具都没有时：「更多」仍在，分隔线 0 条（编辑动作组永远非空）", () => {
    const tools = toolDefinitions().map((tool) => ({
      ...tool,
      availability: "unavailable" as const,
    }));
    renderToolbar(tools);

    expect(buttonTestids()).toEqual(["image-toolbar-more"]);
    expect(screen.queryAllByTestId("image-toolbar-separator")).toHaveLength(0);
  });
});
