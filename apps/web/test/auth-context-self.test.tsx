// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSession, mockOnChange, mockSelfSignOut, mockGetSupabaseBrowserClient } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockOnChange: vi.fn(),
    mockSelfSignOut: vi.fn(),
    mockGetSupabaseBrowserClient: vi.fn(),
  }));

vi.mock("../src/lib/self-auth-client", () => ({
  authProvider: vi.fn(() => "self"),
  getSession: mockGetSession,
  onChange: mockOnChange,
  signOut: mockSelfSignOut,
}));

vi.mock("../src/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: mockGetSupabaseBrowserClient,
}));

import { AuthProvider, useAuth } from "../src/lib/auth-context";

const SELF_SESSION = {
  access_token: "self_token_1",
  expires_at: 1_800_000_000,
  refresh_token: "self_refresh_1",
  user: {
    id: "user_self",
    email: "self@example.com",
    user_metadata: { full_name: "Self User" },
    must_change_password: false,
  },
};

function TestConsumer() {
  const { session, user, loading, signOut } = useAuth();
  return (
    <div>
      <span data-testid="token">{session?.access_token ?? "none"}</span>
      <span data-testid="email">{user?.email ?? "none"}</span>
      <span data-testid="loading">{String(loading)}</span>
      <button
        type="button"
        onClick={() => {
          void signOut();
        }}
      >
        sign out
      </button>
    </div>
  );
}

describe("AuthProvider with the self-hosted provider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", "self");
    mockGetSession.mockReturnValue(SELF_SESSION);
    mockOnChange.mockReturnValue(() => {});
    mockSelfSignOut.mockResolvedValue(undefined);
  });

  it("exposes the self-hosted session token and never touches Supabase", async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe("self_token_1");
    });
    expect(screen.getByTestId("email").textContent).toBe("self@example.com");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(mockGetSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("signs out through the self-hosted client", async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe("self_token_1");
    });

    await userEvent.click(screen.getByRole("button", { name: "sign out" }));

    await waitFor(() => {
      expect(mockSelfSignOut).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("token").textContent).toBe("none");
    });
    expect(mockGetSupabaseBrowserClient).not.toHaveBeenCalled();
  });
});
