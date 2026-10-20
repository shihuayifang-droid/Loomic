import type { CropRect, SizePreset } from "@/lib/crop-geometry";
import { cropSourceRect, drawCrop } from "@/lib/crop-geometry";

/**
 * ED-02 crop presets, in spec order.
 *
 * Presets should come from the shared size-preset config (module X, usage=crop);
 * until that config exists they are defined here, in this one place only.
 */
export const CROP_PRESETS: readonly SizePreset[] = [
  { id: "free", name: "通用", ratio: null },
  { id: "1-1", name: "1:1", ratio: [1, 1] },
  { id: "xiaohongshu", name: "小红书 3:4", ratio: [3, 4] },
  { id: "douyin", name: "抖音 9:16", ratio: [9, 16] },
  { id: "instagram", name: "Instagram 4:5", ratio: [4, 5] },
  { id: "youtube", name: "YouTube 16:9", ratio: [16, 9] },
  { id: "wallpaper", name: "手机壁纸 9:19.5", ratio: [9, 19.5] },
];

export type CropCommitDeps = {
  renderCrop: (sourceDataUrl: string, rect: CropRect) => Promise<Blob>;
  upload: (file: File, parentAssetId: string) => Promise<{ assetId: string; url: string }>;
  loadAsDataUrl: (url: string) => Promise<string>;
  addFile: (file: { id: string; dataURL: string; mimeType: string; created: number }) => void;
  newFileId: () => string;
};

/** ED-00i ①: crop → upload as tool:crop → returns what replaceImageInPlace needs. */
export async function commitCropOutput(
  deps: CropCommitDeps,
  input: { sourceDataUrl: string; parentAssetId: string; rect: CropRect; fileName: string },
): Promise<{ fileId: string; assetId: string; width: number; height: number }> {
  const sourceRect = cropSourceRect(input.rect);
  const blob = await deps.renderCrop(input.sourceDataUrl, sourceRect);
  const file = new File([blob], `crop_${input.fileName}`, { type: "image/png" });
  const { assetId, url } = await deps.upload(file, input.parentAssetId);
  const dataURL = await deps.loadAsDataUrl(url);
  const fileId = deps.newFileId();
  deps.addFile({ id: fileId, dataURL, mimeType: "image/png", created: Date.now() });
  return { fileId, assetId, width: sourceRect.width, height: sourceRect.height };
}

/**
 * Browser implementation of `renderCrop`: Image + canvas + drawCrop + toBlob("image/png").
 *
 * jsdom has no 2D context / toBlob / real image loading, so this cannot be unit
 * tested; it is confirmed in the browser.
 */
export function browserRenderCrop(sourceDataUrl: string, rect: CropRect): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const out = cropSourceRect(rect);
      const canvas = document.createElement("canvas");
      canvas.width = out.width;
      canvas.height = out.height;
      const ctx = canvas.getContext("2d");
      if (ctx === null) {
        reject(new Error("canvas 2d context unavailable"));
        return;
      }
      drawCrop(ctx, image, rect);
      canvas.toBlob((blob) => {
        if (blob === null) reject(new Error("canvas toBlob failed"));
        else resolve(blob);
      }, "image/png");
    };
    image.onerror = () => reject(new Error("failed to load source image"));
    image.src = sourceDataUrl;
  });
}
