import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { CreditTransaction } from "@loomic/shared";

import { CreditUsageHistory } from "../src/components/credits/credit-usage-history";
import { fetchCreditTransactions } from "../src/lib/credits-api";
import { poolLabelOf } from "../src/lib/ledger-pool-label";

/**
 * BL-06 · 用量明细的「所属池」列（前端）
 *
 * 钉住四件事：
 *   1) 单池流水显示池名；
 *   2) 拆池流水把非 0 的部分按 每日 / 团队 / 充值 顺序列出来；
 *   3) 负数取绝对值；什么都不知道时显示破折号；
 *   4) 历史表有「所属池」表头，行里那一格显示池名。
 */

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "tok" } }),
}));

vi.mock("@/lib/credits-api", () => ({
  fetchCreditTransactions: vi.fn(),
}));

const TRANSACTIONS: CreditTransaction[] = [
  {
    id: "44444444-4444-4444-8444-444444444444",
    transaction_type: "purchase",
    entry_type: "topup",
    amount: 50,
    balance_after: 150,
    job_id: null,
    description: null,
    created_at: "2024-05-04T10:00:00.000Z",
    pool: "topup",
  },
];

beforeEach(() => {
  vi.mocked(fetchCreditTransactions).mockReset();
  vi.mocked(fetchCreditTransactions).mockResolvedValue({ transactions: TRANSACTIONS });
});

afterEach(() => {
  cleanup();
});

describe("BL-06 · pool label", () => {
  it("BL-06: a single pool shows its name", () => {
    expect(poolLabelOf({ pool: "team" })).toBe("团队池");
    expect(poolLabelOf({ pool: "daily" })).toBe("每日赠送");
    expect(poolLabelOf({ pool: "topup" })).toBe("充值");
  });

  it("BL-06: a split shows each part", () => {
    expect(
      poolLabelOf({ pool: null, pool_breakdown: { daily: 5, team: 7, topup: 0 } }),
    ).toBe("每日 5 · 团队 7");
  });

  it("BL-06: negative amounts read as their size", () => {
    expect(poolLabelOf({ pool_breakdown: { daily: 0, team: -12, topup: 0 } })).toBe("团队 12");
  });

  it("BL-06: nothing known shows a dash", () => {
    expect(poolLabelOf({})).toBe("—");
    expect(poolLabelOf({ pool: null, pool_breakdown: { daily: 0, team: 0, topup: 0 } })).toBe("—");
  });

  it("BL-06: the history table has a 所属池 column", async () => {
    render(createElement(CreditUsageHistory));

    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(1);
    });

    expect(screen.getByRole("columnheader", { name: "所属池" })).toBeInTheDocument();

    const pools = screen.getAllByTestId("credits-history-pool");
    expect(pools).toHaveLength(1);
    expect(pools[0]).toHaveTextContent("充值");
  });
});
