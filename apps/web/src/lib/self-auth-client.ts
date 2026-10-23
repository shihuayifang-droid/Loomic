/**
 * 42F: the self-hosted auth client (`NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self`).
 *
 * A plain module — no React — so both the React provider (`auth-context`) and
 * `server-api`'s 401 retry can share one session and one in-flight refresh.
 * With the switch unset (the default) nothing here runs: the app keeps talking
 * to Supabase exactly as before.
 *
 * The session it hands out is shaped like Supabase's on purpose. `access_token`
 * / `user.id` / `user.email` / `user.user_metadata` are read by ~40 call sites,
 * and choosing a provider must not touch any of them.
 */
import { getServerBaseUrl } from "./env";
import { ApiApplicationError } from "./server-api";

/** localStorage key the session lives under (the token itself: see T-124). */
export const SELF_AUTH_STORAGE_KEY = "hahart.auth.session";

export type SelfUser = {
  id: string;
  email: string;
  user_metadata: { full_name?: string };
  must_change_password: boolean;
};

export type SelfSession = {
  /** Bearer token for our own API. */
  access_token: string;
  /** Seconds since the epoch. */
  expires_at: number;
  refresh_token: string;
  user: SelfUser;
};

/**
 * What actually sits in localStorage: the public session plus the refresh
 * expiry, which the client needs to expire the session locally without asking
 * the server (an expired refresh token cannot be rotated).
 */
type StoredSession = SelfSession & { refresh_expires_at: number };

/** 200/201 body of `/api/auth/sign-in`, `/sign-up`, `/refresh` (42D). */
type ServerSessionBody = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    mustChangePassword: boolean;
  };
};

/**
 * Which auth backend the browser build talks to. Only the exact value `"self"`
 * switches; anything else (unset, typo, `"oauth"`) stays on Supabase so a
 * misconfigured deployment degrades to the behaviour it had before 42F.
 */
export function authProvider(): "supabase" | "self" {
  // Must be referenced literally: the bundler only inlines a direct
  // `process.env.NEXT_PUBLIC_*` read (same constraint as env.ts).
  const configured = process.env.NEXT_PUBLIC_HAHART_AUTH_PROVIDER?.trim();
  return configured === "self" ? "self" : "supabase";
}

type Listener = (session: SelfSession | null) => void;

const listeners = new Set<Listener>();

/** Subscribe to session changes (sign-in, refresh, sign-out). Returns the unsubscribe. */
export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(session: SelfSession | null): void {
  for (const listener of [...listeners]) {
    listener(session);
  }
}

// --- storage ---

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage disabled (private mode / blocked): sign-in still works for the
    // current page, it just does not survive a reload.
    return null;
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.access_token !== "string") return false;
  if (typeof record.refresh_token !== "string") return false;
  if (typeof record.expires_at !== "number") return false;
  if (typeof record.refresh_expires_at !== "number") return false;
  const user = record.user;
  if (typeof user !== "object" || user === null) return false;
  const fields = user as Record<string, unknown>;
  return typeof fields.id === "string" && typeof fields.email === "string";
}

function readStored(): StoredSession | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(SELF_AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(session: StoredSession): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SELF_AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A quota error must not fail a login that the server already accepted.
  }
}

function clearStored(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(SELF_AUTH_STORAGE_KEY);
  } catch {
    // Same reason as writeStored: the in-memory session is already gone.
  }
}

// --- HTTP ---

function authUrl(path: string): string {
  return `${getServerBaseUrl()}${path}`;
}

function secondsOf(isoTimestamp: string): number {
  return Math.floor(Date.parse(isoTimestamp) / 1000);
}

function toStored(body: ServerSessionBody): StoredSession {
  const userMetadata: SelfUser["user_metadata"] = {};
  if (body.user.displayName) userMetadata.full_name = body.user.displayName;
  return {
    access_token: body.accessToken,
    expires_at: secondsOf(body.accessTokenExpiresAt),
    refresh_token: body.refreshToken,
    refresh_expires_at: secondsOf(body.refreshTokenExpiresAt),
    user: {
      id: body.user.id,
      email: body.user.email,
      user_metadata: userMetadata,
      must_change_password: body.user.mustChangePassword,
    },
  };
}

/**
 * The server's `{ error: { code, message } }` as an `ApiApplicationError`, so a
 * caller can branch on the code (`invalid_credentials`, `weak_password`, ...)
 * the way it already does for every other API call.
 */
async function toApplicationError(
  response: Response,
): Promise<ApiApplicationError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const code = body?.error?.code ?? "application_error";
  const message =
    body?.error?.message ?? `Request failed with status ${response.status}`;
  return new ApiApplicationError(code, message, response.status, body);
}

async function postAuth(
  path: string,
  payload: unknown,
  accessToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(authUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function acceptSession(response: Response): Promise<SelfSession> {
  if (!response.ok) throw await toApplicationError(response);
  const body = (await response.json()) as ServerSessionBody;
  const stored = toStored(body);
  writeStored(stored);
  notify(stored);
  return stored;
}

// --- public API ---

export async function signIn(
  email: string,
  password: string,
): Promise<SelfSession> {
  return acceptSession(await postAuth("/api/auth/sign-in", { email, password }));
}

export async function signUp(
  email: string,
  password: string,
  displayName?: string,
): Promise<SelfSession> {
  const payload = displayName
    ? { email, password, displayName }
    : { email, password };
  return acceptSession(await postAuth("/api/auth/sign-up", payload));
}

/** The stored session, or `null` when there is none or its refresh token is past expiry. */
export function getSession(): SelfSession | null {
  const stored = readStored();
  if (!stored) return null;
  if (stored.refresh_expires_at * 1000 <= Date.now()) {
    clearStored();
    return null;
  }
  return stored;
}

let pendingRefresh: Promise<SelfSession | null> | null = null;

/**
 * Rotate the refresh token and store the new session.
 *
 * Concurrent callers share one request: a page that fires several saves at once
 * after expiry would otherwise present the same refresh token several times,
 * which the server reads as replay and answers by revoking the whole family.
 */
export function refresh(): Promise<SelfSession | null> {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = runRefresh().finally(() => {
    pendingRefresh = null;
  });
  return pendingRefresh;
}

async function runRefresh(): Promise<SelfSession | null> {
  const stored = readStored();
  if (!stored) return null;

  const response = await postAuth("/api/auth/refresh", {
    refreshToken: stored.refresh_token,
  });
  if (response.status === 401) {
    // The refresh token is dead (expired, revoked, or already replayed): the
    // user has to sign in again, so the local copy goes too.
    clearStored();
    notify(null);
    return null;
  }
  return acceptSession(response);
}

/** Revoke the server session, then drop the local one whatever the server said. */
export async function signOut(): Promise<void> {
  const stored = readStored();
  try {
    if (stored) {
      await postAuth("/api/auth/sign-out", {
        refreshToken: stored.refresh_token,
      });
    }
  } catch {
    // A failed sign-out call must not leave the user half signed in locally.
  }
  clearStored();
  notify(null);
}

/**
 * Change the password of the signed-in user (42E: 204 on success).
 *
 * The server revokes every session of that user, this one included, so the
 * local session is cleared rather than refreshed — the next request must ask
 * for a fresh sign-in.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const stored = readStored();
  const response = await postAuth(
    "/api/auth/change-password",
    { currentPassword, newPassword },
    stored?.access_token,
  );
  if (!response.ok) throw await toApplicationError(response);
  clearStored();
  notify(null);
}
