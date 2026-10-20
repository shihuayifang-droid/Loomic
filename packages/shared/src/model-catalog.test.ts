import { describe, expect, it } from "vitest";

import {
  IMAGE_MODEL_CATALOG,
  modalityOfCatalogModel,
  modelModalitySchema,
  VIDEO_MODEL_CATALOG,
} from "./model-catalog.js";

// MD-04: 模态是独立字段，靠目录归属判断，不解析 id / 工具名。
describe("MD-04 model modality", () => {
  it("MD-04: the modality list keeps 3d and reserves audio", () => {
    expect([...modelModalitySchema.options]).toEqual([
      "image",
      "video",
      "3d",
      "audio",
    ]);
  });

  it("MD-04: every catalogued image model is image and every video model is video", () => {
    for (const id of Object.keys(IMAGE_MODEL_CATALOG)) {
      expect(modalityOfCatalogModel(id)).toBe("image");
    }
    for (const id of Object.keys(VIDEO_MODEL_CATALOG)) {
      expect(modalityOfCatalogModel(id)).toBe("video");
    }
  });

  it("MD-04: an unknown id has no modality, even if its name says video", () => {
    expect(modalityOfCatalogModel("someone/fake-video-model")).toBeNull();
  });

  it("MD-04: no id is in both catalogues", () => {
    const imageIds = new Set(Object.keys(IMAGE_MODEL_CATALOG));
    const shared = Object.keys(VIDEO_MODEL_CATALOG).filter((id) =>
      imageIds.has(id),
    );
    expect(shared).toEqual([]);
  });
});
