import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { MockImageProvider } from "./mock-image.js";
import { OpenAIImageProvider } from "./openai-image.js";
import { registerAllProviders } from "./register-all.js";
import { clearProviders, getImageProvider } from "./registry.js";

function envWith(extra: Partial<ServerEnv>): ServerEnv {
  return {
    agentBackendMode: "state",
    agentModel: "test",
    port: 0,
    version: "test",
    webOrigin: "http://localhost",
    ...extra,
  } as ServerEnv;
}

function declared(provider: { models: readonly { id: string; operation: string }[] }) {
  return provider.models.map((m) => `${m.id}:${m.operation}`).sort();
}

describe("MockImageProvider (HAHART_IMAGE_PROVIDER_MOCK)", () => {
  beforeEach(() => {
    clearProviders();
  });
  afterEach(() => {
    clearProviders();
  });

  it("returns byte-identical output for the same input", async () => {
    const mock = new MockImageProvider(new OpenAIImageProvider("k"));
    const params = { prompt: "a cat", model: "kwjm/gpt-image-2" };

    const first = await mock.generate(params);
    const second = await mock.generate(params);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const bytes = (r: { url: string }) =>
      Buffer.from(r.url.split(",")[1] ?? "", "base64");
    expect(bytes(first).length).toBeGreaterThan(0);
    expect(bytes(second).equals(bytes(first))).toBe(true);
    expect(first.mimeType).toBe("image/png");
    expect(first.providerMeta.mock).toBe(true);
  });

  it("declares the same name, models and operations as the provider it replaces", () => {
    const real = new OpenAIImageProvider("k");
    const mock = new MockImageProvider(real);

    expect(mock.name).toBe(real.name);
    expect(declared(mock)).toEqual(declared(real));
    expect(declared(mock).length).toBeGreaterThan(0);
  });

  it("registerAllProviders installs the mock when hahartImageProviderMock=true", async () => {
    const realName = new OpenAIImageProvider("k").name;
    registerAllProviders(
      envWith({ openAIApiKey: "k", hahartImageProviderMock: true }),
    );

    const provider = getImageProvider(realName);
    expect(provider).toBeInstanceOf(MockImageProvider);
    const out = await provider.generate({ prompt: "x", model: "kwjm/gpt-image-2" });
    expect((out as { providerMeta?: { mock?: boolean } }).providerMeta?.mock).toBe(true);
  });

  it("registerAllProviders keeps the real provider when the flag is off", () => {
    const realName = new OpenAIImageProvider("k").name;
    registerAllProviders(envWith({ openAIApiKey: "k" }));

    expect(getImageProvider(realName)).toBeInstanceOf(OpenAIImageProvider);
  });
});
