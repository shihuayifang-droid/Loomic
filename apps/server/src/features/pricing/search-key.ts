import type { ImageQualityLevel, SubscriptionPlan } from "@loomic/shared";
import { PLAN_CONFIGS } from "@loomic/shared";

import type { BillingGuardSpec } from "../credits/with-billing.js";

/**
 * GN-07 档位（`search_key`）推导（工单31D 裁决 3）。
 *
 * 这段逻辑原先写在 `features/credits/with-billing.ts` 里两次 —— 一次给
 * `tierGuard.checkResolution`，一次给 `priceQuoter.quote`。询价接口也要问价目表
 * 同一件事，如果它自己再抄一遍，两边就有三个可以各自漂移的副本，而漂移的后果是
 * **同一个请求在「报价」和「扣费」时报出两个价**，账面完全看不出来。
 *
 * 所以：纯函数、只读 `PLAN_CONFIGS`、不碰数据库和时钟，提交路径与询价路径共用。
 *
 * 口径（与提交路径逐条一致，本单只做重构、行为不变）：
 * - 图片：`plan_max` 解析成该套餐的 `maxResolution`（不是字面量 `"plan_max"`，
 *   否则会命中通配行、把一次 hd 请求按模型默认价算），其余情况原样使用档位；
 * - 视频：只有默认行，未给 resolution 时用 `"unspecified"`（预期内，不是缺陷）。
 */

/** 视频没给 resolution 时问价目表的档位名（视频只有默认行）。 */
export const UNSPECIFIED_RESOLUTION = "unspecified";

/**
 * 一次请求要问价目表的档位，以及（图片）解析后的实际档位。
 *
 * `effectiveQuality` 只对图片有意义：视频没有「档位」这个概念，所以是 `null`。
 * 图片 guard 一定解析出具体档位（`plan_max` 也会被换成套餐值），因此那个分支
 * 用第一条重载拿到非空类型，不需要在调用点写断言或回退默认值 —— 回退默认值正是
 * 这里要消灭的那类「猜」。
 */
export function billingSearchKey(
  guard: Extract<BillingGuardSpec, { jobType: "image_generation" }>,
  plan: SubscriptionPlan,
): { effectiveQuality: ImageQualityLevel; searchKey: string };
export function billingSearchKey(
  guard: BillingGuardSpec,
  plan: SubscriptionPlan,
): { effectiveQuality: ImageQualityLevel | null; searchKey: string };
export function billingSearchKey(
  guard: BillingGuardSpec,
  plan: SubscriptionPlan,
): { effectiveQuality: ImageQualityLevel | null; searchKey: string } {
  if (guard.jobType === "image_generation") {
    const effectiveQuality =
      guard.quality === "plan_max"
        ? PLAN_CONFIGS[plan].maxResolution
        : guard.quality;

    return { effectiveQuality, searchKey: effectiveQuality };
  }

  return {
    effectiveQuality: null,
    searchKey: guard.resolution ?? UNSPECIFIED_RESOLUTION,
  };
}
