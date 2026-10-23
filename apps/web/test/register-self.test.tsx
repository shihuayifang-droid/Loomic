// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchViewer,
  mockReplace,
  mockSignUp,
  mockGetSupabaseBrowserClient,
  supabaseAuth,
} = vi.hoisted(() => ({
  mockFetchViewer: vi.fn().mockResolvedValue({
    workspace: { id: "w1" },
    profile: { id: "u1" },
    membership: { workspaceId: "w1", userId: "u1", role: "owner" },
  }),
  mockReplace: vi.fn(),
  mockSignUp: vi.fn(),
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
  signUp: mockSignUp,
}));

vi.mock("@/lib/supabase-browser", () => ({
  getSupabaseBrowserClient: mockGetSupabaseBrowserClient,
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: mockReplace })),
}));

import { ApiApplicationError } from "@/lib/server-api";
import { RegisterForm } from "../src/components/register-form";

function selfSession(token: string) {
  return {
    access_token: token,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-1",
    user: {
      id: "u1",
      email: "new-user@example.com",
      user_metadata: {},
      must_change_password: false,
    },
  };
}

function fillForm(email: string, password: string) {
  fireEvent.change(screen.getByLabelText(/^email$/i), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/confirm password/i), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: /create account/i }));
}

describe("Register form (self-hosted auth)", () => {
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

  it("signs up through the self auth client and bootstraps the viewer", async () => {
    mockSignUp.mockResolvedValueOnce(selfSession("fresh-token"));

    render(<RegisterForm />);
    fillForm("new-user@example.com", "password-123");

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith("new-user@example.com", "password-123");
      expect(mockFetchViewer).toHaveBeenCalledWith("fresh-token");
      expect(mockReplace).toHaveBeenCalledWith("/home");
    });

    expect(screen.queryByText(/check your email/i)).toBeNull();
    expect(mockGetSupabaseBrowserClient).not.toHaveBeenCalled();
    expect(supabaseAuth.signUp).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithOtp).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(supabaseAuth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it("shows the catalogue message when the email is already taken", async () => {
    mockSignUp.mockRejectedValueOnce(
      new ApiApplicationError("email_taken", "email taken", 409),
    );

    render(<RegisterForm />);
    fillForm("new-user@example.com", "password-123");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "这个邮箱已注册，请直接登录。",
    );
    expect(mockFetchViewer).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.queryByText(/check your email/i)).toBeNull();
  });
});
