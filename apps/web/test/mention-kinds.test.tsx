import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MentionPill } from "../src/components/chat/mention-pill";
import { MENTION_PREFIX, MENTION_TEXT_MAX_CHARS, isMentionTextTruncated, mentionFromPickerItem, mentionKindOf } from "../src/lib/mention-kinds";

afterEach(cleanup);

describe("mention kinds (AG-03)", () => {
  it("AG-03: the four legacy types map onto the new kinds", () => {
    expect(mentionKindOf("canvas-image")).toBe("shape");
    expect(mentionKindOf("brand-kit-asset")).toBe("asset");
    expect(mentionKindOf("image-model")).toBe("model");
    expect(mentionKindOf("skill")).toBe("skill");
  });

  it("AG-03: the prefix table matches the spec", () => {
    expect(MENTION_PREFIX).toEqual({
      shape: "shape-",
      asset: "asset-",
      file: "file-",
      model: "model-",
      skill: "skill-",
    });
  });

  it("AG-03: an unknown type is null", () => {
    expect(mentionKindOf("nope")).toBeNull();
    expect(mentionKindOf("")).toBeNull();
  });

  it("AG-03: an old message's model mention renders as a model capsule", () => {
    // A message saved before the migration still carries kind="image-model".
    render(<MentionPill label="Imagen 4" kind="image-model" />);

    const capsule = screen.getByTestId("agent-mention-capsule");

    expect(capsule.getAttribute("data-kind")).toBe("model");
    expect(capsule.textContent).toContain("模型");
    expect(capsule.textContent).toContain("Imagen 4");
  });

  it("AG-03: an old brand-kit mention renders as an asset capsule", () => {
    render(<MentionPill label="春季品牌素材" kind="brand-kit-asset" />);

    const capsule = screen.getByTestId("agent-mention-capsule");

    expect(capsule.getAttribute("data-kind")).toBe("asset");
    expect(capsule.textContent).toContain("素材");
  });

  it("AG-03: an unknown kind still renders with data-kind unknown", () => {
    render(<MentionPill label="???" kind="mystery" />);

    const capsule = screen.getByTestId("agent-mention-capsule");

    expect(capsule.getAttribute("data-kind")).toBe("unknown");
    expect(capsule.textContent).toContain("引用");
  });

  it("AG-03: the injection cap is 4000 characters", () => {
    expect(MENTION_TEXT_MAX_CHARS).toBe(4000);
    expect(isMentionTextTruncated("字".repeat(4000))).toBe(false);
    expect(isMentionTextTruncated("字".repeat(4001))).toBe(true);
  });

  it("AG-03: empty or missing text is never truncated", () => {
    expect(isMentionTextTruncated("")).toBe(false);
    expect(isMentionTextTruncated(null)).toBe(false);
    expect(isMentionTextTruncated(undefined)).toBe(false);
  });

  it("AG-03: a truncated capsule says 已截断", () => {
    render(<MentionPill label="设计指南" kind="brand-kit-asset" truncated />);

    const badge = screen.getByTestId("agent-mention-capsule-truncated");

    expect(badge.textContent).toBe("已截断");
  });

  it("AG-03: a capsule within the cap shows no truncation", () => {
    render(<MentionPill label="设计指南" kind="brand-kit-asset" />);

    expect(screen.queryByTestId("agent-mention-capsule-truncated")).toBeNull();
  });

  it("AG-03: a brand text asset becomes a mention with its text", () => {
    const mention = mentionFromPickerItem({
      kind: "brand-kit-asset",
      id: "a1",
      label: "设计指南",
      assetType: "font",
      textContent: "正文",
    });

    expect(mention).toEqual({
      mentionType: "brand-kit-asset",
      id: "a1",
      label: "设计指南",
      assetType: "font",
      textContent: "正文",
    });
    expect(
      Object.prototype.hasOwnProperty.call(mention, "fileUrl"),
    ).toBe(false);
  });

  it("AG-03: an image model becomes a model mention", () => {
    const mention = mentionFromPickerItem({
      kind: "image-model",
      id: "m1",
      label: "Imagen 4",
      description: "A model",
    });

    expect(mention).toEqual({
      mentionType: "image-model",
      id: "m1",
      label: "Imagen 4",
    });
  });

  it("AG-03: a skill keeps its slug", () => {
    const mention = mentionFromPickerItem({
      kind: "skill",
      id: "s1",
      label: "写文案",
      slug: "copy-writing",
      description: "Writes copy",
    });

    expect(mention).toEqual({
      mentionType: "skill",
      id: "s1",
      label: "写文案",
      slug: "copy-writing",
    });
  });

  it("AG-03: canvas images are references, not mentions", () => {
    const mention = mentionFromPickerItem({
      kind: "canvas-image",
      id: "c1",
      name: "画布图 1",
      thumbnailUrl: "https://example.com/thumb.png",
      assetId: "asset-1",
      url: "https://example.com/image.png",
      mimeType: "image/png",
    });

    expect(mention).toBeNull();
  });

  it("AG-03: the same pick always serialises the same", () => {
    const item = {
      kind: "brand-kit-asset",
      id: "a1",
      label: "设计指南",
      assetType: "font",
      textContent: "正文",
    } as const;

    const first = mentionFromPickerItem(item);
    const second = mentionFromPickerItem(item);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
