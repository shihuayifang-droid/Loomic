import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl, loadWebEnv } from "../src/lib/env";

describe("@loomic/web env helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the browser-safe Supabase env and explicit server base url", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4010");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", " https://example.supabase.co ");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", " anon-key ");

    const env = loadWebEnv();

    expect(env).toEqual({
      serverBaseUrl: "http://localhost:4010",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    });
  });

  it("rejects missing browser-safe Supabase env values", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(() => loadWebEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("does not require the Supabase env when the provider is self", () => {
    vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", "self");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const env = loadWebEnv();

    expect(env.supabaseUrl).toBe("");
    expect(env.supabaseAnonKey).toBe("");
  });

  it("still requires the Supabase env when the provider is supabase", () => {
    vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", "supabase");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(() => loadWebEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("keeps getServerBaseUrl compatible with the default fallback", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "");

    expect(getServerBaseUrl()).toBe("http://localhost:3001");
  });

  it("reads getServerBaseUrl from process env when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:4020");

    expect(getServerBaseUrl()).toBe("http://localhost:4020");
  });
});
