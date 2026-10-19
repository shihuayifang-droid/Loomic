"use client";

import * as React from "react";

import type { ToolDefinition } from "@loomic/shared";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { applyToolbarConfig } from "@/lib/toolbar-config";
import type { ToolbarConfig } from "@/lib/toolbar-config";
import { cn } from "@/lib/utils";

import { ImageToolbar } from "./image-toolbar";

/**
 * ED-00g · 自定义工具栏弹窗（工单 30N T2）
 *
 * ## 本单做到哪儿
 *
 * 只做到「前端能力层」：草稿预览 + 保存回调。**不接入画布**，也不落服务端 ——
 * 按用户存到服务端、换浏览器后仍在，要等后端偏好接口（工单 §1 的验收 2 只做「保存时回调给出新配置」）。
 *
 * ## 三条实现口径（工单 §2）
 *
 * 1. **预览条就是真实工具条**：直接渲染 `<ImageToolbar tools={applyToolbarConfig(tools, draft)}
 *    showLabels={draft.show_labels} />`。`ImageToolbar` / `ImageToolbarMoreMenu` 的过滤逻辑一行
 *    都不用改，配置到 `default_slot` 的翻译全在 `applyToolbarConfig` 里（裁决 3）。
 * 2. **草稿态**：挂载（= 对话框打开）时从 `config` 复制一份，之后所有勾选只改草稿 ——
 *    取消、Esc、点遮罩都只是丢弃草稿并调 `onCancel`，反向操作永远不会漏到外面（裁决 8）。
 *    所以本组件是**「打开即挂载」**用法的：调用方用条件渲染或 `key` 控制，不要常驻挂载后
 *    指望它自己跟 `config` 同步。
 * 3. **网格只列 `removable === true` 的工具**：快捷编辑、下载不可移除，不出现（裁决 4）。
 *    `availability === "unavailable"` 的工具仍然列出，但置灰且不可勾选，旁边标「即将上线」。
 *
 * ## 交互与 testid（裁决 7 / 8）
 *
 * - 格子是 toggle，带 `aria-pressed`；「显示工具名称」是 `role="switch"` + `aria-checked`。
 * - testid 全在 `image-` 前缀下：`image-toolbar-customize-dialog` / `-preview` /
 *   `-item-{slug}` / `-show-labels` / `-cancel` / `-save`。
 *   其中 `-item-{slug}` 的 slug 取 `tool.testid` 去掉开头的 `image-toolbar-`，
 *   所以是连字符形式（`multi-angle`），不是 id 里的下划线（`multi_angle`）。
 * - 弹窗框架用 `components/ui/dialog.tsx`（工单要求先查 `components/ui/`，**不许新造对话框**）。
 *   Esc 与点遮罩由 Base UI 的 `Dialog` 自己关，关的时候走 `onOpenChange(false)`，语义与「取消」一致。
 */

/** 定义里的 testid 前缀（21AB 的契约：`image-toolbar-{id with "_" -> "-"}`）。 */
const TOOL_TESTID_PREFIX = "image-toolbar-";

/**
 * 网格格子的 slug：`tool.testid` 去掉开头的 `image-toolbar-`（裁决 7）。
 *
 * 契约保证前缀存在（定义表的 `testid` 字段就是按它生成的），兜底分支只是不静默失败：
 * 万一定义里少了前缀，仍按 id 的连字符形式出 slug，格子不会因为 slug 变成空串而全部同名。
 */
function itemSlug(tool: ToolDefinition): string {
  if (tool.testid.startsWith(TOOL_TESTID_PREFIX)) {
    return tool.testid.slice(TOOL_TESTID_PREFIX.length);
  }
  return tool.id.replace(/_/g, "-");
}

/** 预览条上的按钮不接画布（本单不接入），点它什么都不发生。 */
function noop() {
  // 预览条要的是「看到什么样子」，不是「点了能执行」。真实工具条的 onToolSelect 由画布给。
}

const GRID_ITEM_CLASS = cn(
  "flex flex-col items-start gap-0.5 rounded-lg border border-border px-2.5 py-2 text-left text-xs outline-none transition-colors",
  "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
  "aria-pressed:border-primary aria-pressed:bg-primary/10",
  // 不可勾选的原因写在旁边（X-P5），这里只管「看得出来不能点」。
  "disabled:pointer-events-none disabled:opacity-60",
);

function CustomizeItem({
  tool,
  pressed,
  onToggle,
}: {
  tool: ToolDefinition;
  pressed: boolean;
  onToggle: () => void;
}) {
  const unavailable = tool.availability === "unavailable";

  return (
    <button
      type="button"
      // 模板字符串是 testid lint 认可的形式（工单 §6：不许写成常量引用）。
      data-testid={`image-toolbar-customize-item-${itemSlug(tool)}`}
      aria-pressed={pressed}
      disabled={unavailable}
      onClick={onToggle}
      className={GRID_ITEM_CLASS}
    >
      <span className="max-w-full truncate">{tool.label}</span>
      {unavailable ? (
        <span className="text-[0.65rem] text-muted-foreground">即将上线</span>
      ) : null}
    </button>
  );
}

export type CustomizeToolbarDialogProps = {
  /** 整份工具定义（`GET /api/tools` 的原样数据）。 */
  tools: ToolDefinition[];
  /** 打开时的配置（服务端返回，或上一次保存的结果）。本组件只复制，不改它。 */
  config: ToolbarConfig;
  /** 点「保存」时给出新配置。本单不落库，落库由接入单接后端偏好接口。 */
  onSave: (config: ToolbarConfig) => void;
  /** 取消 / Esc / 点遮罩：丢弃草稿。 */
  onCancel: () => void;
};

export function CustomizeToolbarDialog({
  tools,
  config,
  onSave,
  onCancel,
}: CustomizeToolbarDialogProps) {
  // 草稿：挂载时复制一份。数组也复制，别让第一次勾选就写到调用方的 config 上。
  const [draft, setDraft] = React.useState<ToolbarConfig>(() => ({
    pinned: [...config.pinned],
    show_labels: config.show_labels,
  }));

  const previewTools = applyToolbarConfig(tools, draft);
  // 网格只列可移除的（快捷编辑、下载不出现，裁决 4）。顺序照定义表，不按 pinned 重排。
  const gridTools = tools.filter((tool) => tool.removable);

  function togglePinned(toolId: string) {
    setDraft((previous) => {
      const pressed = previous.pinned.includes(toolId);
      return {
        // 勾上就追加到末尾 —— `pinned` 的数组顺序就是 main 区的顺序（裁决 3）。
        pinned: pressed
          ? previous.pinned.filter((id) => id !== toolId)
          : [...previous.pinned, toolId],
        show_labels: previous.show_labels,
      };
    });
  }

  function toggleShowLabels() {
    setDraft((previous) => ({
      pinned: previous.pinned,
      show_labels: !previous.show_labels,
    }));
  }

  function handleSave() {
    // 出口再复制一份：对话框关掉以后调用方手里的配置不该和草稿共用数组。
    onSave({ pinned: [...draft.pinned], show_labels: draft.show_labels });
  }

  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        // Esc 与点遮罩都是「丢弃草稿」（裁决 8）：它们只会把 open 变 false。
        if (!open) onCancel();
      }}
    >
      <DialogContent data-testid="image-toolbar-customize-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>自定义工具栏</DialogTitle>
          <DialogDescription>
            勾选要放在工具条上的工具，上面的预览会立刻跟着变。保存只改配置，不改画布上的对象。
          </DialogDescription>
        </DialogHeader>

        {/* 预览条：与真实工具条同一个组件（ED-00g「前端要点」）。 */}
        <div
          data-testid="image-toolbar-customize-preview"
          className="flex justify-center overflow-x-auto rounded-2xl bg-muted/40 p-3"
        >
          <ImageToolbar tools={previewTools} showLabels={draft.show_labels} onToolSelect={noop} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {gridTools.map((tool) => (
            <CustomizeItem
              key={tool.id}
              tool={tool}
              pressed={draft.pinned.includes(tool.id)}
              onToggle={() => togglePinned(tool.id)}
            />
          ))}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border px-2.5 py-2">
          <span id="image-toolbar-customize-show-labels-label" className="text-xs">
            显示工具名称
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.show_labels}
            aria-labelledby="image-toolbar-customize-show-labels-label"
            data-testid="image-toolbar-customize-show-labels"
            onClick={toggleShowLabels}
            className={cn(
              "inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              draft.show_labels ? "bg-primary" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "block size-4 rounded-full bg-background transition-transform",
                draft.show_labels ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        <DialogFooter>
          <Button
            data-testid="image-toolbar-customize-cancel"
            type="button"
            variant="outline"
            onClick={onCancel}
          >
            取消
          </Button>
          <Button data-testid="image-toolbar-customize-save" type="button" onClick={handleSave}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
