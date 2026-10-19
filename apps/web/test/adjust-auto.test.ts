import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { autoAdjust } from "../src/lib/adjust-auto";
import {
  ZERO_ADJUST,
  renderAdjust,
  type AdjustParams,
  type PixelBuffer,
} from "../src/lib/adjust-render";

/**
 * 工单 30K T4 · ED-01 自动调整。
 *
 * 覆盖工单 §3-T4 点名的四件事：暗且低对比图的建议方向、灰阶图的「不要乱动」、
 * 建议值代入渲染后的收敛性、以及返回值形状（恰好 5 个键、整数、值域内）。
 *
 * 所有图都在测试里现造，不读文件。`autoAdjust` 只看像素统计，测试可以直接核对方向与幅度。
 */

const SIDE = 128;

/** 水平灰阶渐变：亮度均匀铺满 0~1。 */
function greyRamp(): PixelBuffer {
  const data = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const value = Math.round((x / (SIDE - 1)) * 255);
      const offset = (y * SIDE + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width: SIDE, height: SIDE, data };
}

/** 暗且低对比：亮度集中在 0.1~0.3。 */
function darkLowContrast(): PixelBuffer {
  return levelRamp(0.1, 0.3);
}

/** 纯灰度的水平亮度渐变 `from`~`to`（0~1）。 */
function levelRamp(from: number, to: number): PixelBuffer {
  const data = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const level = from + (to - from) * (x / (SIDE - 1));
      const value = Math.round(Math.min(1, Math.max(0, level)) * 255);
      const offset = (y * SIDE + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width: SIDE, height: SIDE, data };
}

/**
 * 有色图：三个相位差 120° 的余弦（色度恒为 1.5 × amplitude），叠在 `from`~`to` 的亮度渐变上。
 *
 * 相位差 120° 是刻意的：这样每个像素的色度都一样，`autoAdjust` 的色度建议不会被
 * 「一半饱和一半灰」的分布拉偏，收敛性才有确定的含义。
 */
function triPhase(from: number, to: number, amplitude: number): PixelBuffer {
  const data = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const level = from + (to - from) * (x / (SIDE - 1));
      const hue = (y / SIDE) * 2 * Math.PI;
      const channels = [0, 1, 2].map((index) =>
        Math.min(1, Math.max(0, level + amplitude * Math.cos(hue - (index * 2 * Math.PI) / 3))),
      );
      const offset = (y * SIDE + x) * 4;
      data[offset] = Math.round(channels[0]! * 255);
      data[offset + 1] = Math.round(channels[1]! * 255);
      data[offset + 2] = Math.round(channels[2]! * 255);
      data[offset + 3] = 255;
    }
  }
  return { width: SIDE, height: SIDE, data };
}

const RESULT_KEYS = ["blacks", "contrast", "exposure", "vibrance", "whites"] as const;

/** 把建议值完整代入渲染，再跑一次 `autoAdjust`，返回第二轮建议。 */
function rerun(image: PixelBuffer): ReturnType<typeof autoAdjust> {
  const suggestion = autoAdjust(image);
  const applied: AdjustParams = { ...ZERO_ADJUST, ...suggestion };
  return autoAdjust(renderAdjust(image, applied));
}

describe("T2 autoAdjust（ED-01 自动调整）", () => {
  it("暗且低对比的图（亮度集中在 0.1~0.3）：exposure > 0 且 contrast > 0", () => {
    const suggestion = autoAdjust(darkLowContrast());
    expect(suggestion.exposure).toBeGreaterThan(0);
    expect(suggestion.contrast).toBeGreaterThan(0);
  });

  it("亮度均匀铺满 0~1 的灰阶图：5 项都满足 |v| ≤ 5", () => {
    const suggestion = autoAdjust(greyRamp());
    for (const key of RESULT_KEYS) {
      expect(Math.abs(suggestion[key]), `灰阶图上 ${key} = ${suggestion[key]} 偏得太多`).toBeLessThanOrEqual(
        5,
      );
    }
    // 灰图没有色度可言，vibrance 必须是 0（给灰图提色度不会有效果）
    expect(suggestion.vibrance).toBe(0);
  });

  it("收敛：建议值代入 renderAdjust 后再跑一次，5 项都满足 |v| ≤ 10", () => {
    // 两张图：灰阶（建议本来就接近 0）与有色图（exposure / contrast / vibrance 都有实质建议）
    const cases: ReadonlyArray<{ name: string; image: PixelBuffer }> = [
      { name: "灰阶渐变", image: greyRamp() },
      { name: "有色渐变", image: triPhase(0.22, 0.72, 0.1) },
    ];

    for (const { name, image } of cases) {
      const first = autoAdjust(image);
      // 前提自检：这一轮确实动过（否则「收敛」是空断言）
      expect(Math.max(...RESULT_KEYS.map((key) => Math.abs(first[key]))), `${name} 第一轮建议全为 0`).toBeGreaterThan(
        0,
      );

      const second = rerun(image);
      for (const key of RESULT_KEYS) {
        expect(
          Math.abs(second[key]),
          `${name}：代入后 ${key} 仍建议 ${second[key]}（第一轮是 ${first[key]}）`,
        ).toBeLessThanOrEqual(10);
      }
    }
  });

  it("返回值恰好 5 个键，都是整数，都在 [−100, 100] 内", () => {
    const images: ReadonlyArray<[string, PixelBuffer]> = [
      ["全黑", levelRamp(0, 0)],
      ["全白", levelRamp(1, 1)],
      ["灰阶", greyRamp()],
      ["暗且低对比", darkLowContrast()],
      ["有色", triPhase(0.22, 0.72, 0.1)],
      ["高对比有色", triPhase(0.05, 0.95, 0.3)],
    ];

    for (const [name, image] of images) {
      const suggestion = autoAdjust(image);
      expect(Object.keys(suggestion).sort(), `${name} 的键集合`).toEqual([...RESULT_KEYS]);
      for (const key of RESULT_KEYS) {
        const value = suggestion[key];
        expect(Number.isInteger(value), `${name} 的 ${key} = ${value} 不是整数`).toBe(true);
        expect(value).toBeGreaterThanOrEqual(-100);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("不调用 renderAdjust：源码里除了注释没有这个标识符", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "..", "src", "lib", "adjust-auto.ts"), "utf8");
    // 抹掉块注释与整行注释后再查，避免「注释里提到过」被误判
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("renderAdjust");
  });
});
