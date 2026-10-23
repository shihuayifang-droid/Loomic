import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { GenerationConfirmCard } from "../src/components/chat/generation-confirm-card";

/**
 * AG-10 / 工单40N：确认卡本身只做三件事 —— 原文照念服务端那句话、把价钱写在
 * 按钮上、把点击报给调用方。提交在 `use-generation-confirmation` 里，这里不测。
 */

const MESSAGE = "将用 model-x 生成 4 张 4K（16:9），消耗 60 分";

function renderCard(overrides?: {
  submitting?: boolean;
  error?: string | null;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  return render(
    <GenerationConfirmCard
      message={MESSAGE}
      creditsCost={60}
      submitting={overrides?.submitting ?? false}
      error={overrides?.error ?? null}
      onConfirm={overrides?.onConfirm ?? (() => {})}
      onCancel={overrides?.onCancel ?? (() => {})}
    />,
  );
}

afterEach(cleanup);

describe("GenerationConfirmCard (AG-10)", () => {
  it("AG-10: shows the server sentence verbatim and prices the OK button", () => {
    renderCard();

    expect(screen.getByTestId("chat-confirm-card")).toBeInTheDocument();
    expect(screen.getByTestId("chat-confirm-card").textContent).toContain(
      MESSAGE,
    );
    // 文案逐字：不是「确认」，也不是「确认生成」，价钱就在按钮上。
    expect(screen.getByTestId("chat-confirm-card-ok").textContent).toBe(
      "确认生成 · 60",
    );
    expect(screen.getByTestId("chat-confirm-card-cancel").textContent).toBe(
      "取消",
    );
  });

  it("AG-10: cancel answers the question and never confirms", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderCard({ onConfirm, onCancel });

    fireEvent.click(screen.getByTestId("chat-confirm-card-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(0);
  });

  it("AG-10: both buttons are disabled while the submit is in flight", () => {
    renderCard({ submitting: true });

    expect(screen.getByTestId("chat-confirm-card-ok")).toBeDisabled();
    expect(screen.getByTestId("chat-confirm-card-cancel")).toBeDisabled();
  });

  it("AG-10: a failed submit shows its error and keeps the card", () => {
    renderCard({ error: "credit pool exhausted" });

    expect(screen.getByTestId("chat-confirm-card")).toBeInTheDocument();
    expect(screen.getByTestId("chat-confirm-card-error").textContent).toContain(
      "credit pool exhausted",
    );
  });
});
