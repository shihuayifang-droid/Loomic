/**
 * AG-03 mention kinds.
 *
 * Mentions used to be typed "image-model" / "brand-kit-asset" and the two were
 * spelled out inline at every call site.  The canonical kinds are the five
 * below; `mentionKindOf` maps both the new kinds and the four legacy types that
 * still live inside stored messages, so old conversations keep rendering after
 * the migration.
 */

import type { MessageMention } from "@loomic/shared";

import type { MessageMentionPickerItem } from "@/components/canvas-image-picker";

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

/** AG-03: the ONE conversion from a picked item to a message mention. Every entry (@, the add-asset button) must call this. Canvas images are not mentions (they become references) → null. */
export function mentionFromPickerItem(
  item: MessageMentionPickerItem,
): MessageMention | null {
  if (item.kind === "image-model") {
    return { mentionType: "image-model", id: item.id, label: item.label };
  }
  if (item.kind === "skill") {
    return {
      mentionType: "skill",
      id: item.id,
      label: item.label,
      slug: item.slug,
    };
  }
  if (item.kind === "brand-kit-asset") {
    return {
      mentionType: "brand-kit-asset",
      id: item.id,
      label: item.label,
      assetType: item.assetType,
      ...(item.textContent !== undefined ? { textContent: item.textContent } : {}),
      ...(item.fileUrl !== undefined ? { fileUrl: item.fileUrl } : {}),
    };
  }
  // Canvas images become references on the canvas, never mentions.
  return null;
}
