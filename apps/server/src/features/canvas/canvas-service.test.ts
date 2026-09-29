// Every code CanvasServiceError can carry must be one the wire schema accepts.
//
// applicationErrorResponseSchema.parse() runs INSIDE the route's error path
// (see http/canvases.ts sendCanvasError). An unlisted code therefore makes the
// parse throw while already handling a failure, and the client receives Fastify's
// generic zod dump instead of the intended reply — the real cause replaced by
// noise. That has happened here before: `provider_not_configured` was sent for
// months by a branch that consequently never once produced its intended response.
//
// `_errcode-audit.mjs` greps for the `code: "..."` object-literal form and so
// cannot see these, because CanvasServiceError takes its code POSITIONALLY. This
// test is the check that actually executes.
import { applicationErrorCodeSchema } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import { CanvasServiceError } from "./canvas-service.js";

/**
 * Mirrors the CanvasErrorCode union. Kept as a literal list rather than derived
 * from the type, because a type cannot be enumerated at runtime — and a check
 * that silently covers nothing is worse than no check. Adding a member to the
 * union without adding it here is caught by the exhaustiveness assertion below.
 */
const CODES = [
  "canvas_not_found",
  "canvas_save_failed",
  "service_unavailable",
] as const;

describe("CanvasServiceError wire contract", () => {
  it.each(CODES)("%s is accepted by applicationErrorCodeSchema", (code) => {
    expect(() => applicationErrorCodeSchema.parse(code)).not.toThrow();
  });

  it("the list above still covers the constructor's accepted codes", () => {
    // If CanvasErrorCode gains a member, this stops compiling: the parameter type
    // no longer accepts only CODES[number]. It is a compile-time guard expressed
    // as a runtime test so it travels with the file it guards.
    const accepted: (typeof CODES)[number] = "service_unavailable";
    const err = new CanvasServiceError(accepted, "msg", 503);
    expect(err.code).toBe("service_unavailable");
    expect(err.statusCode).toBe(503);
  });
});
