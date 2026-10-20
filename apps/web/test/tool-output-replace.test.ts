// 工单35R · ED-00i ④：工具产物「原位替换」。
//
// 这一层不做 I/O，所以断言可以直接钉在对象身份上：撤销能不能回到原图取决于
// 「id / x / y / angle 没动、只有 fileId 换了」，而会不会污染历史栈取决于
// 「没命中时返回的还是同一个数组」。这两个都是引用级事实，替身证明不了。
import { describe, expect, it } from "vitest";

import { replaceImageInPlace } from "../src/lib/tool-output-replace";

function imageElement(overrides: Record<string, unknown> = {}): any {
  return {
    id: "img-1",
    type: "image",
    x: 120,
    y: 240,
    width: 400,
    height: 300,
    angle: 0.5,
    fileId: "file-old",
    version: 3,
    versionNonce: 111,
    updated: 1700000000000,
    customData: { existing: "kept" },
    ...overrides,
  };
}

describe("replaceImageInPlace (ED-00i ④)", () => {
  it("ED-00i: the image is replaced in place with the tool output", () => {
    const elements = [imageElement()];

    const output = replaceImageInPlace(elements, "img-1", {
      fileId: "file-new",
      assetId: "asset-new",
      parentAssetId: "asset-old",
      source: "tool:adjust",
    });

    const replaced = output[0];
    // Same slot on the canvas: Excalidraw's undo restores by element id.
    expect(replaced.id).toBe("img-1");
    expect(replaced.x).toBe(120);
    expect(replaced.y).toBe(240);
    expect(replaced.angle).toBe(0.5);
    // Only the file underneath changed.
    expect(replaced.fileId).toBe("file-new");
    expect(replaced.version).toBe(4);
    expect(replaced.customData).toMatchObject({
      toolSource: "tool:adjust",
      parentAssetId: "asset-old",
      assetId: "asset-new",
    });
    // The element's own customData must survive the merge.
    expect(replaced.customData.existing).toBe("kept");
    // The source element is untouched (the old scene stays valid for undo).
    expect(elements[0].fileId).toBe("file-old");
  });

  it("ED-00i: a crop also updates the size", () => {
    const elements = [imageElement()];

    const cropped = replaceImageInPlace(elements, "img-1", {
      fileId: "file-crop",
      assetId: "asset-crop",
      parentAssetId: "asset-old",
      source: "tool:crop",
      width: 300,
      height: 200,
    })[0];
    expect(cropped.width).toBe(300);
    expect(cropped.height).toBe(200);

    // An adjustment keeps the geometry it had.
    const adjusted = replaceImageInPlace(elements, "img-1", {
      fileId: "file-adjust",
      assetId: "asset-adjust",
      parentAssetId: "asset-old",
      source: "tool:adjust",
    })[0];
    expect(adjusted.width).toBe(400);
    expect(adjusted.height).toBe(300);
  });

  it("ED-00i: other elements are returned by reference", () => {
    const untouched = imageElement({ id: "img-2" });
    const elements = [imageElement(), untouched];

    const output = replaceImageInPlace(elements, "img-1", {
      fileId: "file-new",
      assetId: "asset-new",
      parentAssetId: "asset-old",
      source: "tool:adjust",
    });

    expect(output).toHaveLength(2);
    // Excalidraw diffs by reference; a clone would register as an edit.
    expect(output[1]).toBe(untouched);
    expect(output[0]).not.toBe(elements[0]);
  });

  it("ED-00i: an unknown id leaves the scene unchanged", () => {
    const elements = [imageElement()];

    const output = replaceImageInPlace(elements, "nope", {
      fileId: "file-new",
      assetId: "asset-new",
      parentAssetId: "asset-old",
      source: "tool:adjust",
    });

    expect(output).toBe(elements);
  });

  it("ED-00i: a non-image element is not replaced", () => {
    const rectangle = {
      id: "rect-1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      version: 1,
    };
    const elements = [rectangle, imageElement({ id: "img-2" })];

    const output = replaceImageInPlace(elements, "rect-1", {
      fileId: "file-new",
      assetId: "asset-new",
      parentAssetId: "asset-old",
      source: "tool:crop",
      width: 5,
      height: 5,
    });

    expect(output).toBe(elements);
    expect(output[0]).toBe(rectangle);
    expect(output[0].fileId).toBeUndefined();
  });
});
