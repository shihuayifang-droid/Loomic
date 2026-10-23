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

/**
 * OP-13 start-up self-check. Every assertion looks at key NAMES and at "no
 * value leaked into the message"; the values below are obvious placeholders,
 * never anything resembling a real credential.
 */
const PRODUCTION_SOURCE = {
  NODE_ENV: "production",
  LOOMIC_AGENT_BACKEND_MODE: "state",
} as const;

const COMPLETE_PRODUCTION_SOURCE = {
  ...PRODUCTION_SOURCE,
  DATABASE_URL:
    "postgres://placeholder-user@placeholder-host:5432/placeholder-db",
  SUPABASE_URL: "https://placeholder-project.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
  SUPABASE_JWT_SECRET: "placeholder-jwt-secret",
  OPENAI_API_KEY: "placeholder-openai-key",
} as const;

function productionErrorMessage(
  source: NodeJS.ProcessEnv,
  overrides: typeof VERSION_OVERRIDE = VERSION_OVERRIDE,
): string {
  try {
    loadServerEnv(overrides, source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("OP-13 production refuses to start without required configuration", () => {
  it("OP-13: production with every required key starts", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, COMPLETE_PRODUCTION_SOURCE),
    ).not.toThrow();
  });

  it("OP-13: production without DATABASE_URL refuses to start and names it", () => {
    const message = productionErrorMessage({
      ...COMPLETE_PRODUCTION_SOURCE,
      DATABASE_URL: undefined,
      SUPABASE_URL: "secret-value-xyz",
      SUPABASE_SERVICE_ROLE_KEY: "secret-value-xyz",
      SUPABASE_JWT_SECRET: "secret-value-xyz",
      OPENAI_API_KEY: "secret-value-xyz",
    });

    expect(message).toContain("databaseUrl");
    expect(message).toContain("OP-13");
    expect(message).not.toContain("supabaseUrl");
    expect(message).not.toContain("supabaseServiceRoleKey");
    expect(message).not.toContain("supabaseJwtSecret");
    expect(message).not.toContain("secret-value-xyz");
  });

  it("OP-13: production without any image provider refuses to start", () => {
    const message = productionErrorMessage({
      NODE_ENV: "production",
      LOOMIC_AGENT_BACKEND_MODE: "state",
      DATABASE_URL:
        "postgres://placeholder-user@placeholder-host:5432/placeholder-db",
      SUPABASE_URL: "https://placeholder-project.invalid",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
      SUPABASE_JWT_SECRET: "placeholder-jwt-secret",
    });

    expect(message).toContain("one of openAIApiKey");
    expect(message).not.toContain("placeholder-jwt-secret");
  });

  it("OP-13: every missing key is listed at once", () => {
    const message = productionErrorMessage(PRODUCTION_SOURCE);

    expect(message).toContain("OP-13");
    expect(message).toContain("databaseUrl");
    expect(message).toContain("supabaseUrl");
    expect(message).toContain("supabaseServiceRoleKey");
    expect(message).toContain("supabaseJwtSecret");
    expect(message).toContain(
      "one of openAIApiKey|googleApiKey|googleVertexProject|replicateApiToken|volcesApiKey",
    );
  });

  it("OP-13: development without keys still starts", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.databaseUrl).toBeUndefined();
    expect(env.supabaseUrl).toBeUndefined();
    expect(env.agentBackendMode).toBe("state");
  });
});

describe("AG-10 agent confirmation threshold", () => {
  it("AG-10: the threshold defaults to 50", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.agentConfirmThreshold).toBe(50);
  });

  it("AG-10: HAHART_AGENT_CONFIRM_THRESHOLD=20 sets the threshold to 20", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      HAHART_AGENT_CONFIRM_THRESHOLD: "20",
    });

    expect(env.agentConfirmThreshold).toBe(20);
  });

  it("AG-10: a negative threshold refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_AGENT_CONFIRM_THRESHOLD: "-1",
      }),
    ).toThrow("HAHART_AGENT_CONFIRM_THRESHOLD");
  });

  it("AG-10: a non-numeric threshold refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_AGENT_CONFIRM_THRESHOLD: "abc",
      }),
    ).toThrow("HAHART_AGENT_CONFIRM_THRESHOLD");
  });
});
