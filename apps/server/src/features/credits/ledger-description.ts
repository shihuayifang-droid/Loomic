// @credits-system — BL-06: readable ledger descriptions for generations
/**
 * What a generation charge says on the credit ledger (BL-06).
 *
 * Before this module each of the five charge sites concatenated its own English
 * string ("Image generation: " plus the raw model id), so the ledger showed a
 * generator name a user cannot recognise. The rule BL-06 asks for is: the
 * Chinese kind first, then the model, and — only when one charge covers several
 * images — how many.
 *
 * Model ids are written verbatim here. A display name for models is a separate
 * concern (the model catalog carries none yet), so this module does not guess
 * one.
 */
export type GenerationKind = "image" | "video";

const KIND_LABELS: Record<GenerationKind, string> = {
  image: "图像生成",
  video: "视频生成",
};

/** BL-06: what a generation charge says in the ledger — readable, Chinese, kind first. */
export function generationLedgerDescription(
  kind: GenerationKind,
  modelId: string,
  opts?: { count?: number },
): string {
  const base = `${KIND_LABELS[kind]} · ${modelId}`;
  const count = opts?.count;

  // A video charge is a single clip, so a count never applies to it.
  if (kind !== "image" || count === undefined) return base;
  if (!Number.isInteger(count) || count <= 1) return base;

  return `${base} · ${count} 张`;
}
