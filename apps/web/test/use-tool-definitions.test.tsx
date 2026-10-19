import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工单 30F T1 · ED-00k 工具定义取数。
 *
 * 只 mock 两样东西：
 * - `fetch`：这样走的是**真的** `fetchToolDefinitions`，schema 校验也是真的
 *   （工单 T1 要求「schema 校验失败时抛错，不能静默降级」，mock 掉 server-api 就验不到了）。
 * - `components/toast`：要断言「弹了几次、文案是什么」，用 spy 比包真 Provider 干净
 *   （真 Provider 会带 3 秒定时器和 DOM 移除，变成在测 toast 组件本身）。
 *
 * `useToolDefinitions` 的请求缓存在**模块级**（同一个 token 只请求一次），所以每个用例
 * 用自己的 token：缓存按 token 分键，用例之间天然隔离，也不需要导出「清缓存」的后门。
 */

const { errorToastSpy, toastSpy } = vi.hoisted(() => ({
  errorToastSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock("../src/components/toast", () => ({
  useToast: () => ({ toast: toastSpy, success: toastSpy, error: errorToastSpy }),
}));

import { useToolDefinitions } from "../src/hooks/use-tool-definitions";
import { lookupError } from "../src/lib/error-catalog";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

/** 服务端 `GET /api/tools` 的**线格式**（snake_case），照抄 21AB 的两条。 */
const WIRE_TOOLS = [
  {
    id: "adjust",
    label: "调整",
    icon: "adjust",
    testid: "image-toolbar-adjust",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: [{ id: "no_adjustment", message: "未做任何调整" }],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
  {
    id: "quick_edit",
    label: "快捷编辑",
    icon: "quick_edit",
    testid: "image-toolbar-quick-edit",
    form: "panel",
    default_slot: "main",
    removable: false,
    consumes: true,
    pricing: { generator: "quick_edit", tiers: [] },
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: "quick_edit",
    disabled_rules: [{ id: "empty_prompt", message: "请先描述要怎么改" }],
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  },
];

/** 未知错误一律归到目录里的 service 条（`lookupError(undefined)`）。 */
const SERVICE_MESSAGE = lookupError(undefined).message;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("useToolDefinitions（ED-00k 取数）", () => {
  it("200 且通过校验：status=ready，tools 条数等于 mock 条数", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tools: WIRE_TOOLS }),
    });

    const { result } = renderHook(() => useToolDefinitions("tok-ready"));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.tools).toHaveLength(WIRE_TOOLS.length);
    expect(result.current.tools.map((tool) => tool.id)).toEqual(["adjust", "quick_edit"]);
    // 带鉴权头，和 fetchJob 一致。
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/tools",
      expect.objectContaining({ headers: { Authorization: "Bearer tok-ready" } }),
    );
    expect(errorToastSpy).not.toHaveBeenCalled();
  });

  it("结构不合 schema：status=error，并弹出目录里的 service 文案", async () => {
    // `id` 有小写字母以外的字符 + 缺字段：`toolListResponseSchema.parse` 必须抛错，
    // 而不是被 `as` 断言吞掉（工单 T1：不能静默降级）。
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tools: [{ id: "Bad Id", label: "坏的" }] }),
    });

    const { result } = renderHook(() => useToolDefinitions("tok-bad-schema"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.tools).toEqual([]);
    expect(errorToastSpy).toHaveBeenCalledTimes(1);
    expect(errorToastSpy).toHaveBeenCalledWith(SERVICE_MESSAGE);
  });

  it("网络错误：status=error（并弹同一条 service 文案）", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useToolDefinitions("tok-network"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.tools).toEqual([]);
    expect(errorToastSpy).toHaveBeenCalledTimes(1);
    expect(errorToastSpy).toHaveBeenCalledWith(SERVICE_MESSAGE);
  });

  it("同一个 token 只请求 1 次（重新挂载也走缓存）", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tools: WIRE_TOOLS }),
    });

    const first = renderHook(() => useToolDefinitions("tok-once"));
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    first.unmount();

    const second = renderHook(() => useToolDefinitions("tok-once"));
    await waitFor(() => expect(second.result.current.status).toBe("ready"));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(second.result.current.tools).toHaveLength(WIRE_TOOLS.length);
  });

  it("没有 accessToken 时不发请求，状态停在 loading", async () => {
    const { result } = renderHook(() => useToolDefinitions(null));

    // 给挂载后的 effect 留一拍，确认它真的没有发请求。
    await waitFor(() => expect(result.current.status).toBe("loading"));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.tools).toEqual([]);
  });
});
