// @credits-system — Image model list with tier annotations and accessibility flags
import type { FastifyInstance } from "fastify";

import {
  canAccessModel,
  MODEL_MIN_TIER,
  type SubscriptionPlan,
} from "@loomic/shared";

import type { CreditService } from "../features/credits/credit-service.js";
import { getAvailableImageModels } from "../generation/providers/registry.js";
import type { RequestAuthenticator } from "../supabase/user.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";

export async function registerImageModelRoutes(
  app: FastifyInstance,
  options: {
    auth: RequestAuthenticator;
    creditService: CreditService;
    viewerService: ViewerService;
  },
) {
  app.get("/api/image-models", async (request, reply) => {
    const models = getAvailableImageModels();

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

    const annotated = models.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.description,
      iconUrl: m.iconUrl,
      provider: m.provider,
      accessible: userPlan !== null && canAccessModel(userPlan, m.id),
      minTier: MODEL_MIN_TIER[m.id] ?? "pro",
      // Exposed so the picker can gate the reference-image dropzone and the
      // aspect-ratio choices per model instead of duplicating those rules.
      limits: m.limits,
    }));

    return reply.code(200).send({ models: annotated });
  });
}
