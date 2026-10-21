import { describe, expect, it } from "vitest";

import { billingErrorRoute } from "../src/lib/billing-error-route";
import { lookupError } from "../src/lib/error-catalog";

/**
 * BL-45 验收：三种用尽提示按优先级判断，错误码进 X 模块错误码表。
 *
 *   1. 个人上限到了      → 「本月额度已用完（上限 N），可联系管理员调整」 personal_cap_reached
 *   2. 团队池空了        → 「团队本月额度已用完」                       team_pool_exhausted
 *   3. 以上都没有、充值也不够 → 「积分不足」+「去充值」按钮              insufficient_credits
 *
 * 目录里的文案是**不带 N** 的版本（目录不知道 N）；带 N 的那句由服务端在
 * `billing.error.message` 里给出，`billingErrorRoute` 的第二参把它接过来。
 * 这三句都按字面量断言 —— 改文案必须同时改这里，否则「规格原文」就不再被保护。
 */
describe("BL-45: refusal copy", () => {
  it("BL-45: the catalog copy for each refusal is the spec's wording", () => {
    expect(lookupError("personal_cap_reached").message).toBe(
      "本月额度已用完，可联系管理员调整",
    );
    expect(lookupError("team_pool_exhausted").message).toBe(
      "团队本月额度已用完",
    );
    expect(lookupError("insufficient_credits").message).toBe("积分不足");
  });

  it("BL-45: a personal cap refusal shows the server's sentence with the cap", () => {
    expect(
      billingErrorRoute(
        "personal_cap_reached",
        "本月额度已用完（上限 20000），可联系管理员调整",
      ),
    ).toEqual({
      kind: "message",
      text: "本月额度已用完（上限 20000），可联系管理员调整",
    });
  });

  it("BL-45: an unrelated server message is not shown for a cap refusal", () => {
    expect(billingErrorRoute("personal_cap_reached", "cap")).toEqual({
      kind: "message",
      text: "本月额度已用完，可联系管理员调整",
    });
  });

  it("BL-45: team pool exhausted shows 团队本月额度已用完", () => {
    expect(billingErrorRoute("team_pool_exhausted")).toEqual({
      kind: "message",
      text: "团队本月额度已用完",
    });
    // 池空没有带 N 的服务端变体，第二参不能把它换成别的话。
    expect(billingErrorRoute("team_pool_exhausted", "本月额度已用完（上限 20000），可联系管理员调整")).toEqual({
      kind: "message",
      text: "团队本月额度已用完",
    });
  });

  it("BL-45: insufficient credits still opens the credit dialog", () => {
    // 「去充值」按钮在这个弹窗里，行为不变。
    expect(billingErrorRoute("insufficient_credits")).toEqual({
      kind: "credit_dialog",
    });
    expect(billingErrorRoute("insufficient_credits", "积分不足")).toEqual({
      kind: "credit_dialog",
    });
  });
});
