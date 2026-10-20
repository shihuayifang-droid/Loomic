// MD-02: public model identifiers and the Agent tool names generated from them.
//
// Rule (from MD-02): the outward id is `<provider>/<model_slug>` and every segment
// is lower snake_case — `[a-z0-9]+` groups joined by single underscores. Upper case,
// hyphens and dots are refused. The Agent tool name is `generate_<modality>_<slug>`
// and is always derived, never hand-written; the modality is an independent field
// (see MD-04 in model-catalog.ts) and only appears in the tool name for readability.
//
// The ids currently in model-catalog.ts are NOT migrated yet: they still carry
// hyphens and dots (e.g. `black-forest-labs/flux-kontext-pro`,
// `bytedance/seedream-4.5`). Renaming them touches pricing seed rows, stored jobs
// and preferences, so it is tracked separately. `model-identifiers.test.ts` pins the
// current count of non-conforming catalogue ids so the debt can only shrink.

import type { ModelModality } from "./model-catalog.js";

/** `<provider>/<model_slug>`, each segment lower snake_case. */
export const PUBLIC_MODEL_ID_PATTERN =
  /^[a-z0-9]+(?:_[a-z0-9]+)*\/[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** `generate_<modality>_<model_slug>` — the names the Agent surface exposes. */
export const AGENT_TOOL_NAME_PATTERN = /^generate_(image|video)_[a-z0-9_]+$/;

/** True when `id` already follows the MD-02 public identifier rule. */
export function isValidPublicModelId(id: string): boolean {
  return PUBLIC_MODEL_ID_PATTERN.test(id);
}

/**
 * Builds the Agent tool name for `publicId`.
 * @throws when `publicId` does not follow MD-02 — a tool name is only ever derived
 * from a conforming id, so a bad id surfaces here instead of shipping a bad tool.
 */
export function agentToolNameFor(modality: ModelModality, publicId: string): string {
  if (!isValidPublicModelId(publicId)) {
    throw new Error(
      `MD-02: cannot derive an Agent tool name from non-conforming public model id "${publicId}"`,
    );
  }
  const slug = publicId.slice(publicId.indexOf("/") + 1);
  return `generate_${modality}_${slug}`;
}
