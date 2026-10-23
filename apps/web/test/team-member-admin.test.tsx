import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { TeamMember } from "@loomic/shared";

import { TeamMemberAdmin } from "../src/components/credits/team-member-admin";
import {
  addTeamMember,
  fetchTeamMembers,
  removeTeamMember,
  setTeamMemberRole,
} from "../src/lib/admin-credits-api";
import { ApiApplicationError } from "../src/lib/server-api";

/**
 * AD-08 §3 · 后台成员管理
 *
 * 钉住四件事：
 *   1) 列表把 owner 与自己那一行锁住（角色只读、没有移出按钮）；
 *   2) 改角色直接打服务端，失败时下拉回到原值并把错误念出来；
 *   3) 移出必须先确认，取消不发请求，成功才让行消失并报转移数量；
 *   4) 按邮箱加入：空邮箱点不动，成功后重新拉列表，已在团队里就说「该成员已在团队中」。
 */

vi.mock("@/lib/admin-credits-api", () => ({
  fetchTeamMembers: vi.fn(),
  addTeamMember: vi.fn(),
  setTeamMemberRole: vi.fn(),
  removeTeamMember: vi.fn(),
}));

const OWNER: TeamMember = {
  userId: "u-owner",
  email: "owner@x.com",
  displayName: "老板",
  role: "owner",
  joinedAt: "2026-01-01T00:00:00.000Z",
};

const MEMBER: TeamMember = {
  userId: "u-member",
  email: "member@x.com",
  displayName: "小王",
  role: "member",
  joinedAt: "2026-02-02T00:00:00.000Z",
};

const SELF: TeamMember = {
  userId: "u-self",
  email: "self@x.com",
  displayName: null,
  role: "admin",
  joinedAt: "2026-03-03T00:00:00.000Z",
};

const CURRENT_USER_ID = "u-self";

beforeEach(() => {
  vi.mocked(fetchTeamMembers).mockReset();
  vi.mocked(addTeamMember).mockReset();
  vi.mocked(setTeamMemberRole).mockReset();
  vi.mocked(removeTeamMember).mockReset();

  vi.mocked(fetchTeamMembers).mockResolvedValue([OWNER, MEMBER, SELF]);
  vi.mocked(addTeamMember).mockResolvedValue({ added: true });
  vi.mocked(setTeamMemberRole).mockResolvedValue({ changed: true });
  vi.mocked(removeTeamMember).mockResolvedValue({
    removed: 1,
    transferred: { projects: 2, assets: 5, objects: 3 },
  });
});

afterEach(() => {
  cleanup();
});

async function renderPanel() {
  render(
    <TeamMemberAdmin accessToken="tok" currentUserId={CURRENT_USER_ID} />,
  );
  await screen.findByTestId("credits-member-row-u-member");
}

describe("TeamMemberAdmin · AD-08 列表", () => {
  it("AD-08: lists every member and locks the owner and the current admin", async () => {
    await renderPanel();

    expect(screen.getAllByTestId(/^credits-member-row-/)).toHaveLength(3);
    expect(screen.getByTestId("credits-member-row-u-owner")).toHaveTextContent(
      "owner@x.com",
    );
    expect(screen.getByTestId("credits-member-row-u-member")).toHaveTextContent(
      "小王",
    );
    expect(screen.getByTestId("credits-member-row-u-self")).toHaveTextContent(
      "self@x.com",
    );

    // owner: role text only, no way to remove
    expect(screen.queryByTestId("credits-member-role-u-owner")).toBeNull();
    expect(screen.getByTestId("credits-member-role-readonly-u-owner")).toHaveTextContent(
      "拥有者",
    );
    expect(screen.queryByTestId("credits-member-remove-u-owner")).toBeNull();

    // myself: same lock
    expect(screen.queryByTestId("credits-member-role-u-self")).toBeNull();
    expect(screen.queryByTestId("credits-member-remove-u-self")).toBeNull();

    // everybody else: both controls
    expect(screen.getByTestId("credits-member-role-u-member")).toBeInTheDocument();
    expect(screen.getByTestId("credits-member-remove-u-member")).toBeInTheDocument();
  });
});

describe("TeamMemberAdmin · AD-08 改角色", () => {
  it("AD-08: switching member to admin calls the server", async () => {
    await renderPanel();

    fireEvent.change(screen.getByTestId("credits-member-role-u-member"), {
      target: { value: "admin" },
    });

    await waitFor(() => {
      expect(setTeamMemberRole).toHaveBeenCalledWith("tok", "u-member", "admin");
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-member-role-u-member")).toHaveValue("admin");
    });
  });

  it("AD-08: a refused role change rolls the select back and shows the error", async () => {
    vi.mocked(setTeamMemberRole).mockRejectedValue(
      new ApiApplicationError("invalid_request", "role (member | admin) is required."),
    );

    await renderPanel();

    fireEvent.change(screen.getByTestId("credits-member-role-u-member"), {
      target: { value: "admin" },
    });

    await screen.findByTestId("credits-member-error");
    expect(screen.getByTestId("credits-member-role-u-member")).toHaveValue("member");
  });
});

describe("TeamMemberAdmin · AD-08 移出", () => {
  it("AD-08: cancel asks nothing, confirm removes the row and reports the transfer", async () => {
    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-member-remove-u-member"));

    const confirm = await screen.findByTestId(
      "credits-member-remove-confirm-u-member",
    );
    expect(confirm).toHaveTextContent("移出后该成员无法再使用，其项目将转给你。确认移出？");

    fireEvent.click(screen.getByTestId("credits-member-remove-cancel-u-member"));
    expect(
      screen.queryByTestId("credits-member-remove-confirm-u-member"),
    ).toBeNull();
    expect(removeTeamMember).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("credits-member-remove-u-member"));
    await screen.findByTestId("credits-member-remove-confirm-u-member");
    fireEvent.click(screen.getByTestId("credits-member-remove-ok-u-member"));

    await waitFor(() => {
      expect(removeTeamMember).toHaveBeenCalledWith("tok", "u-member");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("credits-member-row-u-member")).toBeNull();
    });
    expect(screen.getByTestId("credits-member-notice")).toHaveTextContent(
      "转移项目 2 个",
    );
  });
});

describe("TeamMemberAdmin · AD-08 按邮箱加入", () => {
  it("AD-08: the submit stays disabled without an e-mail", async () => {
    await renderPanel();

    expect(screen.getByTestId("credits-member-add-submit")).toBeDisabled();

    fireEvent.change(screen.getByTestId("credits-member-add-email"), {
      target: { value: "new@x.com" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("credits-member-add-submit")).not.toBeDisabled();
    });
  });

  it("AD-08: adding a member posts the e-mail and reloads the list", async () => {
    await renderPanel();

    fireEvent.change(screen.getByTestId("credits-member-add-email"), {
      target: { value: "new@x.com" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-member-add-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-member-add-submit"));

    await waitFor(() => {
      expect(addTeamMember).toHaveBeenCalledWith("tok", {
        email: "new@x.com",
        role: "member",
      });
    });
    await waitFor(() => {
      expect(vi.mocked(fetchTeamMembers).mock.calls).toHaveLength(2);
    });
  });

  it("AD-08: an address already in the team says so", async () => {
    vi.mocked(addTeamMember).mockResolvedValue({ added: false });

    await renderPanel();

    fireEvent.change(screen.getByTestId("credits-member-add-email"), {
      target: { value: "member@x.com" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-member-add-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-member-add-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-member-notice")).toHaveTextContent(
        "该成员已在团队中",
      );
    });
  });
});
