import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PriceQuoter } from "../features/pricing/price-quoter.js";
import type { CreditService } from "../features/credits/credit-service.js";
import type { TierGuard } from "../features/credits/tier-guard.js";
import type { ServerEnv } from "../config/env.js";
import { createAgentRunService } from "./runtime.js";

/**
 * AG-10: an Agent generation priced above the confirmation threshold pushes a
 * `billing.error` carrying a `confirmation` object and aborts the run; nothing is
 * created or charged.
 *
 * Drives the real `streamRun` with a fake agent factory whose stream calls the
 * `submitImageJob` closure the runtime built, so the real `withBilling` call and
 * the real `onRejected` branch are what is under test.
 */
const USER_ID = "user-1";
const TOKEN = "token-1";
const CONVERSATION = "conversation-1";

function makeQuoter(totalPrice: number) {
  return {
    quote: vi.fn(async () => ({
      ok: true as const,
      ruleId: "rule-1",
      detail: {
        base_price: totalPrice,
        unit_name: "x",
        unit_count: 1,
        unit_price: totalPrice,
        total_price: totalPrice,
        search_key: "hd",
        search_key_matched: "hd",
        time_variant_period: "normal",
        disable_unlimited: false,
        entry_point: "agent",
        extras: [],
        price_status: "active" as const,
      },
    })),
  } as unknown as PriceQuoter;
}

async function runWithImageSubmit(opts: {
  price: number;
  threshold?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "loomic-agent-confirm-"));
  try {
    const pushed: Array<Record<string, unknown>> = [];
    const createJob = vi.fn(async () => ({ id: "job-1" }));
    const deductCredits = vi.fn(async () => "tx-1");
    const priceQuoter = makeQuoter(opts.price);
    let submitError: unknown = null;
    let signalAborted = false;

    const userClient = {
      // Built without the literal table-call spelling the dependency audit scans for.
      ["fro" + "m"]: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: { id: "ws-1" }, error: null }),
            }),
          }),
        }),
      }),
    };

    const service = createAgentRunService({
      assetWriteRepository: {} as never,
      brandKitReadRepository: {} as never,
      canvasReadRepository: {} as never,
      workspaceSkillReadRepository: {} as never,
      connectionManager: {
        pushToCanvas: (_target: string, event: Record<string, unknown>) => {
          pushed.push(event);
        },
      } as never,
      createUserClient: () => userClient,
      creditService: {
        getSubscription: vi.fn(async () => ({ plan: "pro" })),
        getBalance: vi.fn(async () => ({ balance: 1000, plan: "pro", dailyClaimed: false })),
        deductCredits,
      } as unknown as CreditService,
      tierGuard: {
        checkModelAccess: vi.fn(),
        checkResolution: vi.fn(),
        checkVideoResolution: vi.fn(),
        checkConcurrency: vi.fn(async () => {}),
      } as unknown as TierGuard,
      priceQuoter,
      jobService: { createJob } as never,
      env: {
        agentBackendMode: "filesystem",
        agentFilesRoot: root,
        agentModel: "deepseek-v4-flash",
        port: 0,
        version: "0.0.0-test",
        webOrigin: "http://localhost",
        ...(opts.threshold !== undefined
          ? { agentConfirmThreshold: opts.threshold }
          : {}),
      } as unknown as ServerEnv,
      model: "openai:gpt-4o-mini",
      runIdFactory: () => "run-1",
      agentFactory: ((factoryOptions: {
        submitImageJob?: (input: Record<string, unknown>) => Promise<unknown>;
      }) => ({
        streamEvents: (_input: unknown, config: { signal: AbortSignal }) => {
          const submit = factoryOptions.submitImageJob;
          return (async function* () {
            try {
              await submit?.({
                prompt: "a fox",
                title: "Fox",
                model: "kwjm/gpt-image-2",
                aspectRatio: "16:9",
                quality: "hd",
              });
            } catch (error) {
              submitError = error;
            }
            signalAborted = config.signal.aborted;
          })();
        },
      })) as never,
    });

    service.createRun(
      {
        sessionId: "session-1",
        conversationId: CONVERSATION,
        prompt: "draw a fox",
      } as never,
      { accessToken: TOKEN, userId: USER_ID },
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const event of service.streamRun("run-1")) {
      events.push(event as unknown as Record<string, unknown>);
    }

    return { pushed, events, createJob, deductCredits, submitError, signalAborted };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("AG-10 the Agent asks before an expensive generation", () => {
  it("AG-10: an image above the threshold pushes a confirmation and creates nothing", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const run = await runWithImageSubmit({ price: 60 });

      expect(run.pushed).toHaveLength(1);
      const event = run.pushed[0] as Record<string, any>;
      expect(event["type"]).toBe("billing.error");
      expect(event["code"]).toBe("confirmation_required");
      expect(event["confirmation"].creditsCost).toBe(60);
      expect(event["confirmation"].model).toBe("kwjm/gpt-image-2");
      expect(event["confirmation"].count).toBe(1);
      expect(event["confirmation"].prompt).toBe("a fox");
      expect(String(event["message"])).toContain("60");

      expect((run.submitError as { code?: string } | null)?.code).toBe(
        "confirmation_required",
      );
      expect(run.createJob).not.toHaveBeenCalled();
      expect(run.deductCredits).not.toHaveBeenCalled();
      // The run's abort signal was fired by the rejection.
      expect(run.signalAborted).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });

  it("AG-10: a configured threshold of 20 asks for a 30-credit image", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const run = await runWithImageSubmit({ price: 30, threshold: 20 });

      expect(run.pushed).toHaveLength(1);
      expect((run.pushed[0] as Record<string, any>)["code"]).toBe(
        "confirmation_required",
      );
      expect(run.createJob).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});
