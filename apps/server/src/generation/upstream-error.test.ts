import { describe, expect, it } from "vitest";

import { isReferenceImageLimitError, REFERENCE_IMAGE_LIMIT_CODE } from "./upstream-error.js";

describe("isReferenceImageLimitError (工单40B / MD-03)", () => {
  it("MD-03: the four upstream phrasings for 'too many reference images' are recognised", () => {
    const upstreamMessages = [
      "Invalid request: too many images (max 4)",
      "You can provide at most 3 images",
      "Exceeds the maximum number of input images",
      "image count must be <= 10",
    ];

    for (const message of upstreamMessages) {
      expect(isReferenceImageLimitError(new Error(message)), message).toBe(true);
      // Providers sometimes throw the bare string, so the non-Error shape is
      // part of the contract too.
      expect(isReferenceImageLimitError(message), message).toBe(true);
    }
  });

  it("MD-03: casing never matters", () => {
    expect(isReferenceImageLimitError(new Error("TOO MANY IMAGES"))).toBe(true);
    expect(isReferenceImageLimitError(new Error("Image Count exceeded"))).toBe(true);
  });

  it("MD-03: ordinary upstream failures are not mistaken for a reference image cap", () => {
    for (const message of ["rate limited", "content policy violation"]) {
      expect(isReferenceImageLimitError(new Error(message)), message).toBe(false);
      expect(isReferenceImageLimitError(message), message).toBe(false);
    }
  });

  it("MD-03: the code is the one the server, shared and web all speak", () => {
    expect(REFERENCE_IMAGE_LIMIT_CODE).toBe("reference_image_limit");
  });
});
