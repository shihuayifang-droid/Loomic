import { describe, expect, it } from "vitest";

import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG } from "./model-catalog.js";

// BL-14 第 1 条 / 工单 31C：价格只存在价目表（`pricing_rules`）里，代码里不留价格常量。
//
// 这里原本是视频估价函数的那组用例。函数和成本表已随本单删除（价格改由运行时
// 询价），所以这组用例无处可测；文件不能空着（空的测试文件 vitest 会报
// "No test suite found"），于是把它换成一条守得住的门禁：catalog 里不许再出现价格字段。
describe("model catalog", () => {
  it("carries no price field on any entry", () => {
    const entries = [
      ...Object.values(IMAGE_MODEL_CATALOG),
      ...Object.values(VIDEO_MODEL_CATALOG),
    ];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain("cost");
    }
  });
});
