import type { EntryPoint } from "@loomic/shared";

import type { PricingRuleRepository } from "../../db/pricing-rule-repository.js";
import {
  MODEL_NOT_AVAILABLE,
  resolvePriceFromCandidates,
  type ResolvePriceOutcome,
} from "./resolve-price.js";

/**
 * BL-14 第 3 条 / GN-07 —— 运行时询价（工单 31B · T1）。
 *
 * 扣费路径原来的价格来自 shared 里写死的成本函数（`getImageCreditCost` /
 * `getVideoCreditCost`），未登记的模型会落到 `DEFAULT_*_COST` 兜底，**照样扣费**。
 * 本模块把「这一次要扣多少钱」换成「去价目表问一次」，于是：
 *
 * - 表里没有这个模型 → `model_not_available`：调用方在建任务、查余额之前就拒绝；
 * - 表里有、价格 `pending` → 报 0 元（可以执行，按 0 扣，另记一条待定价流水）；
 * - 表里有、价格 `active` → 报表里的价格。
 *
 * **不缓存。** 改价必须立即生效（BL-14 第 4 条）：价目表的 `effective_at` 已经承担
 * 「定时生效」，这里再加一层内存缓存就会让改价晚一个 TTL 才被看见，而且进程重启
 * 前后行为不一致 —— 那种不一致没法用一条 SQL 复现。
 *
 * 仓储错误**原样传上去**，不许吞掉后按 0 处理：一次读失败被当成「免费」就是全站
 * 免费一秒，而免费是这里唯一一个「不报错也不扣钱」的结果，所以它必须只能由数据
 * 本身产生（`pending`），不能由一次 IO 错误产生。
 */
export type PriceQuoter = {
  /**
   * 询价。`at` 由调用方取一次并传进来（工单 31B 裁决 5）：一次计费只应有一个
   * 「现在」，否则「取候选」与「判断生效」之间跨过一个生效时间，同一笔请求就会
   * 用两个时刻算账。
   */
  quote(input: {
    modelId: string;
    entryPoint: EntryPoint;
    searchKey: string;
    at: Date;
  }): Promise<ResolvePriceOutcome>;
};

export function createPriceQuoter(deps: {
  pricingRuleRepository: PricingRuleRepository;
}): PriceQuoter {
  return {
    async quote(input) {
      // 先问「登记过没有」，是因为未登记与「登记了但档位没配上」在 GN-07 里是
      // 两件事：前者一律拒绝，后者才走默认行。这个谓词也就是那条分界线。
      const registered = await deps.pricingRuleRepository.hasModel({
        modelId: input.modelId,
      });

      // 未登记的模型连候选都不读：一行规则都没有，候选集必然是空数组，而空候选
      // 在 `resolvePriceFromCandidates` 里的含义是「种子数据缺行」（fail closed），
      // 与「这个 id 没登记」用同一个错误码但不同的成因。省掉这次读不会丢信息。
      if (!registered) return { ok: false, code: MODEL_NOT_AVAILABLE };

      const candidates = await deps.pricingRuleRepository.listCandidateRules({
        modelId: input.modelId,
        at: input.at,
      });

      return resolvePriceFromCandidates(
        {
          modelId: input.modelId,
          entryPoint: input.entryPoint,
          searchKey: input.searchKey,
        },
        candidates,
        registered,
      );
    },
  };
}
