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
