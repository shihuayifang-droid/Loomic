import { describe, expect, it } from "vitest";

import { TOOLBAR_HEIGHT } from "../src/components/canvas/image-toolbar";
import { TOOLBAR_MARGIN, imageToolbarPosition } from "../src/lib/toolbar-position";

/**
 * 工单 30Q §5 · `imageToolbarPosition`。
 *
 * 这个文件只测纯函数：jsdom 里工具条宽度恒为 0，真实定位必须在浏览器里看，
 * 所以工单 §5 明写「测试只测纯函数」。
 *
 * 几个数值的来处（`el = {x:100, y:200, width:80, height:60}`，zoom 1，scroll 0）：
 * - 外接框中心 = `(100 + 80/2, 200 + 60/2)` = `(140, 230)`；
 * - 未旋转时半宽 40、半高 30 → 上沿 200 → 工具条上沿 `200 − 8 − 44` = **148**；
 * - 工具条宽度传 0 时 `x` 就等于外接框中心 140（居中减去自身宽度的一半）。
 */

/** 基准元素：100×200 起、80×60 大小、未旋转。 */
const ELEMENT = { x: 100, y: 200, width: 80, height: 60, angle: 0 };

/** 把「工具条上沿」从结果里还原出来，方便断言缩放是线性放大的。 */
function topEdgeOf(position: { y: number }): number {
  return position.y + TOOLBAR_MARGIN + TOOLBAR_HEIGHT;
}

describe("imageToolbarPosition（ED-00a 跟随定位）", () => {
  it("未旋转时放在上方、水平居中，坐标按 (scene + scroll) * zoom 换算", () => {
    const position = imageToolbarPosition({
      el: ELEMENT,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });

    // x = 外接框中心 − 工具条半宽（这里是 0）
    expect(position.x).toBe(140);
    // y = 外接框上沿 200 − 间距 8 − 工具条高度 44
    expect(position.y).toBe(200 - TOOLBAR_MARGIN - TOOLBAR_HEIGHT);
    expect(position.placement).toBe("above");
  });

  it("scroll 与 zoom 一起参与换算（不是只乘 zoom，也不是只加 scroll）", () => {
    const position = imageToolbarPosition({
      el: ELEMENT,
      scrollX: -40,
      scrollY: 30,
      zoom: 1.5,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });

    // 中心 x = (140 + (−40)) * 1.5 = 150；中心 y = (230 + 30) * 1.5 = 390
    expect(position.x).toBe(150);
    // 上沿 = 390 − 30 * 1.5 = 345 → 345 − 8 − 44
    expect(topEdgeOf(position)).toBe(345);
    expect(position.placement).toBe("above");
  });

  it("贴近顶部时改放到图片下方，placement = below", () => {
    const position = imageToolbarPosition({
      el: { x: 100, y: 0, width: 80, height: 60, angle: 0 },
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });

    // 上沿 0 → 上方位置是 0 − 52 < 8，翻到下方：下沿 60 + 8
    expect(position.placement).toBe("below");
    expect(position.y).toBe(68);
    // x 不受上下翻转影响
    expect(position.x).toBe(140);
  });

  it("左边缘与右边缘都会被夹住（工具条不越出视口）", () => {
    const left = imageToolbarPosition({
      el: { x: 0, y: 400, width: 20, height: 20, angle: 0 },
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 200,
    });
    // 居中位置 = 10 − 100 = −90 → 夹到左边界 8
    expect(left.x).toBe(TOOLBAR_MARGIN);

    const right = imageToolbarPosition({
      el: { x: 900, y: 400, width: 20, height: 20, angle: 0 },
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 200,
    });
    // 居中位置 = 910 − 100 = 810 → 右边界 1000 − 200 − 8 = 792
    expect(right.x).toBe(1000 - 200 - TOOLBAR_MARGIN);
  });

  it("旋转 90° 时外接框宽高互换，位置随之变化", () => {
    const unrotated = imageToolbarPosition({
      el: ELEMENT,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });
    const rotated = imageToolbarPosition({
      el: { ...ELEMENT, angle: Math.PI / 2 },
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });

    // 半高从 30（60/2）变成 40（80/2）：上沿从 200 抬到 190，工具条跟着上移 10。
    expect(topEdgeOf(unrotated)).toBe(200);
    expect(topEdgeOf(rotated)).toBe(190);
    expect(rotated.y).toBe(unrotated.y - 10);
    // 居中对齐只看外接框中心，而中心在旋转下不变 —— 所以 x 不动是**预期**，不是漏算。
    expect(rotated.x).toBe(unrotated.x);
  });

  it("旋转会改变翻到下方时的位置（矮宽元素转 90° 后下沿从 10 变成 105）", () => {
    const wide = { x: 0, y: 0, width: 200, height: 10, angle: 0 };
    const unrotated = imageToolbarPosition({
      el: wide,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });
    const rotated = imageToolbarPosition({
      el: { ...wide, angle: Math.PI / 2 },
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 1000,
      toolbarWidth: 0,
    });

    // 两种情况都放不下（上沿贴 0），都翻到下方；但下沿从 10 变成 200。
    expect(unrotated.placement).toBe("below");
    expect(rotated.placement).toBe("below");
    expect(unrotated.y).toBe(10 + TOOLBAR_MARGIN);
    // 旋转绕**元素中心**（x + w/2, y + h/2）= (100, 5) 进行，所以下沿 = 5 + 200/2 = 105。
    expect(rotated.y).toBe(105 + TOOLBAR_MARGIN);
  });

  it("zoom 为 2 时坐标翻倍（间距与工具条高度是常量，不跟着放大）", () => {
    const base = {
      el: ELEMENT,
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 10000,
      toolbarWidth: 0,
    };
    const atOne = imageToolbarPosition({ ...base, zoom: 1 });
    const atTwo = imageToolbarPosition({ ...base, zoom: 2 });

    // 工具条宽度为 0 时 x 就是外接框中心，纯线性
    expect(atTwo.x).toBe(atOne.x * 2);
    // 上沿同样是纯线性；8 与 44 是常量，所以从「上沿」还原出来比才相等
    expect(topEdgeOf(atTwo)).toBe(topEdgeOf(atOne) * 2);
  });

  it("工具条比视口还宽时贴左边，不返回负数", () => {
    const position = imageToolbarPosition({
      el: ELEMENT,
      scrollX: 0,
      scrollY: 0,
      zoom: 1,
      viewportWidth: 100,
      toolbarWidth: 400,
    });

    expect(position.x).toBe(TOOLBAR_MARGIN);
  });
});
