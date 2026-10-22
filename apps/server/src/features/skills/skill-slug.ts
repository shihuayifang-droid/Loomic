import { createHash } from "node:crypto";

/**
 * The single place a skill name becomes a slug (T-61 ①).
 *
 * Two route files carried an identical private copy of this rule, and that rule
 * maps every non-ASCII character to a dash and then strips dashes from both
 * ends. A name written entirely in Chinese therefore collapsed to the empty
 * string: the row was inserted, but the published response requires a non-empty
 * slug, so the request failed on the way out.
 *
 * The ASCII rule wins first and is kept byte for byte, so every English name
 * produces exactly the slug it produced before. Only when that rule yields
 * nothing does the name fall back to a derived, deterministic suffix, which
 * keeps the same name mapping to the same slug (and therefore keeps the unique
 * constraint answering a duplicate with a conflict, as it did before).
 */

/** Length of the hex digest kept by the fallback, so `skill-` + 12 = 18. */
const FALLBACK_DIGEST_LENGTH = 12;

/**
 * Slug for a skill name.
 *
 * @param name the raw, untrimmed skill name
 * @returns the ASCII slug when there is one, otherwise `skill-<digest>`
 */
export function generateSkillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);

  if (slug.length > 0) return slug;

  const digest = createHash("sha256")
    .update(name.trim())
    .digest("hex")
    .slice(0, FALLBACK_DIGEST_LENGTH);

  return `skill-${digest}`;
}
