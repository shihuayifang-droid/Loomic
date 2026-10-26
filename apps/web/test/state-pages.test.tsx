import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import NotFound from "../src/app/not-found";
import { EmptyState } from "../src/components/states/empty-state";
import {
  PENDING_REVIEW_DESCRIPTION,
  PENDING_REVIEW_TITLE,
  PendingReviewState,
  REJECTED_DESCRIPTION,
  REJECTED_TITLE,
  RejectedState,
  StatePage,
} from "../src/components/states/state-page";

/**
 * 工单 45DP · BR-13 状态页与空状态骨架的验收测试。
 *
 * 三条主线：
 *   1) 404 页：渲染标题，插画位只有那个带 testid 的占位框，**没有别的图片**；
 *   2) 待审核页 / 被拒绝页：文案分别正确（文案常量由 `state-page.tsx` 导出，
 *      断言的也是同一份常量，避免测试和实现各写一套措辞）；
 *   3) `EmptyState`：无数据时渲染标题，有数据时不渲染。
 */

const PLACEHOLDER_TESTID = "state-illustration-placeholder";

// 本仓 vitest 没开 globals，@testing-library 的自动 cleanup 不会注册，
// 所以逐个用例清 DOM —— 不清的话上一个用例的 404 页会留在下一个用例的 container 里。
afterEach(() => {
  cleanup();
});

describe("BR-13 状态页骨架", () => {
  it("404 页渲染出标题，且除占位框外没有任何图片", () => {
    const { container } = render(<NotFound />);

    const heading = container.querySelector("h1");
    expect(heading, "404 页必须有一个 h1 标题").toBeTruthy();
    expect(heading?.textContent ?? "").toContain("404");
    expect(heading?.textContent ?? "").toContain("页面不存在");

    // 插画位：恰好一个占位框，且它带约定的 testid
    expect(screen.getByTestId(PLACEHOLDER_TESTID)).toBeTruthy();

    // 「没有出现占位框以外的图片」：img / picture / svg 图片 / role=img 一律不许有
    const images = container.querySelectorAll("img, picture, image, svg, [role='img']");
    expect(images, `404 页不该出现图片元素：${images.length} 个`).toHaveLength(0);

    // 唯一的动作：回工作区
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/home");
  });

  it("待审核页的文案正确（标题 + 说明）", () => {
    const { container } = render(<PendingReviewState />);

    expect(container.querySelector("h1")?.textContent).toBe(PENDING_REVIEW_TITLE);
    expect(screen.getByText(PENDING_REVIEW_DESCRIPTION)).toBeTruthy();
    // 待审核页只解释「在等谁」，不解释「为什么被拒」
    expect(container.textContent ?? "").not.toContain(REJECTED_TITLE);
  });

  it("被拒绝页的文案正确（标题 + 说明）", () => {
    const { container } = render(<RejectedState />);

    expect(container.querySelector("h1")?.textContent).toBe(REJECTED_TITLE);
    expect(screen.getByText(REJECTED_DESCRIPTION)).toBeTruthy();
    expect(container.textContent ?? "").not.toContain(PENDING_REVIEW_TITLE);
  });

  it("StatePage 默认渲染一个带 testid 的插画占位框，传了 illustrationSlot 就换成真插画", () => {
    const { container, rerender } = render(<StatePage title="骨架自测" />);
    expect(screen.getByTestId(PLACEHOLDER_TESTID)).toBeTruthy();

    rerender(
      <StatePage title="骨架自测" illustrationSlot={<span data-testid="stub-illustration">插画</span>} />,
    );
    expect(screen.getByTestId("stub-illustration")).toBeTruthy();
    expect(screen.queryByTestId(PLACEHOLDER_TESTID)).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("骨架自测");
  });
});

describe("BR-13 统一空状态 EmptyState", () => {
  it("无数据（isEmpty）时渲染标题与说明", () => {
    render(<EmptyState isEmpty title="还没有参考图" description="拖入或点击上传" />);

    expect(screen.getByText("还没有参考图")).toBeTruthy();
    expect(screen.getByText("拖入或点击上传")).toBeTruthy();
  });

  it("有数据时整块不渲染", () => {
    const { container } = render(<EmptyState isEmpty={false} title="还没有参考图" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("还没有参考图")).toBeNull();
  });

  it("testId 透传到容器上，action 只在空状态里出现", () => {
    const { rerender } = render(
      <EmptyState
        isEmpty
        testId="ref-empty"
        title="还没有参考图，拖入或点击上传"
        action={<button type="button" data-testid="ref-empty-action">上传</button>}
      />,
    );

    expect(screen.getByTestId("ref-empty")).toBeTruthy();
    expect(screen.getByTestId("ref-empty-action")).toBeTruthy();

    rerender(
      <EmptyState
        isEmpty={false}
        testId="ref-empty"
        title="还没有参考图，拖入或点击上传"
        action={<button type="button" data-testid="ref-empty-action">上传</button>}
      />,
    );
    expect(screen.queryByTestId("ref-empty")).toBeNull();
    expect(screen.queryByTestId("ref-empty-action")).toBeNull();
  });
});
