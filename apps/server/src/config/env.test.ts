import { describe, expect, it } from "vitest";

import { isProductionEnv, loadServerEnv } from "./env.js";

/**
 * AG-39 / QA-12 / OP-13: production must refuse the filesystem backend mode,
 * and "production" has exactly one definition (NODE_ENV=production).
 *
 * Every case passes its own `source`, so nothing here reads or mutates
 * `process.env` — vitest itself runs with NODE_ENV=test.
 */
const VERSION_OVERRIDE = { version: "0.0.0-test" };

describe("AG-39 production refuses the filesystem backend", () => {
  it("AG-39: production refuses the filesystem backend", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "production",
        LOOMIC_AGENT_BACKEND_MODE: "filesystem",
      }),
    ).toThrow(/not allowed in production/);
  });

  it("AG-39: an override cannot smuggle filesystem into production", () => {
    expect(() =>
      loadServerEnv(
        { ...VERSION_OVERRIDE, agentBackendMode: "filesystem" },
        { NODE_ENV: "production", LOOMIC_AGENT_BACKEND_MODE: "state" },
      ),
    ).toThrow(/not allowed in production/);
  });

  it("AG-39: development may still use the filesystem backend", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      LOOMIC_AGENT_BACKEND_MODE: "filesystem",
    });

    expect(env.agentBackendMode).toBe("filesystem");
  });
});

describe("OP-13 isProductionEnv", () => {
  it("OP-13: production is NODE_ENV=production and nothing else", () => {
    expect(isProductionEnv({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ NODE_ENV: "test" })).toBe(false);
  });
});
