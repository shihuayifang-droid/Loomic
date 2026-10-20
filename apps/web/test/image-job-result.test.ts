// GN-37 / 工单 35P：图像生成改走任务链路后，画布拿到的不是一条 HTTP 响应体，
// 而是任务完成后 `background_jobs.result` 的形状。这里钉住「哪种结果能落图、
// 哪种必须报错」，因为「成功但没 URL」若当成空结果，界面上就只剩一张破图。
import { describe, expect, it } from "vitest";

import { imageResultFromJob } from "../src/lib/image-job-result";

describe("imageResultFromJob (GN-37)", () => {
  it("GN-37: a finished image job gives the canvas its url and type", () => {
    const result = imageResultFromJob({
      result: {
        signed_url: "https://x/a.png?token=1",
        mime_type: "image/webp",
        asset_id: "a1",
        width: 1024,
        height: 768,
      },
    });

    expect(result).toEqual({
      url: "https://x/a.png?token=1",
      mimeType: "image/webp",
      assetId: "a1",
      width: 1024,
      height: 768,
    });
  });

  it("GN-37: a job without an image url is an error", () => {
    expect(() =>
      imageResultFromJob({ result: { mime_type: "image/png" } }),
    ).toThrow(/no image URL/);
    expect(() => imageResultFromJob({})).toThrow(/no image URL/);
  });

  it("GN-37: a missing mime type defaults to png", () => {
    expect(
      imageResultFromJob({ result: { signed_url: "https://x/b" } }),
    ).toEqual({ url: "https://x/b", mimeType: "image/png" });
  });
});
