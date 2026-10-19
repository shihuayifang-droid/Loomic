import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetDirectExecuteLocksForTest,
  useDirectExecute,
  type DirectExecuteResult,
  type UseDirectExecuteInput,
} from "../src/hooks/use-direct-execute";
import type { PriceState } from "../src/lib/price-display";

/**
 * ED-00m 前端 · `useDirectExecute`（工单 30M T2 / T4）
 *
 * 三个要害，逐个钉住：
 *   1. **锁必须同步**：同一个 `act` 里连点 3 次，只有第一次穿过（验收 1 前端那一半）。
 *      `setState` 是异步的，这条用例就是用来打「用 state 当锁」那种写法的。
 *   2. **`clientRequestId` 的复用**：reject 后复用（GN-38 去重），resolve 后换新。
 *   3. **`onStart` 在 `submit` 被 await 之前同步调用**（验收 3 前端那一半）。
 *
 * 锁是**模块级**的，会在用例之间残留；本仓 vitest 没开 `globals: true`，RTL 也不会自动
 * cleanup，所以每例之后必须先 `cleanup()`（卸掉订阅）再 `__resetDirectExecuteLocksForTest()`。
 */

/** 手动控制的 promise：用来把「submit 还没 resolve」这一刻钉住。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PRICED_9: PriceState = { status: "priced", amount: 9 };

function makeInput(overrides: Partial<UseDirectExecuteInput> = {}): UseDirectExecuteInput {
  return {
    toolId: "vectorize",
    sourceId: "img-1",
    price: PRICED_9,
    available: 100,
    etaSeconds: null,
    submit: async () => ({ jobId: "job-default" }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  __resetDirectExecuteLocksForTest();
});

describe("useDirectExecute：防连点（验收 1 前端部分）", () => {
  it("同一个 act 里连点 3 次，submit 只被调用 1 次，第 2、3 次返回 in_flight", async () => {
    const gate = deferred<{ jobId: string }>();
    const submit = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useDirectExecute(makeInput({ submit })));

    await act(async () => {
      // 三连点在**同一拍**里发起；锁若不是同步置位，三次都会读到 loading=false。
      const first = result.current.execute();
      const second = result.current.execute();
      const third = result.current.execute();

      expect(submit).toHaveBeenCalledTimes(1);

      expect(await second).toEqual({ status: "in_flight" });
      expect(await third).toEqual({ status: "in_flight" });

      gate.resolve({ jobId: "job-1" });
      expect(await first).toEqual({ status: "submitted", jobId: "job-1" });
    });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("提交中 loading 与 disabled 都为 true；resolve 之后都回到 false，再点会正常提交", async () => {
    const first = deferred<{ jobId: string }>();
    const second = deferred<{ jobId: string }>();
    const submit = vi.fn();
    submit.mockImplementationOnce(() => first.promise);
    submit.mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() => useDirectExecute(makeInput({ submit })));

    expect(result.current.loading).toBe(false);
    expect(result.current.disabled).toBe(false);

    let firstRun!: Promise<DirectExecuteResult>;
    await act(async () => {
      firstRun = result.current.execute();
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.disabled).toBe(true);

    await act(async () => {
      first.resolve({ jobId: "job-1" });
      expect(await firstRun).toEqual({ status: "submitted", jobId: "job-1" });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.disabled).toBe(false);

    // 锁放掉了，第二次点击要真的再提交一次
    let secondRun!: Promise<DirectExecuteResult>;
    await act(async () => {
      secondRun = result.current.execute();
    });
    expect(submit).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ jobId: "job-2" });
      expect(await secondRun).toEqual({ status: "submitted", jobId: "job-2" });
    });
    expect(result.current.loading).toBe(false);
  });

  it("同一个 (sourceId, toolId) 的两个 hook 实例互斥；sourceId 不同的实例互不影响", async () => {
    const gateA = deferred<{ jobId: string }>();
    const submitA = vi.fn(() => gateA.promise);
    const submitOther = vi.fn(async () => ({ jobId: "job-other" }));

    // a、b 是同一张图 + 同一个工具的两个入口（工具条 / 「更多」菜单），c 换了素材
    const a = renderHook(() => useDirectExecute(makeInput({ submit: submitA })));
    const b = renderHook(() => useDirectExecute(makeInput({ submit: submitA })));
    const c = renderHook(() => useDirectExecute(makeInput({ sourceId: "img-2", submit: submitOther })));

    let runA!: Promise<DirectExecuteResult>;
    await act(async () => {
      runA = a.result.current.execute();
    });

    // 同一格锁：另一个实例立刻看到 loading / disabled
    expect(a.result.current.loading).toBe(true);
    expect(b.result.current.loading).toBe(true);
    expect(b.result.current.disabled).toBe(true);

    await act(async () => {
      expect(await b.result.current.execute()).toEqual({ status: "in_flight" });
    });
    expect(submitA).toHaveBeenCalledTimes(1);

    // 换一张图就是另一格锁，不受影响
    expect(c.result.current.loading).toBe(false);
    expect(c.result.current.disabled).toBe(false);
    await act(async () => {
      expect(await c.result.current.execute()).toEqual({ status: "submitted", jobId: "job-other" });
    });
    expect(submitOther).toHaveBeenCalledTimes(1);

    await act(async () => {
      gateA.resolve({ jobId: "job-a" });
      expect(await runA).toEqual({ status: "submitted", jobId: "job-a" });
    });
    expect(a.result.current.loading).toBe(false);
    expect(b.result.current.loading).toBe(false);
  });
});

describe("useDirectExecute：clientRequestId（裁决 4）", () => {
  it("submit reject 之后再点，复用同一个 id；resolve 之后再点，换新 id", async () => {
    const seen: string[] = [];
    let attempt = 0;
    const submit = vi.fn(async (req: { clientRequestId: string }) => {
      seen.push(req.clientRequestId);
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return { jobId: `job-${attempt}` };
    });

    const { result } = renderHook(() => useDirectExecute(makeInput({ submit })));

    await act(async () => {
      const firstRun = await result.current.execute();
      expect(firstRun.status).toBe("failed");
      if (firstRun.status === "failed") {
        expect(firstRun.error).toBeInstanceOf(Error);
      }
    });
    // 失败不占锁：入口必须还能再点
    expect(result.current.loading).toBe(false);
    expect(result.current.disabled).toBe(false);

    await act(async () => {
      expect(await result.current.execute()).toEqual({ status: "submitted", jobId: "job-2" });
    });

    await act(async () => {
      expect(await result.current.execute()).toEqual({ status: "submitted", jobId: "job-3" });
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeTruthy();
    // 失败 → 复用：请求可能已经落地，同一个 id 让服务端去重，避免扣两次
    expect(seen[1]).toBe(seen[0]);
    // 成功 → 清空：下一次是新的一单
    expect(seen[2]).not.toBe(seen[0]);
    expect(seen[2]).toBeTruthy();
  });
});

describe("useDirectExecute：占位回调（验收 3 前端部分）", () => {
  it("onStart 在 submit 还没 resolve 时已同步调用 1 次，etaSeconds 与传入一致", async () => {
    const gate = deferred<{ jobId: string }>();
    const onStart = vi.fn<(info: { clientRequestId: string; etaSeconds: number | null }) => void>();
    // 参数显式写出来，`mock.calls[0][0]` 才有类型（否则 `vi.fn()` 的 calls 是空元组）
    const submit = vi.fn<(req: { clientRequestId: string }) => Promise<{ jobId: string }>>(
      () => gate.promise,
    );
    const { result } = renderHook(() =>
      useDirectExecute(makeInput({ submit, onStart, etaSeconds: 12 })),
    );

    let run!: Promise<DirectExecuteResult>;
    let settled = false;
    let calledBeforeSettle = 0;

    await act(async () => {
      run = result.current.execute();
      void run.then(() => {
        settled = true;
      });
      // 同一拍：submit 已经发出去了，但 promise 还悬着
      expect(submit).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      calledBeforeSettle = onStart.mock.calls.length;
    });

    expect(calledBeforeSettle).toBe(1);
    const info = onStart.mock.calls[0]?.[0];
    expect(info?.etaSeconds).toBe(12);
    // 回调里拿到的 id 与真正发给服务端的那个必须是同一个
    expect(info?.clientRequestId).toBe(submit.mock.calls[0]?.[0]?.clientRequestId);

    await act(async () => {
      gate.resolve({ jobId: "job-1" });
      expect(await run).toEqual({ status: "submitted", jobId: "job-1" });
    });
  });

  it("etaSeconds 为 null 时原样透传（取不到 eta_seconds 的工具）", async () => {
    const onStart = vi.fn();
    const { result } = renderHook(() =>
      useDirectExecute(
        makeInput({ etaSeconds: null, onStart, submit: async () => ({ jobId: "job-1" }) }),
      ),
    );

    await act(async () => {
      await result.current.execute();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]?.[0]?.etaSeconds).toBeNull();
  });
});

describe("useDirectExecute：被拦时不产生任何副作用（验收 2）", () => {
  it("priced 9 / available 8 → disabled、原因逐字、execute 返回 blocked 且不调 submit/onStart", async () => {
    const submit = vi.fn(async () => ({ jobId: "never" }));
    const onStart = vi.fn();
    const { result } = renderHook(() =>
      useDirectExecute(makeInput({ available: 8, submit, onStart })),
    );

    expect(result.current.disabled).toBe(true);
    expect(result.current.reason).toBe("积分不足：需要 9，当前 8");
    // 不可点时 title 用 reason，tooltip 仍然描述价格本身（T3 里 reason 优先）
    expect(result.current.tooltip).toBe("点击即扣 9 分");

    await act(async () => {
      expect(await result.current.execute()).toEqual({
        status: "blocked",
        reason: "积分不足：需要 9，当前 8",
      });
    });

    expect(submit).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it("estimating / error 也不产生副作用，原因分别是「价格获取中」「价格获取失败」", async () => {
    const submit = vi.fn(async () => ({ jobId: "never" }));
    const onStart = vi.fn();

    const estimating = renderHook(() =>
      useDirectExecute(
        makeInput({ price: { status: "estimating" }, available: 100, submit, onStart }),
      ),
    );
    expect(estimating.result.current.disabled).toBe(true);
    expect(estimating.result.current.reason).toBe("价格获取中");
    await act(async () => {
      expect(await estimating.result.current.execute()).toEqual({
        status: "blocked",
        reason: "价格获取中",
      });
    });

    const error = renderHook(() =>
      useDirectExecute(makeInput({ price: { status: "error" }, available: 100, submit, onStart })),
    );
    expect(error.result.current.reason).toBe("价格获取失败");
    await act(async () => {
      expect(await error.result.current.execute()).toEqual({
        status: "blocked",
        reason: "价格获取失败",
      });
    });

    expect(submit).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("pending / free 可点：真的会提交（不误拦）", async () => {
    const submit = vi.fn(async () => ({ jobId: "job-free" }));
    const { result } = renderHook(() =>
      useDirectExecute(
        makeInput({ price: { status: "pending" }, available: 0, submit, etaSeconds: 3 }),
      ),
    );

    expect(result.current.disabled).toBe(false);
    expect(result.current.reason).toBeNull();
    expect(result.current.tooltip).toBe("待定价，点击即执行");

    await act(async () => {
      expect(await result.current.execute()).toEqual({ status: "submitted", jobId: "job-free" });
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
