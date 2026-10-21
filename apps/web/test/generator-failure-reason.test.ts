import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lookupError } from "../src/lib/error-catalog";

/**
 * CV-02 失败态：画布上的元素必须写出「具体原因」，而且和面板显示的是同一句
 * 文案（同一个错误目录条目）。这里做源码断言 —— 两个面板挂载都要 Excalidraw
 * 上下文、WebSocket 与任务轮询，渲染类测试已覆盖流程（见
 * generation-error-actions.test.tsx / image-generator-cancel.test.tsx /
 * video-generator-cancel.test.tsx）。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function readPanel(file: string): string {
  return readFileSync(path.resolve(HERE, "..", "src", "components", "canvas", file), "utf8");
}

const PANELS = ["image-generator-panel.tsx", "video-generator-panel.tsx"] as const;

describe("CV-02 generator failure reason", () => {
  it("CV-02: the canvas element shows the same reason as the panel", () => {
    for (const file of PANELS) {
      const source = readPanel(file);
      // The element state now carries the catalogue copy instead of a fixed line.
      expect(source, `${file} should set errorMessage: reason`).toContain(
        "errorMessage: reason",
      );
      expect(source, `${file} should not hard-code 生成失败`).not.toContain(
        'errorMessage: "生成失败"',
      );
    }
  });

  it("CV-02: a timed-out job reads as a timeout", () => {
    expect(lookupError("timeout").message).toContain("超时");
  });
});
