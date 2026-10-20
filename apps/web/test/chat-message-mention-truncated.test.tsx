import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ContentBlock } from "@loomic/shared";

import { ChatMessage } from "../src/components/chat-message";

afterEach(cleanup);

/**
 * AG-03: a sent user message carrying a brand-kit text asset.
 *
 * `textContent` is the asset body the composer attached when the mention was
 * created (chat-sidebar.tsx), so the sent message can say whether the server
 * had to cut it.
 */
function sentTextAssetMessage(textContent: string) {
  const contentBlocks: ContentBlock[] = [
    { type: "text", text: "用这个素材" },
    {
      type: "mention",
      mentionType: "brand-kit-asset",
      id: "a1",
      label: "设计指南",
      assetType: "font",
      textContent,
    },
  ];

  return <ChatMessage role="user" contentBlocks={contentBlocks} />;
}

describe("sent message mention truncation (AG-03)", () => {
  it("AG-03: a sent text asset over 4000 characters shows 已截断", () => {
    render(sentTextAssetMessage("字".repeat(4001)));

    const badge = screen.getByTestId("agent-mention-capsule-truncated");

    expect(badge.textContent).toBe("已截断");
  });

  it("AG-03: a sent text asset within the cap does not", () => {
    render(sentTextAssetMessage("字".repeat(10)));

    expect(screen.queryByTestId("agent-mention-capsule-truncated")).toBeNull();
  });
});
