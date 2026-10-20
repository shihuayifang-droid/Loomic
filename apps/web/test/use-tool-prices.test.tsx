import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@loomic/shared";

/**
 * 工单 35L T4 · ED-00f「更多」菜单直接执行类工具的询价。
 *
 * 只 mock `@/lib/server-api` 的 `fetchPriceQuote`（要验的是「问了哪些工具、结果怎么落进
 * 菜单状态」，不是请求本身 —— 请求体形状由 GN-01 的契约与后端用例守）。`priceStateFromQuote`
 * 走真身：把询价结果映射成标价五态是 ED-00f 的另一半，替身掉它就等于没验。
 */

const fetchPriceQuoteMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPriceQuote: fetchPriceQuoteMock,
}));

import { useToolPrices } from "../src/hooks/use-tool-prices";

const TOKEN = "tok-prices";

/**
 * 本 hook 不读余额（余额是 `use-credits` 的事），响应里的 `balance` 只要不改形状即可。
 * 询价响应的 schema（GN-01）里它是与 `GET /api/credits` 同结构的一坨。
 */
const BALANCE = {};

/** 一条合法 `price_detail`（字段照 `priceDetailSchema`；`total_price` 是本例要断言的那个数）。 */
const PRICE_DETAIL = {
  base_price: 12,
  unit_name: "次",
  unit_count: 1,
  unit_price: 12,
  total_price: 12,
  search_key: "*",
  search_key_matched: null,
  time_variant_period: "normal",
  disable_unlimited: false,
  entry_point: "tool",
  extras: [],
  price_status: "active",
};

/** 一份工具定义：只写本例关心的字段，其余照 `toolDefinitionSchema` 的默认形态。 */
function makeTool(
  overrides: Partial<ToolDefinition> & { id: string; label: string },
): ToolDefinition {
  return {
    icon: overrides.id,
    testid: `image-toolbar-${overrides.id.replace(/_/g, "-")}`,
    form: "direct",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "none",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
    ...overrides,
  };
}

/** 直接执行 + 在「更多」里 + 有计价规则 = 要询价的那一个。 */
const VECTORIZE = makeTool({
  id: "vectorize",
  label: "矢量",
  consumes: true,
  pricing: { generator: "vectorize", tiers: ["*"] },
});
/** 打开面板类：菜单里同样出现，但不标价、也不询价（带计价规则，单靠 `pricing !== null` 挡不住）。 */
const ADJUST = makeTool({
  id: "adjust",
  label: "调整",
  form: "panel",
  pricing: { generator: "adjust_like", tiers: [] },
});
/** 直接执行但不在「更多」里（在主工具条上）：不询价（同样带计价规则）。 */
const DOWNLOAD = makeTool({
  id: "download",
  label: "下载",
  default_slot: "main",
  pricing: { generator: "download_like", tiers: [] },
});
/** 直接执行且在「更多」里，但没有计价规则：只有 `pricing !== null` 这一条能挡掉它。 */
const UNPRICED = makeTool({ id: "unpriced_direct", label: "未计价" });

const MENU_TOOLS: ToolDefinition[] = [VECTORIZE, ADJUST, DOWNLOAD, UNPRICED];

beforeEach(() => {
  // 每个用例自己决定这次询价的成败，不存在「上一例的 resolve 漏到这一例」。
  fetchPriceQuoteMock.mockReset();
  // 失败分支会 console.error 一行诊断：本例断言的是状态，不是日志，收掉免得刷屏。
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useToolPrices（ED-00f 询价）", () => {
  it("ED-00f: only enabled direct tools in the more menu are quoted", async () => {
    fetchPriceQuoteMock.mockResolvedValue({ items: [], balance: BALANCE });

    renderHook(() => useToolPrices(TOKEN, MENU_TOOLS));

    await waitFor(() => expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(1));
    // 一次请求带全批：只有 vectorize 进 items，adjust（面板类）与 download（不在「更多」）不进。
    expect(fetchPriceQuoteMock).toHaveBeenCalledWith(TOKEN, {
      items: [{ kind: "tool", tool_id: "vectorize" }],
    });
  });

  it("ED-00f: while the quote is out the price reads estimating", async () => {
    // 永不 resolve：模拟请求还在飞。
    fetchPriceQuoteMock.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useToolPrices(TOKEN, MENU_TOOLS));

    await waitFor(() =>
      expect(result.current).toEqual({ vectorize: { status: "estimating" } }),
    );
  });

  it("ED-00f: the answer becomes the tag state", async () => {
    fetchPriceQuoteMock.mockResolvedValue({
      items: [{ status: "ok", price_detail: PRICE_DETAIL }],
      balance: BALANCE,
    });

    const { result } = renderHook(() => useToolPrices(TOKEN, MENU_TOOLS));

    await waitFor(() =>
      expect(result.current).toEqual({ vectorize: { status: "priced", amount: 12 } }),
    );
  });

  it("ED-00f: a failed quote shows the retry state", async () => {
    fetchPriceQuoteMock.mockRejectedValue(new Error("quote down"));

    const { result } = renderHook(() => useToolPrices(TOKEN, MENU_TOOLS));

    await waitFor(() => expect(result.current).toEqual({ vectorize: { status: "error" } }));
  });
});

/**
 * 工单 36M T5 · ED-00c「工具条渲染时并发询价所有付费工具的全部档位」。
 *
 * 上面 35L 的四例一个字都没改：它们的夹具（ADJUST / DOWNLOAD / UNPRICED）都是
 * `consumes: false`，换判据之后仍然不询价；VECTORIZE 的 `tiers` 只有 `"*"`，
 * 所以询价项照旧不带 `search_key`。
 */

/** 付费 + 三档：每档一项询价，结果按 `toolId:tier` 落。 */
const UPSCALE = makeTool({
  id: "upscale",
  label: "放大",
  consumes: true,
  default_slot: "main",
  pricing: { generator: "upscale", tiers: ["2k", "4k", "8k"] },
});

/** 付费 + 无档位（`tiers: ["*"]`）：一项询价，key 就是 toolId。 */
const PAID_DIRECT = makeTool({
  id: "vectorize",
  label: "矢量",
  consumes: true,
  pricing: { generator: "vectorize", tiers: ["*"] },
});

/** 付费但不可用：不询价（`availability` 是另一条挡板）。 */
const MOTION = makeTool({
  id: "motion",
  label: "动态图片",
  consumes: true,
  availability: "unavailable",
  pricing: { generator: "motion", tiers: [] },
});

describe("useToolPrices（ED-00c 全档询价）", () => {
  it("ED-00c: every tier of every enabled paid tool is quoted in one request", async () => {
    fetchPriceQuoteMock.mockResolvedValue({ items: [], balance: BALANCE });

    renderHook(() => useToolPrices(TOKEN, [UPSCALE, PAID_DIRECT]));

    await waitFor(() => expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(1));
    // 一次请求带两工具的全部槽位：放大三档 + 矢量一项 = 4 项，三档都带 `search_key`。
    expect(fetchPriceQuoteMock).toHaveBeenCalledWith(TOKEN, {
      items: [
        { kind: "tool", tool_id: "upscale", search_key: "2k" },
        { kind: "tool", tool_id: "upscale", search_key: "4k" },
        { kind: "tool", tool_id: "upscale", search_key: "8k" },
        { kind: "tool", tool_id: "vectorize" },
      ],
    });
    expect(fetchPriceQuoteMock.mock.calls[0]?.[1]?.items).toHaveLength(4);
  });

  it("ED-00c: unavailable and free tools are not quoted", async () => {
    fetchPriceQuoteMock.mockResolvedValue({ items: [], balance: BALANCE });

    // 只有 PAID_DIRECT 该被问价：MOTION 不可用，ADJUST 面板类、UNPRICED 无计价规则都不花钱。
    renderHook(() => useToolPrices(TOKEN, [MOTION, ADJUST, UNPRICED, PAID_DIRECT]));

    await waitFor(() => expect(fetchPriceQuoteMock).toHaveBeenCalledTimes(1));
    expect(fetchPriceQuoteMock).toHaveBeenCalledWith(TOKEN, {
      items: [{ kind: "tool", tool_id: "vectorize" }],
    });
  });

  it("ED-00c: results are keyed by tool and tier", async () => {
    fetchPriceQuoteMock.mockResolvedValue({
      items: [
        { status: "ok", price_detail: { ...PRICE_DETAIL, search_key: "2k", search_key_matched: "2k" } },
        { status: "ok", price_detail: { ...PRICE_DETAIL, search_key: "4k", search_key_matched: "4k" } },
        { status: "ok", price_detail: { ...PRICE_DETAIL, search_key: "8k", search_key_matched: "8k" } },
        { status: "ok", price_detail: PRICE_DETAIL },
      ],
      balance: BALANCE,
    });

    const { result } = renderHook(() => useToolPrices(TOKEN, [UPSCALE, PAID_DIRECT]));

    await waitFor(() =>
      expect(result.current).toEqual({
        "upscale:2k": { status: "priced", amount: 12 },
        "upscale:4k": { status: "priced", amount: 12 },
        "upscale:8k": { status: "priced", amount: 12 },
        // 无档位工具的 key 仍是 toolId（35K / 35L 的菜单读法靠这条不变）。
        vectorize: { status: "priced", amount: 12 },
      }),
    );
    expect(Object.keys(result.current)).toContain("upscale:2k");
    expect(Object.keys(result.current)).toContain("vectorize");
  });
});
