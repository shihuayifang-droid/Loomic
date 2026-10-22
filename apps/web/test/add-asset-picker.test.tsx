// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BrandKitMentionItem,
  MessageMentionPickerItem,
} from "../src/components/canvas-image-picker";
import { AddAssetPicker } from "../src/components/chat/add-asset-picker";
import { mentionFromPickerItem } from "../src/lib/mention-kinds";

afterEach(cleanup);

/** AG-03 第二入口：夹具只放「我的素材」两个 item，和 chat-sidebar 传的 brandKitMentionItems 同形。 */
const COLOR_ASSET: BrandKitMentionItem = {
  kind: "brand-kit-asset",
  id: "kit-color-1",
  label: "品牌色",
  assetType: "color",
  textContent: "#0b1f3a",
};

const LOGO_ASSET: BrandKitMentionItem = {
  kind: "brand-kit-asset",
  id: "kit-logo-1",
  label: "主 Logo",
  assetType: "logo",
  fileUrl: "https://example.test/logo.png",
};

const ITEMS: MessageMentionPickerItem[] = [COLOR_ASSET, LOGO_ASSET];

function renderPicker(items: MessageMentionPickerItem[] = ITEMS) {
  const onSelect = vi.fn();
  render(<AddAssetPicker items={items} onSelect={onSelect} />);
  return { onSelect };
}

describe("AddAssetPicker（AG-03 添加素材第二入口）", () => {
  it("AG-03: the add-asset button opens the asset list", async () => {
    const user = userEvent.setup();
    renderPicker();

    expect(screen.queryByText("品牌色")).toBeNull();

    await user.click(screen.getByTestId("chat-input-add-asset"));

    expect(screen.getByText("品牌色")).toBeInTheDocument();
    expect(screen.getByText("主 Logo")).toBeInTheDocument();
  });

  it("AG-03: picking from the button hands the very same item to the shared handler", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByTestId("chat-input-add-asset"));
    await user.click(screen.getByText("品牌色"));

    expect(onSelect.mock.calls).toHaveLength(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe(COLOR_ASSET);
    // 选完就关：列表项不再渲染。
    expect(screen.queryByText("品牌色")).toBeNull();
  });

  it("AG-03: both entries produce field-for-field the same mention", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker();

    await user.click(screen.getByTestId("chat-input-add-asset"));
    await user.click(screen.getByText("品牌色"));

    const fromButtonEntry = onSelect.mock.calls[0]?.[0] as
      | MessageMentionPickerItem
      | undefined;
    expect(fromButtonEntry).toBe(COLOR_ASSET);

    // @ 入口在 chat-sidebar 里对同一个 item 走的就是 mentionFromPickerItem。
    const atEntryMention = mentionFromPickerItem(COLOR_ASSET);
    const buttonEntryMention = mentionFromPickerItem(
      fromButtonEntry as MessageMentionPickerItem,
    );

    expect(atEntryMention).not.toBeNull();
    expect(buttonEntryMention).toEqual(atEntryMention);
    expect(buttonEntryMention).toEqual({
      mentionType: "brand-kit-asset",
      id: "kit-color-1",
      label: "品牌色",
      assetType: "color",
      textContent: "#0b1f3a",
    });
  });

  it("AG-03: no assets, no button action", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderPicker([]);

    const button = screen.getByTestId("chat-input-add-asset");
    expect(button).toBeDisabled();

    await user.click(button);

    expect(screen.queryByTestId("canvas-image-picker-item")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
