"use client";

import { useEffect, useState, type ReactNode } from "react";

import { LoadingScreen } from "@/components/loading-screen";
import { PendingReviewState } from "@/components/states/state-page";
import { useAuth } from "@/lib/auth-context";
import { fetchViewer } from "@/lib/server-api";

/**
 * AD-00 / T-85 -- team-membership gate for the workspace shell.
 *
 * Admission is team membership: an account that is signed in but not yet a
 * member of a team sees a single waiting page and nothing else (no sidebar, no
 * credits button, no page content).
 *
 * Only an explicit `teamMembership === null` from `GET /api/viewer` counts as
 * "waiting": an older server that predates the field (undefined) and a failed
 * read both fall back to `allowed`, because the authoritative gate lives on
 * the server (403 `not_team_member`), and a frontend hiccup must never lock a
 * real member out of the product.
 */
type GateState = "checking" | "pending" | "allowed";

export function AccessGate({ children }: { children: ReactNode }) {
  const { session, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    if (!accessToken) {
      // No session yet -- the layout's own login guard owns this case.
      setState("allowed");
      return;
    }

    let cancelled = false;
    setState("checking");

    fetchViewer(accessToken)
      .then((viewer) => {
        if (cancelled) return;
        setState(viewer.teamMembership === null ? "pending" : "allowed");
      })
      .catch(() => {
        if (cancelled) return;
        setState("allowed");
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  if (state === "checking") {
    return <LoadingScreen />;
  }

  if (state === "pending") {
    return (
      <PendingReviewState
        titleTestId="account-pending-title"
        action={
          <button
            type="button"
            data-testid="account-pending-signout"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              void signOut();
            }}
          >
            退出登录
          </button>
        }
      />
    );
  }

  return <>{children}</>;
}
