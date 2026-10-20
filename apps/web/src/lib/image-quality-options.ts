import type { ImageModelInfo } from "./server-api";

export type QualityOption = { value: "standard" | "hd" | "ultra"; label: string };

/** Built-in options for when the model list has not loaded yet (or an older server). */
export const LEGACY_QUALITY_OPTIONS: readonly QualityOption[] = [
  { value: "standard", label: "1K" },
  { value: "hd", label: "2K" },
  { value: "ultra", label: "4K" },
];

/**
 * MD-03: the quality choices to render for this model.
 * - model not known yet: LEGACY_QUALITY_OPTIONS (unchanged behaviour while loading)
 * - model known with `quality`: those tiers, labelled by the server
 * - model known without `quality`: null: render no selector, send no quality
 */
export function qualityOptionsFor(
  model: Pick<ImageModelInfo, "quality"> | undefined,
): readonly QualityOption[] | null {
  if (!model) return LEGACY_QUALITY_OPTIONS;
  if (!model.quality) return null;
  return model.quality.map((tier) => ({ value: tier.key, label: tier.label }));
}
