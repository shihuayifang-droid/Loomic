import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ToolDefinition } from "@loomic/shared";

import { CustomizeToolbarDialog } from "../src/components/canvas/customize-toolbar-dialog";
import type { ToolbarConfig } from "../src/lib/toolbar-config";

/**
 * 工单 30N T2/T4 · ED-00g 自定义工具栏弹窗（草稿预览 + 取消不生效）。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup —— 工单 §3 T4 明确要求本文件手动 `cleanup()`。
 *
 * ## 夹具与 21AB 真实表的差异（有意为之，回传里也写了）
 *
 * 真实表里 `multi_angle` 是 `availability: "unavailable"`。但工单 §3 T4 要求「取消勾选『多角度』后
 * 预览里 `image-toolbar-multi-angle` 消失」—— 预览只渲染 enabled 的工具，所以验收 1 要的这一行
 * 必须在夹具里是 enabled；「unavailable 不可勾选」那条用 `mockup` 覆盖（真实表里它也是 unavailable）。
 *
 * 弹窗框架复用 `components/ui/dialog.tsx`，Esc 与点遮罩由 Base UI 的 Dialog 自己关，
 * 关的时候走 `onOpenChange(false)` → `onCancel`，所以两条都能在这里断言。
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

function toolDefinitions(): ToolDefinition[] {
  return [
    // 两个不可移除：不该出现在网格里（裁决 4）
    tool("quick_edit", {
      label: "快捷编辑",
      default_slot: "main",
      removable: false,
      consumes: true,
      pricing: { generator: "quick_edit", tiers: [] },
    }),
    tool("download", { label: "下载", default_slot: "main", removable: false }),
    // 可移除、enabled
    tool("adjust", { label: "调整", default_slot: "more" }),
    tool("crop", { label: "裁剪", default_slot: "more" }),
    tool("multi_angle", { label: "多角度", default_slot: "main" }),
    // 可移除、unavailable：列出但不可勾选
    tool("mockup", { label: "Mockup", default_slot: "more", availability: "unavailable" }),
  ];
}

function initialConfig(): ToolbarConfig {
  return { pinned: ["multi_angle", "crop"], show_labels: false };
}

function renderDialog(config: ToolbarConfig = initialConfig()) {
  const onSave = vi.fn<(next: ToolbarConfig) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <CustomizeToolbarDialog
      tools={toolDefinitions()}
      config={config}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return { onSave, onCancel, config };
}

afterEach(() => {
  cleanup();
});

describe("CustomizeToolbarDialog（ED-00g 验收 1：草稿预览、取消不生效）", () => {
  it("验收1：取消勾选「多角度」后预览里 image-toolbar-multi-angle 消失；点取消 onSave 0 次、onCancel 1 次", async () => {
    const user = userEvent.setup();
    const { onSave, onCancel } = renderDialog();

    const preview = screen.getByTestId("image-toolbar-customize-preview");
    expect(within(preview).getByTestId("image-toolbar-multi-angle")).toBeInTheDocument();

    await user.click(screen.getByTestId("image-toolbar-customize-item-multi-angle"));

    expect(within(preview).queryByTestId("image-toolbar-multi-angle")).toBeNull();
    // 取消不生效：草稿改了，但调用方一个字都没收到
    await user.click(screen.getByTestId("image-toolbar-customize-cancel"));

    expect(onSave).toHaveBeenCalledTimes(0);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("保存后 onSave 收到的 pinned 里没有 multi_angle，show_labels 是开关的当前值", async () => {
    const user = userEvent.setup();
    const { onSave, onCancel, config } = renderDialog();

    await user.click(screen.getByTestId("image-toolbar-customize-item-multi-angle")); // 取消勾选
    await user.click(screen.getByTestId("image-toolbar-customize-item-adjust")); // 新勾一个，追加到末尾
    await user.click(screen.getByTestId("image-toolbar-customize-show-labels")); // 打开显示名称
    await user.click(screen.getByTestId("image-toolbar-customize-save"));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(0);

    const saved = onSave.mock.calls[0]?.[0];
    expect(saved?.pinned).not.toContain("multi_angle");
    // 顺序按勾选/取消后的 pinned：原 ["multi_angle","crop"] 去掉 multi_angle，再追加 adjust
    expect(saved?.pinned).toEqual(["crop", "adjust"]);
    expect(saved?.show_labels).toBe(true);
    // 草稿是副本：调用方手里的 config 没被改过
    expect(config.pinned).toEqual(["multi_angle", "crop"]);
    expect(config.show_labels).toBe(false);
  });

  it("网格里没有快捷编辑和下载（只列 removable === true 的工具）", () => {
    renderDialog();

    expect(screen.queryByTestId("image-toolbar-customize-item-quick-edit")).toBeNull();
    expect(screen.queryByTestId("image-toolbar-customize-item-download")).toBeNull();
    // 剩下的可移除工具都在：adjust / crop / multi_angle / mockup
    expect(screen.getAllByTestId(/^image-toolbar-customize-item-/)).toHaveLength(4);
  });

  it("unavailable 的工具不可勾选，旁边有「即将上线」，预览里也不出现", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    const item = screen.getByTestId("image-toolbar-customize-item-mockup");
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("aria-pressed", "false");
    expect(within(item).getByText("即将上线")).toBeInTheDocument();

    // 点它既不会翻转状态，也不会进草稿
    await user.click(item);
    expect(item).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByTestId("image-toolbar-customize-save"));
    expect(onSave.mock.calls[0]?.[0].pinned).not.toContain("mockup");

    // 预览条只渲染 enabled 的工具，所以置灰工具在预览里根本没有
    const preview = screen.getByTestId("image-toolbar-customize-preview");
    expect(within(preview).queryByTestId("image-toolbar-mockup")).toBeNull();
  });

  it("toggle 的 aria-pressed 随状态翻转", async () => {
    const user = userEvent.setup();
    renderDialog();

    // 初始：multi_angle 在 pinned 里 = true；adjust 不在 = false
    const pinnedItem = screen.getByTestId("image-toolbar-customize-item-multi-angle");
    const unpinnedItem = screen.getByTestId("image-toolbar-customize-item-adjust");
    expect(pinnedItem).toHaveAttribute("aria-pressed", "true");
    expect(unpinnedItem).toHaveAttribute("aria-pressed", "false");

    await user.click(pinnedItem);
    expect(pinnedItem).toHaveAttribute("aria-pressed", "false");
    await user.click(unpinnedItem);
    expect(unpinnedItem).toHaveAttribute("aria-pressed", "true");
    // 再点回来
    await user.click(pinnedItem);
    expect(pinnedItem).toHaveAttribute("aria-pressed", "true");
  });

  it("打开 show_labels 后，预览里能看到工具名文本（关闭时不渲染）", async () => {
    const user = userEvent.setup();
    renderDialog();

    const preview = screen.getByTestId("image-toolbar-customize-preview");
    const switchControl = screen.getByTestId("image-toolbar-customize-show-labels");
    expect(switchControl).toHaveAttribute("role", "switch");
    expect(switchControl).toHaveAttribute("aria-checked", "false");
    // 关闭时预览里只有图标，没有工具名文本
    expect(within(preview).queryByText("裁剪")).toBeNull();
    expect(within(preview).queryByText("多角度")).toBeNull();

    await user.click(switchControl);

    expect(switchControl).toHaveAttribute("aria-checked", "true");
    expect(within(preview).getByText("裁剪")).toBeInTheDocument();
    expect(within(preview).getByText("多角度")).toBeInTheDocument();
    // 预览仍是同一个组件渲染的（不是另写一条假工具条）
    expect(within(preview).getByTestId("image-toolbar")).toBeInTheDocument();
  });

  it("按 Esc 调用 onCancel（草稿丢弃，onSave 0 次）", async () => {
    const user = userEvent.setup();
    const { onSave, onCancel } = renderDialog();

    // 先改一下草稿，确保 Esc 丢的是改过的草稿
    await user.click(screen.getByTestId("image-toolbar-customize-item-crop"));
    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(0);
  });

  it("点遮罩同样按取消处理（裁决 8：三条路径都丢弃草稿）", async () => {
    const user = userEvent.setup();
    const { onSave, onCancel } = renderDialog();

    await user.click(screen.getByTestId("image-toolbar-customize-item-crop"));
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(0);
  });
});
