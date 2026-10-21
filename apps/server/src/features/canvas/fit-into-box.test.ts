import { describe, expect, it } from "vitest";

import { fitIntoBox } from "./fit-into-box.js";

/**
 * 工单 37H：GN-02 ⑤「回填按产物实际宽高比放」—— server 侧。
 *
 * 占位框是按**请求**的比例画的，上游却常把请求吸附到自己的固定尺寸，于是
 * 返回产物的形状和框不一样。`fitIntoBox` 只做一件事：等比 contain + 居中，
 * 绝不拉伸。数据与 web `test/fit-result.test.ts`（36X）同组。
 */

describe("fitIntoBox", () => {
  it("GN-02: content of the same shape fills the box", () => {
    const box = { x: 0, y: 0, width: 512, height: 512 };
    expect(fitIntoBox(box, { width: 1024, height: 1024 })).toEqual(box);
  });

  it("GN-02: wider content is letterboxed, not stretched", () => {
    const placed = fitIntoBox(
      { x: 0, y: 0, width: 512, height: 512 },
      { width: 1536, height: 1024 },
    );
    expect(placed.x).toBe(0);
    expect(placed.width).toBe(512);
    expect(placed.y).toBeCloseTo(85.33333333333333);
    expect(placed.height).toBeCloseTo(341.3333333333333);
  });

  it("GN-02: taller content is pillarboxed", () => {
    const placed = fitIntoBox(
      { x: 0, y: 0, width: 512, height: 512 },
      { width: 1024, height: 1536 },
    );
    expect(placed.y).toBe(0);
    expect(placed.height).toBe(512);
    expect(placed.x).toBeCloseTo(85.33333333333333);
    expect(placed.width).toBeCloseTo(341.3333333333333);
  });

  it("GN-02: a portrait video inside a landscape box keeps the box corner", () => {
    const placed = fitIntoBox(
      { x: 100, y: 50, width: 640, height: 360 },
      { width: 1080, height: 1920 },
    );
    expect(placed.height).toBe(360);
    expect(placed.width).toBeCloseTo(202.5);
    expect(placed.x).toBeCloseTo(318.75);
    expect(placed.y).toBe(50);
  });

  it("GN-02: an unknown content size keeps the box", () => {
    const box = { x: 0, y: 0, width: 512, height: 512 };
    expect(fitIntoBox(box, {})).toEqual(box);
    expect(fitIntoBox(box, { width: null, height: 720 })).toEqual(box);
    expect(fitIntoBox(box, { width: 0, height: 10 })).toEqual(box);
  });
});
