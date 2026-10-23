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

/** A mention like `[@image:#1]` or `[/skill:#2]` is a server-side pointer, not words. */
const MENTION_PLACEHOLDER = /\[[@/][a-z]+:#\d+\]/gi;

/** How many characters of the user's own words a ledger line keeps. */
const SUMMARY_MAX_CHARS = 30;

/**
 * BL-06: the user's own words, shortened to one ledger line.
 *
 * A serialised prompt is what the model needs, not what the user wrote — it
 * carries `<canvas_state>` / `<input_images>` / `<references>` blocks and
 * `[@image:#1]`-style pointers. This keeps the readable part: no pointer,
 * no XML tail, no run of whitespace, at most {@link SUMMARY_MAX_CHARS} chars.
 */
function agentPromptSummary(userPrompt: string | null | undefined): string {
  if (!userPrompt) return "";

  // Defensive: if a caller hands over the serialised message, the XML block and
  // everything after it is machinery the user never typed.
  const tagStart = userPrompt.indexOf("<");
  const head = tagStart === -1 ? userPrompt : userPrompt.slice(0, tagStart);

  return head
    .replace(MENTION_PLACEHOLDER, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * BL-06: what an Agent charge says in the ledger — the user's request first, so
 * the row reads like the conversation instead of like a serialised prompt.
 *
 * The kind and model still come from {@link generationLedgerDescription}: a
 * request with no words left (empty, or nothing but pointers) falls back to it
 * unchanged.
 */
export function agentLedgerDescription(
  userPrompt: string | null | undefined,
  kind: GenerationKind,
  modelId: string,
): string {
  const summary = agentPromptSummary(userPrompt);
  if (!summary) return generationLedgerDescription(kind, modelId);

  const chars = Array.from(summary);
  const shortened =
    chars.length > SUMMARY_MAX_CHARS
      ? `${chars.slice(0, SUMMARY_MAX_CHARS).join("")}…`
      : summary;

  return `「${shortened}」 · ${KIND_LABELS[kind]} · ${modelId}`;
}
