"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { errorCodeOf, lookupError } from "../../lib/error-catalog";
import { changePassword as selfChangePassword } from "../../lib/self-auth-client";

const mismatchMessage = "两次输入的密码不一致";

interface ForcePasswordChangeProps {
  /** The temporary password the user just signed in with. */
  currentPassword: string;
  /** Hands the new password back so the caller can sign in again with it. */
  onDone: (newPassword: string) => void;
}

/**
 * 42G: the step between "signed in" and "inside the app" for a user whose
 * password was reset by an administrator. It only talks to the self-hosted
 * auth client; the caller owns what happens after `onDone`.
 */
export function ForcePasswordChange({
  currentPassword,
  onDone,
}: ForcePasswordChangeProps) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newPassword) return;
    if (newPassword !== confirmPassword) {
      setError(mismatchMessage);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await selfChangePassword(currentPassword, newPassword);
      onDone(newPassword);
    } catch (err) {
      setError(lookupError(errorCodeOf(err)).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="space-y-6"
    >
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">请设置新密码</h2>
        <p className="text-sm text-muted-foreground">
          管理员已为你重置密码，请设置一个新密码后重新登录
        </p>
      </div>

      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden text-center text-sm text-destructive"
            role="alert"
            data-testid="account-force-change-error"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <motion.form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="force-change-new">新密码</Label>
          <Input
            id="force-change-new"
            data-testid="account-force-change-new"
            type="password"
            placeholder="••••••••"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="force-change-confirm">再次输入</Label>
          <Input
            id="force-change-confirm"
            data-testid="account-force-change-confirm"
            type="password"
            placeholder="••••••••"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
        <Button
          data-testid="account-force-change-submit"
          type="submit"
          className="w-full"
          disabled={loading}
        >
          {loading ? "提交中..." : "设置新密码"}
        </Button>
      </motion.form>
    </motion.div>
  );
}
