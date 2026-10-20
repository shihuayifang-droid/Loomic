// X-40 §3: the two generation routes used to answer `generation_failed` with
// `error.message` — the upstream / driver / network text, verbatim. These pin
// the replace route: the client always gets a fixed, category-level sentence.
import { afterEach, describe, expect, it, vi } from "vitest";

import { applicationErrorResponseSchema } from "@loomic/shared";

import { generationFailedBody, generatorRelayProvenance } from "./generate.js";

describe("generationFailedBody (X-40 §3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("X-40: an upstream error never reaches the client verbatim", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = generationFailedBody(
      new Error('replicate: 422 Unprocessable Entity {"detail":"secret prompt text"}'),
    );

    expect(body.error.code).toBe("generation_failed");
    expect(body.error.message).toBe("AI 服务暂时不可用，请稍后重试。");
    expect(JSON.stringify(body)).not.toContain("secret prompt text");
  });

  it("X-40: a database error is answered with the fixed data-service sentence", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = generationFailedBody(
      new Error('relation "public.assets" does not exist'),
    );

    expect(body.error.message).toBe("数据服务异常，请稍后重试。");
  });

  it("X-40: a non-Error value still yields a fixed sentence", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = generationFailedBody("boom");

    expect(body.error.message).toBe("请求处理失败，请重试。");
  });

  it("X-40: the body is a valid application error response", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = generationFailedBody(new Error("x"));

    expect(() => applicationErrorResponseSchema.parse(body)).not.toThrow();
  });
});

// GN-11 / T-84: the relay upload used to record where the image came from but
// not what it cost. These pin the provenance the relay now writes.
describe("generatorRelayProvenance (GN-11)", () => {
  it("GN-11: the relay provenance carries the charged amount", () => {
    expect(
      generatorRelayProvenance({ modelId: "m", prompt: "p", creditsCharged: 9 }),
    ).toEqual({
      source: "generator",
      operation: "image_generation",
      modelId: "m",
      prompt: "p",
      creditsCharged: 9,
    });
  });

  it("GN-11: a free generation records 0, not null", () => {
    const provenance = generatorRelayProvenance({
      modelId: "m",
      prompt: "p",
      creditsCharged: 0,
    });

    expect(provenance.creditsCharged).toBe(0);
  });
});
