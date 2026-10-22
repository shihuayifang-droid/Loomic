import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * BL-45 / T-109（工单 39C）· 画布宿主把可用额度传给生成面板。
 *
 * 两个面板（39A 图片 / 39B 视频）各有一个可选 `availableCredits?: number | null`，
 * 不传就不询价。这里把两个面板换成只读探针，验的是 registry 的 `render`
 * 到底有没有把 ctx 里的额度映射成面板 props —— 真面板自己的询价逻辑由 39A / 39B 的用例覆盖。
 *
 * 第 4 条是源码断言（照 `no-upgrade-entry.test.ts` 读文本）：`CanvasToolMenu` 目前没有
 * 任何用例渲染它（`a11y-state.test.tsx` 只数 aria 属性行），渲染它要拖进 excalidraw 与
 * 整个 Provider 树，而这条要断言的是「宿主是从 useCredits 取的额度」。
 */

vi.mock("../src/components/canvas/image-generator-panel", () => ({
  ImageGeneratorPanel: (p: any) => (
    <div data-testid="canvas-image-generator-probe">
      {String(p.availableCredits)}
    </div>
  ),
}));

vi.mock("../src/components/canvas/video-generator-panel", () => ({
  VideoGeneratorPanel: (p: any) => (
    <div data-testid="canvas-video-generator-probe">
      {String(p.availableCredits)}
    </div>
  ),
}));

import { GENERATOR_SPECS } from "../src/components/canvas/generator-registry";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 一个 spec 的 `render` 结果节点，host 侧只做 `{active && spec.render(...)}`。 */
function renderSpecNode(kind: string, ctx: Record<string, unknown>) {
  const spec = GENERATOR_SPECS.find((s) => s.kind === kind);
  expect(spec).toBeDefined();
  const node = spec!.render({
    id: "e1",
    data: {},
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    ctx: {
      excalidrawApi: {},
      accessToken: "t",
      canvasScrollZoom: { scrollX: 0, scrollY: 0, zoom: 1 },
      onClose: () => {},
      ...ctx,
    } as any,
  });
  render(<>{node}</>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("T-109 generator registry forwards the available credits", () => {
  it("T-109: the image panel receives the available credits", () => {
    renderSpecNode("image", { availableCredits: 150 });
    expect(screen.getByTestId("canvas-image-generator-probe")).toHaveTextContent(
      "150",
    );
  });

  it("T-109: the video panel receives the available credits", () => {
    renderSpecNode("video", { availableCredits: 150 });
    expect(screen.getByTestId("canvas-video-generator-probe")).toHaveTextContent(
      "150",
    );
  });

  it("T-109: without credits in the context the panels get none", () => {
    renderSpecNode("image", {});
    // `undefined` 就是「宿主不知道」：面板据此整块关掉询价，而不是当成 0。
    expect(screen.getByTestId("canvas-image-generator-probe")).toHaveTextContent(
      "undefined",
    );
  });
});

describe("T-109 canvas tool menu reads the credits", () => {
  it("T-109: the tool menu passes the credits", () => {
    const source = fs.readFileSync(
      path.resolve(HERE, "../src/components/canvas-tool-menu.tsx"),
      "utf8",
    );
    // 宿主从 useCredits 取额度，并把它放进交给 spec.render 的 ctx 里。
    expect(source).toContain("useCredits()");
    expect(source).toContain("availableCredits");
    expect(source).toMatch(/ctx:\s*\{[^}]*availableCredits/s);
  });
});
