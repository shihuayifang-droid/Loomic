import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { ViewerResponse } from "@loomic/shared";

import { AccessGate } from "../src/components/auth/access-gate";
import { fetchViewer } from "../src/lib/server-api";

/**
 * AD-00 / T-85 -- admission is team membership.
 *
 * Pins the four outcomes of the workspace shell gate:
 *   1) an explicit `teamMembership: null` shows only the waiting page;
 *   2) the only way out of that page is signing out;
 *   3) a member gets the workspace;
 *   4) an older server without the field, and a failed viewer read, both let
 *      the user through -- the server is the authority, not the frontend.
 */

const mocks = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<void>>(),
  session: null as { access_token: string } | null,
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: mocks.session, signOut: mocks.signOut }),
}));

vi.mock("@/lib/server-api", () => ({
  fetchViewer: vi.fn(),
}));

const MEMBER_VIEWER: ViewerResponse = {
  profile: { id: "u1", email: "member@example.com", displayName: "成员" },
  workspace: {
    id: "ws-personal",
    name: "个人空间",
    type: "personal",
    ownerUserId: "u1",
  },
  membership: { workspaceId: "ws-personal", userId: "u1", role: "owner" },
  teamWorkspace: {
    id: "ws-team",
    name: "团队空间",
    type: "team",
    ownerUserId: "owner-1",
  },
  teamMembership: { workspaceId: "ws-team", userId: "u1", role: "member" },
};

const PENDING_VIEWER: ViewerResponse = {
  profile: { id: "u1", email: "member@example.com", displayName: "成员" },
  workspace: {
    id: "ws-personal",
    name: "个人空间",
    type: "personal",
    ownerUserId: "u1",
  },
  membership: { workspaceId: "ws-personal", userId: "u1", role: "owner" },
  teamWorkspace: null,
  teamMembership: null,
};

// A server that predates the team fields: the keys are simply absent.
const LEGACY_VIEWER: ViewerResponse = {
  profile: { id: "u1", email: "member@example.com", displayName: "成员" },
  workspace: {
    id: "ws-personal",
    name: "个人空间",
    type: "personal",
    ownerUserId: "u1",
  },
  membership: { workspaceId: "ws-personal", userId: "u1", role: "owner" },
};

function renderGate() {
  return render(
    <AccessGate>
      <div data-testid="workspace-content">工作区内容</div>
    </AccessGate>,
  );
}

beforeEach(() => {
  mocks.session = { access_token: "tok-1" };
  mocks.signOut.mockReset();
  mocks.signOut.mockResolvedValue(undefined);
  vi.mocked(fetchViewer).mockReset();
});

afterEach(() => {
  cleanup();
  mocks.session = null;
});

describe("AccessGate", () => {
  it("AD-00: a signed-in account outside the team sees only the waiting page", async () => {
    vi.mocked(fetchViewer).mockResolvedValue(PENDING_VIEWER);

    renderGate();

    const title = await screen.findByTestId("account-pending-title");
    expect(title.textContent).toBe("已提交申请，等待管理员审核");
    expect(screen.queryByTestId("workspace-content")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(
      screen.getByTestId("account-pending-signout").textContent,
    ).toBe("退出登录");
    expect(fetchViewer).toHaveBeenCalledTimes(1);
    expect(fetchViewer).toHaveBeenCalledWith("tok-1");
  });

  it("AD-00: the only way out is signing out", async () => {
    vi.mocked(fetchViewer).mockResolvedValue(PENDING_VIEWER);

    renderGate();

    fireEvent.click(await screen.findByTestId("account-pending-signout"));

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("AD-00: a team member gets the workspace", async () => {
    vi.mocked(fetchViewer).mockResolvedValue(MEMBER_VIEWER);

    renderGate();

    expect(await screen.findByTestId("workspace-content")).toBeInTheDocument();
    expect(screen.queryByTestId("account-pending-title")).toBeNull();
  });

  it("AD-00: an older server without the field still lets the member in", async () => {
    vi.mocked(fetchViewer).mockResolvedValue(LEGACY_VIEWER);

    renderGate();

    expect(await screen.findByTestId("workspace-content")).toBeInTheDocument();
    expect(screen.queryByTestId("account-pending-title")).toBeNull();
  });

  it("AD-00: a failed viewer read does not lock the user out", async () => {
    vi.mocked(fetchViewer).mockRejectedValue(new Error("network down"));

    renderGate();

    expect(await screen.findByTestId("workspace-content")).toBeInTheDocument();
    expect(screen.queryByTestId("account-pending-title")).toBeNull();
  });
});
