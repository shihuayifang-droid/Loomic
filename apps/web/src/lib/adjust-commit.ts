import type { AdjustParams, PixelBuffer } from "@/lib/adjust-render";
import { renderAdjust } from "@/lib/adjust-render";

export type AdjustCommitDeps = {
  /** Browser: Image -> canvas -> getImageData. */
  decode: (sourceDataUrl: string) => Promise<PixelBuffer>;
  /** Browser: putImageData -> toBlob("image/png"). */
  encode: (pixels: PixelBuffer) => Promise<Blob>;
  upload: (file: File, parentAssetId: string) => Promise<{ assetId: string; url: string }>;
  loadAsDataUrl: (url: string) => Promise<string>;
  addFile: (file: { id: string; dataURL: string; mimeType: string; created: number }) => void;
  newFileId: () => string;
};

/** ED-00i ①: render the adjustment at the ORIGINAL size, upload as tool:adjust, return what replaceImageInPlace needs. */
export async function commitAdjustOutput(
  deps: AdjustCommitDeps,
  input: { sourceDataUrl: string; parentAssetId: string; params: AdjustParams; fileName: string },
): Promise<{ fileId: string; assetId: string; width: number; height: number }> {
  const src = await deps.decode(input.sourceDataUrl);
  // The same render function the preview uses (ED-01 acceptance 3).
  const out = renderAdjust(src, input.params);
  const blob = await deps.encode(out);
  const file = new File([blob], `adjust_${input.fileName}`, { type: "image/png" });
  const { assetId, url } = await deps.upload(file, input.parentAssetId);
  const dataURL = await deps.loadAsDataUrl(url);
  const fileId = deps.newFileId();
  deps.addFile({ id: fileId, dataURL, mimeType: "image/png", created: Date.now() });
  return { fileId, assetId, width: src.width, height: src.height };
}

/**
 * Browser implementation of `decode`: Image + canvas + getImageData.
 *
 * jsdom has no 2D context / real image loading, so this is confirmed in the browser.
 */
export function browserDecode(sourceDataUrl: string): Promise<PixelBuffer> {
  return new Promise<PixelBuffer>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        reject(new Error("canvas 2d context unavailable"));
        return;
      }
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      resolve({ width, height, data: imageData.data });
    };
    image.onerror = () => reject(new Error("failed to load source image"));
    image.src = sourceDataUrl;
  });
}

/** Browser implementation of `encode`: putImageData + toBlob("image/png"). */
export function browserEncode(pixels: PixelBuffer): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      reject(new Error("canvas 2d context unavailable"));
      return;
    }
    const data = new Uint8ClampedArray(pixels.data);
    ctx.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0);
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("canvas toBlob failed"));
      else resolve(blob);
    }, "image/png");
  });
}
