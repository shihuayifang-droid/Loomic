import { describe, expect, it } from "vitest";
import {
  agentAssetReferenceSchema,
  imageArtifactSchema,
  videoArtifactSchema,
} from "./artifacts.js";

describe("imageArtifactSchema", () => {
  it("accepts artifact with placement coordinates", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
      placement: { x: 100, y: 200, width: 512, height: 512 },
    });
    expect(result.placement).toEqual({ x: 100, y: 200, width: 512, height: 512 });
  });

  it("succeeds without placement (backward compat)", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://example.com/img.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
    });
    expect(result.placement).toBeUndefined();
  });
});

// X-52: an artifact's identity is the asset, not the URL it happened to be
// fetched with. The ticket's rule is "assetId + objectPath travel with every
// artifact; url is only this read's projection", so these cases pin that the
// stable fields are carried, that an artifact without them still parses (the
// pre-X-52 rows must not stop loading), and that a reference REQUIRES both.
describe("artifact stable asset references (X-52)", () => {
  it("case 1: an image artifact carries assetId and objectPath next to url", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://proj.test/storage/v1/object/sign/project-assets/team/a.png?token=t",
      assetId: "asset-1",
      objectPath: "team/project-1/a.png",
      mimeType: "image/png",
      width: 512,
      height: 512,
    });

    expect(result.assetId).toBe("asset-1");
    expect(result.objectPath).toBe("team/project-1/a.png");
  });

  it("case 2: a video artifact carries assetId next to the CV-01 objectPath", () => {
    const result = videoArtifactSchema.parse({
      type: "video",
      url: "https://proj.test/storage/v1/object/sign/project-assets/team/v.mp4?token=t",
      assetId: "asset-2",
      objectPath: "team/project-1/v.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });

    expect(result.assetId).toBe("asset-2");
    expect(result.objectPath).toBe("team/project-1/v.mp4");
  });

  it("case 3: a legacy artifact with neither field still parses", () => {
    const result = videoArtifactSchema.parse({
      type: "video",
      url: "https://provider.test/legacy.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });

    expect(result.assetId).toBeUndefined();
    expect(result.objectPath).toBeUndefined();
  });

  it("case 4: an asset reference requires assetId, objectPath and a size", () => {
    expect(
      agentAssetReferenceSchema.safeParse({
        objectPath: "team/p/a.png",
        bucket: "project-assets",
        mimeType: "image/png",
        byteSize: 3,
      }).success,
    ).toBe(false);

    const parsed = agentAssetReferenceSchema.parse({
      assetId: "asset-1",
      objectPath: "team/p/a.png",
      bucket: "project-assets",
      mimeType: "image/png",
      byteSize: 3,
    });
    // signedUrl is deliberately absent here: it is a projection, not identity.
    expect(parsed.signedUrl).toBeUndefined();
  });
});
