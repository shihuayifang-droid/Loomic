import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIImageProvider } from "./openai-image.js";

/** 1x1 PNG — the tests never decode it, they only need the wire to look valid. */
const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** Reference image as a data URI so `fetchAsBase64` inlines it instead of
 * hitting the network — the only `fetch` calls recorded are the API calls. */
const SOURCE_PNG_DATA_URI = `data:image/png;base64,${ONE_PX_PNG_BASE64}`;

/** Every size string the tier table can emit. */
const TIER_TABLE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(calls: RecordedCall[]) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: ONE_PX_PNG_BASE64 }] }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function provider(): OpenAIImageProvider {
  return new OpenAIImageProvider("test-key", "https://gateway.test/v1");
}

function formOf(call: RecordedCall): FormData {
  expect(call.init.body).toBeInstanceOf(FormData);
  return call.init.body as FormData;
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIImageProvider sizes", () => {
  it("ED-06: sunburst sends the exact source size", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    const image = await provider().generate({
      prompt: "make it sunny, keep the framing",
      model: "kwjm/gpt-image-2.5-sunburst",
      size: { width: 1280, height: 720 },
      inputImages: [SOURCE_PNG_DATA_URI],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/images/edits");

    const form = formOf(calls[0]!);
    expect(form.get("size")).toBe("1280x720");
    expect(form.get("model")).toBe("gpt-image-2.5-sunburst");

    expect(image.width).toBe(1280);
    expect(image.height).toBe(720);
  });

  it("sunburst without a size keeps the tier table", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    await provider().generate({
      prompt: "make it sunny",
      model: "kwjm/gpt-image-2.5-sunburst",
      inputImages: [SOURCE_PNG_DATA_URI],
    });

    const size = formOf(calls[0]!).get("size");
    expect(TIER_TABLE_SIZES).toContain(size);
    // Defaults are quality "hd" + aspectRatio "1:1".
    expect(size).toBe("2048x2048");
  });

  it("gpt-image-2 ignores an explicit size", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    const image = await provider().generate({
      prompt: "make it sunny",
      model: "kwjm/gpt-image-2",
      size: { width: 1280, height: 720 },
      inputImages: [SOURCE_PNG_DATA_URI],
    });

    const size = formOf(calls[0]!).get("size");
    expect(size).not.toBe("1280x720");
    expect(TIER_TABLE_SIZES).toContain(size);
    expect(size).toBe("2048x2048");
    expect(image.width).toBe(2048);
    expect(image.height).toBe(2048);
  });

  it("both endpoints send a browser User-Agent", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    const instance = provider();

    // generations (no reference image)
    await instance.generate({
      prompt: "a cat",
      model: "kwjm/gpt-image-2",
    });

    // edits (one reference image)
    await instance.generate({
      prompt: "make it sunny",
      model: "kwjm/gpt-image-2.5-sunburst",
      size: { width: 640, height: 480 },
      inputImages: [SOURCE_PNG_DATA_URI],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/images/generations");
    expect(calls[1]!.url).toContain("/images/edits");

    for (const call of calls) {
      const userAgent = headersOf(call)["User-Agent"];
      expect(typeof userAgent).toBe("string");
      expect(userAgent!.startsWith("Mozilla/5.0")).toBe(true);
    }
  });

  it("sunburst is not in the public model catalog", () => {
    const ids = provider().models.map((model) => model.id);

    expect(ids).not.toContain("kwjm/gpt-image-2.5-sunburst");
  });
});

describe("OpenAIImageProvider catalogue sizes", () => {
  it("gpt-image-2 sends a size the gateway lists verbatim", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    await provider().generate({
      prompt: "a cat",
      model: "kwjm/gpt-image-2",
      size: { width: 2048, height: 1152 },
    });

    expect(JSON.parse(String(calls[0]!.init.body)).size).toBe("2048x1152");
  });

  it("gpt-image-2 falls back to the tier table for a size the gateway does not list", async () => {
    const calls: RecordedCall[] = [];
    stubFetch(calls);

    await provider().generate({
      prompt: "a cat",
      model: "kwjm/gpt-image-2",
      size: { width: 1280, height: 720 },
    });

    expect(JSON.parse(String(calls[0]!.init.body)).size).toBe("2048x2048");
  });
});
