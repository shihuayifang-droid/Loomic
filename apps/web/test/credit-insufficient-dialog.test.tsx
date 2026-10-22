// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 工单 38Q / BL-45 / BL-40：积分不足弹窗。
 * 需求 BL-45「以上都没有、充值也不够 → 积分不足 + 去充值」；
 * 需求 BL-40「界面不再出现任何订阅档位 / 升级提示」—— 38B 起 `/api/payments/checkout` 一律 410。
 */
const { createCheckout } = vi.hoisted(() => ({
  createCheckout: vi.fn(async () => ({ checkoutUrl: "https://example.invalid/checkout" })),
}));

vi.mock("@/lib/payments-api", () => ({ createCheckout }));

import { CreditInsufficientDialog } from "../src/components/credits/credit-insufficient-dialog";

type DialogProps = {
  open?: boolean;
  currentBalance: number;
  requiredAmount: number;
  plan?: string;
  dailyClaimed?: boolean;
  onClaimDaily?: () => Promise<void>;
};

function renderDialog(props: DialogProps) {
  const merged = {
    open: true,
    onClose: () => {},
    plan: "free",
    dailyClaimed: true,
    ...props,
  };
  return render(<CreditInsufficientDialog {...merged} />);
}

describe("CreditInsufficientDialog", () => {
  afterEach(() => {
    cleanup();
    createCheckout.mockClear();
  });

  it("BL-45: the dialog says 积分不足 and offers 去充值", () => {
    renderDialog({ open: true, currentBalance: 5, requiredAmount: 12 });

    expect(screen.getByTestId("credits-insufficient-title")).toHaveTextContent(
      "积分不足",
    );

    const topup = screen.getByTestId("credits-insufficient-topup");
    expect(topup).toHaveAttribute("href", "/settings?tab=usage");
    expect(topup).toHaveTextContent("去充值");
    expect(topup.tagName).toBe("A");

    // 正文与三格标签都是中文口径
    expect(screen.getByText(/本次需要/)).toBeInTheDocument();
    expect(screen.getByText("需要")).toBeInTheDocument();
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText("还差")).toBeInTheDocument();
    expect(screen.getByTestId("credits-insufficient-cancel")).toHaveTextContent(
      "取消",
    );
  });

  it("BL-40: there is no upgrade button and no checkout call", () => {
    renderDialog({ open: true, currentBalance: 5, requiredAmount: 12 });

    expect(screen.queryByTestId("credits-insufficient-upgrade")).toBeNull();
    expect(screen.queryByText("Upgrade Plan")).toBeNull();
    expect(createCheckout).toHaveBeenCalledTimes(0);
  });

  it("BL-45: the shortfall is required minus available", () => {
    const { unmount } = renderDialog({
      open: true,
      requiredAmount: 12,
      currentBalance: 5,
    });
    expect(
      screen.getByTestId("credits-insufficient-shortfall"),
    ).toHaveTextContent("7");
    unmount();

    renderDialog({ open: true, requiredAmount: 12, currentBalance: 20 });
    expect(
      screen.getByTestId("credits-insufficient-shortfall"),
    ).toHaveTextContent("0");
  });

  it("the daily claim still appears for a free plan that has not claimed", () => {
    const onClaimDaily = vi.fn(async () => {});
    renderDialog({
      open: true,
      currentBalance: 5,
      requiredAmount: 12,
      plan: "free",
      dailyClaimed: false,
      onClaimDaily,
    });

    expect(screen.getByTestId("credits-insufficient-claim")).toHaveTextContent(
      "领取今日赠送",
    );
  });

  /**
   * BL-45 / 工单39I：三池口径的拒绝不带 `plan`，`creditDialogFieldsOf` 给的是
   * `{ plan: "pool", dailyClaimed: true }` —— 弹窗只留「去充值」，不出现
   * 「领取今日赠送」（旧领取接口已下线）。
   */
  it("BL-45: a pool shortfall shows no daily claim", () => {
    const onClaimDaily = vi.fn(async () => {});
    renderDialog({
      open: true,
      currentBalance: 5,
      requiredAmount: 12,
      plan: "pool",
      dailyClaimed: true,
      onClaimDaily,
    });

    expect(screen.queryByTestId("credits-insufficient-claim")).toBeNull();
    expect(screen.queryByText("领取今日赠送")).toBeNull();
    expect(screen.getByTestId("credits-insufficient-topup")).toHaveTextContent(
      "去充值",
    );
  });
});
