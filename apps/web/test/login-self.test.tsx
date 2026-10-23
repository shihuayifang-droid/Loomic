// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchViewer,
  mockReplace,
  mockSignIn,
  mockChangePassword,
  mockGetSupabaseBrowserClient,
  supabaseAuth,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockReplace: vi.fn(),
  mockSignIn: vi.fn(),
  mockChangePassword: vi.fn().mockResolvedValue(undefined),
  mockGetSupabaseBrowserClient: vi.fn(),
  supabaseAuth: {
    signInWithOtp: vi.fn(),
    signInWithPassword: vi.fn(),
    signInWithOAuth: vi.fn(),
    signUp: vi.fn(),
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock("@/lib/server-api", () => {
  class ApiApplicationError extends Error {
    code: string;
    status: number | undefined;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.name = "ApiApplicationError";
      this.code = code;
      this.status = status;
    }
  }
  class JobFailed extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.name = "JobFailed";
      this.code = code;
    }
  }
  return { fetchViewer: mockFetchViewer, ApiApplicationError, JobFailed };
});

vi.mock("@/lib/self-auth-client", () => ({
  authProvider: () => "self",
  signIn: mockSignIn,
  changePassword: mockChangePassword,
}));

vi.mock("@/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: mockGetSupabaseBrowserClient,
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
}));

import { ApiApplicationError } from "@/lib/server-api";
import { LoginForm } from "../src/components/login-form";

function selfSession(token: string, mustChangePassword: boolean) {
  return {
    access_token: token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-1",
    user: {
      id: "u1",
      email: "user@example.com",
      user_metadata: {},
      must_change_password: mustChangePassword,
    },
  };
}

function fillCredentials(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(/^email$/i), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("Login form (self-hosted auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_HAHART_AUTH_PROVIDER", "self");
    mockGetSupabaseBrowserClient.mockReturnValue({ auth: supabaseAuth });
    mockFetchViewer.mockResolvedValue({
      workspace: { id: "w1" },
      profile: { id: "u1" },
      membership: { workspaceId: "w1", userId: "u1", role: "owner" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("renders only the email + password form, with no Supabase entry points", async () => {
    render(<LoginForm />);

    expect(screen.getByLabelText(/^email$/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(screen.queryByTestId("account-login-google")).toBeNull();
    expect(screen.queryByTestId("account-login-mode-toggle")).toBeNull();
    expect(screen.queryByText(/send login link/i)).toBeNull();
    expect(mockGetSupabaseBrowserClient).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithOtp).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithOAuth).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("signs in with the self auth client and bootstraps the viewer", async () => {
    mockSignIn.mockResolvedValueOnce(selfSession("self-token", false));

    render(<LoginForm />);
    fillCredentials("user@example.com", "secret-123");

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith("user@example.com", "secret-123");
      expect(mockFetchViewer).toHaveBeenCalledWith("self-token");
      expect(mockReplace).toHaveBeenCalledWith("/home");
    });
    expect(mockGetSupabaseBrowserClient).not.toHaveBeenCalled();
  });

  it("shows the catalogue message for invalid credentials", async () => {
    mockSignIn.mockRejectedValueOnce(
      new ApiApplicationError("invalid_credentials", "invalid credentials", 401),
    );

    render(<LoginForm />);
    fillCredentials("user@example.com", "wrong-password");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "邮箱或密码不正确。",
    );
    expect(mockFetchViewer).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("forces a password change, then signs in again with the new password", async () => {
    mockSignIn.mockResolvedValueOnce(selfSession("temp-token", true));
    mockSignIn.mockResolvedValueOnce(selfSession("fresh-token", false));

    render(<LoginForm />);
    fillCredentials("user@example.com", "temp-password");

    expect(await screen.findByTestId("account-force-change-submit")).toBeTruthy();
    expect(mockFetchViewer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("account-force-change-new"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByTestId("account-force-change-confirm"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.click(screen.getByTestId("account-force-change-submit"));

    await waitFor(() => {
      expect(mockChangePassword).toHaveBeenCalledWith(
        "temp-password",
        "brand-new-password",
      );
      expect(mockSignIn).toHaveBeenNthCalledWith(
        1,
        "user@example.com",
        "temp-password",
      );
      expect(mockSignIn).toHaveBeenNthCalledWith(
        2,
        "user@example.com",
        "brand-new-password",
      );
      expect(mockFetchViewer).toHaveBeenCalledWith("fresh-token");
      expect(mockReplace).toHaveBeenCalledWith("/home");
    });
  });

  it("refuses a mismatched confirmation without calling the API", async () => {
    mockSignIn.mockResolvedValueOnce(selfSession("temp-token", true));

    render(<LoginForm />);
    fillCredentials("user@example.com", "temp-password");

    expect(await screen.findByTestId("account-force-change-submit")).toBeTruthy();

    fireEvent.change(screen.getByTestId("account-force-change-new"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByTestId("account-force-change-confirm"), {
      target: { value: "something-else" },
    });
    fireEvent.click(screen.getByTestId("account-force-change-submit"));

    expect(
      (await screen.findByTestId("account-force-change-error")).textContent,
    ).toContain("两次输入的密码不一致");
    expect(mockChangePassword).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
