import { describe, expect, it } from "vitest";

import {
  type FlipRotateState,
  drawTransformed,
  fromElementTransform,
  normalizeAngle,
  parseAngleInput,
  rotateStep,
  toElementTransform,
  toggleFlip,
  transformedFileName,
  transformedSize,
} from "../src/lib/flip-rotate";

/**
 * 工单 30J T5 · ED-03 的纯函数用例。
 *
 * 全部是纯函数，**不碰 canvas**（jsdom 没有 2D 上下文，`getContext("2d")` 返回 null）：
 * 导出路径用「记录调用的假 ctx」断言，见 `drawTransformed` 那组。
 */

const BASE: FlipRotateState = { angle: 0, flipH: false, flipV: false };

/** `setTransform` 的 6 个参数，顺序同画布 `(a, b, c, d, e, f)`。 */
type TransformCall = [number, number, number, number, number, number];

/**
 * 记录调用的假 ctx。
 *
 * 用 `...args` 收参数再整体造型：`drawImage` 在 TS 里是重载（4/5/9 参），
 * 写死 9 个形参的话，走到 5 参重载时后 4 个是 `undefined`，断言里就得比一堆 `undefined`。
 * 这里只记「除 image 之外的实参」，断言才和真实调用形状一一对应。
 */
function makeFakeCtx(): {
  ctx: Pick<CanvasRenderingContext2D, "setTransform" | "drawImage">;
  setTransformCalls: TransformCall[];
  drawImageCalls: number[][];
} {
  const setTransformCalls: TransformCall[] = [];
  const drawImageCalls: number[][] = [];
  const ctx = {
    setTransform: (...args: number[]): void => {
      setTransformCalls.push(args as TransformCall);
    },
    drawImage: (...args: unknown[]): void => {
      drawImageCalls.push(args.slice(1) as number[]);
    },
  } as unknown as Pick<CanvasRenderingContext2D, "setTransform" | "drawImage">;
  return { ctx, setTransformCalls, drawImageCalls };
}

describe("normalizeAngle", () => {
  it("负数和超过一圈的数都落到 [0, 360)", () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(90)).toBe(90);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(-360)).toBe(0);
    expect(normalizeAngle(725)).toBe(5);
  });

  it("不返回 -0（快照断言里 -0 和 0 长得不一样）", () => {
    expect(Object.is(normalizeAngle(-0), -0)).toBe(false);
    expect(Object.is(normalizeAngle(-360), 0)).toBe(true);
  });
});

describe("parseAngleInput（裁决 1：以验收为准，任意整数取模）", () => {
  /**
   * 工单 §3-T5 点名的 8 条 + 追加的边界。
   * `null` = 非法，调用方负责把输入框恢复成原值。
   */
  const cases: ReadonlyArray<readonly [string, number | null]> = [
    ["450", 90],
    ["-90", 270],
    ["360", 0],
    ["90°", 90],
    [" 45 ", 45],
    ["12.5", null],
    ["", null],
    ["abc", null],
    // 追加：符号 / 多圈 / 只有单位 / 科学计数 / 空白夹在数字与单位之间
    ["0", 0],
    ["-450", 270],
    ["900", 180],
    ["+45", 45],
    ["-0", 0],
    ["°", null],
    ["45 °", null],
    ["   ", null],
    ["1e3", null],
    ["90°°", null],
  ];

  for (const [raw, expected] of cases) {
    it(`parseAngleInput(${JSON.stringify(raw)}) === ${String(expected)}`, () => {
      expect(parseAngleInput(raw)).toBe(expected);
    });
  }

  it("返回值一定已归一：落在 [0, 360) 里的整数", () => {
    for (const raw of ["-1000", "-1", "0", "1", "359", "360", "721"]) {
      const parsed = parseAngleInput(raw);
      expect(parsed).not.toBeNull();
      expect(Number.isInteger(parsed as number)).toBe(true);
      expect(parsed as number).toBeGreaterThanOrEqual(0);
      expect(parsed as number).toBeLessThan(360);
    }
  });
});

describe("rotateStep / toggleFlip", () => {
  it("连续 4 次 rotateStep 回到 0", () => {
    let state: FlipRotateState = BASE;
    const angles: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = rotateStep(state);
      angles.push(state.angle);
    }
    expect(angles).toEqual([90, 180, 270, 0]);
  });

  it("rotateStep 在 350° 上跨圈归一（350 + 90 = 80）", () => {
    expect(rotateStep({ ...BASE, angle: 350 }).angle).toBe(80);
  });

  it("toggleFlip 只翻对应的那一轴，且不改角度", () => {
    expect(toggleFlip(BASE, "h")).toEqual({ angle: 0, flipH: true, flipV: false });
    expect(toggleFlip(BASE, "v")).toEqual({ angle: 0, flipH: false, flipV: true });
    expect(toggleFlip({ ...BASE, angle: 90 }, "h")).toEqual({ angle: 90, flipH: true, flipV: false });
    // 连按两次回到原样
    expect(toggleFlip(toggleFlip(BASE, "v"), "v")).toEqual(BASE);
  });
});

describe("toElementTransform / fromElementTransform", () => {
  it("flipH → scale[0] = -1、flipV → scale[1] = -1，角度转弧度", () => {
    expect(toElementTransform({ angle: 0, flipH: false, flipV: false })).toEqual({
      angle: 0,
      scale: [1, 1],
    });
    expect(toElementTransform({ angle: 90, flipH: true, flipV: false })).toEqual({
      angle: Math.PI / 2,
      scale: [-1, 1],
    });
    expect(toElementTransform({ angle: 180, flipH: false, flipV: true })).toEqual({
      angle: Math.PI,
      scale: [1, -1],
    });
    expect(toElementTransform({ angle: 270, flipH: true, flipV: true }).scale).toEqual([-1, -1]);
  });

  it("往返：4 个角度 × 4 种翻转组合共 16 组，逐组还原", () => {
    const angles = [0, 90, 180, 270];
    let checked = 0;
    for (const angle of angles) {
      for (const flipH of [false, true]) {
        for (const flipV of [false, true]) {
          const state: FlipRotateState = { angle, flipH, flipV };
          expect(fromElementTransform(toElementTransform(state))).toEqual(state);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(16);
  });

  it("弧度转度会取整（90° 的反算是 90.00000000000001，不取整就带小数）", () => {
    const state = fromElementTransform({ angle: Math.PI / 2, scale: [1, 1] });
    expect(state.angle).toBe(90);
    expect(Number.isInteger(state.angle)).toBe(true);
  });
});

describe("transformedFileName（裁决 2：_flipH → _flipV → _rot{角度}）", () => {
  it("只 flipH：cat.png → cat_flipH.png", () => {
    expect(transformedFileName("cat.png", { angle: 0, flipH: true, flipV: false })).toBe(
      "cat_flipH.png",
    );
  });

  it("flipH + 旋转 90°：cat.png → cat_flipH_rot90.png", () => {
    expect(transformedFileName("cat.png", { angle: 90, flipH: true, flipV: false })).toBe(
      "cat_flipH_rot90.png",
    );
  });

  it("没有任何变换时得到原文件名（不拼 _rot0）", () => {
    expect(transformedFileName("cat.png", BASE)).toBe("cat.png");
    expect(transformedFileName("cat.jpg", { angle: 0, flipH: false, flipV: false })).toBe("cat.jpg");
  });

  it("没有扩展名时后缀直接接在末尾", () => {
    expect(transformedFileName("cat", { angle: 90, flipH: false, flipV: false })).toBe("cat_rot90");
    expect(transformedFileName("cat", { angle: 0, flipH: false, flipV: true })).toBe("cat_flipV");
  });

  it("三项变换按固定顺序拼接，扩展名留在最后", () => {
    expect(transformedFileName("cat.png", { angle: 270, flipH: true, flipV: true })).toBe(
      "cat_flipH_flipV_rot270.png",
    );
    // 裁决 3：flipH + flipV 不合并成 180°，按字面状态拼两段
    expect(transformedFileName("cat.webp", { angle: 0, flipH: true, flipV: true })).toBe(
      "cat_flipH_flipV.webp",
    );
  });
});

describe("transformedSize（外接矩形）", () => {
  it("0° / 180° 宽高不变；90° / 270° 宽高互换", () => {
    expect(transformedSize(1254, 800, 0)).toEqual({ width: 1254, height: 800 });
    expect(transformedSize(1254, 800, 90)).toEqual({ width: 800, height: 1254 });
    expect(transformedSize(1254, 800, 180)).toEqual({ width: 1254, height: 800 });
    expect(transformedSize(1254, 800, 270)).toEqual({ width: 800, height: 1254 });
  });

  it("45° 时按 |w·cos| + |h·sin| 取整（1254×800 → 1452×1452）", () => {
    // 2054 * cos(45°) = 1452.397… → 取整 1452；两个方向同式所以相等。
    const size = transformedSize(1254, 800, 45);
    expect(size).toEqual({ width: 1452, height: 1452 });
    // 取整后仍是整数（不是 1452.397… 这种）
    expect(Number.isInteger(size.width)).toBe(true);
  });
});

describe("drawTransformed（导出：一次 setTransform + 一次 drawImage）", () => {
  const IMAGE = {} as unknown as CanvasImageSource;
  const W = 1254;
  const H = 800;

  it("1254×800、90°：输出尺寸 800×1254，矩阵把 4 个角都映射进输出框（误差 ≤ 1e-6）", () => {
    const { ctx, setTransformCalls, drawImageCalls } = makeFakeCtx();
    drawTransformed(ctx, IMAGE, W, H, { angle: 90, flipH: false, flipV: false });

    expect(setTransformCalls).toHaveLength(1);
    expect(drawImageCalls).toHaveLength(1);
    // 以原图中心为原点画，所以参数是 (-w/2, -h/2, w, h)
    expect(drawImageCalls[0]).toEqual([-W / 2, -H / 2, W, H]);

    const [a, b, c, d, e, f] = setTransformCalls[0] as TransformCall;
    const out = transformedSize(W, H, 90);
    expect(out).toEqual({ width: 800, height: 1254 });

    const halfW = W / 2;
    const halfH = H / 2;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [-halfW, halfH],
      [halfW, halfH],
    ];
    const EPS = 1e-6;
    for (const [x, y] of corners) {
      // 画布约定：x' = a·x + c·y + e、y' = b·x + d·y + f
      const tx = a * x + c * y + e;
      const ty = b * x + d * y + f;
      expect(tx, `x 越界：(${x},${y}) → ${tx}`).toBeGreaterThanOrEqual(-EPS);
      expect(tx, `x 越界：(${x},${y}) → ${tx}`).toBeLessThanOrEqual(out.width + EPS);
      expect(ty, `y 越界：(${x},${y}) → ${ty}`).toBeGreaterThanOrEqual(-EPS);
      expect(ty, `y 越界：(${x},${y}) → ${ty}`).toBeLessThanOrEqual(out.height + EPS);
    }
  });

  it("0° 不旋转：矩阵是纯平移（a=1、b=0、c=0、d=1），平移量是输出中心", () => {
    const { ctx, setTransformCalls } = makeFakeCtx();
    drawTransformed(ctx, IMAGE, W, H, BASE);

    const [a, b, c, d, e, f] = setTransformCalls[0] as TransformCall;
    // `-sin(0)` 在 JS 里是 -0，所以用数值接近而不是字符串相等来断言。
    expect(a).toBeCloseTo(1, 10);
    expect(b).toBeCloseTo(0, 10);
    expect(c).toBeCloseTo(0, 10);
    expect(d).toBeCloseTo(1, 10);
    expect(e).toBe(W / 2);
    expect(f).toBe(H / 2);
  });

  it("flipH 时 x 轴取负（a 变号），角点仍然落在输出框里", () => {
    const { ctx, setTransformCalls } = makeFakeCtx();
    drawTransformed(ctx, IMAGE, W, H, { angle: 0, flipH: true, flipV: false });

    const [a, b, c, d, e, f] = setTransformCalls[0] as TransformCall;
    expect(a).toBeCloseTo(-1, 10);
    expect(b).toBeCloseTo(0, 10);
    expect(c).toBeCloseTo(0, 10);
    expect(d).toBeCloseTo(1, 10);

    // 原图左上角 (-627, -400) 翻转后应该落到输出框的右上角附近
    const tx = a * -627 + c * -400 + e;
    const ty = b * -627 + d * -400 + f;
    expect(tx).toBeCloseTo(W, 6);
    expect(ty).toBeCloseTo(0, 6);
  });
});
