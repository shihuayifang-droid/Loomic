import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TYPICAL_SECONDS,
  elapsedHint,
  GenerationShimmer,
} from "@/components/media/generation-shimmer";

/**
 * 工单36V · GN-02 ⑥：预估耗时是「按类型的典型值」，超过它占位要说「比预期慢」，
 * 不能说「即将完成」（任务已经慢了，不能暗示快好了）。
 *
 * `globals` 未开启（见 vitest.config.ts），RTL 的自动 cleanup 不会注册，必须自己
 * afterEach(cleanup)。
 */

afterEach(cleanup);

describe("GN-02 elapsed hint", () => {
  it("GN-02: within the estimate it says how long is left", () => {
    expect(elapsedHint(20, 60)).toBe("约剩 40s");
  });

  it("GN-02: past the estimate it says the job is slower than expected", () => {
    expect(elapsedHint(61, 60)).toBe("比预期慢");
  });

  it("GN-02: exactly at the estimate is still on time", () => {
    expect(elapsedHint(60, 60)).toBe("约剩 0s");
  });

  it("GN-02: a slow generating slot shows the slow hint", () => {
    render(
      <GenerationShimmer
        kind="image"
        startedAt={Date.now() - 61_000}
        width={200}
        height={200}
      />,
    );

    const hint = screen.getByTestId("canvas-generation-elapsed-hint");
    expect(hint).toHaveTextContent("比预期慢");
    expect(hint.getAttribute("data-state")).toBe("slow");
    // 阈值来自导出的典型值：改 TYPICAL_SECONDS 时这条会一起动
    expect(TYPICAL_SECONDS.image).toBe(60);
  });
});
