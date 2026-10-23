import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { AdminPasswordReset } from "../src/components/credits/admin-password-reset";
import { resetMemberPassword } from "../src/lib/admin-auth-api";
import { ApiApplicationError } from "../src/lib/server-api";

/**
 * 42H · 后台「重置成员密码」
 *
 * 钉住三件事：
 *   1) 空邮箱提交不了，提交时把管理员填的邮箱原样交给 API；
 *   2) 临时密码只显示这一次：能复制，点关闭后 DOM 里就没了；
 *   3) 失败时中文服务端原文优先，英文 message 退回目录文案。
 */

vi.mock("@/lib/admin-auth-api", () => ({
  resetMemberPassword: vi.fn(),
}));

const writeText = vi.fn();

const TEMPORARY = "Tmp-Pass-1234";

beforeEach(() => {
  vi.mocked(resetMemberPassword).mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

function renderPanel() {
  render(<AdminPasswordReset accessToken="tok" />);
}

function typeEmail(value: string) {
  fireEvent.change(screen.getByTestId("credits-admin-reset-email"), {
    target: { value },
  });
}

async function submitAndShowResult(result: {
  email: string;
  temporaryPassword: string;
}) {
  vi.mocked(resetMemberPassword).mockResolvedValue(result);
  renderPanel();
  typeEmail(result.email);
  fireEvent.click(screen.getByTestId("credits-admin-reset-submit"));
  await screen.findByTestId("credits-admin-reset-password");
}

describe("AdminPasswordReset · 提交", () => {
  it("42H: an empty e-mail cannot be submitted", () => {
    renderPanel();

    expect(screen.getByTestId("credits-admin-reset-submit")).toBeDisabled();

    typeEmail("   ");

    expect(screen.getByTestId("credits-admin-reset-submit")).toBeDisabled();
    expect(resetMemberPassword).not.toHaveBeenCalled();
  });

  it("42H: submitting mints a password for the typed e-mail and shows it", async () => {
    vi.mocked(resetMemberPassword).mockResolvedValue({
      email: "a@x.test",
      temporaryPassword: TEMPORARY,
    });

    renderPanel();
    typeEmail("a@x.test");
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-reset-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-reset-submit"));

    await waitFor(() => {
      expect(resetMemberPassword).toHaveBeenCalledWith("tok", "a@x.test");
    });
    await screen.findByTestId("credits-admin-reset-password");
    expect(screen.getByTestId("credits-admin-reset-result")).toHaveTextContent(
      "a@x.test 的临时密码：",
    );
    expect(screen.getByTestId("credits-admin-reset-password")).toHaveTextContent(
      TEMPORARY,
    );
    expect(screen.getByTestId("credits-admin-reset-result")).toHaveTextContent(
      "只显示这一次，关闭后无法再查看",
    );
  });
});

describe("AdminPasswordReset · 一次性展示", () => {
  it("42H: copying puts the temporary password on the clipboard", async () => {
    await submitAndShowResult({ email: "a@x.test", temporaryPassword: TEMPORARY });

    fireEvent.click(screen.getByTestId("credits-admin-reset-copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(TEMPORARY);
    });
  });

  it("42H: dismissing forgets the password and clears the e-mail", async () => {
    await submitAndShowResult({ email: "a@x.test", temporaryPassword: TEMPORARY });

    fireEvent.click(screen.getByTestId("credits-admin-reset-dismiss"));

    expect(screen.queryByTestId("credits-admin-reset-password")).toBeNull();
    expect(screen.queryByTestId("credits-admin-reset-result")).toBeNull();
    expect(screen.queryByText(TEMPORARY)).toBeNull();
    expect(screen.getByTestId("credits-admin-reset-email")).toHaveValue("");
  });
});

describe("AdminPasswordReset · 失败文案", () => {
  it("42H: a Chinese server message (404 该邮箱没有账号) is shown verbatim", async () => {
    vi.mocked(resetMemberPassword).mockRejectedValue(
      new ApiApplicationError("invalid_request", "该邮箱没有账号", 404),
    );

    renderPanel();
    typeEmail("nobody@x.test");
    fireEvent.click(screen.getByTestId("credits-admin-reset-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-reset-error")).toHaveTextContent(
        "该邮箱没有账号",
      );
    });
    expect(screen.queryByTestId("credits-admin-reset-result")).toBeNull();
  });

  it("42H: an English message falls back to the catalogue wording for the code", async () => {
    vi.mocked(resetMemberPassword).mockRejectedValue(
      new ApiApplicationError("forbidden", "Forbidden", 403),
    );

    renderPanel();
    typeEmail("a@x.test");
    fireEvent.click(screen.getByTestId("credits-admin-reset-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-reset-error")).toHaveTextContent(
        "没有权限执行这个操作。",
      );
    });
  });
});
