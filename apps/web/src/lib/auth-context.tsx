"use client";

import type { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import * as selfAuth from "./self-auth-client";
import type { SelfSession } from "./self-auth-client";
import { getSupabaseBrowserClient } from "./supabase-browser";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 42F: the provider is fixed at build time (`NEXT_PUBLIC_*`), so the branch
    // is constant for a given bundle. Unset means Supabase, unchanged.
    if (selfAuth.authProvider() === "self") {
      const apply = (next: SelfSession | null) => {
        // The self-hosted session is handed out as a Supabase `Session` on
        // purpose: every call site reads only `access_token`, `user.id`,
        // `user.email` and `user.user_metadata`, and a provider switch must not
        // touch them. The cast is the price of not widening the context type,
        // which would push `User | SelfUser` into ~40 consumers that read
        // Supabase-only fields (`avatar_url`, ...).
        const asSession = next as unknown as Session | null;
        setSession(asSession);
        setUser(asSession?.user ?? null);
        setLoading(false);
      };

      apply(selfAuth.getSession());
      return selfAuth.onChange(apply);
    }

    const supabase = getSupabaseBrowserClient();

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setUser(newSession?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    if (selfAuth.authProvider() === "self") {
      await selfAuth.signOut();
      setSession(null);
      setUser(null);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
