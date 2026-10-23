import { describe, expect, it } from "vitest";

import { loadServerEnv } from "../config/env.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import { selectRequestAuthenticator } from "./select-authenticator.js";

const VERSION_OVERRIDE = { version: "0.0.0-test" };
/** Test-only key material: 36 bytes, never anything resembling a secret. */
const SELF_SECRET = "self-auth-test-secret-0123456789abcd";

const SUPABASE_AUTHENTICATOR: RequestAuthenticator = {
  authenticate: async () => null,
};
const SELF_AUTHENTICATOR: RequestAuthenticator = {
  authenticate: async () => null,
};

type Counts = { self: number; supabase: number };

function trackSelect(env: NodeJS.ProcessEnv): {
  authenticator: RequestAuthenticator;
  counts: Counts;
} {
  const counts: Counts = { self: 0, supabase: 0 };

  const authenticator = selectRequestAuthenticator(
    loadServerEnv(VERSION_OVERRIDE, env),
    {
      supabase: () => {
        counts.supabase += 1;
        return SUPABASE_AUTHENTICATOR;
      },
      self: () => {
        counts.self += 1;
        return SELF_AUTHENTICATOR;
      },
    },
  );

  return { authenticator, counts };
}

describe("S-A3 selectRequestAuthenticator", () => {
  it("S-A3: unset HAHART_AUTH_PROVIDER builds only the supabase authenticator", () => {
    const { authenticator, counts } = trackSelect({});

    expect(authenticator).toBe(SUPABASE_AUTHENTICATOR);
    expect(counts).toEqual({ self: 0, supabase: 1 });
  });

  it("S-A3: HAHART_AUTH_PROVIDER=supabase builds only the supabase authenticator", () => {
    const { authenticator, counts } = trackSelect({
      HAHART_AUTH_PROVIDER: "supabase",
    });

    expect(authenticator).toBe(SUPABASE_AUTHENTICATOR);
    expect(counts).toEqual({ self: 0, supabase: 1 });
  });

  it("S-A3: HAHART_AUTH_PROVIDER=self builds only the self authenticator", () => {
    const { authenticator, counts } = trackSelect({
      HAHART_AUTH_PROVIDER: "self",
      HAHART_AUTH_JWT_SECRET: SELF_SECRET,
    });

    expect(authenticator).toBe(SELF_AUTHENTICATOR);
    expect(counts).toEqual({ self: 1, supabase: 0 });
  });
});
