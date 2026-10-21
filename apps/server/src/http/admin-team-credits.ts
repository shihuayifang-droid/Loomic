import {
  adminCreditAdjustRequestSchema,
  adminCreditAdjustResponseSchema,
  adminPersonalCapRequestSchema,
  adminPersonalCapResponseSchema,
  applicationErrorResponseSchema,
  creditCapTemplateApplyRequestSchema,
  creditCapTemplateApplyResponseSchema,
  creditCapTemplateCreateRequestSchema,
  creditCapTemplateListResponseSchema,
  creditCapTemplateSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";
import type { ApplicationErrorCode } from "@loomic/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminCreditWriteRepository } from "../db/admin-credit-write-repository.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const FORBIDDEN_MESSAGE = "Only team admins can manage team members.";
const UNAVAILABLE_MESSAGE = "Unable to verify team membership.";
const ADJUST_FAILED_MESSAGE = "Unable to adjust credits.";
const CAP_FAILED_MESSAGE = "Unable to set the personal cap.";
const INVALID_ADJUST_MESSAGE =
  "delta (non-zero integer) and reason are required.";
const INVALID_CAP_MESSAGE = "cap (a non-negative integer) is required.";
const INVALID_TEMPLATE_MESSAGE =
  "name (1-40 characters) and cap (a non-negative integer) are required.";
const INVALID_TEMPLATE_ID_MESSAGE = "templateId must be a uuid.";
const INVALID_APPLY_MESSAGE = "userIds (1-500 uuids) are required.";
const TEMPLATE_FAILED_MESSAGE = "Unable to manage credit cap templates.";
const LIST_FAILED_MESSAGE = "Unable to list credit cap templates.";
const APPLY_FAILED_MESSAGE = "Unable to apply the cap template.";
/** 37W's unique (workspace_id, name): one name per workspace, said plainly. */
const DUPLICATE_TEMPLATE_MESSAGE = "已有同名模板";
const TEMPLATE_NOT_FOUND_MESSAGE = "模板不存在";
const UNIQUE_VIOLATION = "23505";

/** SQLSTATE of 37U's 「减分不足」 refusal; its `detail` is how much may be taken. */
const ADJUST_EXCEEDS_TOPUP = "P0405";
/** SQLSTATE of 37U's rejected-argument refusals (delta 0, empty reason, cap < 0). */
const INVALID_PARAMETER = "22023";

/** Member ids are auth user ids (uuid). Anything else is a malformed path (T-06). */
const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The administrator plus the team workspace the write is charged to. */
type AdminActor = {
  user: AuthenticatedUser;
  workspaceId: string;
};

function sendApplicationError(
  reply: FastifyReply,
  statusCode: number,
  code: ApplicationErrorCode,
  message: string,
) {
  return reply.code(statusCode).send(
    applicationErrorResponseSchema.parse({
      error: { code, message },
    }),
  );
}

function sendInvalidUserId(reply: FastifyReply) {
  return sendApplicationError(
    reply,
    400,
    "invalid_request",
    "userId must be a uuid.",
  );
}

/**
 * The parts of a `pg` error this module is allowed to act on. Everything else
 * about the driver error — the statement, the host, the connection string —
 * stays out of the response and out of the reason string.
 */
function readDatabaseError(error: unknown): {
  code: string | null;
  detail: string | null;
} {
  if (typeof error !== "object" || error === null) {
    return { code: null, detail: null };
  }

  const record = error as Readonly<Record<string, unknown>>;
  return {
    code: typeof record.code === "string" ? record.code : null,
    detail: typeof record.detail === "string" ? record.detail : null,
  };
}

/**
 * BL-12 / BL-01 / AD-01 §2 admin credit surface.
 *
 * Registered beside `registerAdminTeamRoutes` and built the same way: the same
 * 401 / 503 / 403 gate (a copy of that file's `requireAdmin`, so the two admin
 * surfaces cannot drift apart), then the write, then the database's own answer.
 * The database checks the actor a third time — these functions are service-role
 * only and `security definer` — so this file is the "server refuses too" half,
 * not the only refusal.
 */
export async function registerAdminTeamCreditRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    teamMembership: TeamMembershipService;
    adminCreditWriteRepository: AdminCreditWriteRepository;
  },
) {
  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AdminActor | null> {
    const user = await options.auth.authenticate(request);

    if (!user) {
      reply.code(401).send(
        unauthenticatedErrorResponseSchema.parse({
          error: {
            code: "unauthorized",
            message: "Missing or invalid bearer token.",
          },
        }),
      );
      return null;
    }

    let membership;
    try {
      membership = await options.teamMembership.get(user.id);
    } catch {
      sendApplicationError(reply, 503, "application_error", UNAVAILABLE_MESSAGE);
      return null;
    }

    if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
      sendApplicationError(reply, 403, "forbidden", FORBIDDEN_MESSAGE);
      return null;
    }

    return { user, workspaceId: membership.workspace.id };
  }

  /**
   * The two refusals 37U expresses, mapped once for both routes. `P0405` carries
   * the number the member may still give up, verbatim from the database.
   */
  function sendWriteError(
    reply: FastifyReply,
    error: unknown,
    failedMessage: string,
  ) {
    const databaseError = readDatabaseError(error);

    if (databaseError.code === ADJUST_EXCEEDS_TOPUP) {
      return sendApplicationError(
        reply,
        409,
        "adjust_exceeds_topup",
        `最多可减 ${databaseError.detail ?? ""}`,
      );
    }

    if (databaseError.code === INVALID_PARAMETER) {
      return sendApplicationError(
        reply,
        400,
        "invalid_request",
        failedMessage === ADJUST_FAILED_MESSAGE
          ? INVALID_ADJUST_MESSAGE
          : INVALID_CAP_MESSAGE,
      );
    }

    // `credit_adjust_failed` is not in shared's enum, so the generic code is
    // used rather than widening the contract for one internal failure.
    return sendApplicationError(reply, 500, "application_error", failedMessage);
  }

  app.post<{ Params: { userId: string } }>(
    "/api/admin/team/members/:userId/credits",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;

      if (!USER_ID_PATTERN.test(request.params.userId)) {
        return sendInvalidUserId(reply);
      }

      const parsed = adminCreditAdjustRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return sendApplicationError(
          reply,
          400,
          "invalid_request",
          INVALID_ADJUST_MESSAGE,
        );
      }

      try {
        const transactionId =
          await options.adminCreditWriteRepository.adjustTopup({
            workspaceId: admin.workspaceId,
            userId: request.params.userId,
            operatorId: admin.user.id,
            delta: parsed.data.delta,
            reason: parsed.data.reason,
          });

        return reply
          .code(200)
          .send(adminCreditAdjustResponseSchema.parse({ transactionId }));
      } catch (error) {
        return sendWriteError(reply, error, ADJUST_FAILED_MESSAGE);
      }
    },
  );

  app.put<{ Params: { userId: string } }>(
    "/api/admin/team/members/:userId/cap",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;

      if (!USER_ID_PATTERN.test(request.params.userId)) {
        return sendInvalidUserId(reply);
      }

      const parsed = adminPersonalCapRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return sendApplicationError(
          reply,
          400,
          "invalid_request",
          INVALID_CAP_MESSAGE,
        );
      }

      try {
        const cap = await options.adminCreditWriteRepository.setPersonalCap({
          workspaceId: admin.workspaceId,
          userId: request.params.userId,
          cap: parsed.data.cap,
        });

        return reply
          .code(200)
          .send(adminPersonalCapResponseSchema.parse({ cap }));
      } catch (error) {
        return sendWriteError(reply, error, CAP_FAILED_MESSAGE);
      }
    },
  );

  /**
   * BL-01 / 37Y: the workspace's credit cap templates.
   *
   * The template list is read through the same privileged repository as the
   * writes, because the table's policy only lets an admin of the workspace see
   * its rows and this route has already decided the caller is one. The answer is
   * parsed before it is sent, so a malformed row cannot reach the browser.
   */
  app.get("/api/admin/team/cap-templates", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return reply;

    try {
      const templates = await options.adminCreditWriteRepository.listCapTemplates({
        workspaceId: admin.workspaceId,
      });

      return reply
        .code(200)
        .send(creditCapTemplateListResponseSchema.parse({ templates }));
    } catch {
      return sendApplicationError(reply, 500, "application_error", LIST_FAILED_MESSAGE);
    }
  });

  app.post("/api/admin/team/cap-templates", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return reply;

    const parsed = creditCapTemplateCreateRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return sendApplicationError(
        reply,
        400,
        "invalid_request",
        INVALID_TEMPLATE_MESSAGE,
      );
    }

    try {
      const template = await options.adminCreditWriteRepository.createCapTemplate({
        workspaceId: admin.workspaceId,
        name: parsed.data.name,
        cap: parsed.data.cap,
      });

      return reply.code(201).send(creditCapTemplateSchema.parse(template));
    } catch (error) {
      const databaseError = readDatabaseError(error);

      // One name per workspace: reusing one is refused by the database, and the
      // administrator is told which rule they hit rather than "something failed".
      if (databaseError.code === UNIQUE_VIOLATION) {
        return sendApplicationError(
          reply,
          409,
          "invalid_request",
          DUPLICATE_TEMPLATE_MESSAGE,
        );
      }

      return sendApplicationError(
        reply,
        500,
        "application_error",
        TEMPLATE_FAILED_MESSAGE,
      );
    }
  });

  /**
   * Apply one template to a list of members. Who is skipped is the database
   * function's decision ("a cap set by hand is not overwritten"), so the count
   * returned here is the authoritative one.
   */
  app.post<{ Params: { templateId: string } }>(
    "/api/admin/team/cap-templates/:templateId/apply",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;

      if (!USER_ID_PATTERN.test(request.params.templateId)) {
        return sendApplicationError(
          reply,
          400,
          "invalid_request",
          INVALID_TEMPLATE_ID_MESSAGE,
        );
      }

      const parsed = creditCapTemplateApplyRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return sendApplicationError(
          reply,
          400,
          "invalid_request",
          INVALID_APPLY_MESSAGE,
        );
      }

      try {
        const applied = await options.adminCreditWriteRepository.applyCapTemplate({
          workspaceId: admin.workspaceId,
          templateId: request.params.templateId,
          userIds: parsed.data.userIds,
        });

        return reply
          .code(200)
          .send(creditCapTemplateApplyResponseSchema.parse({ applied }));
      } catch (error) {
        const databaseError = readDatabaseError(error);

        // A template that is not this workspace's is, to this administrator,
        // simply not there — 404 says that without confirming it exists.
        if (databaseError.code === INVALID_PARAMETER) {
          return sendApplicationError(
            reply,
            404,
            "invalid_request",
            TEMPLATE_NOT_FOUND_MESSAGE,
          );
        }

        return sendApplicationError(
          reply,
          500,
          "application_error",
          APPLY_FAILED_MESSAGE,
        );
      }
    },
  );
}
