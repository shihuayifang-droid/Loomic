"use client";

import { useState } from "react";

import { CROP_PRESETS } from "@/lib/crop-commit";
import type { CropRect, Size } from "@/lib/crop-geometry";

import { CropPanel } from "./crop-panel";

/**
 * ED-02 · crop session: owns the crop rect state (initially the whole image)
 * and renders the panel. The on-canvas overlay is wired by another ticket.
 */
export function CropToolSession(props: {
  source: Size;
  onCancel: () => void;
  onDone: (rect: CropRect) => void;
}) {
  const { source, onCancel, onDone } = props;
  const [rect, setRect] = useState<CropRect>({
    x: 0,
    y: 0,
    width: source.width,
    height: source.height,
  });

  return (
    <CropPanel
      source={source}
      presets={[...CROP_PRESETS]}
      rect={rect}
      onRectChange={setRect}
      onCancel={onCancel}
      onDone={onDone}
    />
  );
}
