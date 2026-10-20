import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { CanvasBottomBar } from "../src/components/canvas-bottom-bar";

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收
afterEach(() => {
  cleanup();
});

/** Excalidraw API 的最小替身（canvas-bottom-bar 的 props 是 any） */
function makeApi() {
  return {
    getAppState: vi.fn(() => ({ zoom: { value: 1 }, viewBackgroundColor: "#FFFFFF" })),
    updateScene: vi.fn(),
    scrollToContent: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
}

function renderBar() {
  const api = makeApi();
  render(
    <CanvasBottomBar
      excalidrawApi={api}
      layersOpen={false}
      onToggleLayers={() => {}}
      filesOpen={false}
      onToggleFiles={() => {}}
      referencesOpen={false}
      onToggleReferences={() => {}}
      leftPanelOpen={false}
    />,
  );
  return api;
}

/** 迁移前的预设（ZOOM_PRESETS = 0.25/0.5/0.75/1/1.5/2，末尾 Fit All） */
const PRESET_IDS = ["0.25", "0.5", "0.75", "1", "1.5", "2"];
const PRESET_TEXTS = ["25%", "50%", "75%", "100%", "150%", "200%"];

describe("canvas-bottom-bar 缩放菜单迁移到 AppDropdown", () => {
  it("点击 canvas-zoom-dropdown 后菜单展开，预设项与迁移前一一对应（数量/文字/顺序）", async () => {
    renderBar();
    const trigger = screen.getByTestId("canvas-zoom-dropdown");
    expect(trigger).toHaveTextContent("100%");

    await userEvent.click(trigger);
    const menu = await screen.findByTestId("canvas-zoom-dropdown-menu");
    const rows = within(menu).getAllByRole("menuitem");

    expect(rows).toHaveLength(PRESET_IDS.length + 1);
    expect(rows.map((row) => row.textContent)).toEqual([...PRESET_TEXTS, "Fit All"]);

    // 每项的 testid 沿用现有预设标识（ZOOM_PRESETS 的数值）
    PRESET_IDS.forEach((preset, index) => {
      const item = screen.getByTestId(`canvas-zoom-dropdown-item-${preset}`);
      expect(item).toHaveTextContent(PRESET_TEXTS[index] as string);
    });
    expect(screen.getByTestId("canvas-zoom-dropdown-item-fit-all")).toBeInTheDocument();
  });

  it("选择某个预设时，回调收到的参数和迁移前一致", async () => {
    const api = renderBar();
    await userEvent.click(screen.getByTestId("canvas-zoom-dropdown"));
    await userEvent.click(await screen.findByTestId("canvas-zoom-dropdown-item-0.5"));

    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(api.updateScene).toHaveBeenCalledWith({ appState: { zoom: { value: 0.5 } } });
    await waitFor(() => expect(screen.queryByTestId("canvas-zoom-dropdown-menu")).toBeNull());
  });

  it("Fit All 仍然调 scrollToContent 并收起菜单", async () => {
    const api = renderBar();
    await userEvent.click(screen.getByTestId("canvas-zoom-dropdown"));
    await userEvent.click(await screen.findByTestId("canvas-zoom-dropdown-item-fit-all"));

    expect(api.scrollToContent).toHaveBeenCalledTimes(1);
    expect(api.updateScene).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("canvas-zoom-dropdown-menu")).toBeNull());
  });

  it("aria-expanded 正确切换", async () => {
    renderBar();
    const trigger = screen.getByTestId("canvas-zoom-dropdown");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("背景色弹层仍能打开（回归检查）", async () => {
    renderBar();
    expect(screen.queryByText("画布背景色")).toBeNull();

    await userEvent.click(screen.getByLabelText("Background color"));

    expect(await screen.findByText("画布背景色")).toBeInTheDocument();
  });
});
