import { describe, expect, it } from "vitest";

import {
  ADJUST_PARAM_IDS,
  LUMA_WEIGHTS,
  NEIGHBOUR_RADIUS_K,
  TONE_SHIFT_GAIN,
  ZERO_ADJUST,
  downsample,
  isZeroAdjust,
  neighbourhoodRadius,
  renderAdjust,
  toneWeight,
  type AdjustParamId,
  type AdjustParams,
  type PixelBuffer,
} from "../src/lib/adjust-render";

/**
 * 工单 30K T4 · ED-01 渲染内核。
 *
 * 覆盖规格 ED-01 的验收 2（计算部分）与验收 3（预览与导出一致），
 * 以及工单 §2-4 那张「公式下限」清单 —— **每条性质一个用例**，全部是像素级断言。
 *
 * 合成图完全在测试里构造（256×256，不读任何文件）：水平亮度渐变 + 竖向色相渐变，
 * 右下角叠一块 8px 的高对比棋盘（给 clarity / sharpen 这类邻域算子用）。
 * 棋盘格与降采样网格（4px）对齐，所以「先渲染再降」与「先降再渲染」在棋盘内部是同一组像素值
 * —— 这不是放宽阈值，而是让合成图的边缘不对齐噪声掩盖真正的算法差异。
 *
 * jsdom 没有 canvas，本文件全程只用 `PixelBuffer`，不 `createElement("canvas")`。
 */

const SIDE = 256;
/** 验收 3 的预览尺寸。 */
const PREVIEW = 64;
/** 棋盘区的左上角与格子边距（都对齐到降采样网格 4px 的整数倍）。 */
const CHECKER_ORIGIN = 192;
const CHECKER_CELL = 8;
/** 色相渐变的幅度与亮度渐变的幅度：两者相加刚好 [0,1]，且逐通道均值为 0.5。 */
const HUE_AMPLITUDE = 0.4;
const LEVEL_AMPLITUDE = 0.6;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 合成图：水平亮度渐变 + 竖向色相渐变 + 右下角棋盘。 */
function makeImage(): PixelBuffer {
  const data = new Uint8ClampedArray(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const offset = (y * SIDE + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (x >= CHECKER_ORIGIN && y >= CHECKER_ORIGIN) {
        const cell = Math.floor(x / CHECKER_CELL) + Math.floor(y / CHECKER_CELL);
        const value = cell % 2 === 0 ? 1 : 0;
        r = value;
        g = value;
        b = value;
      } else {
        const level = x / (SIDE - 1) - 0.5;
        const hue = y / SIDE;
        const cr = 0.5 + 0.5 * Math.cos(2 * Math.PI * hue);
        const cg = 0.5 + 0.5 * Math.cos(2 * Math.PI * hue - (2 * Math.PI) / 3);
        const cb = 0.5 + 0.5 * Math.cos(2 * Math.PI * hue - (4 * Math.PI) / 3);
        r = clamp01(0.5 + HUE_AMPLITUDE * (cr - 0.5) + LEVEL_AMPLITUDE * level);
        g = clamp01(0.5 + HUE_AMPLITUDE * (cg - 0.5) + LEVEL_AMPLITUDE * level);
        b = clamp01(0.5 + HUE_AMPLITUDE * (cb - 0.5) + LEVEL_AMPLITUDE * level);
      }
      data[offset] = Math.round(r * 255);
      data[offset + 1] = Math.round(g * 255);
      data[offset + 2] = Math.round(b * 255);
      data[offset + 3] = 255;
    }
  }
  return { width: SIDE, height: SIDE, data };
}

/** 单像素缓冲：给「一个公式一行期望值」的用例用。 */
function pixel(r: number, g: number, b: number): PixelBuffer {
  return { width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, 255]) };
}

/** 全灰缓冲。 */
function solid(width: number, height: number, value: number): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 只把指定几项置为非 0，其余 16/17 项保持 0。 */
function adjust(overrides: Partial<AdjustParams>): AdjustParams {
  return { ...ZERO_ADJUST, ...overrides };
}

function lumaOfPixel(img: PixelBuffer, index: number): number {
  const offset = index * 4;
  return (
    LUMA_WEIGHTS.r * img.data[offset]! +
    LUMA_WEIGHTS.g * img.data[offset + 1]! +
    LUMA_WEIGHTS.b * img.data[offset + 2]!
  );
}

function meanChannel(img: PixelBuffer, channel: 0 | 1 | 2): number {
  let sum = 0;
  for (let i = 0; i < img.width * img.height; i += 1) sum += img.data[i * 4 + channel]!;
  return sum / (img.width * img.height);
}

function meanLuma(img: PixelBuffer): number {
  let sum = 0;
  for (let i = 0; i < img.width * img.height; i += 1) sum += lumaOfPixel(img, i);
  return sum / (img.width * img.height);
}

function stdLuma(img: PixelBuffer): number {
  const mean = meanLuma(img);
  let sum = 0;
  for (let i = 0; i < img.width * img.height; i += 1) {
    const delta = lumaOfPixel(img, i) - mean;
    sum += delta * delta;
  }
  return Math.sqrt(sum / (img.width * img.height));
}

/** 指定矩形区域的亮度均值（x0/y0 含，x1/y1 不含）。 */
function regionMeanLuma(img: PixelBuffer, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      sum += lumaOfPixel(img, y * img.width + x);
      count += 1;
    }
  }
  return sum / count;
}

/** 四角 16×16 区域的平均亮度。 */
function cornerMeanLuma(img: PixelBuffer): number {
  const size = 16;
  const far = img.width - size;
  const blocks = [
    regionMeanLuma(img, 0, 0, size, size),
    regionMeanLuma(img, far, 0, img.width, size),
    regionMeanLuma(img, 0, far, size, img.height),
    regionMeanLuma(img, far, far, img.width, img.height),
  ];
  return blocks.reduce((sum, value) => sum + value, 0) / blocks.length;
}

/** 逐通道平均绝对差（单位：0~255 的字节量级）。 */
function meanAbsDiff(left: PixelBuffer, right: PixelBuffer): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      sum += Math.abs(left.data[i + channel]! - right.data[i + channel]!);
      count += 1;
    }
  }
  return sum / count;
}

/** 两个字节缓冲的逐字节差异个数（`toBe` 逐元素比较在 256KB 上太慢，这里手写）。 */
function byteMismatches(left: Uint8ClampedArray, right: Uint8ClampedArray): number {
  if (left.length !== right.length) return -1;
  let mismatches = 0;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) mismatches += 1;
  return mismatches;
}

describe("T1 §2-4 公式下限（每条性质一例）", () => {
  it("全部为 0 时恒等：输出与输入逐字节相等，且不改 src", () => {
    const source = makeImage();
    const before = Uint8ClampedArray.from(source.data);

    const out = renderAdjust(source, ZERO_ADJUST);

    expect(byteMismatches(out.data, before)).toBe(0);
    expect(byteMismatches(source.data, before)).toBe(0); // src 未被改写
    expect(out.data).not.toBe(source.data); // 是副本，不是同一个缓冲
    expect([out.width, out.height]).toEqual([SIDE, SIDE]);
  });

  it("exposure：rgb × 2^(v/100)，逐通道分别放大", () => {
    const mid = pixel(100, 100, 100);
    expect(Array.from(renderAdjust(mid, adjust({ exposure: 50 })).data.slice(0, 3))).toEqual([
      141, 141, 141,
    ]);

    const colored = pixel(60, 120, 180);
    expect(Array.from(renderAdjust(colored, adjust({ exposure: 25 })).data.slice(0, 3))).toEqual([
      71, 143, 214,
    ]);

    // 负值减半；超过 255 的被夹住
    expect(Array.from(renderAdjust(pixel(64, 64, 64), adjust({ exposure: -100 })).data.slice(0, 3))).toEqual([
      32, 32, 32,
    ]);
    expect(
      Array.from(renderAdjust(pixel(200, 200, 200), adjust({ exposure: 100 })).data.slice(0, 3)),
    ).toEqual([255, 255, 255]);
  });

  it("saturation = −100：每个像素 R=G=B=Rec.709 亮度（±1）", () => {
    const source = makeImage();
    const out = renderAdjust(source, adjust({ saturation: -100 }));

    let worstChannelSpread = 0;
    let worstLumaGap = 0;
    for (let i = 0; i < SIDE * SIDE; i += 1) {
      const offset = i * 4;
      const r = out.data[offset]!;
      const g = out.data[offset + 1]!;
      const b = out.data[offset + 2]!;
      worstChannelSpread = Math.max(worstChannelSpread, Math.abs(r - g), Math.abs(g - b));
      worstLumaGap = Math.max(worstLumaGap, Math.abs(r - lumaOfPixel(source, i)));
    }
    expect(worstChannelSpread).toBe(0);
    expect(worstLumaGap).toBeLessThanOrEqual(1);
  });

  it("temperature > 0：平均 R 上升、平均 B 下降；< 0 时相反", () => {
    const source = makeImage();
    const baseR = meanChannel(source, 0);
    const baseB = meanChannel(source, 2);

    const warm = renderAdjust(source, adjust({ temperature: 50 }));
    expect(meanChannel(warm, 0)).toBeGreaterThan(baseR);
    expect(meanChannel(warm, 2)).toBeLessThan(baseB);

    const cool = renderAdjust(source, adjust({ temperature: -50 }));
    expect(meanChannel(cool, 0)).toBeLessThan(baseR);
    expect(meanChannel(cool, 2)).toBeGreaterThan(baseB);
  });

  it("tint > 0：平均 G 下降（偏洋红）；< 0 时相反", () => {
    const source = makeImage();
    const baseG = meanChannel(source, 1);

    expect(meanChannel(renderAdjust(source, adjust({ tint: 50 })), 1)).toBeLessThan(baseG);
    expect(meanChannel(renderAdjust(source, adjust({ tint: -50 })), 1)).toBeGreaterThan(baseG);
  });

  it("contrast > 0：标准差上升，平均值变化不超过 ±2；< 0 时标准差下降", () => {
    const source = makeImage();
    const baseStd = stdLuma(source);
    const baseMean = meanLuma(source);

    const strong = renderAdjust(source, adjust({ contrast: 40 }));
    expect(stdLuma(strong)).toBeGreaterThan(baseStd);
    expect(Math.abs(meanLuma(strong) - baseMean)).toBeLessThanOrEqual(2);

    const weak = renderAdjust(source, adjust({ contrast: -40 }));
    expect(stdLuma(weak)).toBeLessThan(baseStd);
    expect(Math.abs(meanLuma(weak) - baseMean)).toBeLessThanOrEqual(2);
  });

  it("highlights < 0：只压亮部，亮度 < 0.25 的像素变化不超过 ±1", () => {
    const source = makeImage();
    const out = renderAdjust(source, adjust({ highlights: -60 }));

    let darkPixels = 0;
    let darkChanged = 0;
    let brightPixels = 0;
    let brightDropped = 0;
    let worstDarkDelta = 0;
    for (let i = 0; i < SIDE * SIDE; i += 1) {
      const luma = lumaOfPixel(source, i) / 255;
      const delta = (lumaOfPixel(out, i) - lumaOfPixel(source, i)) / 255;
      if (luma < 0.25) {
        darkPixels += 1;
        worstDarkDelta = Math.max(worstDarkDelta, Math.abs(delta));
        if (delta !== 0) darkChanged += 1;
      }
      if (luma > 0.75) {
        brightPixels += 1;
        if (delta < 0) brightDropped += 1;
      }
    }
    // 前提自检：图里确实有暗部；亮部真的被压了
    expect(darkPixels).toBeGreaterThan(0);
    expect(brightPixels).toBeGreaterThan(0);
    expect(brightDropped).toBe(brightPixels);
    // 暗部一个像素都不该动（权重在 Y ≤ 0.25 处恰好为 0，量化误差也不许出现）
    expect(worstDarkDelta).toBeLessThanOrEqual(1 / 255);
    expect(darkChanged).toBe(0);
  });

  it("shadows > 0：只提暗部，亮度 > 0.75 的像素变化不超过 ±1", () => {
    const source = makeImage();
    const out = renderAdjust(source, adjust({ shadows: 60 }));

    let brightPixels = 0;
    let brightChanged = 0;
    let worstBrightDelta = 0;
    for (let i = 0; i < SIDE * SIDE; i += 1) {
      const luma = lumaOfPixel(source, i) / 255;
      if (luma > 0.75) {
        brightPixels += 1;
        let pixelDelta = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          const offset = i * 4 + channel;
          pixelDelta = Math.max(
            pixelDelta,
            Math.abs(out.data[offset]! - source.data[offset]!),
          );
        }
        worstBrightDelta = Math.max(worstBrightDelta, pixelDelta);
        if (pixelDelta !== 0) brightChanged += 1;
      }
    }
    expect(brightPixels).toBeGreaterThan(0);
    expect(worstBrightDelta).toBeLessThanOrEqual(1);
    expect(brightChanged).toBe(0);

    // 暗部确实被提亮了
    const darkBefore = regionMeanLuma(source, 0, 0, 32, SIDE);
    const darkAfter = regionMeanLuma(out, 0, 0, 32, SIDE);
    expect(darkAfter).toBeGreaterThan(darkBefore);
  });

  it("vignette < 0：四角变暗、中心不变；> 0：四角变亮", () => {
    const source = makeImage();
    const center = { size: 16 };

    const dark = renderAdjust(source, adjust({ vignette: -50 }));
    expect(cornerMeanLuma(dark)).toBeLessThan(cornerMeanLuma(source));

    const centerBefore = regionMeanLuma(source, SIDE / 2 - center.size / 2, SIDE / 2 - center.size / 2, SIDE / 2 + center.size / 2, SIDE / 2 + center.size / 2);
    const centerAfter = regionMeanLuma(dark, SIDE / 2 - center.size / 2, SIDE / 2 - center.size / 2, SIDE / 2 + center.size / 2, SIDE / 2 + center.size / 2);
    expect(Math.abs(centerAfter - centerBefore)).toBeLessThanOrEqual(1);

    const bright = renderAdjust(source, adjust({ vignette: 50 }));
    expect(cornerMeanLuma(bright)).toBeGreaterThan(cornerMeanLuma(source));
    const centerBright = regionMeanLuma(bright, SIDE / 2 - center.size / 2, SIDE / 2 - center.size / 2, SIDE / 2 + center.size / 2, SIDE / 2 + center.size / 2);
    expect(Math.abs(centerBright - centerBefore)).toBeLessThanOrEqual(1);
  });

  it("四个色调权重与导出的 toneWeight() 一致（渲染循环里那份是内联的同式）", () => {
    // 渲染的热循环把三次多项式写开了（省掉每像素 4 次除法），本条把两份式子钉在一起：
    // 灰像素上亮度的实测变化量必须等于 `toneWeight()` + `TONE_SHIFT_GAIN` 算出的预测值。
    const cases: ReadonlyArray<{ id: AdjustParamId; value: number }> = [
      { id: "highlights", value: -50 },
      { id: "highlights", value: 40 },
      { id: "shadows", value: 50 },
      { id: "shadows", value: -40 },
      { id: "whites", value: -40 },
      { id: "blacks", value: 40 },
    ];

    for (const { id, value } of cases) {
      const params: Record<AdjustParamId, number> = { ...ZERO_ADJUST };
      params[id] = value;
      for (const level of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const byte = Math.round(level * 255);
        const unit = byte / 255;
        const luma = LUMA_WEIGHTS.r * unit + LUMA_WEIGHTS.g * unit + LUMA_WEIGHTS.b * unit;
        const weight = toneWeight(id as "highlights" | "shadows" | "whites" | "blacks", luma);
        const amount = TONE_SHIFT_GAIN[id as "highlights" | "shadows" | "whites" | "blacks"] * (value / 100);
        // highlights 是乘性，其余三项是加性
        const expected =
          id === "highlights" ? unit * (1 + amount * weight) : unit + amount * weight;

        const out = renderAdjust(pixel(byte, byte, byte), params);
        const predicted = Math.round(Math.min(1, Math.max(0, expected)) * 255);
        // 实现在 Float32Array 里往返（写入即 fround），落在 .5 边界上的亮度允许 1 个字节的量化差；
        // 公式有偏差的话差值会远大于 1（这些取值下权重的误差会放大到 1 个字节以上）。
        expect(
          Math.abs(out.data[0]! - predicted),
          `${id}=${value} 在亮度 ${level}：公式预测 ${predicted}，实测 ${out.data[0]}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("邻域类：半径 = max(1, round(k × 短边 / 1000))，与短边成比例", () => {
    // 四个 k 都是执行方定的常数，写在 NEIGHBOUR_RADIUS_K 与文件头注释里
    expect(NEIGHBOUR_RADIUS_K).toEqual({ clarity: 16, sharpen: 4, glamour: 24, bloom: 40 });

    for (const k of Object.values(NEIGHBOUR_RADIUS_K)) {
      // 短边翻倍 → 半径翻倍（这里取的尺寸让 round 恰好不产生 ±1 抖动）
      expect(neighbourhoodRadius(k, 1000, 1000)).toBe(2 * neighbourhoodRadius(k, 500, 500));
      // 只看短边：长边再长也不加半径
      expect(neighbourhoodRadius(k, 500, 2000)).toBe(neighbourhoodRadius(k, 500, 500));
      // 下限 1 像素
      expect(neighbourhoodRadius(k, 4, 4)).toBe(1);
    }
  });

  it("grain：同一输入运行两次逐字节相等；且确实产生了变化", () => {
    const source = solid(32, 32, 128);
    const once = renderAdjust(source, adjust({ grain: 80 }));
    const twice = renderAdjust(source, adjust({ grain: 80 }));

    expect(once.data).toEqual(twice.data);
    expect(once.data).not.toEqual(source.data);

    // 同样的坐标、同样的种子 → 每个像素的偏移都一样（跨调用稳定）
    const thirdRun = renderAdjust(solid(32, 32, 128), adjust({ grain: 80 }));
    expect(thirdRun.data).toEqual(once.data);
  });

  it("iso：17 个 id 与 ZERO_ADJUST 的键集合一致，isZeroAdjust 只认全 0", () => {
    expect(ADJUST_PARAM_IDS).toHaveLength(17);
    expect(new Set(ADJUST_PARAM_IDS).size).toBe(17);
    expect([...ADJUST_PARAM_IDS].sort()).toEqual(Object.keys(ZERO_ADJUST).sort());
    for (const id of ADJUST_PARAM_IDS) expect(ZERO_ADJUST[id]).toBe(0);

    expect(isZeroAdjust(ZERO_ADJUST)).toBe(true);
    for (const id of ADJUST_PARAM_IDS) {
      const oneNonZero: Record<AdjustParamId, number> = { ...ZERO_ADJUST };
      oneNonZero[id] = 1;
      expect(isZeroAdjust(oneNonZero), `${id} 非 0 时不该判为恒等`).toBe(false);
    }
  });
});

describe("T1 downsample（预览降采样）", () => {
  it("整数倍：4×4 全 7 → 1×1 仍是 7；[0,10,20,30] → 15", () => {
    expect(Array.from(downsample(solid(4, 4, 7), 1, 1).data)).toEqual([7, 7, 7, 255]);

    const quad = new Uint8ClampedArray(16);
    quad[0] = 0;
    quad[4] = 10;
    quad[8] = 20;
    quad[12] = 30;
    for (let i = 0; i < 4; i += 1) quad[i * 4 + 3] = 255;
    const out = downsample({ width: 2, height: 2, data: quad }, 1, 1);
    expect(out.data[0]).toBe(15);
    expect(out.data[3]).toBe(255);
  });

  it("非整数倍：面积加权，整体均值守恒（±1）", () => {
    const source = makeImage();
    const out = downsample(source, 100, 100);
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
    expect(Math.abs(meanChannel(out, 0) - meanChannel(source, 0))).toBeLessThanOrEqual(1);
    expect(Math.abs(meanChannel(out, 1) - meanChannel(source, 1))).toBeLessThanOrEqual(1);
    expect(Math.abs(meanChannel(out, 2) - meanChannel(source, 2))).toBeLessThanOrEqual(1);
  });
});

describe("验收 3：预览与导出一致（平均绝对差）", () => {
  /**
   * 三组参数（工单 §3-T4 的表）：grain 三组都是 0。
   *
   * 阈值照工单：A、B ≤ 3/255，C ≤ 6/255。差值按 **[0,1] 归一化**的口径比（就是「平均每个通道
   * 差几个字节级」）：3/255 ≈ 平均差 3 个字节级，6/255 ≈ 6 个。回传里同时给出归一化值与字节级数值。
   */
  const GROUPS: ReadonlyArray<{ name: string; params: AdjustParams; limit: number }> = [
    {
      name: "A 只用「光」组 7 项",
      limit: 3 / 255,
      params: adjust({
        light: 30,
        exposure: 40,
        contrast: 35,
        highlights: -40,
        shadows: 30,
        whites: -30,
        blacks: 35,
      }),
    },
    {
      name: "B 只用「色」组 4 项",
      limit: 3 / 255,
      params: adjust({ vibrance: 50, saturation: -30, temperature: 45, tint: -35 }),
    },
    {
      name: "C 混合（clarity / vignette / saturation / exposure）",
      limit: 6 / 255,
      params: adjust({ clarity: 50, vignette: -50, saturation: 20, exposure: 20 }),
    },
  ];

  it("三组的 |先渲染再降采样 − 先降采样再渲染| 都在阈值内", () => {
    const source = makeImage();
    const preview = downsample(source, PREVIEW, PREVIEW);
    const measurements: string[] = [];

    for (const group of GROUPS) {
      const renderThenDown = downsample(renderAdjust(source, group.params), PREVIEW, PREVIEW);
      const downThenRender = renderAdjust(preview, group.params);
      // 归一化到 [0,1]：与工单的 3/255、6/255 同口径
      const diff = meanAbsDiff(renderThenDown, downThenRender) / 255;
      measurements.push(
        `${group.name}: ${diff.toExponential(3)} = ${(diff * 255).toFixed(4)} 字节级` +
          `（阈值 ${(group.limit * 255).toFixed(0)} 字节级）`,
      );
      expect(diff, `${group.name} 的平均绝对差 ${diff} 超过 ${group.limit}`).toBeLessThanOrEqual(
        group.limit,
      );
    }

    // 这三个数字要贴进回传，跑测试时也打出来，方便复核
    console.log(`[adjust-render] 验收 3 平均绝对差（归一化 / 字节级）\n${measurements.join("\n")}`);
  });
});

describe("验收 2（计算部分）：渲染耗时", () => {
  /** 一张 400×400 的渐变图（构造一次，计时不含造图）。 */
  function timingImage(): PixelBuffer {
    const width = 400;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = Math.round((x / (width - 1)) * 255);
        data[offset + 1] = Math.round((y / (height - 1)) * 255);
        data[offset + 2] = Math.round(((x + y) / (width + height - 2)) * 255);
        data[offset + 3] = 255;
      }
    }
    return { width, height, data };
  }

  /** 空跑一次（JIT 预热）后计时 runs 次，返回中位数毫秒。 */
  function medianMs(image: PixelBuffer, params: AdjustParams, runs: number): number {
    renderAdjust(image, params);
    const samples: number[] = [];
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      renderAdjust(image, params);
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    return samples[Math.floor(samples.length / 2)]!;
  }

  it("「光」「色」11 项逐像素参数：400×400 跑 5 次中位数 < 16ms", () => {
    const image = timingImage();
    const perPixelOnly = adjust({
      light: 30,
      exposure: 40,
      contrast: 35,
      highlights: -40,
      shadows: 30,
      whites: -30,
      blacks: 35,
      vibrance: 50,
      saturation: -30,
      temperature: 45,
      tint: -35,
    });

    const median = medianMs(image, perPixelOnly, 5);
    console.log(
      `[adjust-render] 验收 2 耗时：400×400 逐像素 11 项中位数 ${median.toFixed(2)}ms（断言 < 16ms）`,
    );
    expect(median).toBeLessThan(16);
  });

  it("17 项全开：只记录耗时不作断言，并列出最费时的两项", () => {
    const image = timingImage();
    const allOpen = adjust({
      light: 30,
      exposure: 40,
      contrast: 35,
      highlights: -40,
      shadows: 30,
      whites: -30,
      blacks: 35,
      vibrance: 50,
      saturation: -30,
      temperature: 45,
      tint: -35,
      sharpen: 60,
      clarity: 50,
      grain: 40,
      vignette: -50,
      glamour: 40,
      bloom: 40,
    });

    const median = medianMs(image, allOpen, 5);
    console.log(
      `[adjust-render] 验收 2 耗时：400×400 十七项全开中位数 ${median.toFixed(2)}ms（只记录）`,
    );

    // 逐项单独计时（各取 3 次中位数），用来回答「超了 16ms 是哪两项拖的」
    const perParam = ADJUST_PARAM_IDS.map((id) => {
      const single: Record<AdjustParamId, number> = { ...ZERO_ADJUST };
      single[id] = allOpen[id];
      return { id, ms: medianMs(image, single, 3) };
    }).sort((left, right) => right.ms - left.ms);
    console.log(
      `[adjust-render] 单项耗时前 3：${perParam
        .slice(0, 3)
        .map((entry) => `${entry.id} ${entry.ms.toFixed(2)}ms`)
        .join(" / ")}（只记录）`,
    );

    expect(Number.isFinite(median)).toBe(true);
  });
});
