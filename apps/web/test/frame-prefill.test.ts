import { describe, expect, it } from "vitest";

import { pickFramesFromSelection } from "../src/lib/frame-prefill";

/**
 * 工单 41E：`pickFramesFromSelection` —— 首尾帧模式从画布选中的图里取「首 / 尾」。
 *
 * 口径：
 *   1) **键顺序 = 选中先后**（Excalidraw 按选中顺序插键）→ 第一个键是首帧；
 *   2) 不足两张返回 `null`（不拿同一张凑两次）；
 *   3) 非图片元素跳过；图片没有 `files[fileId].dataURL` 也跳过。
 */

const DATA_A = "data:image/png;base64,QUFBQQ==";
const DATA_B = "data:image/png;base64,QkJCQg==";

type Element = { id: string; type: string; fileId?: string };

function api(
  selectedElementIds: Record<string, boolean>,
  elements: Element[],
  files: Record<string, { dataURL?: string } | undefined>,
) {
  return {
    getAppState: () => ({ selectedElementIds }),
    getSceneElements: () => elements,
    getFiles: () => files,
  };
}

const IMG_A: Element = { id: "imgA", type: "image", fileId: "fileA" };
const IMG_B: Element = { id: "imgB", type: "image", fileId: "fileB" };
const FILES = { fileA: { dataURL: DATA_A }, fileB: { dataURL: DATA_B } };

describe("AG-07 首尾帧带入选帧顺序（工单 41E）", () => {
  it("AG-07: the selection order decides first and last", () => {
    const picked = pickFramesFromSelection(
      api({ imgB: true, imgA: true }, [IMG_A, IMG_B], FILES),
    );

    // 键顺序 B 先 → B 是首帧、A 是尾帧（不是按元素数组顺序）
    expect(picked).toEqual({ first: DATA_B, last: DATA_A });
  });

  it("AG-07: one selected image is not enough", () => {
    expect(pickFramesFromSelection(api({ imgA: true }, [IMG_A, IMG_B], FILES))).toBeNull();
  });

  it("AG-07: non-image elements and images without a file are skipped", () => {
    const picked = pickFramesFromSelection(
      api(
        { txt: true, noFile: true, imgA: true, imgB: true },
        [
          { id: "txt", type: "text" },
          { id: "noFile", type: "image", fileId: "missing" },
          IMG_A,
          IMG_B,
        ],
        FILES,
      ),
    );

    expect(picked).toEqual({ first: DATA_A, last: DATA_B });
  });
});
