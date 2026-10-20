import type { CreditBalanceResponse } from "@loomic/shared";
import { PLAN_CONFIGS, creditBalanceResponseSchema } from "@loomic/shared";

import type { BalanceInfo } from "./credit-service.js";

/**
 * `creditBalanceResponseSchema` 的唯一组装点（工单31D 裁决 7）。
 *
 * 这段映射原先在 `http/credits.ts` 里写了两遍（`GET /api/credits` 一遍、
 * `POST /api/credits/admin/set-plan` 一遍）。现在多了一个消费者 —— 询价接口的响应
 * 里带的 `balance` 必须与 `GET /api/credits` **逐字段相同**（GN-01 验收 1 的
 * 前置），三份拷贝迟早会漂移，所以合成一处。
 *
 * 契约由 `creditBalanceResponseSchema.parse()` 兜着：这里少一个字段就是校验失败，
 * 而不是客户端收到一个「少了 limits」的余额对象。
 */
export function toCreditBalanceResponse(
  info: BalanceInfo,
): CreditBalanceResponse {
  const config = PLAN_CONFIGS[info.plan];

  return creditBalanceResponseSchema.parse({
    balance: info.balance,
    plan: info.plan,
    dailyClaimed: info.dailyClaimed,
    limits: {
      maxConcurrentJobs: config.maxConcurrentJobs,
      maxResolution: config.maxResolution,
      monthlyCredits: config.monthlyCredits,
      dailyCredits: config.dailyCredits,
    },
  });
}
