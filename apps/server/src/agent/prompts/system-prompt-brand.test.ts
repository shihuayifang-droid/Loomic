// BR-17 (工单36N): the product name is HaHart (D-26). The agent's own
// self-introduction lives in the system prompt text, so the brand rename is a
// prompt-content change and nothing else — the exported constant keeps its
// `LOOMIC_SYSTEM_PROMPT` name until the separate code-identifier rename.
//
// These two assertions pin the two ends that matter: the agent says HaHart when
// asked who it is, and the old brand name no longer appears anywhere in what the
// agent says.
import { describe, expect, it } from "vitest";

import { LOOMIC_SYSTEM_PROMPT } from "./loomic-main.js";

describe("system prompt brand", () => {
  it("BR-17: the agent introduces itself as HaHart", () => {
    expect(LOOMIC_SYSTEM_PROMPT.startsWith("你是 HaHart，")).toBe(true);
  });

  it("BR-17: the old brand name is not in what the agent says", () => {
    expect(LOOMIC_SYSTEM_PROMPT).not.toMatch(/loomic/i);
  });
});
