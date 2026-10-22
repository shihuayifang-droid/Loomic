import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工单 38W · T-109「生成器面板提交前拿不到本次价格」的前端预检。
 *
 * 只 mock `@/lib/server-api` 的 `fetchPriceQuote`（要验的是「什么时候问、问到的东西
 * 怎么变成价态、余额够不够」，不是请求本身 —— 请求体形状由 GN-01 的契约守）。
 * `priceStateFromQuote` 走真身：把询价结果映射成标价五态是同一件事的另一半，
 * 替身掉它就等于没验。
 */

const fetchPriceQuoteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPriceQuote: fetchPriceQuoteMock,
}));

import type { GenerationQuoteInput } from "../src/hooks/use-generation-quote";
import {
  GENERATION_QUOTE_DEBOUNCE_MS,
  useGenerationQuote,
} from "../src/hooks/use-generation-quote";

const TOKEN = "tok-quote";

/** 本 hook 不读响应里的余额（余额由调用方传进来），只要形状不被用到即可。 */
const BALANCE = {};

/** 一条合法 `price_detail`（字段照 `priceDetailSchema`；`total_price` 是本例要断言的那个数）。 */
function priceDetail(totalPrice: number) {
  return {
    base_price: totalPrice,
    unit_name: "次",
    unit_count: 1,
    unit_price: totalPrice,
    total_price: totalPrice,
    search_key: "*",
    search_key_matched: null,
    time_variant_period: "normal",
    disable_unlimited: false,
    entry_point: "image_generation",
    extras: [],
    price_status: "active",
  };
}

/** 一次成功询价的响应：一条结果，合计 `totalPrice`。 */
function quoteOf(totalPrice: number) {
  return { items: [{ status: "ok", price_detail: priceDetail(totalPrice) }], balance: BALANCE };
}

/** 图片生成的一次输入（`prompt` 用来区分不同的输入）。 */
function imageInput(prompt: string): GenerationQuoteInput {
  return { kind: "image_generation", request: { prompt, model: "m1" } };
}

type HookProps = { input: GenerationQuoteInput | null; available: number | null };

/** 渲染 hook，允许改 `input` / `available`（防抖与竞态用例都要改输入）。 */
function renderQuote(initialProps: HookProps) {
  return renderHook(
    ({ input, available }: HookProps) => useGenerationQuote(TOKEN, input, available),
    { initialProps },
  );
}

/** 推进一个防抖窗口并把已 resolve 的 Promise 放完（假定时器下的标准做法）。 */
async function advanceDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GENERATION_QUOTE_DEBOUNCE_MS);
  });
}

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup；假定时器也要还原。
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  fetchPriceQuoteMock.mockReset();
  // 失败分支会 console.error 一行诊断：本例断言的是状态，不是日志，收掉免得刷屏。
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("useGenerationQuote（T-109 提交前预检）", () => {
  it("T-109: a priced quote under the balance passes", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(12));

    const { result } = renderQuote({ input: imageInput("cat"), available: 100 });

    // 防抖窗口内还没发请求：价格只能是「估算中」。
    expect(result.current.price).toEqual({ status: "estimating" });
    expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(0);

    await advanceDebounce();

    expect(result.current.price).toEqual({ status: "priced", amount: 12 });
    expect(result.current.precheck).toEqual({ ok: true });
  });

  it("T-109: a price over the available credits is refused before submit", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(120));

    const { result } = renderQuote({ input: imageInput("cat"), available: 100 });

    await advanceDebounce();

    expect(result.current.price).toEqual({ status: "priced", amount: 120 });
    expect(result.current.precheck).toEqual({
      ok: false,
      reason: "insufficient",
      required: 120,
      available: 100,
    });
  });

  it("T-109: the request is debounced", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(12));

    const { rerender } = renderQuote({ input: imageInput("a"), available: 100 });

    // 300ms 内连续改三次：前两个定时器都被后一次输入清掉。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ input: imageInput("b"), available: 100 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ input: imageInput("c"), available: 100 });
    await advanceDebounce();

    expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(1);
    // 问的是最后一次的输入，不是第一次的。
    expect(fetchPriceQuoteMock).toHaveBeenCalledWith(TOKEN, { items: [imageInput("c")] });
  });

  it("T-109: an unknown balance never blocks", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(120));

    const { result } = renderQuote({ input: imageInput("cat"), available: null });

    await advanceDebounce();

    expect(result.current.price).toEqual({ status: "priced", amount: 120 });
    expect(result.current.precheck).toEqual({ ok: true });
  });

  it("T-109: a failed quote does not block", async () => {
    fetchPriceQuoteMock.mockRejectedValue(new Error("quote down"));

    const { result } = renderQuote({ input: imageInput("cat"), available: 0 });

    await advanceDebounce();

    expect(result.current.price).toEqual({ status: "error" });
    expect(result.current.precheck).toEqual({ ok: true });
  });

  it("T-109: no input sends nothing", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(12));

    const { result } = renderQuote({ input: null, available: 100 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(0);
    expect(result.current.price).toEqual({ status: "estimating" });
    expect(result.current.precheck).toEqual({ ok: true });
  });

  it("T-109: a stale answer is dropped", async () => {
    // 第一次请求永不主动 resolve：它代表「输入变了以后才回来的旧答案」。
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    fetchPriceQuoteMock.mockReturnValueOnce(first).mockResolvedValueOnce(quoteOf(12));

    const { result, rerender } = renderQuote({ input: imageInput("a"), available: 100 });

    await advanceDebounce();
    expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(1);

    // 第一条还在飞的时候换输入：第二条立刻问、立刻拿到 12。
    rerender({ input: imageInput("b"), available: 100 });
    await advanceDebounce();
    expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(2);
    expect(result.current.price).toEqual({ status: "priced", amount: 12 });

    // 旧答案（999）此时才到：它属于旧参数，必须被丢弃。
    await act(async () => {
      resolveFirst?.(quoteOf(999));
      await Promise.resolve();
    });

    expect(result.current.price).toEqual({ status: "priced", amount: 12 });
    expect(result.current.precheck).toEqual({ ok: true });
  });

  it("T-109: the request body is the one item", async () => {
    fetchPriceQuoteMock.mockResolvedValue(quoteOf(12));

    renderQuote({ input: imageInput("cat"), available: 100 });
    await advanceDebounce();

    expect(fetchPriceQuoteMock).toHaveBeenCalledWith("tok-quote", {
      items: [{ kind: "image_generation", request: { prompt: "cat", model: "m1" } }],
    });
  });
});
