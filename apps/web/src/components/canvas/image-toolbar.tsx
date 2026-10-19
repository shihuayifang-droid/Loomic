"use client";

import * as React from "react";

import type { ToolDefinition } from "@loomic/shared";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { ImageToolbarMoreMenu } from "./image-toolbar-more-menu";

/**
 * ED-00 / ED-00a · 逐图工具条（工单 30F T2，**纯展示**）
 *
 * ## 规格要点
 *
 * - 三组、两条分隔线：入口（快捷编辑）｜编辑动作（若干工具 + 「更多」）｜导出（下载）。
 * - 尺寸照 ED-00a 的 Lovart 实测：容器高 44、按钮 32×32、间距 4、左右内边距 6、圆角 14。
 * - 每个按钮都有 tooltip（含「更多」「下载」），键盘聚焦时同样出；图标按钮必须有 aria-label。
 * - tooltip 内容 = 工具名 + 快捷键（有则显示）+ 价格 —— **价格本单不显示也不留占位**
 *   （ED-00c 询价未做，写了占位以后会被当成真价格）。
 *
 * ## 不许写死工具清单（X-P11）
 *
 * 工具从 props 传进来的定义读，本文件里出现的具体工具 id **只有**下面
 * `TOOLBAR_EDGE_TOOL_IDS` 与 `TOOL_SHORTCUTS` 两处，都注明规格出处：
 * 前者是 ED-00a 的分组规则（入口组 = 快捷编辑、导出组 = 下载），后者是 ED-00a 原文的快捷键
 * （「快捷编辑 Tab」）。
 *
 * ## 本单不接入画布
 *
 * 跟随对象定位、选中态这些要改 `canvas-editor.tsx`（脏文件），等 T-47 之后做。
 * 所以这里没有任何定位/开合逻辑，只有「给一组定义 → 排出一条工具条」。
 */

/** ED-00a 尺寸常量。写在容器的 style 上，测试可以直接断言（验收 1：容器 44、按钮 32）。 */
export const TOOLBAR_HEIGHT = 44;
export const TOOLBAR_BUTTON = 32;
export const TOOLBAR_GAP = 4;
export const TOOLBAR_PADDING_X = 6;
export const TOOLBAR_RADIUS = 14;

/** 分隔线的 testid（ED-00a 验收 4：分隔线数量 = 2）。 */
export const TOOLBAR_SEPARATOR_TESTID = "image-toolbar-separator";

/**
 * ED-00a 的分组规则：两端组是**固定工具**，其余 main 工具都归中间那一组。
 *
 * 「入口组 = quick_edit，导出组 = download」是本组件里唯一允许写具体工具 id 的业务规则
 * （工单 §1 的例外条款），所以集中成一个常量，不要散到渲染逻辑里。
 */
export const TOOLBAR_EDGE_TOOL_IDS = {
  /** 入口：快捷编辑（ED-00a「入口（快捷编辑）」）。 */
  entry: "quick_edit",
  /** 导出：下载（ED-00a「导出（下载）」）。 */
  export: "download",
} as const;

/**
 * ED-00a 原文的快捷键：「内容 = 工具名 + 快捷键（有则显示，如「快捷编辑 Tab」）」。
 * 规格目前只给了这一个，表里没有的工具就是没有快捷键，tooltip 只显示工具名。
 */
export const TOOL_SHORTCUTS: Readonly<Record<string, string>> = {
  quick_edit: "Tab",
};

/** 按钮的 tooltip 文案：工具名 + 快捷键（没有快捷键时只有工具名）。 */
export function tooltipLabel(tool: ToolDefinition): string {
  const shortcut = TOOL_SHORTCUTS[tool.id];
  return shortcut === undefined ? tool.label : `${tool.label} ${shortcut}`;
}

const TOOL_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * 图标占位。
 *
 * 定义里的 `icon` 是一个键（`adjust` / `crop` / …），把它映射成具体图标属于接入画布那一单的
 * 事：现在写 17 条映射就等于把工具清单又抄了一遍（X-P11 的反面）。所以这里只渲染一个中性
 * 图形，并用 `data-icon` 把定义里的键挂出来，接入时按 `[data-icon]` 逐个替换即可。
 */
function ToolGlyph({ icon }: { icon: string }) {
  return (
    <span
      aria-hidden="true"
      data-icon={icon}
      className="pointer-events-none flex items-center justify-center"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="size-4"
      >
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
        <path d="M5.5 8h5" />
      </svg>
    </span>
  );
}

function ToolButton({
  tool,
  onSelect,
}: {
  tool: ToolDefinition;
  onSelect: (toolId: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <button
            type="button"
            // 定义里已经就是 `image-toolbar-{id}`（21AB），不随状态改名（X-P13）。
            data-testid={tool.testid}
            aria-label={tool.label}
            onClick={() => onSelect(tool.id)}
            style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
            className={TOOL_BUTTON_CLASS}
          />
        }
      >
        <ToolGlyph icon={tool.icon} />
      </TooltipTrigger>
      {/* Tooltip 在 focus 上同样展开，所以 Tab 到按钮也会出 tooltip（ED-00a 验收 2）。 */}
      <TooltipContent data-testid="image-toolbar-tooltip">{tooltipLabel(tool)}</TooltipContent>
    </Tooltip>
  );
}

function Separator() {
  return (
    <span
      data-testid={TOOLBAR_SEPARATOR_TESTID}
      aria-hidden="true"
      className="shrink-0 bg-border"
      style={{ width: 1, height: TOOLBAR_BUTTON - 8 }}
    />
  );
}

export type ImageToolbarProps = {
  /** 整份工具定义（来自 `useToolDefinitions`）。本组件只取 `enabled` 的。 */
  tools: ToolDefinition[];
  onToolSelect: (toolId: string) => void;
};

type ToolbarGroup = {
  key: string;
  children: React.ReactNode;
};

export function ImageToolbar({ tools, onToolSelect }: ImageToolbarProps) {
  const enabledMainTools = tools.filter(
    (tool) => tool.availability === "enabled" && tool.default_slot === "main",
  );

  const entryTool = enabledMainTools.find((tool) => tool.id === TOOLBAR_EDGE_TOOL_IDS.entry);
  const exportTool = enabledMainTools.find((tool) => tool.id === TOOLBAR_EDGE_TOOL_IDS.export);

  /**
   * 编辑动作组：main 里去掉两端固定项，顺序照定义表。
   *
   * 这一组**永远不为空** —— 就算一个可用工具都没有，「更多」按钮仍然在（ED-00f）。
   * 所以「分隔线 = 2」在三组齐全时稳定成立；入口组或导出组没有 enabled 工具时，
   * 省略那一组和它旁边那条分隔线（两边都缺就是 1 条，只剩编辑动作组时是 0 条）。
   */
  const actionTools = enabledMainTools.filter(
    (tool) =>
      tool.id !== TOOLBAR_EDGE_TOOL_IDS.entry && tool.id !== TOOLBAR_EDGE_TOOL_IDS.export,
  );

  const groups: ToolbarGroup[] = [];

  if (entryTool !== undefined) {
    groups.push({
      key: "entry",
      children: <ToolButton tool={entryTool} onSelect={onToolSelect} />,
    });
  }

  groups.push({
    key: "actions",
    children: (
      <>
        {actionTools.map((tool) => (
          <ToolButton key={tool.id} tool={tool} onSelect={onToolSelect} />
        ))}
        {/* ED-00f：编辑按钮的最后一个是「⋯ 更多」，它的 testid 是 `image-toolbar-more`。 */}
        <span
          className="flex items-center justify-center"
          style={{ width: TOOLBAR_BUTTON, height: TOOLBAR_BUTTON }}
        >
          <ImageToolbarMoreMenu tools={tools} onToolSelect={onToolSelect} />
        </span>
      </>
    ),
  });

  if (exportTool !== undefined) {
    groups.push({
      key: "export",
      children: <ToolButton tool={exportTool} onSelect={onToolSelect} />,
    });
  }

  return (
    <div
      data-testid="image-toolbar"
      className="flex items-center border border-border bg-popover shadow-md"
      style={{
        height: TOOLBAR_HEIGHT,
        paddingLeft: TOOLBAR_PADDING_X,
        paddingRight: TOOLBAR_PADDING_X,
        borderRadius: TOOLBAR_RADIUS,
        gap: TOOLBAR_GAP,
      }}
    >
      {groups.map((group, index) => (
        <React.Fragment key={group.key}>
          {/* 分隔线画在相邻两组之间，所以 N 个组就是 N-1 条。 */}
          {index === 0 ? null : <Separator />}
          <div className="flex items-center" style={{ gap: TOOLBAR_GAP }}>
            {group.children}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
