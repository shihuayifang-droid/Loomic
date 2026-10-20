import { describe, expect, it } from "vitest";

import { mergeCanvasContent, mergeElementsById } from "../src/lib/canvas-merge";

/**
 * 工单 34S · CV-03 的客户端合并契约用例。
 *
 * `canvas-merge.ts` 是 CV-03「冲突返回 409 由客户端合并」的唯一实现，此前没有测试。
 * 六个用例按工单 T1–T6 的字面量断言把契约钉住；这里只断言纯函数，**不碰实现**。
 */

/** 一个最小的画布内容，只填本单关心的三块。 */
function content(
  elements: Record<string, unknown>[],
  appState: Record<string, unknown> = {},
  files: Record<string, Record<string, unknown>> = {},
) {
  return { elements, appState, files };
}

/** 取合并结果的 id 序列，用来断言「谁被保留了」和「顺序」。 */
function idsOf(elements: Record<string, unknown>[]): string[] {
  return elements.map((el) => el.id as string);
}

describe("mergeElementsById", () => {
  it("CV-03: an element only the other tab added is kept", () => {
    const theirs = [{ id: "A" }, { id: "B" }];
    const ours = [{ id: "A" }, { id: "C" }];

    const merged = mergeElementsById(theirs, ours);

    expect(idsOf(merged).sort()).toEqual(["A", "B", "C"]);
  });

  it("CV-03: for an element both sides have, ours wins", () => {
    const theirs = [{ id: "A", x: 99 }];
    const ours = [{ id: "A", x: 10 }];

    const merged = mergeElementsById(theirs, ours);

    expect(merged).toEqual([{ id: "A", x: 10 }]);
  });

  it("CV-03: elements without a string id are dropped and order follows the other side first", () => {
    const theirs = [{ id: "B" }, { id: "A" }];
    const ours = [{ id: "A" }, { id: "C" }, { x: 1 }];

    const merged = mergeElementsById(theirs, ours);

    expect(idsOf(merged)).toEqual(["B", "A", "C"]);
  });
});

describe("mergeCanvasContent", () => {
  it("CV-03: the Agent's new image and our rename of another image both survive", () => {
    const theirs = content([
      { id: "img1", customData: { title: "旧名" } },
      { id: "img2", customData: { title: "新图" } },
    ]);
    const ours = content([{ id: "img1", customData: { title: "新名" } }]);

    const merged = mergeCanvasContent(ours, theirs);

    expect(idsOf(merged.elements).sort()).toEqual(["img1", "img2"]);
    expect(merged.elements.find((el) => el.id === "img1")).toEqual({
      id: "img1",
      customData: { title: "新名" },
    });
  });

  it("CV-03: files from both sides are kept, ours winning on the same id", () => {
    const theirs = content([], {}, { f1: { v: 1 }, f2: { v: 2 } });
    const ours = content([], {}, { f1: { v: 9 } });

    const merged = mergeCanvasContent(ours, theirs);

    expect(merged.files).toEqual({ f1: { v: 9 }, f2: { v: 2 } });
  });

  it("CV-03: appState is ours", () => {
    const theirs = content([], { scrollX: 500, scrollY: 400 });
    const ours = content([], { scrollX: 12, scrollY: 34 });

    const merged = mergeCanvasContent(ours, theirs);

    expect(merged.appState).toEqual({ scrollX: 12, scrollY: 34 });
  });
});
