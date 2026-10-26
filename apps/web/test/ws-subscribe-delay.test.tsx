// @vitest-environment jsdom

/**
 * 工单45DF · QA-11 前端故障注入 #1：WS 订阅迟迟不返回。
 *
 * 注入方式：`ws.startRun` 收下 ack 回调后**永不回 ack**（订阅悬着），
 * 用 fake timer 推进时间，不做真实等待。
 *
 * 断言两条：
 *   1. 订阅悬着时界面停在**明确的等待态**（可见的等待/重连文案），
 *      既不是空白，也没有出现任何"已就绪/已连接"的假就绪文案。
 *   2. 等到 10s ack 超时（src/components/chat-sidebar.tsx 的 timeout）之后，
 *      界面给出用户能看见的失败提示，而不是一直转圈。
 *
 * 这里不断言"没崩"。等待态与超时提示都按可见文案取。
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketHandle } from "../src/hooks/use-websocket";
import { ChatSidebar } from "../src/components/chat-sidebar";
import { TierLimitToastProvider } from "../src/components/credits/tier-limit-toast";
import { ToastProvider } from "../src/components/toast";

const {
  createSessionMock,
  deleteSessionMock,
  fetchImageModelsMock,
  fetchMessagesMock,
  fetchModelsMock,
  fetchSessionsMock,
  fetchWorkspaceSkillsMock,
  saveMessageMock,
  updateSessionTitleMock,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  deleteSessionMock: vi.fn(),
  fetchImageModelsMock: vi.fn(),
  fetchMessagesMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  fetchSessionsMock: vi.fn(),
  fetchWorkspaceSkillsMock: vi.fn(),
  saveMessageMock: vi.fn(),
  updateSessionTitleMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  createSession: createSessionMock,
  deleteSession: deleteSessionMock,
  fetchImageModels: fetchImageModelsMock,
  fetchMessages: fetchMessagesMock,
  fetchModels: fetchModelsMock,
  fetchSessions: fetchSessionsMock,
  fetchWorkspaceSkills: fetchWorkspaceSkillsMock,
  saveMessage: saveMessageMock,
  updateSessionTitle: updateSessionTitleMock,
}));

/** chat-sidebar 在 10s 没有收到 agent.run 的 ack 时写进消息里的失败文案。 */
const ACK_TIMEOUT_COPY = "Failed to get response.";

/** 订阅悬着时界面上的等待态文案（chat-sidebar 的 disconnected banner）。 */
const WAITING_COPY = /连接已断开，正在重连/;

/** 任何"已经好了"的假就绪文案都不该在等待期间出现。 */
const FAKE_READY_COPY = /已就绪|已连接|连接正常|Connection established/;

/**
 * `ack` = "never" 时：订阅迟迟不返回（回调收下，永不调用）。
 * `ack` = "now"   时：立刻 ack，作为对照。
 */
function createWs(
  connected: boolean,
  ack: "never" | "now",
): WebSocketHandle {
  const startRun = vi.fn(
    (_payload: unknown, onAck?: (ack: any) => void) => {
      if (ack === "now") {
        onAck?.({
          type: "command.ack",
          action: "agent.run",
          payload: { runId: "run_delayed" },
        });
      }
    },
  );
  return {
    connected,
    startRun,
    cancelRun: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    registerRPC: vi.fn(() => () => {}),
    resumeCanvas: vi.fn(),
  };
}

function renderSidebar(ws: WebSocketHandle) {
  return render(
    <ToastProvider>
      <TierLimitToastProvider>
        <ChatSidebar
          accessToken="token_abc"
          canvasId="canvas-1"
          open
          onToggle={() => {}}
          ws={ws}
        />
      </TierLimitToastProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
    writable: true,
  });
  // sidebar 里挂载的组件会通过 matchMedia 读断点
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  fetchModelsMock.mockReset();
  fetchModelsMock.mockResolvedValue({ models: [] });
  fetchImageModelsMock.mockReset();
  fetchImageModelsMock.mockResolvedValue({ models: [] });
  fetchWorkspaceSkillsMock.mockReset();
  fetchWorkspaceSkillsMock.mockResolvedValue({ skills: [] });
  createSessionMock.mockReset();
  createSessionMock.mockResolvedValue({
    session: {
      id: "session-created",
      title: "New Chat",
      updatedAt: "2026-03-24T00:00:00.000Z",
    },
  });
  deleteSessionMock.mockReset();
  fetchMessagesMock.mockReset();
  fetchMessagesMock.mockResolvedValue({ messages: [] });
  fetchSessionsMock.mockReset();
  fetchSessionsMock.mockResolvedValue({
    sessions: [
      {
        id: "session-real",
        title: "Existing Chat",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    ],
  });
  saveMessageMock.mockReset();
  saveMessageMock.mockResolvedValue(undefined);
  updateSessionTitleMock.mockReset();
  updateSessionTitleMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("QA-11 故障注入：WS 订阅迟迟不返回", () => {
  it("订阅悬着时界面停在明确的等待态（不是空白，也没有假就绪）", async () => {
    const ws = createWs(false, "never");
    renderSidebar(ws);

    // 订阅还没建立：等待态必须看得见
    expect(await screen.findByText(WAITING_COPY)).toBeVisible();
    // 而且不能有任何"已经连上/已就绪"的假就绪文案
    expect(screen.queryByText(FAKE_READY_COPY)).toBeNull();

    // 进到对话区也不是空白页：composer 仍在，用户可以继续输入
    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const input = await screen.findByRole("textbox");
    await user.type(input, "hello loom");

    // 输入的内容留在界面上（空白页会连这行都没有）
    expect(screen.getByText("hello loom")).toBeVisible();
    // 等待态仍在，没有因为输入而被当成"已就绪"
    expect(screen.getByText(WAITING_COPY)).toBeVisible();
    expect(screen.queryByText(FAKE_READY_COPY)).toBeNull();
  });

  it("ack 迟迟不来 → 推到 10s 超时后给出可理解的失败提示", async () => {
    const ws = createWs(true, "never");
    renderSidebar(ws);

    const user = userEvent.setup({
      advanceTimers: (ms) => vi.advanceTimersByTime(ms),
    });
    const input = await screen.findByRole("textbox");
    await user.type(input, "hello loom{Enter}");

    // 订阅已经发出去了，但 ack 一直没回
    expect(ws.startRun).toHaveBeenCalledTimes(1);
    // 超时之前不报失败（否则就是把"慢"当成"坏"）
    expect(screen.queryByText(ACK_TIMEOUT_COPY)).toBeNull();

    // 把时钟推过 chat-sidebar 的 10s ack 超时
    await vi.advanceTimersByTimeAsync(10_500);

    expect(await screen.findByText(ACK_TIMEOUT_COPY)).toBeVisible();
  });
});
