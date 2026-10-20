import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MentionPill } from "../src/components/chat/mention-pill";
import { MENTION_PREFIX, mentionKindOf } from "../src/lib/mention-kinds";

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
});
