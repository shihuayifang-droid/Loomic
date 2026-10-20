/** MD-01: the visibility block the model lists carry (33V). */
export type ModelVisibilityInfo = {
  listed: boolean;
  agent_callable: boolean;
  generator_visible: boolean;
  in_preference: boolean;
};

export type ModelSurface = "agent" | "generator" | "preference";

/**
 * MD-01: every model list filters the same server configuration by its own
 * field. A response without `visibility` (an older server) shows everything.
 */
export function visibleOn<T>(models: readonly T[], surface: ModelSurface): T[] {
  return models.filter((m) => {
    const v = (m as { visibility?: ModelVisibilityInfo | undefined }).visibility;
    if (!v) return true;
    if (!v.listed) return false;
    if (surface === "agent") return v.agent_callable;
    if (surface === "generator") return v.generator_visible;
    return v.in_preference;
  });
}
