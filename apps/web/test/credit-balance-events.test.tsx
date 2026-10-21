// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreditBalanceResponse } from "@loomic/shared";

import { useCredits } from "../src/hooks/use-credits";
import { fetchCredits } from "../src/lib/credits-api";
import { fetchJob } from "../src/lib/server-api";
import {
  publishPoolBalance,
  subscribePoolBalance,
} from "../src/lib/credit-balance-events";

/**
 * 工单 38M · GN-03「状态响应带回的额度直接刷新顶栏，不另调账户接口」。
 *
 * 钉住的是这条链路：`GET /api/jobs/:jobId` 的 `balance` → `publishPoolBalance` →
 * `useCredits` 的 `pools` → 顶栏 / 账户中心读到的 `balance`。
 * 请求形状与 `balance` 的契约由后端用例（38D）守，这里只走真实 `fetchJob`。
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

/** 顶栏挂载时账户接口给的三池（可用 15250）。 */
const POOLS_BEFORE = {
  balances: {
    daily: 50,
    teamRemaining: 30000,
    personalTeamUsed: 5000,
    personalCap: 20000,
    topup: 200,
  },
  available: 15250,
};

/** 跑完一次生成后，状态响应带回的三池（实扣 12，可用 15238）。 */
const POOLS_AFTER = {
  balances: {
    daily: 50,
    teamRemaining: 30000,
    personalTeamUsed: 5012,
    personalCap: 20000,
    topup: 200,
  },
  available: 15238,
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

/** 一条合法 job 行（`backgroundJobSchema`）。 */
function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    project_id: null,
    canvas_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "default",
    job_type: "video_generation",
    status: "running",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    created_by: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
    ...over,
  };
}

/** 让真实 `fetchJob` 拿到的就是这一坨 body。 */
function stubJobResponse(body: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.mocked(fetchCredits).mockReset();
  vi.mocked(fetchCredits).mockResolvedValue(
    makeBalance({ pools: POOLS_BEFORE }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GN-03 · 状态响应带回的额度刷新顶栏", () => {
  it("GN-03: a job status with a balance updates the top bar without another account call", async () => {
    const { result } = renderHook(() => useCredits());
    await waitFor(() => expect(result.current.balance).toBe(15250));
    expect(fetchCredits).toHaveBeenCalledTimes(1);

    stubJobResponse({
      job: jobRow({ status: "succeeded" }),
      balance: {
        balances: POOLS_AFTER.balances,
        available: 15238,
        monthlyCapRemaining: 14988,
      },
    });

    await act(async () => {
      await fetchJob("tok-credits", "11111111-1111-4111-8111-111111111111");
    });

    expect(result.current.balance).toBe(15238);
    expect(result.current.pools?.balances).toEqual(POOLS_AFTER.balances);
    // 顶栏只调过一次账户接口：刷新来自状态响应，不是第二通请求。
    expect(fetchCredits).toHaveBeenCalledTimes(1);
  });

  it("GN-03: a job status without a balance changes nothing", async () => {
    const { result } = renderHook(() => useCredits());
    await waitFor(() => expect(result.current.balance).toBe(15250));

    stubJobResponse({ job: jobRow({ status: "succeeded" }) });

    await act(async () => {
      await fetchJob("tok-credits", "11111111-1111-4111-8111-111111111111");
    });

    expect(result.current.balance).toBe(15250);
  });

  it("GN-03: balance null changes nothing", async () => {
    const { result } = renderHook(() => useCredits());
    await waitFor(() => expect(result.current.balance).toBe(15250));

    stubJobResponse({ job: jobRow({ status: "succeeded" }), balance: null });

    await act(async () => {
      await fetchJob("tok-credits", "11111111-1111-4111-8111-111111111111");
    });

    expect(result.current.balance).toBe(15250);
  });

  it("unsubscribe stops updates", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePoolBalance(listener);

    publishPoolBalance({ balances: POOLS_AFTER.balances, available: 15238 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishPoolBalance({ balances: POOLS_AFTER.balances, available: 15238 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
