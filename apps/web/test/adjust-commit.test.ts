import { describe, expect, it, vi } from "vitest";

import { commitAdjustOutput, type AdjustCommitDeps } from "../src/lib/adjust-commit";
import { renderAdjust, ZERO_ADJUST, type PixelBuffer } from "../src/lib/adjust-render";

function source(): PixelBuffer {
  return {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      10, 20, 30, 255, 200, 150, 100, 255, 60, 70, 80, 255, 250, 240, 230, 255,
    ]),
  };
}

function makeDeps(overrides: Partial<AdjustCommitDeps> = {}) {
  const encode = vi.fn(async (_pixels: PixelBuffer) => new Blob(["png"], { type: "image/png" }));
  const upload = vi.fn(async (_file: File, _parent: string) => ({
    assetId: "asset-new",
    url: "https://x/a.png",
  }));
  const addFile = vi.fn();
  const deps: AdjustCommitDeps = {
    decode: vi.fn(async () => source()),
    encode,
    upload,
    loadAsDataUrl: vi.fn(async () => "data:image/png;base64,OUT"),
    addFile,
    newFileId: () => "file-new",
    ...overrides,
  };
  return { deps, encode, upload, addFile };
}

const params = { ...ZERO_ADJUST, exposure: 30, contrast: 20 };
const input = {
  sourceDataUrl: "data:orig",
  parentAssetId: "parent-1",
  params,
  fileName: "cat.png",
};

describe("commitAdjustOutput", () => {
  it("ED-01: the adjustment is rendered at the source size with the shared renderer", async () => {
    const { deps, encode } = makeDeps();
    await commitAdjustOutput(deps, input);

    expect(encode).toHaveBeenCalledTimes(1);
    const received = encode.mock.calls[0]![0];
    expect(received).toEqual(renderAdjust(source(), params));
    expect(received.width).toBe(2);
    expect(received.height).toBe(2);
  });

  it("ED-00i: the result is uploaded as a child of the original", async () => {
    const { deps, upload } = makeDeps();
    await commitAdjustOutput(deps, input);

    expect(upload).toHaveBeenCalledTimes(1);
    const [file, parent] = upload.mock.calls[0]!;
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/png");
    expect(file.name.startsWith("adjust_")).toBe(true);
    expect(parent).toBe("parent-1");
  });

  it("ED-01: the output keeps the source size", async () => {
    const { deps, addFile } = makeDeps();
    const out = await commitAdjustOutput(deps, input);

    expect(out).toEqual({ fileId: "file-new", assetId: "asset-new", width: 2, height: 2 });
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it("ED-00i: an upload failure adds nothing", async () => {
    const { deps, addFile } = makeDeps({
      upload: vi.fn(async () => {
        throw new Error("upload failed");
      }),
    });

    await expect(commitAdjustOutput(deps, input)).rejects.toThrow("upload failed");
    expect(addFile).toHaveBeenCalledTimes(0);
  });
});
