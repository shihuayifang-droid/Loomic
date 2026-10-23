import { describe, expect, it } from "vitest";

import type { GeneratedImage, ImageGenerateParams } from "../../../generation/types.js";
import { TOOL_DEFINITIONS } from "../tool-definitions.js";
import { ToolRunError, type ToolRunnerInput } from "../tool-runners.js";
import { createQuickEditRunner, QUICK_EDIT_DEFAULT_MODEL } from "./quick-edit.js";
import { createRemoveBackgroundRunner } from "./remove-background.js";

/**
 * ED-06 / ED-07 / GN-05 — the two concrete tool runners.
 *
 * Neither test touches the network: the gateway is a fake `generate` that records
 * its parameters, and Replicate is a fake `fetchImpl`. What is pinned here is the
 * WIRE SHAPE (which model, which size, which bytes) and the failure mapping, not
 * any provider behaviour — the providers have their own tests.
 */

const SOURCE_BYTES = Buffer.from("source-image-bytes");
const EDITED_BYTES = Buffer.from("edited-image-bytes");
const CUTOUT_BYTES = Buffer.from("cutout-image-bytes");
const PREDICTION_URL = "/models/851-labs/background-remover/predictions";

type FakeGenerate = (
  providerName: string,
  params: ImageGenerateParams,
) => Promise<GeneratedImage>;
type FakeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** ED-06's gateway answer: the edited image, inline, at the source size. */
function editedImage(): GeneratedImage {
  return {
    url: `data:image/png;base64,${EDITED_BYTES.toString("base64")}`,
    mimeType: "image/png",
    width: 1024,
    height: 768,
  };
}

function toolInput(overrides: Partial<ToolRunnerInput> = {}): ToolRunnerInput {
  return {
    bytes: SOURCE_BYTES,
    mimeType: "image/png",
    width: 1024,
    height: 768,
    params: { prompt: "  把天空换成蓝色  " },
    model: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function bytesResponse(bytes: Buffer): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response;
}

function requestHeaders(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("quick_edit runner", () => {
  it("ED-06: quick edit sends the prompt, the source bytes and the source size", async () => {
    const calls: Array<{ providerName: string; params: ImageGenerateParams }> = [];
    const generate: FakeGenerate = async (providerName, params) => {
      calls.push({ providerName, params });
      return {
        url: `data:image/png;base64,${EDITED_BYTES.toString("base64")}`,
        mimeType: "image/png",
        width: 1024,
        height: 768,
      };
    };
    const runner = createQuickEditRunner({ generate });

    const result = await runner(toolInput());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // GN-05 keeps the provider fixed and configurable only by code, so it is
    // named here as the gateway's registered `name`.
    expect(call.providerName).toBe("openai");
    expect(call.params.model).toBe(QUICK_EDIT_DEFAULT_MODEL);
    expect(call.params.model).toBe("kwjm/gpt-image-2.5-sunburst");
    expect(call.params.size).toEqual({ width: 1024, height: 768 });
    expect(call.params.inputImages).toHaveLength(1);
    expect(call.params.inputImages?.[0]).toBe(
      `data:image/png;base64,${SOURCE_BYTES.toString("base64")}`,
    );
    expect(call.params.inputImages?.[0]?.startsWith("data:image/png;base64,")).toBe(true);
    // ED-06: the prompt reaches the provider trimmed.
    expect(call.params.prompt).toBe("把天空换成蓝色");
    expect(result).toEqual({ bytes: EDITED_BYTES, mimeType: "image/png" });
  });

  it("ED-06: an empty prompt is refused before any call", async () => {
    let generateCalls = 0;
    const generate: FakeGenerate = async () => {
      generateCalls += 1;
      return editedImage();
    };
    const runner = createQuickEditRunner({ generate });

    await expect(runner(toolInput({ params: { prompt: "   " } }))).rejects.toBeInstanceOf(
      ToolRunError,
    );
    await expect(runner(toolInput({ params: { prompt: "   " } }))).rejects.toMatchObject({
      code: "invalid_input",
      message: "请先描述要怎么改",
    });
    expect(generateCalls).toBe(0);
  });

  it("GN-05: the tool's execution model is used when given", async () => {
    const models: string[] = [];
    const generate: FakeGenerate = async (_providerName, params) => {
      models.push(params.model);
      return editedImage();
    };
    const runner = createQuickEditRunner({ generate });

    await runner(toolInput({ model: "kwjm/other" }));

    expect(models).toEqual(["kwjm/other"]);
  });
});

describe("remove_background runner", () => {
  it("ED-07: remove background posts the bytes, not a URL, to Replicate", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FakeFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return jsonResponse({ status: "succeeded", output: "https://x/out.png" });
      }
      return bytesResponse(CUTOUT_BYTES);
    };
    const runner = createRemoveBackgroundRunner({ apiToken: "test-token", fetchImpl });

    const result = await runner(toolInput({ params: {} }));

    expect(calls).toHaveLength(2);
    const prediction = calls[0]!;
    const download = calls[1]!;
    expect(prediction.url.endsWith(PREDICTION_URL)).toBe(true);
    expect(prediction.init?.method).toBe("POST");
    expect(requestHeaders(prediction.init).Prefer).toBe("wait");
    expect(requestHeaders(prediction.init).Authorization).toBe("Bearer test-token");

    const body = JSON.parse(String(prediction.init?.body)) as {
      input: { image: string };
    };
    expect(body.input.image.startsWith("data:")).toBe(true);
    expect(body.input.image).toBe(
      `data:image/png;base64,${SOURCE_BYTES.toString("base64")}`,
    );

    expect(download.url).toBe("https://x/out.png");
    expect(result).toEqual({ bytes: CUTOUT_BYTES, mimeType: "image/png" });
  });

  it("ED-07: a failed prediction is a provider failure", async () => {
    const fetchImpl: FakeFetch = async () =>
      jsonResponse({ status: "failed", error: "boom" });
    const runner = createRemoveBackgroundRunner({ apiToken: "test-token", fetchImpl });

    const error = await runner(toolInput({ params: {} })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ToolRunError);
    expect((error as ToolRunError).code).toBe("provider_failed");
    expect((error as Error).message).toContain("boom");
  });

  it("ED-07: no token fails at run time without calling out", async () => {
    let fetchCalls = 0;
    const fetchImpl: FakeFetch = async () => {
      fetchCalls += 1;
      return jsonResponse({ status: "succeeded", output: "https://x/out.png" });
    };
    const runner = createRemoveBackgroundRunner({ apiToken: "", fetchImpl });

    await expect(runner(toolInput({ params: {} }))).rejects.toMatchObject({
      code: "provider_failed",
      message: "Replicate API token is not configured",
    });
    expect(fetchCalls).toBe(0);
  });
});

describe("tool definitions", () => {
  it("GN-05: both tools name their execution model", () => {
    const quickEdit = TOOL_DEFINITIONS.find((tool) => tool.id === "quick_edit");
    const removeBackground = TOOL_DEFINITIONS.find(
      (tool) => tool.id === "remove_background",
    );

    expect(quickEdit?.execution_model).toBe("kwjm/gpt-image-2.5-sunburst");
    expect(removeBackground?.execution_model).toBe("replicate/851-labs/background-remover");
  });
});
