"use client";

import { useEffect } from "react";

import { getServerBaseUrl } from "../lib/env";

/**
 * LOCAL FORK — development only.
 *
 * Forwards browser-side failures to the server log so a single log tail shows
 * both sides. Without this, the only record of a client error is the red box in
 * the corner of the screen, which no tooling can read.
 *
 * Captures three sources, because they are genuinely different:
 *  - console.error  — how most of this app reports handled failures
 *                     (e.g. "[canvas-editor] save failed"). These never become
 *                     exceptions, so an error listener alone would miss them.
 *  - "error" event  — uncaught synchronous exceptions.
 *  - "unhandledrejection" — rejected promises with no .catch, which a
 *                     surrounding try/catch cannot see.
 */

const FLUSH_DELAY_MS = 400;
/** Hard cap per flush; the server caps again on its side. */
const MAX_BATCH = 20;

type Entry = {
  kind: string;
  message: string;
  stack?: string;
  url: string;
};

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    const out: { message: string; stack?: string } = {
      message: `${value.name}: ${value.message}`,
    };
    if (value.stack) out.stack = value.stack;
    return out;
  }
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}

export function DevErrorReporter() {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    let queue: Entry[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Guards against the obvious infinite loop: reporting a failure must never
    // itself produce a reportable failure.
    let reporting = false;

    const flush = () => {
      timer = null;
      if (queue.length === 0 || reporting) return;
      const entries = queue.slice(0, MAX_BATCH);
      queue = [];
      reporting = true;
      // Deliberately native fetch + .catch: if the sink is down we drop the
      // batch silently rather than logging about the logger.
      fetch(`${getServerBaseUrl()}/api/dev/client-errors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      })
        .catch(() => {})
        .finally(() => {
          reporting = false;
        });
    };

    const push = (kind: string, value: unknown) => {
      if (reporting) return;
      const { message, stack } = describe(value);
      if (!message) return;
      const entry: Entry = { kind, message, url: window.location.pathname };
      if (stack) entry.stack = stack;
      queue.push(entry);
      if (queue.length > MAX_BATCH * 2) queue = queue.slice(-MAX_BATCH);
      if (timer === null) timer = setTimeout(flush, FLUSH_DELAY_MS);
    };

    const onError = (event: ErrorEvent) => {
      push("uncaught", event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      push("unhandled-rejection", event.reason);
    };

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      originalConsoleError.apply(console, args as []);
      // Prefer the first Error argument for a usable stack; otherwise join the
      // parts the way the console displays them.
      const errorArg = args.find((a) => a instanceof Error);
      push(
        "console.error",
        errorArg ??
          args
            .map((a) => describe(a).message)
            .filter(Boolean)
            .join(" "),
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = originalConsoleError;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  return null;
}
