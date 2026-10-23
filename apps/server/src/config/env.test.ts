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

/**
 * S-A3 (ADR-0001): the HAHART_AUTH_PROVIDER switch and the self-hosted token
 * configuration. The values below are obvious placeholders; one case asserts
 * that a configured secret never reaches the error message.
 */
const SELF_SECRET = "self-auth-test-secret-0123456789abcd";

describe("S-A3 auth provider switch", () => {
  it("S-A3: authProvider defaults to supabase", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.authProvider).toBe("supabase");
  });

  it("S-A3: HAHART_AUTH_PROVIDER=self without a secret refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_AUTH_PROVIDER: "self",
      }),
    ).toThrow("HAHART_AUTH_JWT_SECRET");
  });

  it("S-A3: a too-short self-mode secret refuses to start and is never echoed", () => {
    const message = productionErrorMessage(
      {
        NODE_ENV: "development",
        HAHART_AUTH_PROVIDER: "self",
        HAHART_AUTH_JWT_SECRET: "too-short-placeholder-secret",
      },
      VERSION_OVERRIDE,
    );

    expect(message).toContain("HAHART_AUTH_JWT_SECRET");
    expect(message).not.toContain("too-short-placeholder-secret");
  });

  it("S-A3: self with a 32-byte secret starts and keeps the default issuer / audience", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      HAHART_AUTH_PROVIDER: "self",
      HAHART_AUTH_JWT_SECRET: SELF_SECRET,
    });

    expect(env.authProvider).toBe("self");
    expect(env.authJwtSecret).toBe(SELF_SECRET);
    expect(env.authJwtIssuer).toBe("hahart");
    expect(env.authJwtAudience).toBe("hahart-api");
  });

  it("S-A3: an unknown HAHART_AUTH_PROVIDER refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_AUTH_PROVIDER: "oauth",
      }),
    ).toThrow("Invalid HAHART_AUTH_PROVIDER value: oauth");
  });
});

/**
 * OP-05 (43B): the object storage switch. The default keeps the backend the
 * server uses today, `fs` parses even though the volume backend is a later
 * ticket, and an unknown value refuses to start.
 */
describe("OP-05 object storage provider switch", () => {
  it("OP-05: storageProvider defaults to supabase", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.storageProvider).toBe("supabase");
  });

  it("OP-05: HAHART_STORAGE_PROVIDER=fs parses", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      HAHART_STORAGE_PROVIDER: "fs",
      HAHART_OBJECT_ROOT: "/data/objects",
      HAHART_OBJECT_URL_SECRET: "x".repeat(32),
      HAHART_OBJECT_PUBLIC_BASE: "https://hahart.example.test",
    });

    expect(env.storageProvider).toBe("fs");
  });

  it("OP-05: HAHART_STORAGE_PROVIDER=supabase parses", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      HAHART_STORAGE_PROVIDER: "supabase",
    });

    expect(env.storageProvider).toBe("supabase");
  });

  it("OP-05: an unknown storage provider refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_STORAGE_PROVIDER: "s3",
      }),
    ).toThrow("Invalid HAHART_STORAGE_PROVIDER value: s3");
  });
});

/**
 * OP-05 (43E): the file volume's three settings. They are all-or-nothing once
 * `HAHART_STORAGE_PROVIDER=fs` - a missing directory, key or public origin would
 * otherwise only break at the first request.
 */
describe("OP-05 file volume configuration", () => {
  const FS_SOURCE = {
    NODE_ENV: "development",
    HAHART_STORAGE_PROVIDER: "fs",
    HAHART_OBJECT_ROOT: "/var/lib/hahart/objects",
    HAHART_OBJECT_URL_SECRET: "0123456789abcdef0123456789abcdef",
    HAHART_OBJECT_PUBLIC_BASE: "https://hahart.example.com",
  };

  it("OP-05: fs with all three variables loads them", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, FS_SOURCE);

    expect(env.objectRoot).toBe("/var/lib/hahart/objects");
    expect(env.objectUrlSecret).toBe("0123456789abcdef0123456789abcdef");
    expect(env.objectPublicBase).toBe("https://hahart.example.com");
  });

  it("OP-05: the public base loses its trailing slash", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      ...FS_SOURCE,
      HAHART_OBJECT_PUBLIC_BASE: "https://hahart.example.com/",
    });

    expect(env.objectPublicBase).toBe("https://hahart.example.com");
  });

  it.each([
    "HAHART_OBJECT_ROOT",
    "HAHART_OBJECT_URL_SECRET",
    "HAHART_OBJECT_PUBLIC_BASE",
  ])("OP-05: fs without %s refuses to start and names the variables", (name) => {
    const source: NodeJS.ProcessEnv = { ...FS_SOURCE };
    delete source[name];

    let message = "";
    try {
      loadServerEnv(VERSION_OVERRIDE, source);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("HAHART_OBJECT_ROOT");
    expect(message).toContain("HAHART_OBJECT_URL_SECRET");
    expect(message).toContain("HAHART_OBJECT_PUBLIC_BASE");
  });

  it("OP-05: fs with a too-short secret refuses to start and never echoes it", () => {
    const short = "too-short-placeholder-secret";

    let message = "";
    try {
      loadServerEnv(VERSION_OVERRIDE, {
        ...FS_SOURCE,
        HAHART_OBJECT_URL_SECRET: short,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("HAHART_OBJECT_URL_SECRET");
    expect(message).not.toContain(short);
  });

  it("OP-05: a supabase install leaves the three fields unset", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.objectRoot).toBeUndefined();
    expect(env.objectUrlSecret).toBeUndefined();
    expect(env.objectPublicBase).toBeUndefined();
  });
});

/**
 * 43L: the message-queue switch. The default keeps the pgmq extension client, so
 * an unset variable cannot change what the server and the worker connect to;
 * `native` is the plain-table queue of the new database; an unknown value
 * refuses to start instead of silently polling the wrong queue.
 */
describe("43L queue provider switch", () => {
  it("43L: queueProvider defaults to pgmq", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, { NODE_ENV: "development" });

    expect(env.queueProvider).toBe("pgmq");
  });

  it("43L: HAHART_QUEUE_PROVIDER=native parses", () => {
    const env = loadServerEnv(VERSION_OVERRIDE, {
      NODE_ENV: "development",
      HAHART_QUEUE_PROVIDER: "native",
    });

    expect(env.queueProvider).toBe("native");
  });

  it("43L: an unknown queue provider refuses to start", () => {
    expect(() =>
      loadServerEnv(VERSION_OVERRIDE, {
        NODE_ENV: "development",
        HAHART_QUEUE_PROVIDER: "rabbit",
      }),
    ).toThrow("Invalid HAHART_QUEUE_PROVIDER value: rabbit");
  });
});
