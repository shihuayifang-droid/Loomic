import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerBaseUrl } from "../src/lib/env";

/**
 * 43M v2: the containerised web build is same-origin (deploy/nginx.conf proxies
 * /api and /objects). The build sets NEXT_PUBLIC_SERVER_BASE_URL=same-origin,
 * which getServerBaseUrl() turns into an empty base -- i.e. relative URLs on
 * the serving host instead of the localhost:3001 development fallback.
 */
describe("getServerBaseUrl same-origin sentinel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;
  });

  it("maps the same-origin sentinel to an empty base", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "same-origin");

    expect(getServerBaseUrl()).toBe("");
  });

  it("keeps the localhost fallback when the variable is unset", () => {
    delete process.env.NEXT_PUBLIC_SERVER_BASE_URL;

    expect(getServerBaseUrl()).toBe("http://localhost:3001");
  });

  it("keeps an explicit absolute base untouched", () => {
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "https://x.test");

    expect(getServerBaseUrl()).toBe("https://x.test");
  });
});
