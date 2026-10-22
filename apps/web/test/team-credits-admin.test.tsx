import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { CreditCapTemplate, MemberCreditSummary } from "@loomic/shared";

import { TeamCreditsAdmin } from "../src/components/credits/team-credits-admin";
import {
  adjustMemberTopup,
  applyCapTemplate,
  createCapTemplate,
  fetchCapTemplates,
  fetchMemberCredits,
  setMemberCap,
  setMemberGenerationPaused,
} from "../src/lib/admin-credits-api";
import { ApiApplicationError } from "../src/lib/server-api";

/**
 * AD-01 / BL-12 / BL-01 · 后台成员额度面板
 *
 * 钉住三件事：
 *   1) AD-01：一行里同时给出上限、团队池已用、充值余额、今日赠送剩余；
 *   2) BL-12：加减积分必须填原因、0 与小数提交不了，超扣时把服务端原文念出来；
 *   3) BL-01：改上限、新建模板、把模板套用到勾选的成员。
 */

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "tok" } }),
}));

vi.mock("@/lib/admin-credits-api", () => ({
  fetchMemberCredits: vi.fn(),
  fetchCapTemplates: vi.fn(),
  setMemberCap: vi.fn(),
  adjustMemberTopup: vi.fn(),
  createCapTemplate: vi.fn(),
  applyCapTemplate: vi.fn(),
  setMemberGenerationPaused: vi.fn(),
}));

const MEMBER: MemberCreditSummary = {
  userId: "u1",
  personalCap: 20000,
  teamUsed: 5000,
  topup: 200,
  dailyRemaining: 50,
};

const TEMPLATE: CreditCapTemplate = { id: "t1", name: "标准档", cap: 15000 };

const MEMBER_NAMES = {
  u1: { displayName: "小王", email: "w@x.com" },
};

beforeEach(() => {
  vi.mocked(fetchMemberCredits).mockReset();
  vi.mocked(fetchCapTemplates).mockReset();
  vi.mocked(setMemberCap).mockReset();
  vi.mocked(adjustMemberTopup).mockReset();
  vi.mocked(createCapTemplate).mockReset();
  vi.mocked(applyCapTemplate).mockReset();
  vi.mocked(setMemberGenerationPaused).mockReset();

  vi.mocked(fetchMemberCredits).mockResolvedValue([MEMBER]);
  vi.mocked(fetchCapTemplates).mockResolvedValue([TEMPLATE]);
  vi.mocked(setMemberCap).mockResolvedValue(30000);
  vi.mocked(adjustMemberTopup).mockResolvedValue("tx-1");
  vi.mocked(createCapTemplate).mockResolvedValue({
    id: "t2",
    name: "高额度",
    cap: 50000,
  });
  vi.mocked(applyCapTemplate).mockResolvedValue(1);
  vi.mocked(setMemberGenerationPaused).mockResolvedValue({
    paused: true,
    changed: true,
  });
});

afterEach(() => {
  cleanup();
});

async function renderPanel() {
  render(<TeamCreditsAdmin memberNames={MEMBER_NAMES} />);
  await screen.findByTestId("credits-admin-table");
}

function openAdjustForm() {
  fireEvent.click(screen.getByTestId("credits-admin-adjust-open-u1"));
}

describe("TeamCreditsAdmin · AD-01", () => {
  it("AD-01: the table shows cap, team use, top-up and today's daily", async () => {
    await renderPanel();

    const row = screen.getByTestId("credits-admin-row-u1");
    expect(row).toHaveTextContent("小王");
    expect(row).toHaveTextContent("20,000");
    expect(row).toHaveTextContent("5,000");
    expect(row).toHaveTextContent("200");
    expect(row).toHaveTextContent("50");
  });

  it("AD-01: raising a cap to 30000 shows the new cap", async () => {
    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-admin-cap-edit-u1"));
    fireEvent.change(screen.getByTestId("credits-admin-cap-input-u1"), {
      target: { value: "30000" },
    });
    fireEvent.click(screen.getByTestId("credits-admin-cap-save-u1"));

    await waitFor(() => {
      expect(setMemberCap).toHaveBeenCalledWith("tok", "u1", 30000);
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-row-u1")).toHaveTextContent("30,000");
    });
  });

  it("load failure shows retry", async () => {
    vi.mocked(fetchMemberCredits).mockRejectedValue(new Error("boom"));

    render(<TeamCreditsAdmin memberNames={MEMBER_NAMES} />);

    await screen.findByText("加载失败");
    expect(screen.getByText("重试")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("credits-admin-retry"));

    await waitFor(() => {
      expect(vi.mocked(fetchMemberCredits).mock.calls).toHaveLength(2);
    });
  });
});

describe("TeamCreditsAdmin · BL-12", () => {
  it("BL-12: confirm is disabled without a reason", async () => {
    await renderPanel();
    openAdjustForm();

    fireEvent.change(screen.getByTestId("credits-admin-adjust-delta-u1"), {
      target: { value: "500" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-submit-u1")).toBeDisabled();
    });

    fireEvent.change(screen.getByTestId("credits-admin-adjust-reason-u1"), {
      target: { value: "补发" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-submit-u1")).not.toBeDisabled();
    });
  });

  it("BL-12: confirm is disabled for zero", async () => {
    await renderPanel();
    openAdjustForm();

    fireEvent.change(screen.getByTestId("credits-admin-adjust-delta-u1"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("credits-admin-adjust-reason-u1"), {
      target: { value: "补发" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-submit-u1")).toBeDisabled();
    });
  });

  it("BL-12: taking too much shows 最多可减 500", async () => {
    vi.mocked(adjustMemberTopup).mockRejectedValue(
      new ApiApplicationError("adjust_exceeds_topup", "最多可减 500"),
    );

    await renderPanel();
    openAdjustForm();

    fireEvent.change(screen.getByTestId("credits-admin-adjust-delta-u1"), {
      target: { value: "-800" },
    });
    fireEvent.change(screen.getByTestId("credits-admin-adjust-reason-u1"), {
      target: { value: "误发回收" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-submit-u1")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-adjust-submit-u1"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-error-u1")).toHaveTextContent(
        "最多可减 500",
      );
    });
  });

  it("BL-12: a successful adjustment reloads the table", async () => {
    await renderPanel();
    openAdjustForm();

    fireEvent.change(screen.getByTestId("credits-admin-adjust-delta-u1"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByTestId("credits-admin-adjust-reason-u1"), {
      target: { value: "补发" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-adjust-submit-u1")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-adjust-submit-u1"));

    await waitFor(() => {
      expect(adjustMemberTopup).toHaveBeenCalledWith("tok", "u1", {
        delta: 500,
        reason: "补发",
      });
    });
    await waitFor(() => {
      expect(vi.mocked(fetchMemberCredits).mock.calls).toHaveLength(2);
    });
  });
});

describe("TeamCreditsAdmin · BL-01", () => {
  it("BL-01: applying a template to selected members reports the count", async () => {
    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-admin-select-u1"));
    fireEvent.click(screen.getByTestId("credits-admin-template-apply-t1"));

    await waitFor(() => {
      expect(applyCapTemplate).toHaveBeenCalledWith("tok", "t1", ["u1"]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-template-applied")).toHaveTextContent("已套用 1 人");
    });
  });

  it("BL-01: applying with nobody selected is disabled", async () => {
    await renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-template-apply-t1")).toBeDisabled();
    });
  });

  it("BL-01: a duplicate template name shows the server message", async () => {
    vi.mocked(createCapTemplate).mockRejectedValue(
      new ApiApplicationError("invalid_request", "已有同名模板"),
    );

    await renderPanel();

    fireEvent.change(screen.getByTestId("credits-admin-template-name"), {
      target: { value: "标准档" },
    });
    fireEvent.change(screen.getByTestId("credits-admin-template-cap"), {
      target: { value: "15000" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-template-create")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-template-create"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-template-error")).toHaveTextContent("已有同名模板");
    });
  });
});

describe("TeamCreditsAdmin · AD-01 pause / resume", () => {
  /** 39O writes `generationPaused` only when it is true, so this is a whole paused row. */
  const PAUSED_MEMBER: MemberCreditSummary = { ...MEMBER, generationPaused: true };

  it("AD-01: a paused member shows 已暂停生成", async () => {
    vi.mocked(fetchMemberCredits).mockResolvedValue([PAUSED_MEMBER]);

    await renderPanel();

    expect(screen.getByTestId("credits-admin-paused-u1")).toHaveTextContent("已暂停生成");
    expect(screen.getByTestId("credits-admin-resume-u1")).toBeInTheDocument();
  });

  it("AD-01: pausing needs a reason", async () => {
    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-admin-pause-open-u1"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-pause-submit-u1")).toBeDisabled();
    });

    fireEvent.change(screen.getByTestId("credits-admin-pause-reason-u1"), {
      target: { value: "异常消耗" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-pause-submit-u1")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-pause-submit-u1"));

    await waitFor(() => {
      expect(setMemberGenerationPaused).toHaveBeenCalledWith("tok", "u1", {
        paused: true,
        reason: "异常消耗",
      });
    });
    await waitFor(() => {
      expect(vi.mocked(fetchMemberCredits).mock.calls).toHaveLength(2);
    });
  });

  it("AD-01: a paused member can be resumed", async () => {
    vi.mocked(fetchMemberCredits).mockResolvedValue([PAUSED_MEMBER]);
    vi.mocked(setMemberGenerationPaused).mockResolvedValue({
      paused: false,
      changed: true,
    });

    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-admin-resume-u1"));

    await waitFor(() => {
      expect(setMemberGenerationPaused).toHaveBeenCalledWith("tok", "u1", {
        paused: false,
      });
    });
    await waitFor(() => {
      expect(vi.mocked(fetchMemberCredits).mock.calls).toHaveLength(2);
    });
  });

  it("AD-01: a refused pause shows the server message", async () => {
    vi.mocked(setMemberGenerationPaused).mockRejectedValue(
      new ApiApplicationError("invalid_request", "暂停需要填写原因"),
    );

    await renderPanel();

    fireEvent.click(screen.getByTestId("credits-admin-pause-open-u1"));
    fireEvent.change(screen.getByTestId("credits-admin-pause-reason-u1"), {
      target: { value: "异常消耗" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-pause-submit-u1")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("credits-admin-pause-submit-u1"));

    await waitFor(() => {
      expect(screen.getByTestId("credits-admin-pause-error-u1")).toHaveTextContent(
        "暂停需要填写原因",
      );
    });
  });
});
