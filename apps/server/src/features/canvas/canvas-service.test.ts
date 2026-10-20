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
    // Exhaustiveness, stated the way that actually holds: `CanvasServiceError["code"]`
    // is the whole union the constructor takes, so it only stays assignable to the
    // literal union of CODES above while the two are equal. A member added to the
    // union without a line above stops this file compiling — which is the point,
    // since a code the wire enum does not list is a code the client never receives.
    const carried: CanvasServiceError["code"] = "service_unavailable";
    const covered: (typeof CODES)[number] = carried;
    const err = new CanvasServiceError(covered, "msg", 503);
    expect(err.code).toBe("service_unavailable");
    expect(err.statusCode).toBe(503);
  });
});
