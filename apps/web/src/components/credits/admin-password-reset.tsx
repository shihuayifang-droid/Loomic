// @credits-system — 42H: the admin panel that mints a one-time temporary
// password for a member who forgot theirs. Phase 1 has no reset mail, so the
// admin resets it here and hands the password over in person.
"use client";

import { useState } from "react";

import { resetMemberPassword } from "@/lib/admin-auth-api";
import { errorCodeOf, lookupError } from "@/lib/error-catalog";

export type AdminPasswordResetProps = {
  /** The admin's own access token; the route refuses a non-admin with 403. */
  accessToken: string;
};

type ResetResult = { email: string; temporaryPassword: string };

const HAS_CHINESE = /[\u4e00-\u9fff]/;

/**
 * The server's sentence wins when it is Chinese (404 says 「该邮箱没有账号」,
 * which is more precise than the code's catalogue line), otherwise the
 * catalogue's wording for the code is used — an English upstream message would
 * leak into a Chinese panel.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && HAS_CHINESE.test(error.message)) {
    return error.message;
  }
  return lookupError(errorCodeOf(error)).message;
}

export function AdminPasswordReset({ accessToken }: AdminPasswordResetProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const target = email.trim();
  const canSubmit = target.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const minted = await resetMemberPassword(accessToken, target);
      setResult(minted);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    try {
      await clipboard.writeText(result.temporaryPassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  /** Closing forgets the password: it is shown once and never fetched again. */
  function handleDismiss() {
    setResult(null);
    setEmail("");
    setError(null);
    setCopied(false);
  }

  return (
    <div data-testid="credits-admin-reset" className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">重置成员密码</h3>
      <p className="text-xs text-muted-foreground">
        成员忘记密码时，在这里生成一个临时密码，发给本人；对方登录后需要设置新密码
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          成员邮箱
          <input
            data-testid="credits-admin-reset-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="member@example.com"
            className="w-64 rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <button
          data-testid="credits-admin-reset-submit"
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
        >
          {submitting ? "生成中..." : "重置密码"}
        </button>
      </div>

      {error ? (
        <p data-testid="credits-admin-reset-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {result ? (
        <div
          data-testid="credits-admin-reset-result"
          className="space-y-2 rounded-md border border-dashed p-3"
        >
          <p className="text-sm">{result.email} 的临时密码：</p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              data-testid="credits-admin-reset-password"
              className="rounded bg-secondary px-2 py-1 font-mono text-sm"
            >
              {result.temporaryPassword}
            </code>
            <button
              data-testid="credits-admin-reset-copy"
              type="button"
              onClick={() => void handleCopy()}
              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
            >
              {copied ? "已复制" : "复制"}
            </button>
            <button
              data-testid="credits-admin-reset-dismiss"
              type="button"
              onClick={handleDismiss}
              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
            >
              关闭
            </button>
          </div>
          <p className="text-xs text-muted-foreground">只显示这一次，关闭后无法再查看</p>
        </div>
      ) : null}
    </div>
  );
}
