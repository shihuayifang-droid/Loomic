import type { FastifyReply } from "fastify";

/**
 * X-40 §1: a request body that fails its schema is answered in the SAME shape as
 * every other error - `{ error: { code, message } }` - so the client reads one
 * place. `message` and `issues` stay at the top level as well, for the callers
 * and tests that already read them; they are additive, not a second shape.
 */
export const INVALID_REQUEST_MESSAGE = "Invalid request body";

export function validationErrorBody(issues: unknown[]) {
  return {
    error: { code: "invalid_request" as const, message: INVALID_REQUEST_MESSAGE },
    issues,
    message: INVALID_REQUEST_MESSAGE,
  };
}

export function sendValidationError(reply: FastifyReply, issues: unknown[]) {
  return reply.code(400).send(validationErrorBody(issues));
}
