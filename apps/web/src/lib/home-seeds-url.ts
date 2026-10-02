// The home seed public-URL helper.
//
// WHY THIS IS ITS OWN MODULE
// Seeds used to be hard-coded as public URLs in the user asset bucket
// (`project-assets`), alongside real project files. X-52 has to make that bucket
// private, which would 403 every anonymous home-page, example and discovery
// request at once — so the seed assets move to a bucket of their own and every
// URL is projected onto it on the way out.
//
// The projection is needed by BOTH seed modules, and it was first written inside
// `home-example-seeds.ts`. That made `home-discovery-seeds.ts` (16 cases) import
// a module holding 185 examples plus their prompts, so the discovery page's
// bundle pulled in the entire example library to get two tiny string functions.
// Nothing here imports seed data, so either module can use it alone.
//
// This module must stay dependency-free: it is imported by data modules, and any
// import here becomes part of both pages' bundles.

const SEED_ORIGIN = "https://jmcrxgenontlkxktpihl.supabase.co";
const PUBLIC_OBJECT_PATH = "/storage/v1/object/public/";
/** The user asset bucket that held the seeds until the migration ran. */
const LEGACY_ASSET_BUCKET = "project-assets";
/** Public bucket created for seeds only (migration 20261002000001). */
export const HOME_SEEDS_BUCKET = "home-seeds";
/** Key prefix the seeds used to sit under inside the user bucket. */
const LEGACY_SEED_PREFIX = `${HOME_SEEDS_BUCKET}/`;

/**
 * Build the pre-migration public URL for a seed key.
 *
 * Seed literals are written as `legacySeed(key)` rather than a full URL: the key
 * is the part that never changes, and which bucket serves it is a decision this
 * module owns. The returned value is never rendered directly — it always goes
 * through `toHomeSeedsPublicUrl` (see the projections at the end of the two seed
 * modules).
 */
export function legacySeed(key: string): string {
  return `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${LEGACY_ASSET_BUCKET}/${LEGACY_SEED_PREFIX}${key}`;
}

/**
 * Project a seed URL onto the dedicated public bucket.
 *
 * Pure, and deliberately narrow: only the EXACT public seed prefix in the user
 * bucket is rewritten. A different bucket, a different prefix in the same bucket,
 * a signed URL or a plain link all come back byte-for-byte unchanged.
 */
export function toHomeSeedsPublicUrl(url: string): string {
  const from = `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${LEGACY_ASSET_BUCKET}/${LEGACY_SEED_PREFIX}`;
  const to = `${SEED_ORIGIN}${PUBLIC_OBJECT_PATH}${HOME_SEEDS_BUCKET}/`;
  return url.split(from).join(to);
}
