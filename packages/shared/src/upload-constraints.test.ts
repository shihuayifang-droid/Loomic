import { describe, expect, it } from "vitest";

import {
  checkUploadConstraint,
  UPLOAD_CONSTRAINTS,
  UPLOAD_MAX_BYTES,
} from "./upload-constraints.js";

const MB = 1024 * 1024;

describe("upload constraints (AS-02)", () => {
  it("AS-02: the four media types and their limits are the spec's", () => {
    expect(UPLOAD_CONSTRAINTS.image.maxBytes).toBe(20 * MB);
    expect(UPLOAD_CONSTRAINTS.pdf.maxBytes).toBe(20 * MB);
    expect(UPLOAD_CONSTRAINTS.audio.maxBytes).toBe(15 * MB);
    expect(UPLOAD_CONSTRAINTS.video.maxBytes).toBe(50 * MB);
  });

  it("AS-02: UPLOAD_MAX_BYTES is the largest limit (50MB)", () => {
    expect(UPLOAD_MAX_BYTES).toBe(50 * MB);
  });

  it("AS-02: a 16MB MP3 is refused with 音频最大 15MB", () => {
    expect(
      checkUploadConstraint({ mimeType: "audio/mpeg", byteSize: 16 * MB }),
    ).toEqual({
      ok: false,
      reason: "too_large",
      message: "音频最大 15MB",
    });
  });

  it("AS-02: a 10MB MP4 is accepted as video", () => {
    expect(
      checkUploadConstraint({ mimeType: "video/mp4", byteSize: 10 * MB }),
    ).toEqual({ ok: true, mediaType: "video" });
  });

  it("AS-02: an unknown type is refused", () => {
    expect(
      checkUploadConstraint({ mimeType: "application/zip", byteSize: 1024 }),
    ).toEqual({
      ok: false,
      reason: "unsupported_type",
      message: "不支持的文件类型",
    });
  });

  it("AS-02: exactly the limit is accepted, one byte more is not", () => {
    expect(
      checkUploadConstraint({ mimeType: "image/png", byteSize: 20 * MB }),
    ).toEqual({ ok: true, mediaType: "image" });

    expect(
      checkUploadConstraint({ mimeType: "image/png", byteSize: 20 * MB + 1 }),
    ).toEqual({
      ok: false,
      reason: "too_large",
      message: "图片最大 20MB",
    });
  });
});
