// @credits-system — Video model list with tier annotations and accessibility flags
import type { FastifyInstance } from "fastify";

import {
  MODEL_MIN_TIER,
  type GeneratorParams,
  type SubscriptionPlan,
  canAccessModel,
  modelVisibility,
} from "@loomic/shared";

import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { CreditService } from "../features/credits/credit-service.js";
import {
  getAvailableVideoModels,
  type AvailableVideoModel,
} from "../generation/providers/registry.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/** The default duration the panel starts on when the model does not say. */
const PREFERRED_DURATION = 5;

/**
 * AG-07 — the duration parameter the slider renders.
 *
 * With `allowedDurations` the slider may only stop on those values (a model
 * that supports 5s and 10s but nothing between), so `min` / `max` are the first
 * and last of the sorted list and `default` is the listed value nearest 5s
 * (a tie goes to the smaller one). Without the list the bounds are 1..maxDuration
 * and the step is a whole second.
 */
function toDurationParam(
  limits: AvailableVideoModel["limits"],
): GeneratorParams["params"][number] {
  const allowed = limits.allowedDurations;
  if (allowed !== undefined && allowed.length > 0) {
    const values = [...new Set(allowed)].sort((a, b) => a - b);
    return {
      type: "continuous",
      id: "duration",
      label: "时长",
      unit: "s",
      min: values[0]!,
      max: values[values.length - 1]!,
      step: 1,
      values,
      default: nearestDuration(values),
    };
  }

  return {
    type: "continuous",
    id: "duration",
    label: "时长",
    unit: "s",
    min: 1,
    max: limits.maxDuration,
    step: 1,
    default: Math.min(PREFERRED_DURATION, limits.maxDuration),
  };
}

/** The listed duration closest to {@link PREFERRED_DURATION}; a tie picks the smaller. */
function nearestDuration(values: readonly number[]): number {
  let best = values[0]!;
  let bestDistance = Math.abs(best - PREFERRED_DURATION);
  for (const value of values) {
    const distance = Math.abs(value - PREFERRED_DURATION);
    if (distance < bestDistance || (distance === bestDistance && value < best)) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * AG-07 — one video model as the list API publishes it.
 *
 * Kept out of the route so the panel's contract (capabilities, limits, pricing
 * and the schema-driven `params`) is testable without booting Fastify.
 * `capabilities.firstLastFrame` is always an explicit boolean: the option is
 * shown only for the models that really send a first and a last frame.
 */
export function toVideoModelListItem(
  m: AvailableVideoModel,
  userPlan: SubscriptionPlan | null,
) {
  return {
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    iconUrl: m.iconUrl,
    provider: m.provider,
    modality: "video" as const,
    visibility: modelVisibility(m.id),
    accessible: userPlan !== null && canAccessModel(userPlan, m.id),
    minTier: MODEL_MIN_TIER[m.id] ?? "pro",
    capabilities: {
      ...m.capabilities,
      firstLastFrame: m.capabilities.firstLastFrame === true,
    },
    limits: m.limits,
    params: {
      maxCount: 1,
      params: [toDurationParam(m.limits)],
    } satisfies GeneratorParams,
    pricing: m.pricing,
  };
}

export async function registerVideoModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/video-models", async (request, reply) => {
    const models = getAvailableVideoModels().filter(
      (m) => modelVisibility(m.id).listed,
    );

    // Try to authenticate — unauthenticated users still see models
    let userPlan: SubscriptionPlan | null = null;
    try {
      const user = await options.auth.authenticate(request);
      if (user) {
        const viewer = await options.viewerService.ensureViewer(user);
        const balance = await options.creditService.getBalance(
          viewer.workspace.id,
        );
        userPlan = balance.plan;
      }
    } catch {
      // Auth failure is non-fatal — just show models as inaccessible
    }

    const annotated = models.map((m) => toVideoModelListItem(m, userPlan));

    return reply.code(200).send({ models: annotated });
  });
}
