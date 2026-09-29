import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  ChatOpenAIImageUrlCompat,
  normalizeImageUrlBlocks,
} from "./openai-image-url-compat.js";

describe("normalizeImageUrlBlocks", () => {
  it("★ rewrites a bare image_url string into the { url } object form", () => {
    const messages = [
      new HumanMessage({
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: "data:image/webp;base64,AAAA" },
        ],
      }),
    ];

    const [normalized] = normalizeImageUrlBlocks(messages);

    expect(normalized!.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/webp;base64,AAAA" } },
    ]);
  });

  it("★ never leaves a string image_url anywhere in the output", () => {
    const messages = [
      new HumanMessage({
        content: [
          { type: "image_url", image_url: "https://example.com/a.png" },
          { type: "image_url", image_url: { url: "https://example.com/b.png" } },
        ],
      }),
      new AIMessage({
        content: [{ type: "image_url", image_url: "data:image/png;base64,BBBB" }],
      }),
    ];

    const out = normalizeImageUrlBlocks(messages);

    for (const message of out) {
      if (typeof message.content === "string") continue;
      for (const part of message.content) {
        if ((part as { type?: string }).type !== "image_url") continue;
        expect(typeof (part as { image_url?: unknown }).image_url).toBe("object");
      }
    }
  });

  it("returns the same array when nothing needs changing", () => {
    const messages = [
      new HumanMessage("plain text"),
      new HumanMessage({
        content: [
          { type: "text", text: "already canonical" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      }),
    ];

    expect(normalizeImageUrlBlocks(messages)).toBe(messages);
  });

  it("does not mutate the input messages", () => {
    const original = new HumanMessage({
      content: [{ type: "image_url", image_url: "data:image/png;base64,CCCC" }],
    });

    normalizeImageUrlBlocks([original]);

    expect(original.content).toEqual([
      { type: "image_url", image_url: "data:image/png;base64,CCCC" },
    ]);
  });

  it("preserves message class, id and tool_call_id on cloned messages", () => {
    const messages = [
      new ToolMessage({
        id: "msg-1",
        tool_call_id: "call-1",
        content: [{ type: "image_url", image_url: "data:image/png;base64,DDDD" }],
      }),
    ];

    const [normalized] = normalizeImageUrlBlocks(messages);

    expect(normalized).toBeInstanceOf(ToolMessage);
    expect(normalized!.id).toBe("msg-1");
    expect((normalized as ToolMessage).tool_call_id).toBe("call-1");
  });

  it("preserves tool_calls when cloning an AIMessage", () => {
    const messages = [
      new AIMessage({
        content: [{ type: "image_url", image_url: "data:image/png;base64,EEEE" }],
        tool_calls: [{ id: "call-9", name: "generate_image", args: { prompt: "cat" } }],
      }),
    ];

    const [normalized] = normalizeImageUrlBlocks(messages);

    expect((normalized as AIMessage).tool_calls).toEqual([
      { id: "call-9", name: "generate_image", args: { prompt: "cat" } },
    ]);
  });

  it("leaves non-image content parts untouched", () => {
    const messages = [
      new HumanMessage({
        content: [
          { type: "text", text: "hi" },
          { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
          { type: "image_url", image_url: "data:image/png;base64,FFFF" },
        ],
      }),
    ];

    const [normalized] = normalizeImageUrlBlocks(messages);
    const content = normalized!.content as Array<Record<string, unknown>>;

    expect(content[0]).toEqual({ type: "text", text: "hi" });
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "AAA", format: "wav" },
    });
  });
});

describe("ChatOpenAIImageUrlCompat", () => {
  const makeModel = () =>
    new ChatOpenAIImageUrlCompat({ model: "deepseek-chat", apiKey: "test-key" });

  const tool = {
    type: "function" as const,
    function: {
      name: "noop",
      description: "does nothing",
      parameters: { type: "object", properties: {} },
    },
  };

  // These two are the invariants that the normalization tests above cannot
  // catch. `ChatOpenAI.withConfig` in @langchain/openai@1.3.0 returns
  // `new ChatOpenAI(this.fields)` — a hardcoded class, not `this.constructor` —
  // and `bindTools` is built on `withConfig`. The agent binds tools before every
  // call, so if either clone point drops the subclass the normalization above
  // still passes its own tests while doing nothing on the real request.
  it("★ survives withConfig as the same subclass", () => {
    expect(makeModel().withConfig({ stop: ["\n"] })).toBeInstanceOf(
      ChatOpenAIImageUrlCompat,
    );
  });

  it("★ survives bindTools as the same subclass", () => {
    expect(makeModel().bindTools([tool])).toBeInstanceOf(ChatOpenAIImageUrlCompat);
  });

  it("carries bound call options onto the clone", () => {
    const bound = makeModel().bindTools([tool]) as ChatOpenAIImageUrlCompat;

    expect(bound.invocationParams().tools).toHaveLength(1);
  });
});
