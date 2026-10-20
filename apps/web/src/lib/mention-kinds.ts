/**
 * AG-03 mention kinds.
 *
 * Mentions used to be typed "image-model" / "brand-kit-asset" and the two were
 * spelled out inline at every call site.  The canonical kinds are the five
 * below; `mentionKindOf` maps both the new kinds and the four legacy types that
 * still live inside stored messages, so old conversations keep rendering after
 * the migration.
 */

export type MentionKind = "shape" | "asset" | "file" | "model" | "skill";

/** AG-03 prefix table. */
export const MENTION_PREFIX: Record<MentionKind, string> = {
  shape: "shape-",
  asset: "asset-",
  file: "file-",
  model: "model-",
  skill: "skill-",
};

/**
 * The legacy wire types still found in already-saved messages.
 *
 * "skill" is listed because it was already the new kind; "file" / "attachment"
 * both mean an uploaded attachment.
 */
const LEGACY_TYPE_TO_KIND: Record<string, MentionKind> = {
  "canvas-image": "shape",
  "brand-kit-asset": "asset",
  "image-model": "model",
  skill: "skill",
  file: "file",
  attachment: "file",
};

/** Map the four legacy mention types (and the new kinds themselves) to a kind. Unknown → null. */
export function mentionKindOf(legacyOrKind: string): MentionKind | null {
  if (Object.prototype.hasOwnProperty.call(MENTION_PREFIX, legacyOrKind)) {
    return legacyOrKind as MentionKind;
  }
  return LEGACY_TYPE_TO_KIND[legacyOrKind] ?? null;
}

/** Short Chinese labels shown inside the capsule. Users see Chinese everywhere. */
export const MENTION_KIND_LABEL: Record<MentionKind, string> = {
  shape: "画布",
  asset: "素材",
  file: "附件",
  model: "模型",
  skill: "技能",
};

/** AG-03: the server injects at most this many characters of a text asset (runtime.ts MENTION_TEXT_MAX_CHARS). */
export const MENTION_TEXT_MAX_CHARS = 4000;

/**
 * AG-03: whether a text asset's body is long enough for the server to cut it.
 *
 * The server compares `text.length` (UTF-16 code units), so the count here is
 * deliberately the same — not code points, not grapheme clusters.  Empty or
 * missing text is never truncated.
 */
export function isMentionTextTruncated(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.length > MENTION_TEXT_MAX_CHARS;
}
