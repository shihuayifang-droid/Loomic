// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── next/navigation: only the `tab` query string matters in these cases ──────
let searchParamsValue = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "tab" && searchParamsValue !== "" ? searchParamsValue : null),
  }),
}));

const mockSession = { access_token: "token_123" };
const mockAuthValue = {
  user: { id: "u1", email: "test@test.com" },
  session: mockSession,
  loading: false,
  signOut: vi.fn(),
};
vi.mock("../src/lib/auth-context", () => ({
  useAuth: vi.fn(() => mockAuthValue),
}));

const mockFetchViewer = vi.fn();
const mockFetchWorkspaceSettings = vi.fn();
vi.mock("../src/lib/server-api", () => {
  class ApiAuthError extends Error {}
  class ApiApplicationError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    ApiAuthError,
    ApiApplicationError,
    fetchViewer: (...args: unknown[]) => mockFetchViewer(...args),
    fetchWorkspaceSettings: (...args: unknown[]) =>
      mockFetchWorkspaceSettings(...args),
    fetchModels: () => Promise.resolve({ models: [] }),
    updateProfile: vi.fn(),
    updateWorkspaceSettings: vi.fn(),
  };
});

const mockFetchTeamMembers = vi.fn();
vi.mock("../src/lib/admin-credits-api", () => ({
  fetchTeamMembers: (...args: unknown[]) => mockFetchTeamMembers(...args),
}));

/**
 * The real panel talks to four admin endpoints and renders a table; these cases
 * are about what the settings page hands it, so it is replaced by a recorder.
 */
const mockPanelProps: Array<Record<string, unknown>> = [];
vi.mock("../src/components/credits/team-credits-admin", () => ({
  TeamCreditsAdmin: (props: Record<string, unknown>) => {
    mockPanelProps.push(props);
    return null;
  },
}));

import SettingsPage from "../src/app/(workspace)/settings/page";

type Membership = { workspaceId: string; userId: string; role: string };

const viewerBase = {
  profile: {
    id: "u1",
    email: "test@test.com",
    displayName: "Test",
    avatarUrl: null,
  },
  workspace: {
    id: "w1",
    name: "My Workspace",
    type: "personal",
    ownerUserId: "u1",
  },
  membership: { workspaceId: "w1", userId: "u1", role: "owner" },
};

/** The settings page only reads the viewer's team role and the default model. */
function mockLoads(teamMembership: Membership | null) {
  mockFetchViewer.mockResolvedValue({ ...viewerBase, teamMembership });
  mockFetchWorkspaceSettings.mockResolvedValue({
    settings: { defaultModel: "gpt-5.4-mini" },
  });
}

const TEAM_MEMBERS = [
  {
    userId: "u1",
    email: "wang@example.com",
    displayName: "小王",
    role: "admin",
    joinedAt: "2026-01-01T00:00:00Z",
  },
];

/** Everything the page needs to finish its first load. */
async function renderLoaded() {
  render(<SettingsPage />);
  await screen.findByTestId("settings-tab-profile");
}

describe("Settings page 成员额度 tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    searchParamsValue = "";
    mockPanelProps.length = 0;
    mockFetchTeamMembers.mockResolvedValue(TEAM_MEMBERS);
  });

  afterEach(() => {
    cleanup();
  });

  it("AD-01: a team admin sees the 成员额度 tab", async () => {
    mockLoads({ workspaceId: "w2", userId: "u1", role: "admin" });

    await renderLoaded();

    const tab = screen.getByTestId("settings-tab-team-credits");
    expect(tab).toHaveTextContent("成员额度");
  });

  it("AD-08: a member does not see it", async () => {
    mockLoads({ workspaceId: "w2", userId: "u1", role: "member" });

    await renderLoaded();

    expect(screen.queryByTestId("settings-tab-team-credits")).toBeNull();
  });

  it("AD-08: no team membership does not see it", async () => {
    mockLoads(null);

    await renderLoaded();

    expect(screen.queryByTestId("settings-tab-team-credits")).toBeNull();
  });

  it("AD-01: opening the tab passes member names to the panel", async () => {
    mockLoads({ workspaceId: "w2", userId: "u1", role: "admin" });
    await renderLoaded();

    await userEvent.click(screen.getByTestId("settings-tab-team-credits"));

    await waitFor(() => {
      expect(mockFetchTeamMembers).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const last = mockPanelProps[mockPanelProps.length - 1];
      expect(last).toBeDefined();
      const names = last?.memberNames as
        | Record<string, { displayName: string | null; email: string }>
        | undefined;
      expect(names?.u1?.displayName).toBe("小王");
    });
  });

  it("AD-08: ?tab=team-credits falls back to profile for a non-admin", async () => {
    searchParamsValue = "team-credits";
    mockLoads({ workspaceId: "w2", userId: "u1", role: "member" });

    render(<SettingsPage />);

    // profile content is what the deep link lands on ...
    expect(await screen.findByTestId("account-profile-save")).toBeInTheDocument();
    // ... the member tab never appears and the panel is never mounted.
    expect(screen.queryByTestId("settings-tab-team-credits")).toBeNull();
    expect(mockPanelProps).toHaveLength(0);
    expect(mockFetchTeamMembers).not.toHaveBeenCalled();
  });
});
