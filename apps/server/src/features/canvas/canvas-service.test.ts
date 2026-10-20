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
 * Compares the two types themselves — no value assignment in between, so no
 * literal narrowing can hide a mismatch. The `[A] extends [B]` tuples keep the
 * conditional type from distributing over the members of a union.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

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
    // `Equal` compares the two types themselves, without going through a value
    // assignment, so no literal narrowing can hide a mismatch: add or drop a
    // member on one side only and the `exhaustive` line below stops compiling
    // with TS2322. The check is that compilation, not the expect after it.
    const exhaustive: Equal<CanvasServiceError["code"], (typeof CODES)[number]> = true;
    expect(exhaustive).toBe(true);

    const err = new CanvasServiceError("service_unavailable", "msg", 503);
    expect(err.code).toBe("service_unavailable");
    expect(err.statusCode).toBe(503);
  });
});
