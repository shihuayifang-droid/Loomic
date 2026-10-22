import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JOB_POLL_INTERVAL_MS } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJobMock } = vi.hoisted(() => ({ fetchJobMock: vi.fn() }));

vi.mock("../src/lib/server-api", () => ({
  fetchJob: fetchJobMock,
}));

import { awaitJobCompletion } from "../src/lib/await-job";

const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(here, "..", relativePath), "utf8");
}

/** 一条 REST 行：轮询路径吃它。status=running 表示还没到终态。 */
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

/** 让已排队的 microtask 全部跑完 */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchJobMock.mockReset();
  fetchJobMock.mockResolvedValue({ job: jobRow() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GN-02 ② / GN-39 job poll interval", () => {
  it("GN-02: the safety-net poll runs every 3 seconds", () => {
    expect(JOB_POLL_INTERVAL_MS).toBe(3000);
  });

  it("GN-39: no client keeps its own poll interval", () => {
    const sources = [
      readSource(path.join("src", "lib", "await-job.ts")),
      readSource(path.join("src", "hooks", "use-job-fallback-polling.ts")),
    ];
    for (const source of sources) {
      expect(source).not.toContain("5_000");
      expect(source).not.toContain("5000");
      expect(source).toContain("JOB_POLL_INTERVAL_MS");
    }
  });

  it("GN-02: awaitJobCompletion polls at the shared interval by default", async () => {
    // 这个 promise 一直 pending（job 还在 running），只观察 fetchJob 的调用次数。
    void awaitJobCompletion("tok", "job-1").catch(() => {});

    await vi.advanceTimersByTimeAsync(2999);
    await flush();
    expect(fetchJobMock).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fetchJobMock).toHaveBeenCalledTimes(1);
  });
});

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** 抓一次等待的结果，避免 unhandled rejection 干扰 fake timers。 */
function settleOf<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

/** 推进 n 个共享轮询间隔，每一步之后把 microtask 排空。 */
async function advancePollTicks(ticks: number) {
  for (let i = 0; i < ticks; i += 1) {
    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    await flush();
  }
}

describe("GN-02 验收 2 / polling stops at a terminal status", () => {
  it("GN-02: a 30-second job is polled about ten times and never after it succeeds", async () => {
    // 30 秒的任务 / 3 秒一次 = 10 次；前 9 次还在跑，第 10 次成功。
    for (let i = 0; i < 9; i += 1) {
      fetchJobMock.mockResolvedValueOnce({ job: jobRow() });
    }
    fetchJobMock.mockResolvedValueOnce({
      job: jobRow({ status: "succeeded", result: {} }),
    });

    // 不传 ws，纯轮询兜底。
    const settled = settleOf(awaitJobCompletion("tok", "job-1"));

    await advancePollTicks(10);

    const outcome = await settled;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.status).toBe("succeeded");
    }

    const callsAtTerminal = fetchJobMock.mock.calls.length;
    expect(callsAtTerminal).toBeGreaterThanOrEqual(9);
    expect(callsAtTerminal).toBeLessThanOrEqual(11);

    // 已经到终态：再推进 30 秒，一次请求都不许多。
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fetchJobMock).toHaveBeenCalledTimes(callsAtTerminal);
  });

  it("GN-02: a failed job stops polling too", async () => {
    fetchJobMock.mockResolvedValueOnce({ job: jobRow() });
    fetchJobMock.mockResolvedValueOnce({ job: jobRow() });
    fetchJobMock.mockResolvedValueOnce({
      job: jobRow({
        status: "failed",
        error_code: "upstream_busy",
        error_message: "upstream busy",
      }),
    });

    const settled = settleOf(awaitJobCompletion("tok", "job-1"));

    await advancePollTicks(3);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as Error).name).toBe("JobFailed");
    }
    expect(fetchJobMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fetchJobMock).toHaveBeenCalledTimes(3);
  });

  it("GN-02: a canceled job stops polling too", async () => {
    fetchJobMock.mockResolvedValueOnce({ job: jobRow() });
    fetchJobMock.mockResolvedValueOnce({ job: jobRow() });
    fetchJobMock.mockResolvedValueOnce({
      job: jobRow({ status: "canceled", error_message: "canceled by user" }),
    });

    const settled = settleOf(awaitJobCompletion("tok", "job-1"));

    await advancePollTicks(3);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.error as Error).name).toBe("JobFailed");
    }
    expect(fetchJobMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(fetchJobMock).toHaveBeenCalledTimes(3);
  });
});
