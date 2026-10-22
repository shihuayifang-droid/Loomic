// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomePrompt } from "@/components/home-prompt";
import { AGENT_INPUT_PLACEHOLDER } from "@/lib/composer-copy";

const here = path.dirname(fileURLToPath(import.meta.url));

function readComponentSource(relativePath: string): string {
  return readFileSync(path.resolve(here, "..", relativePath), "utf8");
}

describe("AG-02 composer copy", () => {
  afterEach(() => {
    cleanup();
  });

  it("AG-02: the placeholder is the spec wording", () => {
    expect(AGENT_INPUT_PLACEHOLDER).toBe(
      "请描述你的设计需求，\u201c/\u201d使用技能，\u201c@\u201d引用参考",
    );
  });

  it("AG-02: the home prompt shows it", () => {
    render(<HomePrompt onSubmit={vi.fn()} />);

    expect(
      screen.getByTestId("home-prompt-input").getAttribute("data-placeholder"),
    ).toBe(AGENT_INPUT_PLACEHOLDER);
  });

  it("AG-02: home and canvas use the same input component", () => {
    for (const relativePath of [
      "src/components/home-prompt.tsx",
      "src/components/chat-input.tsx",
    ]) {
      const source = readComponentSource(relativePath);
      expect(
        source.includes('from "./chat-composer"') ||
          source.includes("from \"@/components/chat-composer\""),
      ).toBe(true);
      expect(source).toContain("<ChatComposer");
    }
    expect(readComponentSource("src/components/home-prompt.tsx")).not.toContain(
      "<textarea",
    );
  });

  it("AG-02: no input still says Loomic", () => {
    for (const relativePath of [
      "src/components/home-prompt.tsx",
      "src/components/chat-input.tsx",
    ]) {
      const source = readComponentSource(relativePath);
      expect(source).not.toContain("Loomic");
      expect(source).not.toContain("Start with an idea");
    }
  });
});
