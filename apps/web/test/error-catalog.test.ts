import { cleanup, renderHook } from "@testing-library/react";
import { applicationErrorCodeSchema } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * handler 触到的两个 UI 出口都换成 spy：本工单只做文案，不碰 toast 组件，
 * 所以断言落在「给了什么文案 / 有没有走 tier toast」上。
 */
const mocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showTierLimit: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: mocks.showErrorToast,
  }),
}));

vi.mock("@/components/credits/tier-limit-toast", () => ({
  useTierLimitToast: () => ({ showTierLimit: mocks.showTierLimit }),
}));

import { useGenerationErrorHandler } from "../src/hooks/use-generation-error-handler";
import { JobFailed } from "../src/lib/await-job";
import {
  APP_ERROR_CATALOG,
  EXTRA_ERROR_CATALOG,
  lookupError,
} from "../src/lib/error-catalog";
import { ApiApplicationError } from "../src/lib/server-api";

/** X-40 一期要「通用文案」彻底消失：这条是旧的兜底词，不许再出现在目录里 */
const OLD_GENERIC = "生成失败，请重试。";

/** X-40 规格 §5 的初始条目（13 个码，跨 APP 与 EXTRA 两部分） */
const SPEC_INITIAL_CODES = [
  "personal_cap_reached",
  "team_pool_exhausted",
  "insufficient_credits",
  "model_not_available",
  "model_not_allowed",
  "tool_disabled",
  "quote_mismatch",
  "upstream_busy",
  "timeout",
  "concurrency_limit",
  "account_suspended",
  "service_unavailable",
  "canvas_unavailable",
] as const;

const ALL_ENTRIES = () => [
  ...Object.entries(APP_ERROR_CATALOG),
  ...Object.entries(EXTRA_ERROR_CATALOG),
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("APP_ERROR_CATALOG 与 shared 枚举的对齐（T-49 反方向检查）", () => {
  it("键集合与 applicationErrorCodeSchema.options 双向相等", () => {
    const keys = Object.keys(APP_ERROR_CATALOG).sort();
    const options = [...applicationErrorCodeSchema.options].sort();
    expect(keys).toEqual(options);
    // 反方向再写一遍，防止哪天 sort 之后长度对但集合不同
    for (const code of applicationErrorCodeSchema.options) {
      expect(APP_ERROR_CATALOG[code], `缺少 ${code} 的条目`).toBeDefined();
    }
    expect(keys).toHaveLength(options.length);
  });

  it("EXTRA 里只放枚举外的码（不重复定义 shared 已有的码）", () => {
    const inEnum = new Set<string>(applicationErrorCodeSchema.options);
    for (const code of Object.keys(EXTRA_ERROR_CATALOG)) {
      expect(inEnum.has(code), `${code} 已经在 shared 枚举里，不该再进 EXTRA`).toBe(false);
    }
  });

  it("规格 §5 的 13 个初始条目全都有条目（不落到未知码兜底）", () => {
    const fallback = lookupError(undefined);
    for (const code of SPEC_INITIAL_CODES) {
      const entry = lookupError(code);
      expect(entry, `${code} 没有条目`).toBeDefined();
      // 兜底对象是同一个引用；命中兜底就说明这个码没被收录
      expect(entry === fallback, `${code} 落到了未知码兜底`).toBe(false);
    }
  });

  it("T-58 ②: EXTRA 目录为空，规格 §5 的 13 个码全部在 shared 枚举里", () => {
    expect(Object.keys(EXTRA_ERROR_CATALOG)).toEqual([]);
    for (const code of SPEC_INITIAL_CODES) {
      expect(applicationErrorCodeSchema.options).toContain(code);
    }
  });
});

describe("lookupError", () => {
  it("invalid_request → user_fixable + edit_params（X-40 验收②的前端部分）", () => {
    expect(lookupError("invalid_request")).toMatchObject({
      category: "user_fixable",
      action: "edit_params",
    });
  });

  it("未知码 → service（不许把未知错误说成用户的错）", () => {
    expect(lookupError("zzz_unknown").category).toBe("service");
    expect(lookupError(undefined).category).toBe("service");
  });

  it("额度类 → category quota + action quota", () => {
    for (const code of [
      "insufficient_credits",
      "concurrency_limit",
      "personal_cap_reached",
      "team_pool_exhausted",
    ]) {
      expect(lookupError(code), code).toMatchObject({
        category: "quota",
        action: "quota",
      });
    }
  });

  it("policy 类没有可重试也没有可改的入口（action 为 null）", () => {
    expect(lookupError("account_suspended")).toMatchObject({
      category: "policy",
      action: null,
    });
  });

  it("timeout 的文案以「生成超时」开头", () => {
    expect(lookupError("timeout").message.startsWith("生成超时")).toBe(true);
  });

  it("每个条目都有非空中文文案，且模板一致（类别 ↔ action）", () => {
    for (const [code, entry] of ALL_ENTRIES()) {
      expect(entry.message.length, `${code} 的文案为空`).toBeGreaterThan(0);
      expect(entry.message, `${code} 还在用旧兜底文案`).not.toBe(OLD_GENERIC);
      if (entry.category === "user_fixable") expect(entry.action).toBe("edit_params");
      if (entry.category === "service") expect(entry.action).toBe("retry_later");
      if (entry.category === "quota") expect(entry.action).toBe("quota");
      if (entry.category === "policy") expect(entry.action).toBeNull();
    }
  });
});

describe("useGenerationErrorHandler（X-40 一期接线）", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function handler() {
    const { result } = renderHook(() => useGenerationErrorHandler());
    return result.current.handleGenerationError;
  }

  it("JobFailed(code=timeout) 的文案以「生成超时」开头（码不再被丢掉）", () => {
    const handle = handler();
    const handled = handle(new JobFailed("job-1", "timeout", "upstream said 504"));

    expect(handled).toBe(false);
    const message = mocks.showErrorToast.mock.calls[0]?.[0] as string;
    expect(message.startsWith("生成超时")).toBe(true);
  });

  it("JobFailed(code=upstream_busy) 走目录文案，不是通用文案", () => {
    const handle = handler();
    handle(new JobFailed("job-1", "upstream_busy", "busy"));

    expect(mocks.showErrorToast).toHaveBeenCalledWith(
      APP_ERROR_CATALOG.upstream_busy.message,
    );
    expect(mocks.showErrorToast).not.toHaveBeenCalledWith(OLD_GENERIC);
  });

  it("ApiApplicationError(concurrency_limit) 仍走 tier toast，且不发普通 toast", () => {
    const handle = handler();
    const handled = handle(new ApiApplicationError("concurrency_limit", "limit reached", 429));

    expect(handled).toBe(true);
    expect(mocks.showTierLimit).toHaveBeenCalledWith({
      code: "concurrency_limit",
      message: "limit reached",
    });
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it("insufficient_credits 仍返回 true（调用方负责打开充值弹窗）", () => {
    const handle = handler();
    const handled = handle(new ApiApplicationError("insufficient_credits", "no credits", 402));

    expect(handled).toBe(true);
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.showTierLimit).not.toHaveBeenCalled();
  });

  it("其他应用错误码用目录文案，不再是「生成失败，请重试。」", () => {
    const handle = handler();
    const handled = handle(new ApiApplicationError("generation_failed", "boom", 502));

    expect(handled).toBe(false);
    const message = mocks.showErrorToast.mock.calls[0]?.[0] as string;
    expect(message).toBe(APP_ERROR_CATALOG.generation_failed.message);
    expect(message).not.toBe(OLD_GENERIC);
  });

  it("非 API 的未知错误兜底为 service 文案", () => {
    const handle = handler();
    const handled = handle(new Error("kaboom"));

    expect(handled).toBe(false);
    expect(mocks.showErrorToast).toHaveBeenCalledWith(lookupError(undefined).message);
    expect(mocks.showErrorToast).not.toHaveBeenCalledWith(OLD_GENERIC);
  });
});

// ---------------------------------------------------------------------------
// 工单40B / MD-03：参考图数量超限
//
// 六个未核实上限的模型声明 `"unbounded"`，前端不做拦截，所以上游真的拒了的时候
// 用户必须看到「参考图数量超限」这句，而不是 X-40 要消灭的那句通用文案；能改的是
// 请求里的参考图，所以入口是「修改参数」。
// ---------------------------------------------------------------------------

describe("MD-03: 参考图数量超限（工单40B）", () => {
  it("MD-03: reference_image_limit reads 参考图数量超限", () => {
    expect(lookupError("reference_image_limit")).toMatchObject({
      category: "user_fixable",
      action: "edit_params",
    });
    expect(APP_ERROR_CATALOG.reference_image_limit.message).toContain("参考图数量超限");
    expect(APP_ERROR_CATALOG.reference_image_limit.message).not.toBe(OLD_GENERIC);
  });
});
