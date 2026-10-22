import { describe, expect, it } from "vitest";

import { PLAN_CONFIGS } from "@loomic/shared";
import type { ImageQualityLevel, SubscriptionPlan } from "@loomic/shared";

import type { BillingGuardSpec } from "../credits/with-billing.js";
import {
  DEFAULT_IMAGE_QUALITY,
  UNSPECIFIED_RESOLUTION,
  billingSearchKey,
} from "./search-key.js";

/**
 * 工单31D 裁决 3 —— 档位推导抽成纯函数后的单元用例。
 *
 * 这张表原本写在 `withBilling` 里（两处：一处给 `checkResolution`，一处给 `quote`）。
 * 询价接口要报出与扣费一致的价，就得用同一个推导，所以它必须能脱离计费流程被逐条
 * 验证 —— 否则「报价对不对」只能靠一次真花钱的提交来看。
 *
 * 每条用例的两半都要验：
 * 1. `searchKey`（问价目表用的档位）；
 * 2. `effectiveQuality`（`checkResolution` 用的、`plan_max` 已解析的档位）。
 *
 * 同一份推导也仍被 `with-billing.test.ts` 从计费路径那一侧钉住，且那份测试本单
 * 一行未改 —— 两边的用例合起来才说明「重构没有改变行为」。
 */

type Case = {
  /** 用例名；编号与工单 §5 的条目对应，失败的报错要能直接对回验收项。 */
  name: string;
  guard: BillingGuardSpec;
  plan: SubscriptionPlan;
  expectedQuality: ImageQualityLevel | null;
  expectedSearchKey: string;
};

const CASES: readonly Case[] = [
  {
    name: "case 1: 图片 hd → 档位 hd，effectiveQuality 也是 hd",
    guard: { jobType: "image_generation", quality: "hd" },
    plan: "free",
    expectedQuality: "hd",
    expectedSearchKey: "hd",
  },
  {
    name: "case 2: 图片 plan_max @ free → hd（U-18：与套餐无关）",
    guard: { jobType: "image_generation", quality: "plan_max" },
    plan: "free",
    expectedQuality: "hd",
    expectedSearchKey: "hd",
  },
  {
    name: "case 3: 图片 plan_max @ pro → pro 的 maxResolution（hd）",
    guard: { jobType: "image_generation", quality: "plan_max" },
    plan: "pro",
    expectedQuality: "hd",
    expectedSearchKey: "hd",
  },
  {
    name: "case 4: 视频 1080p → 档位 1080p，effectiveQuality 为 null",
    guard: { jobType: "video_generation", resolution: "1080p" },
    plan: "pro",
    expectedQuality: null,
    expectedSearchKey: "1080p",
  },
  {
    name: "case 5: 视频没给 resolution → 档位 unspecified，effectiveQuality 为 null",
    guard: { jobType: "video_generation" },
    plan: "pro",
    expectedQuality: null,
    expectedSearchKey: UNSPECIFIED_RESOLUTION,
  },
];

describe("billingSearchKey", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const result = billingSearchKey(testCase.guard, testCase.plan);

      expect(result.searchKey).toBe(testCase.expectedSearchKey);
      expect(result.effectiveQuality).toBe(testCase.expectedQuality);
    });
  }

  it("case 6: 视频档位里没有 unknown 这种兜底名 —— 缺省就是 unspecified", () => {
    // 询价接口一旦把「没给 resolution」错写成 `"unknown"`，视频就会命中一个不存在
    // 的档位、退回默认行，报价看起来仍然成功。这里钉住那个取值。
    expect(UNSPECIFIED_RESOLUTION).toBe("unspecified");
  });

  // BL-40 / U-18（2026-10-22 用户决定）：界面不再出现订阅档位，请求没指定画质时
  // 一律按 hd 计价。下面两条钉住「与套餐无关」这件事 —— 逐套餐跑一遍，任何一个
  // 套餐推出别的档位都会红。
  it("U-18: plan_max is hd on every plan", () => {
    expect(DEFAULT_IMAGE_QUALITY).toBe("hd");

    for (const plan of Object.keys(PLAN_CONFIGS) as SubscriptionPlan[]) {
      const result = billingSearchKey(
        { jobType: "image_generation", quality: "plan_max" },
        plan,
      );

      expect(`${plan}:${result.searchKey}`).toBe(`${plan}:hd`);
      expect(result.effectiveQuality).toBe("hd");
    }
  });

  it("U-18: an explicit quality is still used as given", () => {
    for (const quality of ["standard", "ultra"] as ImageQualityLevel[]) {
      const result = billingSearchKey(
        { jobType: "image_generation", quality },
        "free",
      );

      expect(result.searchKey).toBe(quality);
      expect(result.effectiveQuality).toBe(quality);
    }
  });
});
