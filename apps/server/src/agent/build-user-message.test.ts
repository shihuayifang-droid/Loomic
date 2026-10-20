// AG-03 (工单34D): a text asset mentioned with @ is injected into the prompt as
// the `text_content` attribute of its <brand_kit_asset> element, but never more
// than MENTION_TEXT_MAX_CHARS characters. The cap is applied to the RAW text
// (before XML escaping), and a cut element says so with `truncated="true"`, so
// the agent can tell "this is the whole thing" from "you are seeing the head".
//
// These are the first tests that call `buildUserMessage` directly. Everything the
// prompt is assembled from — canvas summary, attachments, generation
// preferences, mentions — funnels through it, so the assertions below pin the
// two ends that matter here: a short text arrives verbatim, a long text arrives
// bounded and labelled.
import { describe, expect, it } from "vitest";

import type { ImageAttachment, MessageMention } from "@loomic/shared";

import {
  MENTION_TEXT_MAX_CHARS,
  buildReferenceList,
  buildUserMessage,
} from "./runtime.js";

/** A brand-kit mention carrying `textContent` (the @-injected body). */
function textAssetMention(textContent: string | null): MessageMention {
  return {
    mentionType: "brand-kit-asset",
    id: "asset-1",
    label: "设计指南",
    assetType: "font",
    textContent,
  };
}

/** The raw (unescaped-as-far-as-the-test-cares) `text_content` attribute value. */
function textContentAttrOf(text: string): string {
  const match = /\btext_content="([^"]*)"/.exec(text);
  expect(match, `no text_content attribute in: ${text.slice(0, 120)}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("buildUserMessage", () => {
  it("AG-03: a prompt with nothing attached is returned unchanged", () => {
    expect(buildUserMessage("hi", [])).toEqual({ text: "hi" });
  });

  it("AG-03: a mentioned text asset's content reaches the prompt", () => {
    const { text } = buildUserMessage("让海报更活泼", [], undefined, [
      textAssetMention("主色 #FF6600，字体思源黑体"),
    ]);

    expect(text).toContain('text_content="主色 #FF6600，字体思源黑体"');
    expect(text).not.toContain("truncated");
  });

  it("AG-03: text over 4000 characters is cut to 4000 and marked truncated", () => {
    const { text } = buildUserMessage("hi", [], undefined, [
      textAssetMention("字".repeat(4001)),
    ]);

    expect(textContentAttrOf(text).length).toBe(4000);
    expect(textContentAttrOf(text)).toBe("字".repeat(MENTION_TEXT_MAX_CHARS));
    expect(text).toContain('truncated="true"');
  });

  it("AG-03: exactly 4000 characters is kept whole and not marked", () => {
    const whole = "字".repeat(4000);
    const { text } = buildUserMessage("hi", [], undefined, [
      textAssetMention(whole),
    ]);

    expect(textContentAttrOf(text)).toBe(whole);
    expect(textContentAttrOf(text).length).toBe(MENTION_TEXT_MAX_CHARS);
    expect(text).not.toContain("truncated");
  });

  it("AG-03: quotes and angle brackets in the text are escaped after cutting", () => {
    const { text } = buildUserMessage("hi", [], undefined, [
      textAssetMention('a"b<c>&'),
    ]);

    expect(textContentAttrOf(text)).toBe("a&quot;b&lt;c&gt;&amp;");
  });

  it("AG-03: an image asset without text gets no text_content attribute", () => {
    const { text } = buildUserMessage("hi", [], undefined, [
      textAssetMention(null),
    ]);

    expect(text).not.toContain("text_content=");
  });

  it("AG-03: the cap is the spec's 4000 characters", () => {
    expect(MENTION_TEXT_MAX_CHARS).toBe(4000);
  });
});

/** An image attachment as the runtime sees it — only the fields it reads. */
function imageAttachment(assetId: string): ImageAttachment {
  return { assetId, mimeType: "image/png" };
}

/** A skill mention: slug + label, and no version/source field yet. */
function skillMention(slug: string, label: string): MessageMention {
  return { mentionType: "skill", id: "skill-1", label, slug };
}

/** A model mention, whose `id` is the model key the agent is told to use. */
function modelMention(id: string): MessageMention {
  return { mentionType: "image-model", id, label: id };
}

describe("buildReferenceList (AG-05)", () => {
  it("AG-05: a message with one image and one skill ends with their numbered references", () => {
    const { text } = buildUserMessage(
      "做一张海报",
      [imageAttachment("a1")],
      undefined,
      [skillMention("poster", "海报")],
    );

    expect(
      text.endsWith(
        "<references>\nImage #1: asset:a1\nSkill #1: poster, 海报\n</references>",
      ),
    ).toBe(true);
  });

  it("AG-05: a mentioned model is listed as Model:", () => {
    const { text } = buildUserMessage("hi", [], undefined, [
      modelMention("google/nano-banana"),
    ]);

    expect(text).toContain("Model: google/nano-banana");
  });

  it("AG-05: no attachments and no mentions add no reference list", () => {
    expect(buildReferenceList([], [])).toBeNull();
    expect(buildUserMessage("hi", [])).toEqual({ text: "hi" });
  });

  it("AG-05: the existing blocks are kept", () => {
    const { text } = buildUserMessage(
      "做一张海报",
      [imageAttachment("a1")],
      undefined,
      [skillMention("poster", "海报")],
    );

    expect(text).toContain("<input_images");
    expect(text).toContain("<human_skill_mentions");
  });

  it("AG-05: reference values are escaped", () => {
    const { text } = buildUserMessage("hi", [], undefined, [
      skillMention("poster", 'a"<b>'),
    ]);

    expect(text).toContain("Skill #1: poster, a&quot;&lt;b&gt;");
  });
});
