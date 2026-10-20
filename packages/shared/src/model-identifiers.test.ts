import { describe, expect, it } from "vitest";

import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from "./model-catalog.js";
import {
  AGENT_TOOL_NAME_PATTERN,
  agentToolNameFor,
  isValidPublicModelId,
} from "./model-identifiers.js";

// MD-02: outward id is `<provider>/<model_slug>` in lower snake_case; the Agent tool
// name is derived from it as `generate_<modality>_<slug>`.
describe("MD-02 public model identifiers", () => {
  it("MD-02: lower snake_case provider/slug is valid", () => {
    expect(isValidPublicModelId("kwjm/gpt_image_2_5_sunburst")).toBe(true);
    expect(isValidPublicModelId("fal/flux_2_pro")).toBe(true);
  });

  it("MD-02: upper case is refused", () => {
    expect(isValidPublicModelId("Fal/flux_2_pro")).toBe(false);
  });

  it("MD-02: hyphens and dots are refused", () => {
    expect(isValidPublicModelId("fal/flux-2-pro")).toBe(false);
    expect(isValidPublicModelId("bytedance/seedream_4.5")).toBe(false);
  });

  it("MD-02: a missing provider or slug is refused", () => {
    expect(isValidPublicModelId("flux_2_pro")).toBe(false);
    expect(isValidPublicModelId("/flux")).toBe(false);
    expect(isValidPublicModelId("fal/")).toBe(false);
  });

  it("MD-02: the Agent tool name is generated and matches the spec pattern", () => {
    const imageTool = agentToolNameFor("image", "kwjm/gpt_image_2_5_sunburst");
    expect(imageTool).toBe("generate_image_gpt_image_2_5_sunburst");
    expect(AGENT_TOOL_NAME_PATTERN.test(imageTool)).toBe(true);

    const videoTool = agentToolNameFor("video", "fal/flux_2_pro");
    expect(videoTool).toBe("generate_video_flux_2_pro");
    expect(AGENT_TOOL_NAME_PATTERN.test(videoTool)).toBe(true);
  });

  it("MD-02: a non-conforming id cannot produce a tool name", () => {
    expect(() => agentToolNameFor("image", "fal/flux-2-pro")).toThrow();
    expect(() => agentToolNameFor("video", "bytedance/seedream_4.5")).toThrow();
  });

  // Debt ledger: the catalogue ids below still violate MD-02. Renaming them moves
  // pricing seed rows, stored jobs and preferences, so it is a separate decision.
  // The pinned number may only shrink — a new catalogue id must be snake_case.
  it("MD-02: catalogue ids still to migrate are listed, so the debt can only shrink", () => {
    const nonConforming = [
      ...Object.keys(IMAGE_MODEL_CATALOG),
      ...Object.keys(VIDEO_MODEL_CATALOG),
    ].filter((id) => !isValidPublicModelId(id));

    // Measured on the current catalogue: all 45 ids (20 image + 25 video) still
    // violate MD-02. Pinned as an exact number, not a range, so any new id has to
    // be snake_case and the count can only go down.
    expect(nonConforming).toHaveLength(45);
  });
});
