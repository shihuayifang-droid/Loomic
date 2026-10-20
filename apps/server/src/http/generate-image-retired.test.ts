import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { JobService } from "../features/jobs/job-service.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";
import { registerGenerateRoutes } from "./generate.js";

/**
 * GN-37 — the retired synchronous image route (`POST /api/agent/generate-image`).
 *
 * Two things are pinned here, and only these two:
 *
 *   1. an authenticated call gets 410 and is told where to go instead, with no
 *      work created and no credit touched;
 *   2. authentication still runs in FRONT of the retirement, so an anonymous
 *      caller gets the 401 it always got and cannot learn the route is gone.
 *
 * The "no work created / no credit touched" half is asserted through doubles
 * that RECORD any method called on them, by whatever name: a `Proxy` rather than
 * a hand-written method list, so a method added to `CreditService` or
 * `JobService` later cannot slip past this test simply by not being listed. If
 * the route ever reaches `withBilling` again, one of those names lands in
 * `calls` and the first case fails.
 */

const TOKEN = "retired-image-token";
const USER: AuthenticatedUser = {
  accessToken: TOKEN,
  email: "retired-image-route@hahart.test",
  id: "00000000-0000-0000-0000-0000000000d1",
  userMetadata: {},
};
const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000d2";

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length) === TOKEN ? USER : null;
  },
};

const calls: string[] = [];

function recordingDouble(label: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return (..._args: unknown[]) => {
          calls.push(`${label}.${property}`);
          return undefined;
        };
      },
    },
  );
}

const creditService = recordingDouble("creditService") as unknown as CreditService;
const jobService = recordingDouble("jobService") as unknown as JobService;

const viewerService = {
  async ensureViewer() {
    return {
      workspace: {
        id: WORKSPACE_ID,
        name: "Personal",
        type: "personal" as const,
        ownerUserId: USER.id,
      },
    };
  },
} as unknown as ViewerService;

const uploadService = {} as unknown as UploadService;

let app: FastifyInstance;

beforeEach(async () => {
  // The doubles are module scope, so case 2 would otherwise see case 1's calls.
  calls.length = 0;

  app = Fastify();
  await registerGenerateRoutes(app, {
    auth,
    creditService,
    jobService,
    viewerService,
    uploadService,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function postSyncImage(headers: Record<string, string>, body: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/agent/generate-image",
    headers,
    payload: body as Record<string, unknown>,
  });
}

describe("POST /api/agent/generate-image (retired)", () => {
  it("GN-37: the synchronous image endpoint answers 410 and points to the job endpoint", async () => {
    const response = await postSyncImage(
      { authorization: `Bearer ${TOKEN}` },
      { prompt: "猫" },
    );

    expect(response.statusCode).toBe(410);
    expect(response.json().error.message).toContain("generate-image-job");
    // Retired means retired: no credit movement and no job row, whichever
    // method the route could have reached them through.
    expect(calls).toEqual([]);
  });

  it("GN-37: unauthenticated callers still get 401", async () => {
    const response = await postSyncImage({}, { prompt: "猫" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });
});
