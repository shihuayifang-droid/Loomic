import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJobMock } = vi.hoisted(() => ({ fetchJobMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({
  fetchJob: fetchJobMock,
}));

import { useJobFallbackPolling } from "../src/hooks/use-job-fallback-polling";

/** 与 use-job-fallback-polling.ts 里的 POLL_INTERVAL_MS 对齐 */
const POLL_MS = 5_000;

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "running",
    job_type: "video_generation",
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 1,
    max_attempts: 3,
    ...over,
  };
}

/** 服务端超时（tool.completed 里 error 含 "timed out"）才会触发兜底轮询 */
const TIMED_OUT_EVENT = {
  type: "tool.completed",
  output: {
    error: "generate_video timed out after 300s",
    jobId: "job-1",
    jobType: "video_generation",
  },
} as never;

function setup() {
  const onJobSucceeded = vi.fn();
  const accessTokenRef = { current: "tok" } as unknown as {
    current: string | undefined;
  };
  const { result } = renderHook(() =>
    useJobFallbackPolling({
      onJobSucceeded,
      accessTokenRef: accessTokenRef as never,
    }),
  );
  return { onJobSucceeded, result };
}

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup；假定时器也要还原
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useJobFallbackPolling（GN-30 终态语义）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJobMock.mockReset();
  });

  it("retrying：继续轮询（不把它当失败）", async () => {
    fetchJobMock.mockResolvedValue({ job: jobRow({ status: "retrying" }) });
    const { result } = setup();

    await act(async () => {
      result.current.checkForTimedOutJobs(TIMED_OUT_EVENT);
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    // 第二次照样问：retrying 不是终态
    expect(fetchJobMock).toHaveBeenCalledTimes(2);
  });

  it("failed：停止轮询", async () => {
    fetchJobMock.mockResolvedValue({ job: jobRow({ status: "failed" }) });
    const { result } = setup();

    await act(async () => {
      result.current.checkForTimedOutJobs(TIMED_OUT_EVENT);
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });

  it("canceled：停止轮询", async () => {
    fetchJobMock.mockResolvedValue({ job: jobRow({ status: "canceled" }) });
    const { result } = setup();

    await act(async () => {
      result.current.checkForTimedOutJobs(TIMED_OUT_EVENT);
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });

  it("legacy 的 dead_letter：按 failed 处理，停止轮询", async () => {
    fetchJobMock.mockResolvedValue({ job: jobRow({ status: "dead_letter" }) });
    const { result } = setup();

    await act(async () => {
      result.current.checkForTimedOutJobs(TIMED_OUT_EVENT);
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });

  it("succeeded：停止轮询并通知调用方刷新画布", async () => {
    fetchJobMock.mockResolvedValue({
      job: jobRow({ status: "succeeded", result: { signed_url: "https://x/y.mp4" } }),
    });
    const { result, onJobSucceeded } = setup();

    await act(async () => {
      result.current.checkForTimedOutJobs(TIMED_OUT_EVENT);
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(onJobSucceeded).toHaveBeenCalledTimes(1);
    expect(onJobSucceeded).toHaveBeenCalledWith("job-1", "video_generation");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });
});
