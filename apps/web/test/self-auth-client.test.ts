// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SELF_AUTH_STORAGE_KEY,
  authProvider,
  changePassword,
  getSession,
  onChange,
  refresh,
  signIn,
  signOut,
} from "../src/lib/self-auth-client";
import { ApiApplicationError } from "../src/lib/server-api";

const mockFetch = vi.fn();

/** An in-memory `Storage`, so each test starts from an empty browser storage. */
function createStorageStub(): Storage {
  const entries = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
  return stub;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The 200/201 body the server's /api/auth routes answer with (42D). */
function serverSession(
  overrides: {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    email?: string;
  } = {},
) {
  return {
    accessToken: overrides.accessToken ?? "access_1",
    accessTokenExpiresAt:
      overrides.accessTokenExpiresAt ??
      new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: overrides.refreshToken ?? "refresh_1",
    refreshTokenExpiresAt:
      overrides.refreshTokenExpiresAt ??
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
    user: {
      id: "user_1",
      email: overrides.email ?? "a@b.com",
      displayName: "Alice",
      mustChangePassword: false,
    },
  };
}

function okResponse(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body };
}

function errorResponse(status: number, code: string, message: string) {
  return { ok: false, status, json: async () => ({ error: { code, message } }) };
}

/** Put a usable session in storage, the way a previous sign-in would have. */
function seedStoredSession(refreshExpiresAt?: number) {
  const stored = {
    access_token: "access_seed",
    expires_at: nowSeconds() + 3600,
    refresh_token: "refresh_seed",
    refresh_expires_at: refreshExpiresAt ?? nowSeconds() + 86_400,
    user: {
      id: "user_seed",
      email: "seed@b.com",
      user_metadata: {},
      must_change_password: false,
    },
  };
  localStorage.setItem(SELF_AUTH_STORAGE_KEY, JSON.stringify(stored));
  return stored;
}

describe("self-auth-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    vi.stubGlobal("localStorage", createStorageStub());
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("authProvider", () => {
    it("defaults to supabase when the switch is unset", () => {
      expect(authProvider()).toBe("supabase");
    });

    it.each(["supabase", "oauth"])("treats %s as supabase", (value) => {
      vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", value);
      expect(authProvider()).toBe("supabase");
    });

    it("returns self only for the exact switch value", () => {
      vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", "self");
      expect(authProvider()).toBe("self");
    });
  });

  describe("signIn", () => {
    it("stores the session, notifies subscribers once, and returns it", async () => {
      const body = serverSession();
      mockFetch.mockResolvedValue(okResponse(body));
      const listener = vi.fn();
      const unsubscribe = onChange(listener);

      const session = await signIn("a@b.com", "correct horse");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/auth/sign-in",
        expect.objectContaining({ method: "POST" }),
      );
      const stored = localStorage.getItem(SELF_AUTH_STORAGE_KEY);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string).access_token).toBe(body.accessToken);
      expect(getSession()?.access_token).toBe(session.access_token);
      expect(session.user.email).toBe("a@b.com");
      expect(session.user.user_metadata.full_name).toBe("Alice");
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("throws ApiApplicationError with the server code and stores nothing", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(401, "invalid_credentials", "Wrong email or password."),
      );

      await expect(signIn("a@b.com", "bad")).rejects.toBeInstanceOf(
        ApiApplicationError,
      );
      await expect(signIn("a@b.com", "bad")).rejects.toMatchObject({
        code: "invalid_credentials",
      });
      expect(localStorage.getItem(SELF_AUTH_STORAGE_KEY)).toBeNull();
    });
  });

  describe("refresh", () => {
    it("sends one request for three concurrent callers", async () => {
      seedStoredSession();
      const body = serverSession({
        accessToken: "access_2",
        refreshToken: "refresh_2",
      });
      let resolveFetch: (value: unknown) => void = () => {};
      mockFetch.mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const calls = [refresh(), refresh(), refresh()];
      resolveFetch(okResponse(body));
      const [first, second, third] = await Promise.all(calls);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(first?.access_token).toBe("access_2");
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(getSession()?.access_token).toBe("access_2");
    });

    it("clears the session and returns null when the refresh token is rejected", async () => {
      seedStoredSession();
      mockFetch.mockResolvedValue(
        errorResponse(401, "invalid_refresh", "Refresh token is invalid."),
      );
      const listener = vi.fn();
      const unsubscribe = onChange(listener);

      await expect(refresh()).resolves.toBeNull();

      expect(localStorage.getItem(SELF_AUTH_STORAGE_KEY)).toBeNull();
      expect(getSession()).toBeNull();
      expect(listener).toHaveBeenCalledWith(null);
      unsubscribe();
    });
  });

  describe("getSession", () => {
    it("returns null and drops a session whose refresh token is past expiry", () => {
      seedStoredSession(nowSeconds() - 60);

      expect(getSession()).toBeNull();
      expect(localStorage.getItem(SELF_AUTH_STORAGE_KEY)).toBeNull();
    });
  });

  describe("signOut", () => {
    it("clears the local session even when the call fails", async () => {
      seedStoredSession();
      mockFetch.mockRejectedValue(new Error("network down"));

      await signOut();

      expect(localStorage.getItem(SELF_AUTH_STORAGE_KEY)).toBeNull();
      expect(getSession()).toBeNull();
    });
  });

  describe("changePassword", () => {
    it("sends the bearer token and clears the session on 204", async () => {
      seedStoredSession();
      mockFetch.mockResolvedValue({ ok: true, status: 204, json: async () => null });

      await changePassword("old-password", "NewPassword123!");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3001/api/auth/change-password",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer access_seed",
          }),
        }),
      );
      expect(localStorage.getItem(SELF_AUTH_STORAGE_KEY)).toBeNull();
    });
  });
});
