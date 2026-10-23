"use client";

/**
 * AG-10 / 工单40N: the confirmation card the chat panel shows when the Agent
 * wants to spend more than the confirmation threshold on one generation.
 *
 * WHY A CARD AND NOT A TOAST
 * The server stopped the run before creating or charging anything, so nothing
 * happened yet — the user is being ASKED, not told. A toast would disappear
 * with the answer still missing, and the run would look like it just stopped.
 * The sentence is the server's own (`billing.error.message`), so the numbers on
 * the buttons and in the sentence can never disagree.
 *
 * The component is deliberately dumb: it renders what the caller hands it and
 * reports clicks. The submit lives in `use-generation-confirmation.ts`, which is
 * testable without mounting the whole sidebar.
 */
export type GenerationConfirmCardProps = {
  /** The server's own sentence: 「将用 … 生成 N 张 …，消耗 M 分」. */
  message: string;
  /** The same M the sentence carries — it is what the OK button promises. */
  creditsCost: number;
  /** A submit is in flight: both buttons are disabled so it cannot be doubled. */
  submitting: boolean;
  /** The submit failed; the card stays so the user can retry or cancel. */
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function GenerationConfirmCard({
  message,
  creditsCost,
  submitting,
  error,
  onConfirm,
  onCancel,
}: GenerationConfirmCardProps) {
  return (
    <div
      data-testid="chat-confirm-card"
      className="mx-1 mb-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm"
    >
      <p className="whitespace-pre-wrap text-foreground">{message}</p>
      {error ? (
        <p
          data-testid="chat-confirm-card-error"
          className="mt-2 text-xs text-red-500"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-testid="chat-confirm-card-ok"
          onClick={onConfirm}
          disabled={submitting}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          确认生成 · {creditsCost}
        </button>
        <button
          type="button"
          data-testid="chat-confirm-card-cancel"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}
