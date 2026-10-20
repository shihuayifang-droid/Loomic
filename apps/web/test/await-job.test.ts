import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJobMock } = vi.hoisted(() => ({ fetchJobMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({
  fetchJob: fetchJobMock,
}));

import {
  JobFailed,
  type JobProgress,
  awaitJobCompletion,
} from "../src/lib/await-job";

/** 一条 REST 行：轮询路径和「补 max_attempts」都吃它 */
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

/** 假 ws handle：记下 onEvent 的回调，测试里手动推事件 */
function makeWs() {
  const handlers: Array<(event: any) => void> = [];
  const ws = {
    connected: true,
    startRun: vi.fn(),
    cancelRun: vi.fn(),
    registerRPC: vi.fn(),
    resumeCanvas: vi.fn(),
    onEvent: (cb: (event: any) => void) => {
      handlers.push(cb);
      return () => {
        const index = handlers.indexOf(cb);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
  return {
    ws: ws as never,
    emit(event: Record<string, unknown>) {
      for (const handler of [...handlers]) {
        handler({ jobId: "job-1", ...event });
      }
    },
    handlerCount: () => handlers.length,
  };
}

/**
 * 把 promise 的结局记在可变对象里。挂上 then 之后不会产生
 * unhandled rejection（多数用例里 promise 到断言时仍是 pending）。
 */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  const done = promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return { state, done };
}

/** 让已排队的 microtask 全部跑完（fetchJob mock 是立即 resolve 的） */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("awaitJobCompletion —— WebSocket 快路径", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJobMock.mockReset();
    fetchJobMock.mockResolvedValue({ job: jobRow() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retrying(attempt=2)：promise 仍 pending，onProgress 拿到 maxAttempts=3，fetchJob 只补一次", async () => {
    const onProgress = vi.fn<(info: JobProgress) => void>();
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, onProgress, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "retrying", attempt: 2 });
    await flush();

    // retrying 不是终态：等待继续，不能 reject
    expect(state.settled).toBe(false);
    // 最后一次回调带上了补回来的分母（第一次不带，是 socket 事件本身的样子）
    expect(onProgress).toHaveBeenLastCalledWith({
      status: "retrying",
      attempt: 2,
      maxAttempts: 3,
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
    expect(fetchJobMock).toHaveBeenCalledWith("tok", "job-1");
  });

  it("再推一次 retrying(attempt=3)：fetchJob 不再被调用（分母已缓存）", async () => {
    const onProgress = vi.fn<(info: JobProgress) => void>();
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, onProgress, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "retrying", attempt: 2 });
    await flush();
    emit({ type: "job.progress", status: "retrying", attempt: 3 });
    await flush();

    expect(state.settled).toBe(false);
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith({
      status: "retrying",
      attempt: 3,
      maxAttempts: 3,
    });
  });

  it("failed 带 error_code=timeout：reject 为 JobFailed，code 保留（T5 要用）", async () => {
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, pollIntervalMs: 1_000 }),
    );

    emit({
      type: "job.progress",
      status: "failed",
      error: { code: "timeout", message: "took too long" },
    });
    await flush();

    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(JobFailed);
    const failed = state.error as JobFailed;
    expect(failed.code).toBe("timeout");
    expect(failed.message).toBe("took too long");
    expect(failed.jobId).toBe("job-1");
  });

  it("succeeded：resolve 为结果记录", async () => {
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, pollIntervalMs: 1_000 }),
    );

    emit({
      type: "job.progress",
      status: "succeeded",
      result: { signed_url: "https://example.test/v.mp4" },
    });
    await flush();

    expect(state.settled).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.value).toMatchObject({
      id: "job-1",
      status: "succeeded",
      result: { signed_url: "https://example.test/v.mp4" },
    });
  });

  it("canceled：按原语义 reject 为 JobFailed，code=canceled、文案是原样那句", async () => {
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "canceled" });
    await flush();

    expect(state.error).toBeInstanceOf(JobFailed);
    const failed = state.error as JobFailed;
    expect(failed.code).toBe("canceled");
    expect(failed.message).toBe('Job ended with status "canceled".');
  });

  it("legacy 的 dead_letter 当作 failed 收尾（不会让等待方转到底）", async () => {
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "dead_letter" });
    await flush();

    expect(state.error).toBeInstanceOf(JobFailed);
    const failed = state.error as JobFailed;
    expect(failed.code).toBe("failed");
    expect(failed.message).toBe('Job ended with status "failed".');
  });

  it("GN-30: 事件自带 maxAttempts 时第一次回调就带分母，fetchJob 一次都不调", async () => {
    const onProgress = vi.fn<(info: JobProgress) => void>();
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, onProgress, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "retrying", attempt: 2, maxAttempts: 4 });
    await flush();

    expect(state.settled).toBe(false);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith({
      status: "retrying",
      attempt: 2,
      maxAttempts: 4,
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(0);
  });

  it("GN-30: 之后不带 maxAttempts 的事件沿用已知分母，仍不请求 REST", async () => {
    const onProgress = vi.fn<(info: JobProgress) => void>();
    const { ws, emit } = makeWs();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { ws, onProgress, pollIntervalMs: 1_000 }),
    );

    emit({ type: "job.progress", status: "retrying", attempt: 2, maxAttempts: 4 });
    await flush();
    emit({ type: "job.progress", status: "retrying", attempt: 3 });
    await flush();

    expect(state.settled).toBe(false);
    expect(onProgress).toHaveBeenLastCalledWith({
      status: "retrying",
      attempt: 3,
      maxAttempts: 4,
    });
    expect(fetchJobMock).toHaveBeenCalledTimes(0);
  });
});

describe("awaitJobCompletion —— 轮询兜底", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJobMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retrying：从 REST 行里取 attempt_count / max_attempts，继续等", async () => {
    fetchJobMock.mockResolvedValue({
      job: jobRow({ status: "retrying", attempt_count: 2, max_attempts: 3 }),
    });
    const onProgress = vi.fn<(info: JobProgress) => void>();
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { onProgress, pollIntervalMs: 1_000 }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.settled).toBe(false);
    expect(onProgress).toHaveBeenLastCalledWith({
      status: "retrying",
      attempt: 2,
      maxAttempts: 3,
    });
  });

  it("failed：reject 为 JobFailed，code 取 job 的 error_code", async () => {
    fetchJobMock.mockResolvedValue({
      job: jobRow({ status: "failed", error_code: "upstream_busy", error_message: "busy" }),
    });
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { pollIntervalMs: 1_000 }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.error).toBeInstanceOf(JobFailed);
    const failed = state.error as JobFailed;
    expect(failed.code).toBe("upstream_busy");
    expect(failed.message).toBe("busy");
  });

  it("succeeded：resolve 为 REST 行本身", async () => {
    const row = jobRow({ status: "succeeded", result: { signed_url: "https://example.test/v.mp4" } });
    fetchJobMock.mockResolvedValue({ job: row });
    const { state } = track(
      awaitJobCompletion("tok", "job-1", { pollIntervalMs: 1_000 }),
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.settled).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.value).toBe(row);
  });
});
