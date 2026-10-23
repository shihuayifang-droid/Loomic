"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import { ForcePasswordChange } from "./auth/force-password-change";
import { errorCodeOf, lookupError } from "../lib/error-catalog";
import { fetchViewer } from "../lib/server-api";
import { authProvider, signIn as selfSignIn } from "../lib/self-auth-client";
import { getSupabaseBrowserClient } from "../lib/supabase-browser";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
} as any;

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
} as any;

interface LoginFormProps {
  initialErrorMessage?: string | null;
}

export function LoginForm({ initialErrorMessage = null }: LoginFormProps) {
  const router = useRouter();
  // Read per render (never at module scope): the provider is a build-time env
  // value, but a module-level snapshot would also freeze a stubbed value in tests.
  const selfMode = authProvider() === "self";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Self-hosted auth has no magic link, so the password form is the only mode.
  const [mode, setMode] = useState<"magic" | "password">(
    selfMode ? "password" : "magic",
  );
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(initialErrorMessage);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  async function bootstrapWorkspace(accessToken: string) {
    try {
      await fetchViewer(accessToken);
      router.replace("/home");
    } catch {
      setError("Could not load your workspace. Please try again.");
    }
  }

  async function handleMagicLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    setLoading(false);
    if (authError) {
      setError(authError.message);
    } else {
      setSent(true);
    }
  }

  async function handlePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    setLoading(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: trimmed,
      password,
    });

    if (authError) {
      setLoading(false);
      setError(authError.message);
    } else {
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setLoading(false);
        setError("Could not finish signing in. Please try again.");
        return;
      }

      await bootstrapWorkspace(accessToken);
      setLoading(false);
    }
  }

  /** 42G: self-hosted sign-in, with the forced password change in the middle. */
  async function handleSelfPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !password) return;
    setLoading(true);
    setError(null);

    try {
      const session = await selfSignIn(trimmed, password);
      if (session.user.must_change_password) {
        // Stay on this screen, but show the new-password step instead.
        setMustChangePassword(true);
        return;
      }
      await bootstrapWorkspace(session.access_token);
    } catch (err) {
      setError(lookupError(errorCodeOf(err)).message);
    } finally {
      setLoading(false);
    }
  }

  /**
   * 42G: the server revokes every session when the password changes, so the
   * temporary one is dead — sign in again with the new password before
   * bootstrapping the workspace.
   */
  async function handlePasswordChanged(newPassword: string) {
    const trimmed = email.trim();
    setPassword(newPassword);
    setLoading(true);
    setError(null);

    try {
      const session = await selfSignIn(trimmed, newPassword);
      setMustChangePassword(false);
      await bootstrapWorkspace(session.access_token);
    } catch (err) {
      setMustChangePassword(false);
      setError(lookupError(errorCodeOf(err)).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (authError) {
      setError(authError.message);
    }
  }

  if (selfMode && mustChangePassword) {
    return (
      <div className="w-full max-w-sm">
        <ForcePasswordChange
          currentPassword={password}
          onDone={handlePasswordChanged}
        />
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <AnimatePresence mode="wait">
        {sent ? (
          <motion.div
            key="sent"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="flex flex-col items-center gap-4 text-center"
          >
            {/* Checkmark circle */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 15 }}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-foreground"
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-background" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <motion.path
                  d="M5 13l4 4L19 7"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ delay: 0.5, duration: 0.4, ease: "easeOut" }}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </motion.div>
            <h2 className="text-lg font-semibold">Check your email</h2>
            <p className="text-sm text-muted-foreground">
              We sent a login link to <strong>{email}</strong>
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            variants={stagger}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
            className="space-y-6"
          >
            <motion.div variants={fadeIn} className="space-y-2 text-center">
              <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
              <p className="text-sm text-muted-foreground">
                Sign in to your workspace
              </p>
            </motion.div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  role="alert"
                  aria-live="polite"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.form
              variants={fadeIn}
              onSubmit={
                selfMode
                  ? handleSelfPassword
                  : mode === "password"
                    ? handlePassword
                    : handleMagicLink
              }
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {(selfMode || mode === "password") && (
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
              )}
              <Button data-testid="account-login-submit" type="submit" className="w-full" disabled={loading}>
                {loading
                  ? selfMode || mode === "password" ? "Signing in..." : "Sending..."
                  : selfMode || mode === "password" ? "Sign in" : "Send login link"}
              </Button>
              {!selfMode && (
                <button data-testid="account-login-mode-toggle"
                  type="button"
                  onClick={() => {
                    setMode(mode === "password" ? "magic" : "password");
                    setError(null);
                  }}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {mode === "password" ? "Use login link instead" : "Use password instead"}
                </button>
              )}
            </motion.form>

            {!selfMode && (
              <>
                <motion.div variants={fadeIn} className="flex items-center gap-4">
                  <Separator className="flex-1" />
                  <span className="text-xs text-muted-foreground uppercase">or</span>
                  <Separator className="flex-1" />
                </motion.div>

                <motion.div variants={fadeIn}>
                  <Button data-testid="account-login-google"
                    variant="outline"
                    className="w-full"
                    onClick={handleGoogle}
                    type="button"
                  >
                    Continue with Google
                  </Button>
                </motion.div>
              </>
            )}

            <motion.p variants={fadeIn} className="text-center text-sm text-muted-foreground">
              Need an account?{" "}
              <Link href="/register" className="font-medium text-foreground underline underline-offset-4">
                Create one
              </Link>
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
