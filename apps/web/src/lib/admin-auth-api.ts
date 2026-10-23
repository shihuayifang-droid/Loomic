// @credits-system — Frontend API client for the admin auth APIs.
// 42H: an owner mints a one-time temporary password for a member who forgot
// theirs, instead of sending a reset mail (find-back is admin-driven in phase 1).
import { getServerBaseUrl } from "./env";
import { ApiAuthError, ApiApplicationError } from "./server-api";

// ── Helpers ──────────────────────────────────────────────────

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const message = body?.error?.message ?? "Request failed";
  throw new ApiApplicationError(code, message, response.status);
}

/** A 2xx body that does not match the contract is drift, not an empty result. */
function invalidResponse(): never {
  throw new ApiApplicationError("application_error", "Invalid response");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 42E's 200 body is exactly `{ email, temporaryPassword }`, so both fields must
 * be present and non-empty; anything else is refused instead of being rendered
 * as an empty password the admin would then send to a member.
 */
function isResetPasswordResult(
  value: unknown,
): value is { email: string; temporaryPassword: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.email) && isNonEmptyString(record.temporaryPassword)
  );
}

// ── 42H: mint a temporary password for one member ────────────

/**
 * `POST /api/admin/auth/reset-password` with `{ email }`.
 *
 * A 200 carries the plaintext temporary password **once**; the caller shows it
 * to the admin and then forgets it — this module keeps no copy of it.
 * Failures: 401 (not signed in), 403 (`forbidden`), 404 (`invalid_request`,
 * 「该邮箱没有账号」), 400 (`invalid_request`).
 */
export async function resetMemberPassword(
  accessToken: string,
  email: string,
): Promise<{ email: string; temporaryPassword: string }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/auth/reset-password`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ email }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed: unknown = await response.json().catch(() => null);
  if (!isResetPasswordResult(parsed)) return invalidResponse();
  return { email: parsed.email, temporaryPassword: parsed.temporaryPassword };
}
