import { describe, expect, it } from "vitest";

import { fitResultIntoSlot } from "../src/lib/fit-result";

/**
 * 工单 36X：GN-02 ⑤「回填按产物实际宽高比放图」。
 *
 * 占位框是按**请求**的比例画的，上游却常把请求吸附到自己的固定尺寸
 * （kwjm 只有 1024²、1536×1024、1024×1536），于是返回图的形状和框不一样。
 * `fitResultIntoSlot` 只做一件事：等比 contain + 居中，绝不拉伸。
 */

describe("fitResultIntoSlot", () => {
  it("GN-02: a result of the same shape fills the slot", () => {
    const slot = { x: 0, y: 0, width: 512, height: 512 };
    expect(fitResultIntoSlot(slot, { width: 1024, height: 1024 })).toEqual(slot);
  });

  it("GN-02: a wider result is letterboxed, not stretched", () => {
    const placed = fitResultIntoSlot(
      { x: 0, y: 0, width: 512, height: 512 },
      { width: 1536, height: 1024 },
    );
    expect(placed.x).toBe(0);
    expect(placed.width).toBe(512);
    expect(placed.y).toBeCloseTo(85.33333333333333);
    expect(placed.height).toBeCloseTo(341.3333333333333);
  });

  it("GN-02: a taller result is pillarboxed", () => {
    const placed = fitResultIntoSlot(
      { x: 0, y: 0, width: 512, height: 512 },
      { width: 1024, height: 1536 },
    );
    expect(placed.y).toBe(0);
    expect(placed.height).toBe(512);
    expect(placed.x).toBeCloseTo(85.33333333333333);
    expect(placed.width).toBeCloseTo(341.3333333333333);
  });

  it("GN-02: the slot position is kept", () => {
    const slot = { x: 100, y: 200, width: 400, height: 300 };
    expect(fitResultIntoSlot(slot, { width: 800, height: 600 })).toEqual(slot);
  });

  it("GN-02: an unknown result size keeps the slot", () => {
    const slot = { x: 0, y: 0, width: 512, height: 512 };
    expect(fitResultIntoSlot(slot, {})).toEqual(slot);
    expect(fitResultIntoSlot(slot, { width: 0, height: 10 })).toEqual(slot);
  });
});
