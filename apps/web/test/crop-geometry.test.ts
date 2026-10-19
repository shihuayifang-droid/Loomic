import { describe, expect, it } from "vitest";

import {
  NOT_CROPPED_REASON,
  type CropRect,
  type Size,
  applyDimensions,
  cropSourceRect,
  doneDisabledReason,
  drawCrop,
  fitRatioRect,
  isFullImage,
  linkedHeight,
  linkedWidth,
  moveRect,
  resizeByHandle,
  validateDimension,
} from "../src/lib/crop-geometry";

/**
 * 工单 30J T5 · ED-02 的几何与校验用例。
 *
 * 三条规格验收（ED-02 验收 1/2/4）按工单原文逐字断言，其余是 §3-T5 点名的补充项。
 * 全部是纯函数，导出路径用「记录调用的假 ctx」（jsdom 没有 2D 上下文）。
 */

const SOURCE: Size = { width: 1254, height: 1254 };

/** 记录 `drawImage` 实参（除 image 之外）的假 ctx。 */
function makeDrawCtx(): {
  ctx: Pick<CanvasRenderingContext2D, "drawImage">;
  calls: number[][];
} {
  const calls: number[][] = [];
  const ctx = {
    drawImage: (...args: unknown[]): void => {
      calls.push(args.slice(1) as number[]);
    },
  } as unknown as Pick<CanvasRenderingContext2D, "drawImage">;
  return { ctx, calls };
}

describe("validateDimension（§3-T3 的三条文案逐字照规格）", () => {
  it("验收 2：原图宽 1254 时输入 W=2000 → 「不能超过原图宽度 1254」", () => {
    expect(validateDimension("2000", "width", 1254)).toEqual({
      ok: false,
      reason: "不能超过原图宽度 1254",
    });
  });

  it("超高的文案是「不能超过原图高度 {max}」", () => {
    expect(validateDimension("2000", "height", 800)).toEqual({
      ok: false,
      reason: "不能超过原图高度 800",
    });
  });

  it("0、负数、小数、空串、非数字都返回「必须是正整数」", () => {
    for (const raw of ["0", "-3", "-1", "12.5", "0.5", "", "  ", "abc", "1e3", "10px"]) {
      expect(validateDimension(raw, "width", 1254), `raw=${JSON.stringify(raw)}`).toEqual({
        ok: false,
        reason: "必须是正整数",
      });
    }
  });

  it("先判形状再判上限：大于上限的小数报「必须是正整数」而不是超限", () => {
    expect(validateDimension("2000.5", "width", 1254)).toEqual({
      ok: false,
      reason: "必须是正整数",
    });
  });

  it("合法值返回 ok 与整数（首尾空白被吃掉，等于上限也可以）", () => {
    expect(validateDimension("900", "width", 1254)).toEqual({ ok: true, value: 900 });
    expect(validateDimension(" 1254 ", "width", 1254)).toEqual({ ok: true, value: 1254 });
    expect(validateDimension("1", "height", 1254)).toEqual({ ok: true, value: 1 });
  });
});

describe("linkedHeight / linkedWidth（裁决 5：Math.round）", () => {
  it("验收 1：3:4 时 W 改为 900 → H 得 1200", () => {
    expect(linkedHeight(900, [3, 4])).toBe(1200);
  });

  it("反向：3:4 时 H 改为 1200 → W 得 900", () => {
    expect(linkedWidth(1200, [3, 4])).toBe(900);
  });

  it("取整规则是 Math.round(W * rh / rw)", () => {
    // 1000 * 4 / 3 = 1333.33 → 1333；1001 * 4 / 3 = 1334.66 → 1335
    expect(linkedHeight(1000, [3, 4])).toBe(1333);
    expect(linkedHeight(1001, [3, 4])).toBe(1335);
    expect(linkedHeight(1254, [1, 1])).toBe(1254);
    expect(linkedWidth(1000, [16, 9])).toBe(1778);
  });
});

describe("fitRatioRect（裁决 6：最大同比例矩形 + 居中）", () => {
  it("1254×1254 取 3:4 → {x:157,y:0,width:941,height:1254}", () => {
    // Math.round(1254*3/4) = Math.round(940.5) = 941；x = Math.round((1254-941)/2) = Math.round(156.5) = 157
    expect(fitRatioRect(SOURCE, [3, 4])).toEqual({ x: 157, y: 0, width: 941, height: 1254 });
  });

  it("ratio 为 null（通用）时返回整图", () => {
    expect(fitRatioRect(SOURCE, null)).toEqual({ x: 0, y: 0, width: 1254, height: 1254 });
  });

  it("1:1 在 1600×900 上取最大正方形并居中", () => {
    expect(fitRatioRect({ width: 1600, height: 900 }, [1, 1])).toEqual({
      x: 350,
      y: 0,
      width: 900,
      height: 900,
    });
  });

  it("16:9 在方图上先按宽贴满，高按比例取整，竖直居中", () => {
    // 宽贴满 1254 → 高 = round(1254*9/16) = round(705.375) = 705 → y = round((1254-705)/2) = 275
    const rect = fitRatioRect(SOURCE, [16, 9]);
    expect(rect).toEqual({ x: 0, y: 275, width: 1254, height: 705 });
    expect(rect.x + rect.width).toBeLessThanOrEqual(SOURCE.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(SOURCE.height);
  });
});

describe("applyDimensions（裁决 7：保持左上角，超出就往回平移）", () => {
  it("放得下时左上角一点不动", () => {
    expect(applyDimensions({ x: 10, y: 20, width: 100, height: 100 }, 300, 400, SOURCE)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 400,
    });
  });

  it("超出右边/下边时整体往左/往上平移，直到放进原图", () => {
    expect(applyDimensions({ x: 900, y: 900, width: 100, height: 100 }, 600, 800, SOURCE)).toEqual({
      x: 654,
      y: 454,
      width: 600,
      height: 800,
    });
  });

  it("大于原图时先夹到原图尺寸", () => {
    expect(applyDimensions({ x: 0, y: 0, width: 100, height: 100 }, 5000, 5000, SOURCE)).toEqual({
      x: 0,
      y: 0,
      width: 1254,
      height: 1254,
    });
  });
});

describe("moveRect（整体平移，夹边不改尺寸）", () => {
  it("普通平移", () => {
    expect(moveRect({ x: 100, y: 100, width: 200, height: 200 }, 50, -30, SOURCE)).toEqual({
      x: 150,
      y: 70,
      width: 200,
      height: 200,
    });
  });

  it("夹边：向左上撞到 0，向右下撞到原图右下角，尺寸不变", () => {
    const rect: CropRect = { x: 10, y: 10, width: 100, height: 100 };
    expect(moveRect(rect, -500, -500, SOURCE)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(moveRect(rect, 5000, 5000, SOURCE)).toEqual({
      x: 1154,
      y: 1154,
      width: 100,
      height: 100,
    });
  });

  it("位移是小数时结果是整数（导出要求整数原图像素）", () => {
    const moved = moveRect({ x: 0, y: 0, width: 100, height: 100 }, 10.6, 4.4, SOURCE);
    expect(Number.isInteger(moved.x)).toBe(true);
    expect(moved.x).toBe(11);
  });
});

describe("resizeByHandle（8 个手柄，含夹边）", () => {
  /** 1000×800 的原图，400×300 的框放在 (100,100) —— 四个方向都有余量。 */
  const SRC: Size = { width: 1000, height: 800 };
  const RECT: CropRect = { x: 100, y: 100, width: 400, height: 300 };

  const cases: ReadonlyArray<readonly [string, CropRect]> = [
    ["e", { x: 100, y: 100, width: 450, height: 300 }],
    ["w", { x: 150, y: 100, width: 350, height: 300 }],
    ["s", { x: 100, y: 100, width: 400, height: 350 }],
    ["n", { x: 100, y: 150, width: 400, height: 250 }],
    ["se", { x: 100, y: 100, width: 450, height: 350 }],
    ["sw", { x: 150, y: 100, width: 350, height: 350 }],
    ["ne", { x: 100, y: 150, width: 450, height: 250 }],
    ["nw", { x: 150, y: 150, width: 350, height: 250 }],
  ];

  for (const [handle, expected] of cases) {
    it(`手柄 ${handle}：位移 (+50,+50) → ${JSON.stringify(expected)}`, () => {
      const next = resizeByHandle(
        RECT,
        handle as "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
        50,
        50,
        SRC,
        null,
      );
      expect(next).toEqual(expected);
    });
  }

  it("夹边：右下角拖出原图 → 宽高停在原图边界上", () => {
    // 右边已经在 900、下边在 700，再各拖 500 只能到 1000 / 800
    const rect: CropRect = { x: 600, y: 500, width: 300, height: 200 };
    expect(resizeByHandle(rect, "se", 500, 500, SRC, null)).toEqual({
      x: 600,
      y: 500,
      width: 400,
      height: 300,
    });
  });

  it("夹边：左边手柄拖过头时宽最小为 1，右边不动", () => {
    const rect: CropRect = { x: 0, y: 0, width: 100, height: 100 };
    expect(resizeByHandle(rect, "w", 500, 0, SRC, null)).toEqual({
      x: 99,
      y: 0,
      width: 1,
      height: 100,
    });
  });

  it("有比例时角手柄以宽为准联动高（dy 被忽略）", () => {
    const rect: CropRect = { x: 0, y: 0, width: 300, height: 400 };
    const next = resizeByHandle(rect, "se", 30, 999, SRC, [3, 4]);
    expect(next).toEqual({ x: 0, y: 0, width: 330, height: 440 });
  });

  it("有比例时边手柄只动那一条边，另一轴按比例联动并以框中心对齐", () => {
    const rect: CropRect = { x: 100, y: 200, width: 300, height: 400 };
    // e：宽 300 → 330，高联动成 440，垂直方向仍以原中心 (200+200=400) 对齐
    expect(resizeByHandle(rect, "e", 30, 0, SRC, [3, 4])).toEqual({
      x: 100,
      y: 180,
      width: 330,
      height: 440,
    });
    // s：高 400 → 440，宽联动成 330，水平方向仍以原中心 (100+150=250) 对齐
    expect(resizeByHandle(rect, "s", 0, 40, SRC, [3, 4])).toEqual({
      x: 85,
      y: 200,
      width: 330,
      height: 440,
    });
  });
});

describe("isFullImage / doneDisabledReason（裁决 8 的优先级）", () => {
  const FULL: CropRect = { x: 0, y: 0, width: 1254, height: 1254 };
  const CROPPED: CropRect = { x: 157, y: 0, width: 941, height: 1254 };

  it("isFullImage 只认「原点 + 整图尺寸」", () => {
    expect(isFullImage(FULL, SOURCE)).toBe(true);
    expect(isFullImage(CROPPED, SOURCE)).toBe(false);
    expect(isFullImage({ ...FULL, x: 1 }, SOURCE)).toBe(false);
    expect(isFullImage({ ...FULL, width: 1253 }, SOURCE)).toBe(false);
  });

  it("宽非法优先于高非法：两个都非法时报宽的原因", () => {
    expect(doneDisabledReason("0", "abc", CROPPED, SOURCE)).toBe("必须是正整数");
    expect(doneDisabledReason("2000", "2000", CROPPED, SOURCE)).toBe("不能超过原图宽度 1254");
  });

  it("宽合法、高非法时报高的原因", () => {
    expect(doneDisabledReason("900", "abc", CROPPED, SOURCE)).toBe("必须是正整数");
    expect(doneDisabledReason("900", "2000", CROPPED, SOURCE)).toBe("不能超过原图高度 1254");
  });

  it("宽高都合法、但框等于整图 → 「未做裁剪」；非法原因优先于它", () => {
    expect(doneDisabledReason("1254", "1254", FULL, SOURCE)).toBe(NOT_CROPPED_REASON);
    expect(NOT_CROPPED_REASON).toBe("未做裁剪");
    // 同样的整图，但输入框非法 → 先报输入问题
    expect(doneDisabledReason("0", "1254", FULL, SOURCE)).toBe("必须是正整数");
  });

  it("宽高都合法且已裁剪 → null（可以点）", () => {
    expect(doneDisabledReason("941", "1254", CROPPED, SOURCE)).toBeNull();
  });
});

describe("cropSourceRect / drawCrop（验收 4：导出尺寸 = 裁剪框尺寸）", () => {
  it("给定 600×800 的 rect，cropSourceRect 记录到 600×800", () => {
    const rect: CropRect = { x: 10, y: 20, width: 600, height: 800 };
    expect(cropSourceRect(rect)).toEqual({ x: 10, y: 20, width: 600, height: 800 });
  });

  it("给定 600×800 的 rect，假 ctx 的 drawImage 记录到 600×800", () => {
    const rect: CropRect = { x: 10, y: 20, width: 600, height: 800 };
    const { ctx, calls } = makeDrawCtx();

    drawCrop(ctx, {} as unknown as CanvasImageSource, rect);

    expect(calls).toHaveLength(1);
    // 源矩形 (x, y, w, h) + 目标矩形 (0, 0, w, h)
    expect(calls[0]).toEqual([10, 20, 600, 800, 0, 0, 600, 800]);
  });

  it("小数坐标在导出前被取整（拖动过程的中间态可能出现小数）", () => {
    const rect: CropRect = { x: 10.4, y: 20.6, width: 599.5, height: 800.2 };
    expect(cropSourceRect(rect)).toEqual({ x: 10, y: 21, width: 600, height: 800 });
  });
});
