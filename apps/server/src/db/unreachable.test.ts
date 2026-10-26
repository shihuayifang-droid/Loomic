// QA-11 故障注入（后端第一条）：数据库不可达。
//
// What these pin: when PostgreSQL cannot be reached at all, the caller gets a
// **503** with a machine-readable code — not a 500, not an uncaught crash, and
// not an empty 200 list. Two layers are checked:
//
//  1. the HTTP layer, through the REAL `registerTeamGate` hook — a membership
//     lookup that fails because the database is down answers 503 and the
//     business handler is never reached;
//  2. the classification itself, fed a `pg`-shaped `ECONNREFUSED` raised by a
//     stub pool — no real database, no network, only an injected rejection.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { applicationErrorResponseSchema } from "@loomic/shared";

import type { TeamMembershipService } from "../features/team/team-membership.js";
import {
  DATABASE_UNAVAILABLE_CODE,
  UPSTREAM_CONNECTION_RESET_CODE,
  UPSTREAM_RATE_LIMITED_CODE,
  classifyInfrastructureFault,
  infrastructureFaultResponse,
} from "../generation/upstream-error.js";
import { registerTeamGate } from "../http/team-gate.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/** A `pg` connection failure, shaped the way the driver really throws it. */
function connectionRefused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.210.134.37:5432"), {
    code: "ECONNREFUSED",
    errno: -111,
    syscall: "connect",
  });
}

describe("数据库不可达 (QA-11)", () => {
  it("QA-11: a membership read that cannot reach the database answers 503, never 500", async () => {
    let handlerCalls = 0;

    const app = Fastify({ logger: false });
    app.get("/api/canvases", async () => {
      handlerCalls += 1;
      return { ok: true };
    });

    const auth = {
      authenticate: async () => ({ id: "00000000-0000-0000-0000-00000000000a" }),
    } as unknown as RequestAuthenticator;

    const teamMembership = {
      get: async () => {
        throw connectionRefused();
      },
    } as unknown as TeamMembershipService;

    registerTeamGate(app, { auth, teamMembership });
    await app.ready();

    try {
      const response = await app.inject({ method: "GET", url: "/api/canvases" });

      // The status is the assertion that matters: 500 would mean the failure was
      // not classified at all and the client cannot tell "try again" from "we
      // broke".
      expect(response.statusCode).toBe(503);
      expect(response.statusCode).not.toBe(500);

      const body: unknown = response.json();
      expect(() => applicationErrorResponseSchema.parse(body)).not.toThrow();
      expect(body).toMatchObject({ error: { code: "application_error" } });
      // The driver text (host, port, socket code) must not reach the client.
      expect(response.body).not.toContain("ECONNREFUSED");
      expect(response.body).not.toContain("10.210.134.37");

      // The request never reached a business handler: the gate answered first.
      expect(handlerCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("QA-11: a stub pool rejection is classified as database_unavailable, not as an upstream fault", async () => {
    // A pool double, not a database: `query` rejects exactly as `pg` does when
    // the server refuses the connection.
    const pool = {
      query: async (): Promise<unknown> => {
        throw connectionRefused();
      },
    };

    const caught: unknown = await pool.query().then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).not.toBeNull();
    expect(classifyInfrastructureFault(caught, "database")).toBe("database_unavailable");

    const mapped = infrastructureFaultResponse(caught, "database");
    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe(DATABASE_UNAVAILABLE_CODE);
    // Our own database being down is not something the client retries blindly.
    expect(mapped.retryable).toBe(false);
    // Fixed sentence: no host, no port, no socket code.
    expect(mapped.message).not.toContain("ECONNREFUSED");
    expect(mapped.message).not.toContain("5432");

    // The three QA-11 faults stay distinguishable from each other.
    expect(DATABASE_UNAVAILABLE_CODE).not.toBe(UPSTREAM_RATE_LIMITED_CODE);
    expect(DATABASE_UNAVAILABLE_CODE).not.toBe(UPSTREAM_CONNECTION_RESET_CODE);
  });

  it("QA-11: a failing query surfaces as a classified fault and never as a success value", async () => {
    const pool = {
      query: async (): Promise<{ rows: unknown[] }> => {
        throw connectionRefused();
      },
    };

    let answered: ReturnType<typeof infrastructureFaultResponse> | undefined;
    let thrown: unknown;

    try {
      const result = await pool.query();
      expect(result.rows).toEqual([]);
    } catch (error) {
      thrown = error;
      answered = infrastructureFaultResponse(error, "database");
    }

    expect(thrown).toBeDefined();
    expect(answered?.statusCode).toBe(503);
    // A failure must never be downgraded to a 2xx body.
    expect(answered?.statusCode).toBeGreaterThanOrEqual(500);
  });
});
