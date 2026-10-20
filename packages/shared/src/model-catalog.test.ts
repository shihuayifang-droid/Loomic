import { describe, expect, it } from "vitest";

import {
  IMAGE_MODEL_CATALOG,
  isModelVisibleFor,
  modalityOfCatalogModel,
  MODEL_VISIBILITY_OVERRIDES,
  modelModalitySchema,
  modelVisibility,
  VIDEO_MODEL_CATALOG,
  type ModelSurface,
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

// MD-01: 一份可见性配置，各面按字段过滤；缺省全部可见。
describe("MD-01 model visibility", () => {
  const allSurfaces: ModelSurface[] = ["agent", "generator", "preference"];

  it("MD-01: an id without an override is listed and visible on every surface", () => {
    for (const surface of allSurfaces) {
      expect(isModelVisibleFor("x", surface)).toBe(true);
    }
    expect(modelVisibility("x")).toEqual({
      listed: true,
      agent_callable: true,
      generator_visible: true,
      in_preference: true,
    });
  });

  it("MD-01: generator-only hides a model from the agent and the preference panel", () => {
    const overrides = {
      x: { agent_callable: false, in_preference: false },
    };
    expect(isModelVisibleFor("x", "agent", overrides)).toBe(false);
    expect(isModelVisibleFor("x", "preference", overrides)).toBe(false);
    expect(isModelVisibleFor("x", "generator", overrides)).toBe(true);
  });

  it("MD-01: delisting takes a model off every surface at once", () => {
    const overrides = { x: { listed: false } };
    for (const surface of allSurfaces) {
      expect(isModelVisibleFor("x", surface, overrides)).toBe(false);
    }
  });

  it("MD-01: an override changes only the fields it names", () => {
    expect(modelVisibility("x", { x: { in_preference: false } })).toEqual({
      listed: true,
      agent_callable: true,
      generator_visible: true,
      in_preference: false,
    });
  });

  it("MD-01: the shipped override table is empty, so behaviour is unchanged", () => {
    expect(Object.keys(MODEL_VISIBILITY_OVERRIDES)).toEqual([]);
  });
});
