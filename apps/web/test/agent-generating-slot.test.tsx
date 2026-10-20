import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { AgentGeneratingSlot } from "@/components/canvas/agent-generating-slot";
import { formatRetryLabel } from "@/lib/job-status";
import type { WebSocketHandle } from "@/hooks/use-websocket";

/**
 * 工单 35C T5：GN-30「可重试失败期间占位显示『重试中（2/3）』且不弹失败提示」。
 *
 * 这里只测画布那块生成中占位怎么读 `job.progress`：假 ws 把订阅者收进
 * `handlers`，用例手动推事件并包在 `act` 里（`globals` 未开启，见 vitest.config.ts，
 * 所以 RTL 的自动 cleanup 不会注册，必须自己 afterEach(cleanup)）。
 */

type ProgressEvent = {
  type: string;
  jobId: string;
  status: string;
  attempt?: number;
  maxAttempts?: number;
};

function makeWs() {
  const handlers: Array<(event: ProgressEvent) => void> = [];
  const onEvent = vi.fn((cb: (event: ProgressEvent) => void) => {
    handlers.push(cb);
    return () => {
      const index = handlers.indexOf(cb);
      if (index >= 0) handlers.splice(index, 1);
    };
  });
  /** 推一条事件给所有当前订阅者；状态更新必须包在 act 里 */
  const push = (event: ProgressEvent) => {
    act(() => {
      for (const handler of [...handlers]) handler(event);
    });
  };
  return { ws: { onEvent } as unknown as WebSocketHandle, handlers, push, onEvent };
}

function renderSlot(props: {
  ws?: WebSocketHandle;
  jobId?: string;
  kind?: "image" | "video";
}) {
  return render(
    <AgentGeneratingSlot
      {...(props.ws !== undefined ? { ws: props.ws } : {})}
      {...(props.jobId !== undefined ? { jobId: props.jobId } : {})}
      kind={props.kind ?? "image"}
      width={512}
      height={512}
    />,
  );
}

afterEach(cleanup);

describe("GN-30 canvas generating slot", () => {
  it("GN-30: a retrying job reads 重试中（2/3）", () => {
    const { ws, push } = makeWs();
    renderSlot({ ws, jobId: "job-1" });

    push({
      type: "job.progress",
      jobId: "job-1",
      status: "retrying",
      attempt: 2,
      maxAttempts: 3,
    });

    const label = formatRetryLabel(2, 3);
    const node = screen.getByTestId("canvas-generation-status");
    expect(node).toHaveTextContent(label);
    // 规格文案：字面量断言，不靠 formatRetryLabel 自己证明自己
    expect(label).toContain("2/3");
    expect(label).toContain("重试中");
    expect(node.textContent).toContain("重试中");
    expect(node.textContent).toContain("2/3");
  });

  it("GN-30: events of another job are ignored", () => {
    const { ws, push } = makeWs();
    renderSlot({ ws, jobId: "job-1" });

    push({
      type: "job.progress",
      jobId: "job-2",
      status: "retrying",
      attempt: 2,
      maxAttempts: 3,
    });

    expect(screen.getByTestId("canvas-generation-status")).toHaveTextContent(
      "图片生成中...",
    );
  });

  it("GN-30: back to running restores the default text", () => {
    const { ws, push } = makeWs();
    renderSlot({ ws, jobId: "job-1" });

    push({
      type: "job.progress",
      jobId: "job-1",
      status: "retrying",
      attempt: 2,
      maxAttempts: 3,
    });
    expect(screen.getByTestId("canvas-generation-status")).toHaveTextContent(
      formatRetryLabel(2, 3),
    );

    push({ type: "job.progress", jobId: "job-1", status: "running" });
    expect(screen.getByTestId("canvas-generation-status")).toHaveTextContent(
      "图片生成中...",
    );
    expect(
      screen.getByTestId("canvas-generation-status").getAttribute("data-state"),
    ).toBe("default");
  });

  it("GN-30: queued reads 排队中", () => {
    const { ws, push } = makeWs();
    renderSlot({ ws, jobId: "job-1" });

    push({ type: "job.progress", jobId: "job-1", status: "queued" });

    expect(screen.getByTestId("canvas-generation-status")).toHaveTextContent(
      "排队中",
    );
  });

  it("GN-30: without a job id nothing is subscribed", () => {
    const { ws, onEvent, handlers } = makeWs();
    renderSlot({ ws });

    expect(onEvent).toHaveBeenCalledTimes(0);
    expect(handlers).toHaveLength(0);
    expect(screen.getByTestId("canvas-generation-status")).toHaveTextContent(
      "图片生成中...",
    );
  });
});
