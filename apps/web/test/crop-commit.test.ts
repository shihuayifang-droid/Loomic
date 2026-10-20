import { describe, expect, it, vi } from "vitest";

import { CROP_PRESETS, commitCropOutput, type CropCommitDeps } from "../src/lib/crop-commit";

function makeDeps(uploadImpl?: () => Promise<{ assetId: string; url: string }>) {
  const upload = vi.fn<CropCommitDeps["upload"]>(
    uploadImpl ?? (async () => ({ assetId: "a-new", url: "https://x/c.png" })),
  );
  const addFile = vi.fn<CropCommitDeps["addFile"]>();
  const deps = {
    renderCrop: vi.fn<CropCommitDeps["renderCrop"]>(async () => new Blob(["png"], { type: "image/png" })),
    upload,
    loadAsDataUrl: vi.fn<CropCommitDeps["loadAsDataUrl"]>(async () => "data:image/png;base64,CROPPED"),
    addFile,
    newFileId: vi.fn<CropCommitDeps["newFileId"]>(() => "file-new"),
  };
  return deps;
}

describe("crop-commit", () => {
  it("ED-02: the crop presets follow the spec order", () => {
    expect(CROP_PRESETS.map((p) => p.name)).toEqual([
      "通用",
      "1:1",
      "小红书 3:4",
      "抖音 9:16",
      "Instagram 4:5",
      "YouTube 16:9",
      "手机壁纸 9:19.5",
    ]);
  });

  it("ED-00i: a crop is rendered at the source pixels and uploaded as a child of the original", async () => {
    const deps = makeDeps();
    await commitCropOutput(deps, {
      sourceDataUrl: "data:image/png;base64,SRC",
      parentAssetId: "parent-1",
      rect: { x: 10.2, y: 19.6, width: 600.4, height: 799.5 },
      fileName: "cat.png",
    });

    expect(deps.renderCrop).toHaveBeenCalledWith("data:image/png;base64,SRC", {
      x: 10,
      y: 20,
      width: 600,
      height: 800,
    });
    expect(deps.upload).toHaveBeenCalledTimes(1);
    const [file, parent] = deps.upload.mock.calls[0] as [File, string];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/png");
    expect(file.name.startsWith("crop_")).toBe(true);
    expect(parent).toBe("parent-1");
  });

  it("ED-02: the output reports the crop size", async () => {
    const deps = makeDeps();
    const result = await commitCropOutput(deps, {
      sourceDataUrl: "data:image/png;base64,SRC",
      parentAssetId: "parent-1",
      rect: { x: 0, y: 0, width: 600, height: 800 },
      fileName: "cat.png",
    });

    expect(result).toEqual({ fileId: "file-new", assetId: "a-new", width: 600, height: 800 });
    expect(deps.addFile).toHaveBeenCalledTimes(1);
    const added = deps.addFile.mock.calls[0]?.[0];
    expect(added?.id).toBe("file-new");
    expect(added?.dataURL).toBe("data:image/png;base64,CROPPED");
  });

  it("ED-00i: an upload failure stops before anything is added", async () => {
    const deps = makeDeps(async () => {
      throw new Error("upload failed");
    });

    await expect(
      commitCropOutput(deps, {
        sourceDataUrl: "data:image/png;base64,SRC",
        parentAssetId: "parent-1",
        rect: { x: 0, y: 0, width: 600, height: 800 },
        fileName: "cat.png",
      }),
    ).rejects.toThrow("upload failed");
    expect(deps.addFile).toHaveBeenCalledTimes(0);
  });
});
