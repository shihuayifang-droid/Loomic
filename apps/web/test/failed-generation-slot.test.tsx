import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { FailedGenerationSlot } from "@/components/media/failed-generation-slot";

/**
 * 工单 34K T3：GN-19 / CV-02 的失败占位。
 * 服务端在任务失败/超时后把元素改写成 `failed: true` + `failureMessage`，
 * 画布据此渲染这块占位；这里只验组件本身（与生成中占位可区分、原因可见、可删除、尺寸跟随元素）。
 *
 * `globals` 未开启（见 vitest.config.ts），所以 RTL 的自动 cleanup 不会注册，
 * 必须自己 afterEach(cleanup)，否则多次 render 之后 getByTestId 会撞到多个节点。
 */

afterEach(cleanup);

describe("GN-19 failed generation slot", () => {
  it("GN-19: a failed slot shows 生成失败 and the server's reason", () => {
    render(
      <FailedGenerationSlot
        kind="image"
        message="图片生成失败，请重试"
        width={512}
        height={512}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByTestId("canvas-failed-slot-message")).toHaveTextContent(
      /^图片生成失败，请重试$/,
    );
  });

  it("GN-19: the failed slot is visibly different from a generating one", () => {
    render(
      <FailedGenerationSlot
        kind="image"
        message="图片生成失败，请重试"
        width={512}
        height={512}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByTestId("canvas-failed-slot").className).toContain(
      "border-destructive",
    );
  });

  it("GN-19: 删除 calls onDelete once", () => {
    const onDelete = vi.fn();
    render(
      <FailedGenerationSlot
        kind="video"
        message="视频生成失败，请重试"
        width={640}
        height={360}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(screen.getByTestId("canvas-failed-slot-delete"));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("GN-19: the slot keeps the element's size", () => {
    render(
      <FailedGenerationSlot
        kind="image"
        message="图片生成失败，请重试"
        width={640}
        height={360}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByTestId("canvas-failed-slot")).toHaveStyle({
      width: "640px",
      height: "360px",
    });
  });
});
