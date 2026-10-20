"use client";

import type { ReactNode } from "react";

import type { ToolDefinition } from "@loomic/shared";

import { AppDropdown } from "@/components/ui/app-dropdown";
import type { AppDropdownItem } from "@/components/ui/app-dropdown";
import { PriceTag } from "@/components/ui/price-tag";
import type { PriceState } from "@/lib/price-display";

/**
 * ED-00f · 工具条末端的「⋯ 更多」溢出菜单（工单 30F T3）
 *
 * 三条规格：
 * 1. 菜单项与工具条按钮是**同一份工具定义**（ED-00k），所以 props 直接收 `tools`，
 *    本文件没有一个具体的工具 id —— 菜单内容完全由定义里的 `default_slot` 决定。
 * 2. 只渲染 `availability === "enabled"` 的工具（ED-00k：未到位的工具不显示）。
 * 3. 底部分隔线下固定一项「自定义工具栏 ›」，属 ED-00g（P1），本期 disabled 并写明原因
 *    （X-P5：禁用项要说清为什么）。
 *
 * 触发器就是工具条上的「更多」按钮：展开方式由 `AppDropdown` 保证是 click（ED-00b），
 * hover 只出 tooltip。
 */

/** 触发器 testid（ED-00a：`image-toolbar-{tool_id}` 规则里「更多」不是工具，单独定名）。 */
export const MORE_MENU_TESTID = "image-toolbar-more";

/** 菜单项 label。规格原文是「自定义工具栏 ›」（ED-00f）。 */
export const CUSTOMIZE_ITEM_LABEL = "自定义工具栏 ›";

/** ED-00g 是 P1，本期不可用；原因文案同时是 hover 时 tooltip 的内容。 */
export const CUSTOMIZE_DISABLED_REASON = "即将上线";

export const CUSTOMIZE_ITEM_ID = "customize";

/** 触发器的可见文案。图标留给接入画布时补（本单是展示型组件）。 */
export const MORE_MENU_LABEL = "更多";

export type ImageToolbarMoreMenuProps = {
  /** 整份工具定义。本组件自己按 `default_slot === "more"` + `enabled` 过滤。 */
  tools: ToolDefinition[];
  onToolSelect: (toolId: string) => void;
  /**
   * ED-00f：直接执行类菜单项的标价，key = 工具 id（`toolDefinition.id`）。
   * 值由询价结果映射（`priceStateFromQuote`）。不传 / 缺某个 id 时那一项显示
   * 「估算中」—— 这正是规格允许的「价格未返回」态，不是占位假数据。
   */
  prices?: Readonly<Record<string, PriceState>> | undefined;
};

function noop() {
  // 「自定义工具栏」本期 disabled：禁用项的 onSelect 不会被触发，
  // 但 `AppDropdownItem.onSelect` 是必填字段，给一个明确的空操作比给 `() => {}` 更好搜。
}

/**
 * 菜单项的 itemId = 工具 id 的 `-` 版本。
 *
 * `AppDropdown` 把 itemId 直接拼进 testid（`{testid}-item-{itemId}`），而工具 id 是
 * snake_case（`flip_rotate`）；不转换的话渲染出来的 testid 会是
 * `image-toolbar-more-item-flip_rotate` —— 下划线不在 `CONVENTIONS.md` §1 的字符集里，
 * 也和定义里 `image-toolbar-flip-rotate` 对不上。回调仍然给原始工具 id（`onToolSelect`）。
 */
function menuItemId(tool: ToolDefinition): string {
  return tool.id.replace(/_/g, "-");
}

/**
 * ED-00f R9：直接执行类（`form === "direct"`）的菜单项在右侧标价，打开面板类的
 * 菜单项不标价 —— 所以 label 的形状由 `form` 决定，不是由某个具体工具决定。
 */
function directItemLabel(
  tool: ToolDefinition,
  prices: Readonly<Record<string, PriceState>> | undefined,
): ReactNode {
  return (
    <span className="flex w-full items-center justify-between gap-3">
      <span>{tool.label}</span>
      <PriceTag
        state={prices?.[tool.id] ?? { status: "estimating" }}
        variant="badge"
      />
    </span>
  );
}

export function ImageToolbarMoreMenu({
  tools,
  onToolSelect,
  prices,
}: ImageToolbarMoreMenuProps) {
  const items: AppDropdownItem[] = tools
    .filter((tool) => tool.availability === "enabled" && tool.default_slot === "more")
    .map((tool) => ({
      id: menuItemId(tool),
      label:
        tool.form === "direct"
          ? directItemLabel(tool, prices)
          : tool.label,
      onSelect: () => onToolSelect(tool.id),
    }));

  items.push({
    id: CUSTOMIZE_ITEM_ID,
    label: CUSTOMIZE_ITEM_LABEL,
    onSelect: noop,
    disabled: true,
    disabledReason: CUSTOMIZE_DISABLED_REASON,
    // 规格：「菜单底部有一条分隔线，下面固定一项」。
    separatorBefore: true,
  });

  return (
    <AppDropdown
      testid={MORE_MENU_TESTID}
      label={MORE_MENU_LABEL}
      // 每个按钮都有 tooltip，包括「更多」（ED-00a）。
      tooltip={MORE_MENU_LABEL}
      ariaLabel={MORE_MENU_LABEL}
      // 触发器撑满工具条给它的 32×32 槽位（尺寸由 `ImageToolbar` 决定，本组件不重复定义）。
      triggerClassName="h-full w-full"
      items={items}
    />
  );
}
