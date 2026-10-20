import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { CreditTransaction } from "@loomic/shared";

import { CreditUsageHistory } from "../src/components/credits/credit-usage-history";
import { fetchCreditTransactions } from "../src/lib/credits-api";

/**
 * BL-06 · 用量明细（前端）
 *
 * 钉住三件事：
 *   1) 类型列显示流水类型的中文名（服务端没给 `entry_type` 时走 shared 兜底翻译）；
 *   2) 按类型多选筛选：点一个类型只剩该类型，「全部」恢复；
 *   3) 列表到底显示「没有更多了」。
 */

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "tok" } }),
}));

vi.mock("@/lib/credits-api", () => ({
  fetchCreditTransactions: vi.fn(),
}));

const TRANSACTIONS: CreditTransaction[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    transaction_type: "generation_deduct",
    entry_type: "consume",
    amount: -5,
    balance_after: 95,
    job_id: null,
    description: null,
    created_at: "2024-05-01T10:00:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    transaction_type: "generation_refund",
    amount: 5,
    balance_after: 100,
    job_id: null,
    description: null,
    created_at: "2024-05-02T10:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    transaction_type: "daily_grant",
    amount: 100,
    balance_after: 200,
    job_id: null,
    description: null,
    created_at: "2024-05-03T10:00:00.000Z",
  },
];

beforeEach(() => {
  vi.mocked(fetchCreditTransactions).mockReset();
  vi.mocked(fetchCreditTransactions).mockResolvedValue({ transactions: TRANSACTIONS });
});

afterEach(() => {
  cleanup();
});

describe("CreditUsageHistory · BL-06", () => {
  it("BL-06: rows show the Chinese entry type", async () => {
    render(<CreditUsageHistory />);

    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(3);
    });

    const rows = screen.getAllByTestId("credits-history-row");
    expect(rows[0]).toHaveTextContent("消耗");
    // 这条不服务端不带 entry_type，靠 shared 的 generation_refund → refund_failed
    expect(rows[1]).toHaveTextContent("失败退款");
    expect(rows[2]).toHaveTextContent("每日赠送");

    // 正负号按 amount 的符号
    expect(rows[0]).toHaveTextContent("-5");
    expect(rows[1]).toHaveTextContent("+5");
  });

  it("BL-06: selecting 失败退款 leaves only the refund row", async () => {
    render(<CreditUsageHistory />);
    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(3);
    });

    fireEvent.click(screen.getByTestId("credits-history-filter-refund_failed"));
    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(1);
    });
    expect(screen.getAllByTestId("credits-history-row")[0]).toHaveTextContent("失败退款");
    expect(screen.getByTestId("credits-history-filter-refund_failed")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByTestId("credits-history-filter-all"));
    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(3);
    });
  });

  it("BL-06: a short list ends with 没有更多了", async () => {
    render(<CreditUsageHistory />);
    await waitFor(() => {
      expect(screen.getAllByTestId("credits-history-row")).toHaveLength(3);
    });

    expect(screen.getByTestId("credits-history-end")).toHaveTextContent("没有更多了");
  });
});
