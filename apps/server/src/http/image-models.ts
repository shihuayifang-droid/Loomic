// @credits-system — Image model list with tier annotations and accessibility flags
import type { FastifyInstance } from "fastify";

import {
  canAccessModel,
  MODEL_MIN_TIER,
  modelVisibility,
  qualityTierLabel,
  type CataloguedImageModelId,
  type ImageQualityOutput,
  type ModelVisibility,
  type SubscriptionPlan,
} from "@loomic/shared";

import type { CreditService } from "../features/credits/credit-service.js";
import type {
  ImageModelInfo,
  ImageModelLimits,
  ImageQuality,
} from "../generation/types.js";
import { getAvailableImageModels } from "../generation/providers/registry.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

/** One selectable quality tier as the panel renders it. */
export interface ImageModelQualityOption {
  key: ImageQuality;
  /** What the provider really returns for this tier, not what the name says. */
  output: ImageQualityOutput;
  /** MD-03: e.g. "超清 4K" when it matches, "超清（实际 2K）" when it is capped. */
  label: string;
}

/** One entry of `GET /api/image-models`. */
export interface ImageModelListItem {
  id: CataloguedImageModelId;
  displayName: string;
  description: string;
  iconUrl?: string | undefined;
  provider: string;
  modality: "image";
  visibility: ModelVisibility;
  accessible: boolean;
  minTier: SubscriptionPlan;
  limits: ImageModelLimits;
  /**
   * MD-03: absent — not an empty array — when the model takes no resolution
   * parameter, so the panel shows no quality selector at all.
   */
  quality?: readonly ImageModelQualityOption[];
}

/**
 * MD-03: turns one provider model into the list item the client sees.
 *
 * Exported so the shape can be tested without booting Fastify. `quality` is
 * spread conditionally because `exactOptionalPropertyTypes` is on: the key must
 * be missing, not present-and-undefined, or the client cannot tell "no selector"
 * from "selector with nothing in it".
 */
export function toImageModelListItem(
  m: ImageModelInfo & { provider: string },
  userPlan: SubscriptionPlan | null,
): ImageModelListItem {
  return {
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    iconUrl: m.iconUrl,
    provider: m.provider,
    modality: "image" as const,
    visibility: modelVisibility(m.id),
    accessible: userPlan !== null && canAccessModel(userPlan, m.id),
    minTier: MODEL_MIN_TIER[m.id] ?? "pro",
    // Exposed so the picker can gate the reference-image dropzone and the
    // aspect-ratio choices per model instead of duplicating those rules.
    limits: m.limits,
    ...(m.qualityTiers
      ? {
          quality: m.qualityTiers.map((t) => ({
            key: t.quality,
            output: t.output,
            label: qualityTierLabel(t.quality, t.output),
          })),
        }
      : {}),
  };
}

export async function registerImageModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/image-models", async (request, reply) => {
    const models = getAvailableImageModels().filter(
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

    const annotated = models.map((m) => toImageModelListItem(m, userPlan));

    return reply.code(200).send({ models: annotated });
  });
}
