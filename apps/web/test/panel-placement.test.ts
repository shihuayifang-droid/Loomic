import { describe, expect, it } from "vitest";

import {
  type PanelPlacement,
  type PanelSize,
  PANEL_GAP,
  type Rect,
  placePanel,
} from "../src/lib/panel-placement";

/**
 * ED-00d · 面板定位：右侧 → 左侧 → 下方，最后钳制回视口内。
 *
 * 每个用例都走同一条公用断言 `expectInsideViewport`（工单 30E §4 要求），
 * 所以「落在视口内」不是抽查，而是每条都查。唯一豁免是**面板比视口还大**那一例：
 * 那时两边不可能同时满足，按规格贴左上角。
 */

/** 公用断言：面板矩形必须完整落在视口矩形里。 */
function expectInsideViewport(
  placement: PanelPlacement,
  panel: PanelSize,
  viewport: Rect,
): void {
  expect(placement.x, "面板左边界不得超出视口左边").toBeGreaterThanOrEqual(viewport.x);
  expect(placement.y, "面板上边界不得超出视口上边").toBeGreaterThanOrEqual(viewport.y);
  expect(
    placement.x + panel.width,
    "面板右边界不得超出视口右边",
  ).toBeLessThanOrEqual(viewport.x + viewport.width);
  expect(
    placement.y + panel.height,
    "面板下边界不得超出视口下边",
  ).toBeLessThanOrEqual(viewport.y + viewport.height);
}

const VIEWPORT: Rect = { x: 0, y: 0, width: 1200, height: 800 };

describe("placePanel：三步选边", () => {
  it("gap 默认值是 8，且作为常量导出", () => {
    expect(PANEL_GAP).toBe(8);
    const anchor: Rect = { x: 100, y: 100, width: 200, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport: VIEWPORT });
    // 100 + 200 + 8
    expect(placement.x).toBe(308);
  });

  it("右侧放得下 → right，x = anchor.x + anchor.width + gap，y 与锚点顶端对齐", () => {
    const anchor: Rect = { x: 100, y: 100, width: 200, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport: VIEWPORT });
    expect(placement).toEqual({ side: "right", x: 308, y: 100 });
    expectInsideViewport(placement, panel, VIEWPORT);
  });

  it("验收 1：对象贴着画布右边缘 → 面板出现在左侧，且完整在视口内", () => {
    // 右边缘：950 + 200 = 1150，右侧再来 8 + 300 就出去了
    const anchor: Rect = { x: 950, y: 100, width: 200, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport: VIEWPORT });
    expect(placement.side).toBe("left");
    // 950 - 8 - 300
    expect(placement).toEqual({ side: "left", x: 642, y: 100 });
    expectInsideViewport(placement, panel, VIEWPORT);
  });

  it("两侧都放不下 → below，y = anchor.y + anchor.height + gap", () => {
    // 视口只有 600 宽：右侧 100+300+8+300=708 出去，左侧 100-8-300 为负
    const viewport: Rect = { x: 0, y: 0, width: 600, height: 800 };
    const anchor: Rect = { x: 100, y: 100, width: 300, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport });
    expect(placement).toEqual({ side: "below", x: 100, y: 258 });
    expectInsideViewport(placement, panel, viewport);
  });

  it("下方也放不下 → 仍是 below，但被钳制回视口内（下边界贴视口下边）", () => {
    const viewport: Rect = { x: 0, y: 0, width: 400, height: 400 };
    const anchor: Rect = { x: 100, y: 300, width: 200, height: 80 };
    const panel: PanelSize = { width: 250, height: 200 };
    const placement = placePanel({ anchor, panel, viewport });
    expect(placement.side).toBe("below");
    // 300 + 80 + 8 = 388 会溢出，钳到 400 - 200 = 200
    expect(placement.y).toBe(200);
    expect(placement.y + panel.height).toBe(400);
    expectInsideViewport(placement, panel, viewport);
  });

  it("右侧放得下但锚点贴着视口底部 → y 被钳制，side 仍是 right", () => {
    const anchor: Rect = { x: 100, y: 700, width: 100, height: 80 };
    const panel: PanelSize = { width: 200, height: 300 };
    const placement = placePanel({ anchor, panel, viewport: VIEWPORT });
    expect(placement.side).toBe("right");
    expect(placement.x).toBe(208);
    // 700 会溢出，钳到 800 - 300 = 500
    expect(placement.y).toBe(500);
    expectInsideViewport(placement, panel, VIEWPORT);
  });

  it("gap 生效：右侧与左侧都用传入的 gap，而不是写死的 8", () => {
    const anchor: Rect = { x: 100, y: 100, width: 200, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    const wide = placePanel({ anchor, panel, viewport: VIEWPORT, gap: 24 });
    expect(wide.side).toBe("right");
    expect(wide.x).toBe(100 + 200 + 24);

    // 左侧同理：950 - 24 - 300
    const edgeAnchor: Rect = { x: 950, y: 100, width: 200, height: 150 };
    const leftWide = placePanel({ anchor: edgeAnchor, panel, viewport: VIEWPORT, gap: 24 });
    expect(leftWide.side).toBe("left");
    expect(leftWide.x).toBe(626);
    // gap: 0 也生效（面板紧贴锚点）
    const flush = placePanel({ anchor, panel, viewport: VIEWPORT, gap: 0 });
    expect(flush.x).toBe(300);
  });

  it("gap 变大可能把 right 挤成 left：说明判定真的用了 gap", () => {
    // 右侧刚好只剩 8px 的空间：gap=8 放得下，gap=20 放不下
    const viewport: Rect = { x: 0, y: 0, width: 608, height: 800 };
    const anchor: Rect = { x: 0, y: 100, width: 300, height: 150 };
    const panel: PanelSize = { width: 300, height: 200 };
    // 0 + 300 + 8 + 300 = 608，正好贴边
    expect(placePanel({ anchor, panel, viewport, gap: 8 }).side).toBe("right");
    const wider = placePanel({ anchor, panel, viewport, gap: 20 });
    expect(wider.side).not.toBe("right");
    expectInsideViewport(wider, panel, viewport);
  });
});

describe("placePanel：视口不在原点", () => {
  it("viewport.x / y 不为 0 时，钳制用的是视口的绝对边界", () => {
    const viewport: Rect = { x: 1000, y: 500, width: 800, height: 600 };
    // 贴视口右边缘：1700 + 80 = 1780，右侧放不下
    const anchor: Rect = { x: 1700, y: 600, width: 80, height: 60 };
    const panel: PanelSize = { width: 280, height: 200 };
    const placement = placePanel({ anchor, panel, viewport });
    expect(placement.side).toBe("left");
    expect(placement.x).toBe(1412);
    expectInsideViewport(placement, panel, viewport);
  });
});

describe("placePanel：面板比视口还大（边界情况）", () => {
  it("按规格贴左上角，并在注释里说明只能溢出（视口比面板小，两边不可能同时满足）", () => {
    const viewport: Rect = { x: 0, y: 0, width: 200, height: 150 };
    const anchor: Rect = { x: 50, y: 40, width: 60, height: 30 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport });
    expect(placement).toEqual({ side: "below", x: 0, y: 0 });
  });

  it("宽超过视口、高没超过：x 贴左边，y 照常（两个轴各自独立钳制）", () => {
    const viewport: Rect = { x: 0, y: 0, width: 200, height: 800 };
    const anchor: Rect = { x: 20, y: 100, width: 40, height: 30 };
    const panel: PanelSize = { width: 300, height: 200 };
    const placement = placePanel({ anchor, panel, viewport });
    expect(placement.side).toBe("below");
    // 宽这一轴放不下 → 贴左边；高这一轴没超视口 → 用下方的 y（100 + 30 + 8）
    expect(placement.x).toBe(0);
    expect(placement.y).toBe(138);
    // 高这一轴仍然完整在视口内
    expect(placement.y + panel.height).toBeLessThanOrEqual(viewport.y + viewport.height);
  });
});

describe("placePanel：公用断言 at scale", () => {
  const scenarios: Array<{ name: string; anchor: Rect; panel: PanelSize; viewport: Rect }> = [
    {
      name: "右侧放得下",
      anchor: { x: 100, y: 100, width: 200, height: 150 },
      panel: { width: 300, height: 200 },
      viewport: VIEWPORT,
    },
    {
      name: "贴右边缘转左侧",
      anchor: { x: 950, y: 100, width: 200, height: 150 },
      panel: { width: 300, height: 200 },
      viewport: VIEWPORT,
    },
    {
      name: "两侧都放不下转下方",
      anchor: { x: 100, y: 100, width: 300, height: 150 },
      panel: { width: 300, height: 200 },
      viewport: { x: 0, y: 0, width: 600, height: 800 },
    },
    {
      name: "下方放不下被钳回来",
      anchor: { x: 100, y: 300, width: 200, height: 80 },
      panel: { width: 250, height: 200 },
      viewport: { x: 0, y: 0, width: 400, height: 400 },
    },
    {
      name: "锚点贴底 y 被钳",
      anchor: { x: 100, y: 700, width: 100, height: 80 },
      panel: { width: 200, height: 300 },
      viewport: VIEWPORT,
    },
    {
      name: "视口原点不为 0",
      anchor: { x: 1700, y: 600, width: 80, height: 60 },
      panel: { width: 280, height: 200 },
      viewport: { x: 1000, y: 500, width: 800, height: 600 },
    },
    {
      name: "锚点在视口外（负坐标）",
      anchor: { x: -120, y: -80, width: 60, height: 40 },
      panel: { width: 200, height: 160 },
      viewport: VIEWPORT,
    },
    {
      name: "小视口 + 大面板仍钳在视口内（两边都放得下才有意义的那一侧）",
      anchor: { x: 500, y: 200, width: 40, height: 40 },
      panel: { width: 320, height: 260 },
      viewport: { x: 0, y: 0, width: 900, height: 700 },
    },
  ];

  it.each(scenarios)("$name：结果完整落在视口内", ({ anchor, panel, viewport }) => {
    const placement = placePanel({ anchor, panel, viewport });
    expectInsideViewport(placement, panel, viewport);
    expect(["right", "left", "below"]).toContain(placement.side);
    // 坐标必须是有限数（不允许 NaN / Infinity 漏到 DOM 上）
    expect(Number.isFinite(placement.x)).toBe(true);
    expect(Number.isFinite(placement.y)).toBe(true);
  });
});
