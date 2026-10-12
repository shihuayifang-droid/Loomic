import { describe, expect, it } from "vitest";
import {
  agentAssetReferenceSchema,
  imageArtifactSchema,
  toolArtifactSchema,
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

// ---------------------------------------------------------------------------
// X-52 (工单14 fixup2): "identity present, url not projectable THIS read" is a
// legal artifact; "no identity at all" is still invalid data.
//
// `chat-service.projectBlockUrls()` removes the url from an artifact whose
// asset the caller may not read, or whose signature the signer refused, and
// re-signs it only when the asset resolves. Requiring `url` here turned that
// deliberate outcome into a Zod failure — a 500 on the message list and on
// message creation. The fix is to make the field optional, and to keep the
// boundary that matters: optional is not the same as unvalidated, and an
// artifact with NO url and NO assetId is still refused, because there is
// nothing left in it to re-derive a projection from.
// ---------------------------------------------------------------------------
describe("artifact projections are optional, identity is not (工单14 fixup2)", () => {
  const UNSIGNED_IMAGE = {
    type: "image" as const,
    assetId: "asset-locked",
    objectPath: "ws-team/p/secret.png",
    mimeType: "image/png",
    width: 512,
    height: 512,
  };

  it("case 1: an image artifact with assetId and NO url parses", () => {
    const result = imageArtifactSchema.parse(UNSIGNED_IMAGE);

    expect(result.url).toBeUndefined();
    // The identity survives the parse, so a later read can re-derive a url and
    // the client can still tell WHICH asset it could not project.
    expect(result.assetId).toBe("asset-locked");
    expect(result.objectPath).toBe("ws-team/p/secret.png");
  });

  it("case 2: a video artifact with assetId and NO url parses", () => {
    const result = videoArtifactSchema.parse({
      type: "video",
      assetId: "asset-locked-video",
      objectPath: "ws-team/p/secret.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });

    expect(result.url).toBeUndefined();
    expect(result.assetId).toBe("asset-locked-video");
    expect(result.objectPath).toBe("ws-team/p/secret.mp4");
  });

  it("case 3: no url AND no assetId is still refused (image and video)", () => {
    // The one direction that must not move: this is not "a projection that is
    // merely missing", it is an artifact with no handle on its media at all.
    const image = imageArtifactSchema.safeParse({
      type: "image",
      mimeType: "image/png",
      width: 512,
      height: 512,
    });
    const video = videoArtifactSchema.safeParse({
      type: "video",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });

    expect(image.success).toBe(false);
    expect(video.success).toBe(false);
  });

  it("case 4: an EMPTY assetId does not stand in for identity", () => {
    const result = imageArtifactSchema.safeParse({
      ...UNSIGNED_IMAGE,
      assetId: "",
    });

    expect(result.success).toBe(false);
  });

  it("case 5: a url that IS present must still be a real url", () => {
    expect(
      imageArtifactSchema.safeParse({ ...UNSIGNED_IMAGE, url: "" }).success,
    ).toBe(false);
    expect(
      imageArtifactSchema.safeParse({ ...UNSIGNED_IMAGE, url: "not-a-url" })
        .success,
    ).toBe(false);
    expect(
      videoArtifactSchema.safeParse({
        type: "video",
        assetId: "asset-1",
        url: "",
        mimeType: "video/mp4",
        width: 1280,
        height: 720,
      }).success,
    ).toBe(false);

    const withUrl = imageArtifactSchema.parse({
      ...UNSIGNED_IMAGE,
      url: "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/secret.png?token=fresh",
    });
    expect(withUrl.url).toContain("token=fresh");
  });

  it("case 6: a legacy URL-only artifact (no identity) still parses", () => {
    const result = imageArtifactSchema.parse({
      type: "image",
      url: "https://cdn.test/legacy.png",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });

    expect(result.url).toBe("https://cdn.test/legacy.png");
    expect(result.assetId).toBeUndefined();
  });

  it("case 7: the artifact UNION enforces the same rule (chat blocks parse through it)", () => {
    const stable = toolArtifactSchema.safeParse(UNSIGNED_IMAGE);
    const identityless = toolArtifactSchema.safeParse({
      type: "image",
      mimeType: "image/png",
      width: 512,
      height: 512,
    });
    const video = toolArtifactSchema.safeParse({
      type: "video",
      assetId: "asset-2",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
    });

    expect(stable.success).toBe(true);
    expect(video.success).toBe(true);
    expect(identityless.success).toBe(false);
  });
});
