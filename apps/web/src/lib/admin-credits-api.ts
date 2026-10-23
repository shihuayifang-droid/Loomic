// @credits-system — Frontend API client for the admin team credit APIs
// (AD-01 member list numbers, BL-12 adjust, BL-01 personal cap / cap templates).
import type {
  CreditCapTemplate,
  MemberCreditSummary,
  TeamMember,
  TeamMemberAddResponse,
  TeamMemberRemoveResponse,
  TeamMemberRoleResponse,
} from "@loomic/shared";

import {
  adminCreditAdjustResponseSchema,
  adminGenerationPauseResponseSchema,
  adminPersonalCapResponseSchema,
  creditCapTemplateApplyResponseSchema,
  creditCapTemplateListResponseSchema,
  creditCapTemplateSchema,
  memberCreditSummaryListResponseSchema,
  teamMemberAddResponseSchema,
  teamMemberListResponseSchema,
  teamMemberRemoveResponseSchema,
  teamMemberRoleResponseSchema,
} from "@loomic/shared";

import { getServerBaseUrl } from "./env";
import { ApiAuthError, ApiApplicationError } from "./server-api";

// ── Helpers ──────────────────────────────────────────────────

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

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
  throw new ApiApplicationError(code, message);
}

/**
 * A 2xx body that does not match the shared contract is a server/client drift,
 * not an empty result: refusing it here keeps a renderer from drawing half a row
 * (a missing `topup` would read as 0 and look like real data).
 */
function invalidResponse(): never {
  throw new ApiApplicationError("application_error", "Invalid response");
}

// ── AD-01: the admin member list's credit columns ────────────

export async function fetchMemberCredits(
  accessToken: string,
): Promise<MemberCreditSummary[]> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/credits`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = memberCreditSummaryListResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.members;
}

// ── AD-01: the names behind the credit rows ──────────────────

export async function fetchTeamMembers(
  accessToken: string,
): Promise<TeamMember[]> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/team/members`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  const parsed = teamMemberListResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.members;
}

// ── BL-12: add / subtract credits with a mandatory reason ────

export async function adjustMemberTopup(
  accessToken: string,
  userId: string,
  input: { delta: number; reason: string },
): Promise<string> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/${encodeURIComponent(userId)}/credits`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ delta: input.delta, reason: input.reason }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = adminCreditAdjustResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.transactionId;
}

// ── BL-01: one member's monthly personal cap ─────────────────

export async function setMemberCap(
  accessToken: string,
  userId: string,
  cap: number,
): Promise<number> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/${encodeURIComponent(userId)}/cap`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ cap }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = adminPersonalCapResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.cap;
}

// ── BL-01: cap templates ─────────────────────────────────────

export async function fetchCapTemplates(
  accessToken: string,
): Promise<CreditCapTemplate[]> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/cap-templates`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = creditCapTemplateListResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.templates;
}

export async function createCapTemplate(
  accessToken: string,
  input: { name: string; cap: number },
): Promise<CreditCapTemplate> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/cap-templates`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ name: input.name, cap: input.cap }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = creditCapTemplateSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

export async function applyCapTemplate(
  accessToken: string,
  templateId: string,
  userIds: string[],
): Promise<number> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/cap-templates/${encodeURIComponent(templateId)}/apply`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ userIds }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = creditCapTemplateApplyResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data.applied;
}

// ── AD-01 / BL-21: pause / resume one member's generation ────

/**
 * `PUT /api/admin/team/members/:userId/generation`.
 *
 * `reason` is sent only when the caller supplies one: the route insists on a
 * reason for a pause (「暂停需要填写原因」) and a resume carries none, so an
 * explicit `undefined` would have to be stripped from the body anyway.
 * `changed: false` is a normal 200 — the member was already in that state.
 */
export async function setMemberGenerationPaused(
  accessToken: string,
  userId: string,
  input: { paused: boolean; reason?: string },
): Promise<{ paused: boolean; changed: boolean }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/${encodeURIComponent(userId)}/generation`,
    {
      method: "PUT",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(
        input.reason === undefined || input.reason === ""
          ? { paused: input.paused }
          : { paused: input.paused, reason: input.reason },
      ),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = adminGenerationPauseResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return { paused: parsed.data.paused, changed: parsed.data.changed };
}

// ── AD-08 §3: team membership — add / change role / remove ───

/**
 * `POST /api/admin/team/members`.
 *
 * A 200 with `added: false` is not a failure: the address already belongs to the
 * team, so the caller should say so instead of pretending a row was created.
 */
export async function addTeamMember(
  accessToken: string,
  input: { email: string; role: "member" | "admin" },
): Promise<TeamMemberAddResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/admin/team/members`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ email: input.email, role: input.role }),
  });
  if (!response.ok) return handleErrorResponse(response);
  const parsed = teamMemberAddResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

/**
 * `PATCH /api/admin/team/members/:userId`.
 *
 * Only `member` / `admin` travel on the wire — the owner's role is fixed — and
 * `changed: false` means the member already held that role.
 */
export async function setTeamMemberRole(
  accessToken: string,
  userId: string,
  role: "member" | "admin",
): Promise<TeamMemberRoleResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ role }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = teamMemberRoleResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

/**
 * `DELETE /api/admin/team/members/:userId`.
 *
 * The server hands the removed member's projects to the admin who asked, so the
 * `transferred` counts are what the panel reports back.
 */
export async function removeTeamMember(
  accessToken: string,
  userId: string,
): Promise<TeamMemberRemoveResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/admin/team/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const parsed = teamMemberRemoveResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}
