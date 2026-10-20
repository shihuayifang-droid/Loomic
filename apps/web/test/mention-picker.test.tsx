import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MessageMentionPicker,
  type MessageMentionPickerItem,
} from "../src/components/canvas-image-picker";

afterEach(cleanup);

/**
 * AG-02 第 3 步：@ 引用列表的分组与键盘操作（工单 37C）。
 * 夹具：1 张画布图 + 1 个素材 + 1 个模型，正好覆盖三组。
 */
const ITEMS: MessageMentionPickerItem[] = [
  {
    kind: "canvas-image",
    id: "img-1",
    name: "画布图 1",
    thumbnailUrl: "https://example.test/1-thumb.png",
    assetId: "asset-img-1",
    url: "https://example.test/1.png",
    mimeType: "image/png",
  },
  {
    kind: "brand-kit-asset",
    id: "kit-1",
    label: "品牌色",
    assetType: "color",
    textContent: "#ffffff",
  },
  {
    kind: "image-model",
    id: "model-1",
    label: "Imagen 4",
    description: "默认模型",
  },
];

function renderPicker(props: {
  items?: MessageMentionPickerItem[];
  query?: string;
} = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  // exactOptionalPropertyTypes：query 为空时整个属性都不传，不传 undefined。
  const queryProps = props.query === undefined ? {} : { query: props.query };
  render(
    <MessageMentionPicker
      items={props.items ?? ITEMS}
      {...queryProps}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose };
}

function activeItems(): HTMLElement[] {
  return screen
    .getAllByTestId("canvas-image-picker-item")
    .filter((el) => el.getAttribute("aria-selected") === "true");
}

describe("mention picker (AG-02)", () => {
  it("AG-02: the @ list is grouped as canvas objects, my assets and models", () => {
    renderPicker();

    const groups = screen.getAllByTestId("agent-mention-group");

    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "canvas-image",
      "brand-kit-asset",
      "image-model",
    ]);
    expect(groups.map((group) => group.textContent)).toEqual([
      expect.stringContaining("画布对象"),
      expect.stringContaining("我的素材"),
      expect.stringContaining("模型"),
    ]);
  });

  it("AG-02: the first item starts active", () => {
    renderPicker();

    const items = screen.getAllByTestId("canvas-image-picker-item");

    expect(items[0]!.getAttribute("aria-selected")).toBe("true");
    expect(items[0]!.getAttribute("data-active")).toBe("true");
    expect(items[1]!.getAttribute("aria-selected")).toBe("false");
  });

  it("AG-02: arrow keys move the selection and wrap", () => {
    renderPicker();

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(activeItems()).toHaveLength(1);
    expect(activeItems()[0]!.textContent).toContain("品牌色");

    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(activeItems()[0]!.textContent).toContain("画布图 1");

    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(activeItems()).toHaveLength(1);
    expect(activeItems()[0]!.textContent).toContain("Imagen 4");
  });

  it("AG-02: Enter inserts the active item", () => {
    const { onSelect, onClose } = renderPicker();

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toEqual(ITEMS[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AG-02: Escape closes without selecting", () => {
    const { onSelect, onClose } = renderPicker();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onSelect).toHaveBeenCalledTimes(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AG-02: Enter in the input picks the item instead of sending", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const submitSpy = vi.fn();
    // 模拟真实的输入框：它自己的 onKeyDown 遇到 Enter 会提交消息。
    render(
      <div>
        <textarea
          data-testid="fake-input"
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSpy();
          }}
        />
        <MessageMentionPicker
          items={ITEMS}
          onSelect={onSelect}
          onClose={onClose}
        />
      </div>,
    );

    fireEvent.keyDown(screen.getByTestId("fake-input"), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(0);
  });

  it("AG-02: empty states read in Chinese", () => {
    renderPicker({ items: [] });
    expect(screen.getByText("暂无可引用的内容")).toBeTruthy();

    cleanup();

    renderPicker({ query: "zzz" });
    expect(screen.getByText("没有匹配「zzz」的内容")).toBeTruthy();
  });
});
