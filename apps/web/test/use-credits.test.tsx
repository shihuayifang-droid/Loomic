import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreditBalanceResponse } from "@loomic/shared";

import { useCredits } from "../src/hooks/use-credits";
import { fetchCredits } from "../src/lib/credits-api";

/**
 * 工单 38J · BL-45「可用额度 = 三池可用额度之和，全站一个口径」的前端第 1 步。
 *
 * 钉住的是 hook 的取值口径，不是请求本身（请求形状由 37Q / 38I 的后端用例守）：
 *   1) 响应里有 `pools` 时，`balance` 就是 `pools.available` 这一个数；
 *   2) 响应里没有 `pools` 键（开关关，38I）时，`balance` 退回旧余额；
 *   3) `pools: null`（开关开但调用方没有团队工作区）时，同样退回旧余额。
 *
 * 消费方（顶栏积分、账户中心）只读 `balance`，所以整套口径只在这一个 hook 里落地。
 */

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "tok-credits" } }),
}));

vi.mock("@/lib/credits-api", () => ({
  fetchCredits: vi.fn(),
  claimDailyCredits: vi.fn(),
}));

/** `limits` 是响应里与余额口径无关的一坨，照契约填满即可。 */
const LIMITS = {
  maxConcurrentJobs: 2,
  maxResolution: "1024",
  monthlyCredits: 1000,
  dailyCredits: 50,
};

/** 三个池的五个数字（`poolBalancesSchema`）；`available` 按 BL-45 是这三池可用之和。 */
const POOLS = {
  balances: {
    daily: 50,
    teamRemaining: 30000,
    personalTeamUsed: 5000,
    personalCap: 20000,
    topup: 200,
  },
  available: 15250,
};

function makeBalance(
  overrides: Partial<CreditBalanceResponse> = {},
): CreditBalanceResponse {
  return {
    balance: 1000,
    plan: "free",
    dailyClaimed: false,
    limits: LIMITS,
    ...overrides,
  } as CreditBalanceResponse;
}

beforeEach(() => {
  vi.mocked(fetchCredits).mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useCredits · BL-45 余额读三池", () => {
  it("BL-45: with pools the balance is the one available figure", async () => {
    vi.mocked(fetchCredits).mockResolvedValue(makeBalance({ pools: POOLS }));

    const { result } = renderHook(() => useCredits());

    await waitFor(() => expect(result.current.balance).toBe(15250));
    expect(result.current.pools?.available).toBe(15250);
  });

  it("BL-45: without pools the balance is the old balance", async () => {
    vi.mocked(fetchCredits).mockResolvedValue(makeBalance());

    const { result } = renderHook(() => useCredits());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBe(1000);
    expect(result.current.pools).toBeNull();
  });

  it("BL-45: pools null (no team) falls back to the old balance", async () => {
    vi.mocked(fetchCredits).mockResolvedValue(makeBalance({ pools: null }));

    const { result } = renderHook(() => useCredits());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.balance).toBe(1000);
  });
});
