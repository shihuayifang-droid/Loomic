import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

/**
 * 工单 36L：CV-02 / GN-35 失败占位的「已退回 N 积分」。
 *
 * 三件事一起验：纯函数只认真正退回来的钱（`credits_refunded`，不是 `credits_cost`）、
 * 占位把这一行画在该画的地方、hook 只读一次并把读取失败吞掉。
 *
 * `globals` 未开启（见 vitest.config.ts），所以 RTL 的自动 cleanup 不会注册，
 * 必须自己 afterEach(cleanup)，否则多次 render 之后 getByTestId 会撞到多个节点。
 */

const { fetchJobCreditsMock } = vi.hoisted(() => ({
  fetchJobCreditsMock: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  fetchJobCredits: fetchJobCreditsMock,
}));

import { FailedGenerationSlot } from "@/components/media/failed-generation-slot";
import { useJobRefundLabel } from "@/hooks/use-job-refund-label";
import { refundLabel } from "@/lib/refund-label";

afterEach(cleanup);

beforeEach(() => {
  fetchJobCreditsMock.mockReset();
});

describe("CV-02 refund label", () => {
  it("CV-02: a refunded job says how much came back", () => {
    expect(refundLabel({ credits_refunded: 12 })).toBe("已退回 12 积分");
  });

  it("CV-02: nothing refunded says nothing", () => {
    expect(refundLabel({ credits_refunded: 0 })).toBeNull();
    expect(refundLabel(null)).toBeNull();
    expect(refundLabel(undefined)).toBeNull();
  });

  it("CV-02: the failed slot shows the refund line", () => {
    render(
      <FailedGenerationSlot
        kind="image"
        message="图片生成失败，请重试"
        width={512}
        height={512}
        onDelete={() => {}}
        refundLabel="已退回 12 积分"
      />,
    );

    expect(screen.getByTestId("canvas-failed-slot-refund").textContent).toBe(
      "已退回 12 积分",
    );
  });

  it("CV-02: without a refund the line is absent", () => {
    render(
      <FailedGenerationSlot
        kind="image"
        message="图片生成失败，请重试"
        width={512}
        height={512}
        onDelete={() => {}}
        refundLabel={null}
      />,
    );

    expect(screen.queryByTestId("canvas-failed-slot-refund")).toBeNull();
  });
});

describe("GN-35 refund hook", () => {
  it("GN-35: the hook reads the job's credits once and labels them", async () => {
    fetchJobCreditsMock.mockResolvedValue({
      job_id: "job-1",
      credits_cost: 10,
      credits_refunded: 7,
      credits_transaction_id: null,
    });

    const { result } = renderHook(() => useJobRefundLabel("t", "job-1"));

    await waitFor(() => expect(result.current).toBe("已退回 7 积分"));
    expect(fetchJobCreditsMock).toHaveBeenCalledTimes(1);
    expect(fetchJobCreditsMock).toHaveBeenCalledWith("t", "job-1");
  });

  it("GN-35: a failed read shows no refund line", async () => {
    fetchJobCreditsMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useJobRefundLabel("t", "job-1"));

    await waitFor(() => expect(fetchJobCreditsMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });
});
