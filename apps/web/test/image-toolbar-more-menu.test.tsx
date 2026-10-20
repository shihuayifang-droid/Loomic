import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ToolDefinition } from "@loomic/shared";

import {
  CUSTOMIZE_DISABLED_REASON,
  CUSTOMIZE_ITEM_ID,
  CUSTOMIZE_ITEM_LABEL,
  ImageToolbarMoreMenu,
  MORE_MENU_TESTID,
} from "../src/components/canvas/image-toolbar-more-menu";
import { formatPrice, type PriceState } from "../src/lib/price-display";

/**
 * 工单 30F T3 · ED-00f「更多」溢出菜单。
 *
 * 夹具与 `image-toolbar.test.tsx` 同源（照抄 21AB `TOOL_DEFINITIONS` 的行）。
 * 菜单本体是 30A 的 `AppDropdown`，本文件只验**菜单项从定义来**这件事，
 * 展开方式等通用行为由 `test/app-dropdown.test.tsx` 覆盖。
 */
afterEach(() => {
  cleanup();
});

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
      id: "expand",
      label: "扩展",
      icon: "expand",
      testid: "image-toolbar-expand",
      form: "panel",
      default_slot: "more",
      removable: true,
      consumes: true,
      pricing: { generator: "expand", tiers: [] },
      output_kind: "image",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [{ id: "no_expand_area", message: "未设置扩展区域" }],
      eta_seconds: null,
      agent_callable: false,
      availability: "unavailable",
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
  ];
}

function renderMenu(tools: ToolDefinition[] = toolDefinitions()) {
  const onToolSelect = vi.fn();
  render(<ImageToolbarMoreMenu tools={tools} onToolSelect={onToolSelect} />);
  return { onToolSelect, tools };
}

/** 展开菜单，返回按文档顺序的菜单项 testid。 */
async function openMenu(): Promise<Array<string | null>> {
  await userEvent.click(screen.getByTestId(MORE_MENU_TESTID));
  const menu = await screen.findByTestId(`${MORE_MENU_TESTID}-menu`);
  return Array.from(menu.querySelectorAll("[data-testid]")).map((element) =>
    element.getAttribute("data-testid"),
  );
}

describe("ImageToolbarMoreMenu（ED-00f）", () => {
  it("验收1：菜单项 = enabled 且 default_slot=more 的定义，一一对应且顺序一致", async () => {
    const { tools } = renderMenu();
    await openMenu();

    const expected = tools
      .filter((tool) => tool.availability === "enabled" && tool.default_slot === "more")
      // 菜单项的 itemId 是工具 id 的 `-` 版本（下划线不在 testid 字符集里）。
      .map((tool) => `${MORE_MENU_TESTID}-item-${tool.id.replace(/_/g, "-")}`);

    // 定义顺序是 adjust → crop → flip_rotate；菜单项必须同序。
    expect(expected).toEqual([
      "image-toolbar-more-item-adjust",
      "image-toolbar-more-item-crop",
      "image-toolbar-more-item-flip-rotate",
    ]);

    for (const testid of expected) {
      expect(await screen.findByTestId(testid)).toBeInTheDocument();
    }

    // 不在 more 槽位的（下载/快捷编辑）与 unavailable 的（扩展）都不许出现。
    expect(screen.queryByTestId(`${MORE_MENU_TESTID}-item-download`)).toBeNull();
    expect(screen.queryByTestId(`${MORE_MENU_TESTID}-item-quick-edit`)).toBeNull();
    expect(screen.queryByTestId(`${MORE_MENU_TESTID}-item-expand`)).toBeNull();
  });

  it("验收3：最后一项是「自定义工具栏 ›」，disabled，hover 时 tooltip 写「即将上线」", async () => {
    renderMenu();
    const testids = await openMenu();

    const customizeTestid = `${MORE_MENU_TESTID}-item-${CUSTOMIZE_ITEM_ID}`;
    // 最后一个「菜单项」是 customize：菜单里唯一的工具项都排在它前面。
    const lastItem = testids[testids.length - 1];
    expect(lastItem === customizeTestid || lastItem === `${customizeTestid}-reason`).toBe(true);

    const customize = await screen.findByTestId(customizeTestid);
    expect(customize).toHaveTextContent(CUSTOMIZE_ITEM_LABEL);
    expect(customize).toHaveAttribute("aria-disabled", "true");

    await userEvent.hover(customize);
    await waitFor(() =>
      expect(screen.getByTestId(`${customizeTestid}-reason`)).toHaveTextContent(
        CUSTOMIZE_DISABLED_REASON,
      ),
    );
  });

  it("「自定义工具栏」disabled：点它不会触发 onToolSelect，菜单也不收起", async () => {
    const { onToolSelect } = renderMenu();
    await openMenu();

    await userEvent.click(screen.getByTestId(`${MORE_MENU_TESTID}-item-${CUSTOMIZE_ITEM_ID}`));

    expect(onToolSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${MORE_MENU_TESTID}-menu`)).toBeInTheDocument();
  });

  it("选中某一项：onToolSelect 调用 1 次，参数是对应的工具 id", async () => {
    const { onToolSelect } = renderMenu();
    await openMenu();

    await userEvent.click(screen.getByTestId(`${MORE_MENU_TESTID}-item-crop`));

    expect(onToolSelect).toHaveBeenCalledTimes(1);
    expect(onToolSelect).toHaveBeenCalledWith("crop");
  });

  it("menu 通过 click 展开；hover 只出 tooltip，不展开", async () => {
    renderMenu();

    const trigger = screen.getByTestId(MORE_MENU_TESTID);
    // hover 前只有触发器自己那一个「更多」。
    expect(screen.getAllByText("更多")).toHaveLength(1);

    await userEvent.hover(trigger);

    // tooltip 出来了（第二个「更多」，文案与触发器同名），菜单仍然关着。
    await waitFor(() => expect(screen.getAllByText("更多")).toHaveLength(2));
    expect(screen.queryByTestId(`${MORE_MENU_TESTID}-menu`)).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);

    expect(await screen.findByTestId(`${MORE_MENU_TESTID}-menu`)).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("反向：多一个 more 工具后菜单项随之增加（没有写死菜单内容）", async () => {
    const extra: ToolDefinition = {
      id: "move_object",
      label: "移动对象",
      icon: "move_object",
      testid: "image-toolbar-move-object",
      form: "panel",
      default_slot: "more",
      removable: true,
      consumes: true,
      pricing: { generator: "move_object", tiers: [] },
      output_kind: "image",
      output_format: null,
      file_prefix: null,
      event_type: null,
      disabled_rules: [{ id: "no_object_selected", message: "尚未选择对象" }],
      eta_seconds: null,
      agent_callable: false,
      availability: "enabled",
    };

    renderMenu([...toolDefinitions(), extra]);
    await openMenu();

    expect(await screen.findByTestId(`${MORE_MENU_TESTID}-item-move-object`)).toBeInTheDocument();
    expect(screen.getByText("移动对象")).toBeInTheDocument();
  });

  it("触发器可访问性：aria-label「更多」+ aria-haspopup=menu", () => {
    renderMenu();
    const trigger = screen.getByTestId(MORE_MENU_TESTID);

    expect(trigger).toHaveAttribute("aria-label", "更多");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  });
});

/**
 * ED-00f R9 · 菜单项标价。
 *
 * 夹具里没有「direct 且 default_slot=more」的项（download 在主槽位），
 * 所以按工单在本文件内额外定义一个 `vectorize`（`form: "direct"` + `more`）。
 * 价格一律由 `formatPrice` 算出的期望文案钉住，不在测试里另写一份文案。
 */
const VECTORIZE: ToolDefinition = {
  id: "vectorize",
  label: "矢量",
  icon: "vectorize",
  testid: "image-toolbar-vectorize",
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
  agent_callable: true,
  availability: "enabled",
};

function renderMenuWithPrices(prices?: Readonly<Record<string, PriceState>>) {
  const onToolSelect = vi.fn();
  render(
    <ImageToolbarMoreMenu
      tools={[...toolDefinitions(), VECTORIZE]}
      onToolSelect={onToolSelect}
      prices={prices}
    />,
  );
  return { onToolSelect };
}

describe("ImageToolbarMoreMenu 标价（ED-00f R9）", () => {
  it("ED-00f: a direct-execute item shows its quoted price", async () => {
    const priced: PriceState = { status: "priced", amount: 12 };
    renderMenuWithPrices({ vectorize: priced });
    await openMenu();

    const item = await screen.findByTestId(`${MORE_MENU_TESTID}-item-vectorize`);
    expect(item).toHaveTextContent("矢量");
    expect(item).toHaveTextContent(formatPrice(priced, "badge"));
  });

  it("ED-00f: without a price a direct item reads 估算中", async () => {
    renderMenuWithPrices();
    await openMenu();

    const item = await screen.findByTestId(`${MORE_MENU_TESTID}-item-vectorize`);
    expect(item).toHaveTextContent(formatPrice({ status: "estimating" }, "badge"));
    expect(item).toHaveTextContent("估算中");
  });

  it("ED-00f: a panel item carries no price", async () => {
    renderMenuWithPrices({ vectorize: { status: "priced", amount: 12 } });
    await openMenu();

    const panelItem = await screen.findByTestId(`${MORE_MENU_TESTID}-item-adjust`);
    expect(panelItem).toHaveTextContent("调整");
    expect(panelItem.textContent ?? "").not.toContain("估算中");
  });
});
