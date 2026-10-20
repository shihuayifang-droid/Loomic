"use client";

import React from "react";

import { MENTION_KIND_LABEL, mentionKindOf } from "@/lib/mention-kinds";

type MentionPillProps = {
  label: string;
  /**
   * A canonical mention kind OR a legacy wire type ("image-model",
   * "brand-kit-asset", …): messages saved before AG-03 still carry the old
   * names, so the prop stays `string` and is normalized below.
   */
  kind: string;
};

/**
 * Inline pill displaying a user mention (model or brand-kit asset).
 * Memoized because it receives stable string props and re-renders frequently
 * inside streaming message lists.
 */
export const MentionPill = React.memo(function MentionPill({
  label,
  kind,
}: MentionPillProps) {
  const k = mentionKindOf(kind);
  return (
    <span
      className="inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 mx-0.5 border-[0.5px] border-muted-foreground text-foreground align-middle"
      data-testid="agent-mention-capsule"
      data-kind={k ?? "unknown"}
    >
      <span className="text-[10px] leading-none text-muted-foreground">
        {k === null ? "引用" : MENTION_KIND_LABEL[k]}
      </span>
      <span className="max-w-[120px] truncate text-[11px] leading-none text-foreground">
        {label}
      </span>
    </span>
  );
});
