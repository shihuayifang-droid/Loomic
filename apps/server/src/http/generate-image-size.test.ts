import { describe, expect, it } from "vitest";

import type { GenerateImageRequest } from "@loomic/shared";

import type { AuthenticatedUser } from "../supabase/user.js";
import { imageJobBillingRequest, isImageSizeAllowed } from "./generate.js";

// Pure-function test: the route's size handling is `isImageSizeAllowed` (400
// before billing) plus `imageJobBillingRequest` (tier + payload), both pure.

const USER: AuthenticatedUser = {
  accessToken: "t",
  email: "size@hahart.test",
  id: "00000000-0000-0000-0000-0000000000d1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000d2";

function build(payload: GenerateImageRequest) {
  return imageJobBillingRequest(USER, WORKSPACE_ID, payload);
}

describe("AG-07 image size on the job route", () => {
  it("16:9-4k bills as ultra and is written to the job payload", () => {
    const request = build({ prompt: "cat", model: "kwjm/gpt-image-2", size: "16:9-4k" });
    expect(request.guard).toMatchObject({ quality: "ultra" });
    expect(request.job?.payload).toMatchObject({
      size: "16:9-4k",
      aspect_ratio: "16:9",
      quality: "ultra",
    });
  });

  it("the size tier overrides the quality in the request", () => {
    const request = build({ prompt: "cat", model: "kwjm/gpt-image-2", size: "3:2", quality: "ultra" });
    expect(request.guard).toMatchObject({ quality: "standard" });
    expect(request.job?.payload).toMatchObject({ size: "3:2", aspect_ratio: "3:2", quality: "standard" });
  });

  it("3:2-4k is rejected", () => {
    expect(isImageSizeAllowed({ prompt: "cat", model: "kwjm/gpt-image-2", size: "3:2-4k" })).toBe(false);
  });

  it("a size on a model without size options is rejected", () => {
    expect(isImageSizeAllowed({ prompt: "cat", model: "google/imagen-4", size: "1:1" })).toBe(false);
  });

  it("a legal size is accepted", () => {
    expect(isImageSizeAllowed({ prompt: "cat", model: "kwjm/gpt-image-2", size: "9:16-4k" })).toBe(true);
  });

  it("without size nothing changes", () => {
    expect(isImageSizeAllowed({ prompt: "cat" })).toBe(true);
    const request = build({ prompt: "cat", model: "kwjm/gpt-image-2" });
    expect(request.guard).toMatchObject({ quality: "hd" });
    const payload = request.job?.payload as Record<string, unknown>;
    expect("size" in payload).toBe(false);
    expect(payload).toMatchObject({ aspect_ratio: "1:1", quality: "hd" });
  });
});