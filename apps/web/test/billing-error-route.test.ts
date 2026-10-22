import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  billingErrorRoute,
  creditDialogFieldsOf,
  TIER_TOAST_CODES,
} from "../src/lib/billing-error-route";

/**
 * AG-10 验收 3：删掉某模型的计价规则后，服务端 fail closed 推
 * `billing.error { code:"model_not_available" }` 并中止本轮 —— 前端必须给用户
 * 一句话，而不是让对话无声地停住。
 */
describe("billingErrorRoute", () => {
  it("AG-10: a model without a price rule tells the user it is unavailable", () => {
    expect(billingErrorRoute("model_not_available")).toEqual({
      kind: "message",
      text: "这个模型暂不可用，请更换模型。",
    });
  });

  it("AG-10: running out of credits still opens the credit dialog", () => {
    expect(billingErrorRoute("insufficient_credits")).toEqual({
      kind: "credit_dialog",
    });
  });

  it("AG-10: plan limits still use the tier toast", () => {
    expect(billingErrorRoute("concurrency_limit")).toEqual({
      kind: "tier_toast",
    });
    expect(billingErrorRoute("model_not_accessible")).toEqual({
      kind: "tier_toast",
    });
    expect(billingErrorRoute("resolution_not_allowed")).toEqual({
      kind: "tier_toast",
    });
  });

  it("AG-10: an unknown billing refusal is never silent", () => {
    const route = billingErrorRoute("something_new");

    expect(route.kind).toBe("message");
    expect(route.kind === "message" ? route.text.length : 0).toBeGreaterThan(0);
  });

  /**
   * 两个文件必须认同一组 tier 码：`tier-limit-toast` 的 `VALID_CODES` 是
   * `Object.keys(TOAST_CONFIG)`，`showTierLimit` 对不在里面的码直接 return。
   * 这里不去渲染 provider（它带 framer-motion + next/navigation + portal），
   * 改为读该组件源码、按 `TOAST_CONFIG` 里的键取出它真正接受的码，与
   * `TIER_TOAST_CODES` 逐项对比。
   */
  it("AG-10: the tier codes agree with the toast", () => {
    // vitest 的 root 就是 `apps\web`（见 vitest.config.ts），源码按相对 root 读取。
    const toastSourcePath = path.resolve(
      process.cwd(),
      "src/components/credits/tier-limit-toast.tsx",
    );
    const source = readFileSync(toastSourcePath, "utf8");

    const configStart = source.indexOf("const TOAST_CONFIG");
    const validCodesStart = source.indexOf("const VALID_CODES");
    expect(configStart).toBeGreaterThan(-1);
    expect(validCodesStart).toBeGreaterThan(configStart);

    const configBlock = source.slice(configStart, validCodesStart);
    const acceptedCodes = Array.from(
      configBlock.matchAll(/^ {2}([a-z_]+):\s*\{/gm),
      (match) => match[1],
    );

    expect(acceptedCodes.length).toBeGreaterThan(0);
    expect([...acceptedCodes].sort()).toEqual([...TIER_TOAST_CODES].sort());
    // `VALID_CODES` 必须是 TOAST_CONFIG 的键 —— 否则上面这份源码解析就不再代表
    // 组件实际接受的码。
    expect(source).toContain("new Set<string>(Object.keys(TOAST_CONFIG))");
    // model_not_available 没有 tier toast 的配置，所以它只能走 message。
    expect(acceptedCodes).not.toContain("model_not_available");
    expect(configBlock).not.toContain("model_not_available");
  });

  /**
   * BL-45 / 工单39I：三池口径的拒绝事件不带 `plan` / `dailyClaimed`。
   * 旧的 `plan ?? "free"` + `dailyClaimed ?? false` 会把它当成「免费档、今天没领」，
   * 弹窗于是出现「领取今日赠送」（调已下线的领取接口）。
   */
  it("BL-45: a pool refusal does not offer the daily claim", () => {
    expect(creditDialogFieldsOf({})).toEqual({
      plan: "pool",
      dailyClaimed: true,
    });
  });

  it("BL-45: an old-balance refusal keeps its plan and daily flag", () => {
    expect(
      creditDialogFieldsOf({ plan: "free", dailyClaimed: false }),
    ).toEqual({ plan: "free", dailyClaimed: false });
  });

  it("BL-45: a personal cap billing.error shows the server sentence", () => {
    const sentence = "本月额度已用完（上限 20000），可联系管理员调整";
    expect(billingErrorRoute("personal_cap_reached", sentence)).toEqual({
      kind: "message",
      text: sentence,
    });
  });

  it("BL-45: team_pool_exhausted shows 团队本月额度已用完", () => {
    const route = billingErrorRoute("team_pool_exhausted");
    expect(route.kind).toBe("message");
    expect(route.kind === "message" ? route.text : "").toContain(
      "团队本月额度已用完",
    );
  });
});
