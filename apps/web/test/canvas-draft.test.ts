import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCanvasDraft,
  readCanvasDraft,
  writeCanvasDraft,
} from "../src/lib/canvas-draft";

/**
 * 工单 35M · CV-24 的本地草稿契约用例。
 *
 * `canvas-draft.ts` 是「保存前先写本地草稿、保存成功后清除、下次打开读回」的唯一实现，
 * 此前没有测试。七个用例按工单的字面量断言把契约钉住；这里只断言导出的行为，
 * **不碰实现**。
 *
 * jsdom 自带 `localStorage`，每例前清空，保证用例之间互不影响。
 */

const KEY_PREFIX = "loomic:canvas-draft:";

/** 一个最小的画布内容，只填本单关心的三块。 */
function content(
  elements: unknown[] = [{ id: "el-1" }],
  appState: Record<string, unknown> = { viewBackgroundColor: "#ffffff" },
  files: Record<string, unknown> = {},
) {
  return { elements, appState, files };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canvas-draft", () => {
  it("CV-24: a draft is stored per canvas and read back", () => {
    const payload = content([{ id: "el-1", x: 10 }], { zoom: 1 });

    expect(writeCanvasDraft("canvas-a", payload)).toBe(true);

    // 存的是按 canvasId 分键的草稿，key 前缀固定。
    expect(localStorage.getItem(`${KEY_PREFIX}canvas-a`)).not.toBeNull();

    const draft = readCanvasDraft("canvas-a");
    expect(draft).not.toBeNull();
    expect(draft!.content).toEqual(payload);
    expect(typeof draft!.savedAt).toBe("number");
    expect(draft!.filesOmitted).toBe(false);

    // 另一个画布没有草稿。
    expect(readCanvasDraft("canvas-b")).toBeNull();
  });

  it("CV-24: clearing removes only that canvas's draft", () => {
    writeCanvasDraft("canvas-a", content([{ id: "a" }]));
    writeCanvasDraft("canvas-b", content([{ id: "b" }]));

    clearCanvasDraft("canvas-a");

    expect(readCanvasDraft("canvas-a")).toBeNull();
    expect(localStorage.getItem(`${KEY_PREFIX}canvas-a`)).toBeNull();
    // canvas-b 的草稿还在。
    expect(readCanvasDraft("canvas-b")!.content.elements).toEqual([{ id: "b" }]);
  });

  it("CV-24: an oversized draft drops its files first", () => {
    const elements = [{ id: "el-1", x: 10 }];
    const payload = content(elements, { zoom: 1 }, {
      "file-1": { data: "x".repeat(2_100_000) },
    });

    expect(writeCanvasDraft("canvas-big", payload)).toBe(true);

    const draft = readCanvasDraft("canvas-big");
    expect(draft).not.toBeNull();
    // files 被丢掉，但 elements 保留。
    expect(draft!.filesOmitted).toBe(true);
    expect(draft!.content.files).toEqual({});
    expect(draft!.content.elements).toEqual(elements);
  });

  it("CV-24: a draft too big even without files is not stored", () => {
    // elements 本身就超过 2,000,000：丢掉 files 也救不回来。
    const payload = content([{ id: "el-1", data: "x".repeat(2_100_000) }]);

    expect(writeCanvasDraft("canvas-huge", payload)).toBe(false);
    expect(localStorage.getItem(`${KEY_PREFIX}canvas-huge`)).toBeNull();
    expect(readCanvasDraft("canvas-huge")).toBeNull();
  });

  it("CV-24: a malformed draft is discarded on read", () => {
    const key = `${KEY_PREFIX}canvas-a`;
    localStorage.setItem(key, JSON.stringify({ foo: 1 }));

    expect(readCanvasDraft("canvas-a")).toBeNull();
    // 读的时候顺手把这个坏条目删掉。
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("CV-24: unparsable JSON reads as no draft", () => {
    localStorage.setItem(`${KEY_PREFIX}canvas-a`, "{not json");

    expect(readCanvasDraft("canvas-a")).toBeNull();
  });

  it("CV-24: a storage failure does not throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });

    expect(() => writeCanvasDraft("canvas-a", content())).not.toThrow();
    expect(writeCanvasDraft("canvas-a", content())).toBe(false);
  });
});
