// 工单45BR / T-128 (OP-04, second slice): the READ side of the home page.
//
// The four `home_*` tables (0012_brand_skills_home.sql) store what the home page
// shows: example cards (prompt + preview images) grouped by category, and
// discovery cases (cover, author, counters) grouped by category. Both are seed
// content: nothing here is per-user, so the only thing the request decides is
// whether the caller is signed in.
//
// Why the object keys are replaced here and not in the browser
// A seed image is stored as an object KEY (`examples/a/b.webp`) in the
// `home-seeds` bucket, not as a URL: a URL baked into the database would have to
// be rewritten whenever the storage host or the bucket's visibility changed
// (that is exactly what 45BP's migrate CLI had to fix once). The bucket is
// private since 工单18's storage cutover, so the browser cannot build a link
// itself — the server signs each key on the way out.
//
// Why a failed signature does NOT fail the request
// Same semantics as 43I: the seed content is the product, the image is a
// preview. A key the backend cannot sign keeps its stored value (the browser
// then shows a broken thumbnail) instead of taking the whole home page down.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";

import {
  applicationErrorResponseSchema,
  unauthenticatedErrorResponseSchema,
} from "@loomic/shared";

import type { ObjectStore } from "../features/storage/object-store.js";
import type { RequestAuthenticator } from "../supabase/user.js";

/** The bucket every home seed lives in (the 45BP import CLI's target). */
const HOME_SEEDS_BUCKET = "home-seeds";

/**
 * How long a signed seed link lasts: 7 days.
 *
 * The home page is the first screen of the product and its cards stay mounted
 * for a long time (a tab left open, a kiosk-style session), so a short TTL would
 * turn thumbnails into broken images while the page is still in use. A week was
 * picked because the content is public seed material — nothing secret is behind
 * the signature, and the worst case of an expired link is a re-fetch on the next
 * visit. It is also short enough that a leaked link does not stay valid forever,
 * which is why it is NOT a permanent URL.
 */
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 3600;

/**
 * How many `signedReadUrl` calls may be in flight at once.
 *
 * A full home page is ~36 examples × a few images each, so signing them one by
 * one would serialise dozens of round trips; signing them all at once would
 * flood the object backend. Ten is the compromise the workorder asks for.
 */
const SIGN_CONCURRENCY = 10;

/** Anything with a scheme (`https:`, `data:`, …) is already a URL, not a key. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type HomeRouteOptions = {
  /** The same authenticator the other `/api/*` routes use: no anonymous reads. */
  auth: RequestAuthenticator;
  /**
   * The plain `pg` pool, resolved LAZILY: building the app must never connect,
   * so an app whose home routes are never called still starts without a
   * database (the same rule every read repository in `db/` follows).
   */
  pool: () => Pool;
  /** The object store that signs the seed keys (fs volume or Supabase). */
  store: ObjectStore;
};

type CategoryRow = { key: string; label: string };

type ExampleRow = {
  category_key: string;
  title: string;
  prompt: string;
  /** `text[]` of object keys (never a URL when the 45BP import wrote it). */
  image_urls: string[] | null;
  /** `jsonb` array of `{ type, name, imgSrc }`, `imgSrc` also being a key. */
  input_mentions: unknown;
};

type DiscoveryCaseRow = {
  id: string;
  category_key: string;
  title: string;
  cover_image_url: string;
  author_name: string;
  author_avatar_url: string;
  view_count: number;
  like_count: number;
  case_url: string;
  seed_prompt: string;
};

/** One `input_mentions` entry, kept as a loose record: extra fields pass through. */
type InputMention = Record<string, unknown>;

const EXAMPLE_CATEGORIES_SQL =
  "select key, label from public.home_example_categories"
  + " where is_active = true order by sort_order, key";

const EXAMPLES_SQL =
  "select category_key, title, prompt, image_urls, input_mentions"
  + " from public.home_example_examples"
  + " where is_active = true order by sort_order, id";

const DISCOVERY_CATEGORIES_SQL =
  "select key, label from public.home_discovery_categories"
  + " where is_active = true order by sort_order, key";

const DISCOVERY_CASES_SQL =
  "select category_key, id, title, cover_image_url, author_name,"
  + " author_avatar_url, view_count, like_count, case_url, seed_prompt"
  + " from public.home_discovery_cases"
  + " where is_active = true order by sort_order, id";

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send(
    unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Missing or invalid bearer token.",
      },
    }),
  );
}

function unavailable(reply: FastifyReply) {
  return reply.code(500).send(
    applicationErrorResponseSchema.parse({
      error: {
        code: "application_error",
        message: "Home content is unavailable.",
      },
    }),
  );
}

/**
 * True when the stored value is a bare object key.
 *
 * Values that already stand on their own are returned untouched: an absolute URL
 * (a seed that was never migrated, or an externally hosted image) and a
 * root-relative link (`/objects/...` in `fs` mode) need no signature.
 */
function isObjectKey(value: string): boolean {
  if (value.length === 0) return false;
  if (HAS_SCHEME.test(value)) return false;
  if (value.startsWith("/")) return false;
  return true;
}

/** The `input_mentions` jsonb, whatever shape it came back in. */
function asMentions(value: unknown): InputMention[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is InputMention =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function mentionImgSrc(mention: InputMention): string | null {
  const src = mention.imgSrc;
  return typeof src === "string" ? src : null;
}

function imageKeysOf(row: ExampleRow): string[] {
  return (row.image_urls ?? []).filter(
    (value): value is string => typeof value === "string",
  );
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, keeping the input
 * order. Written out instead of `Promise.all(items.map(…))` because the point is
 * the bound, not the parallelism.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];

  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          const item = items[index] as T;
          results[index] = await fn(item);
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

/**
 * Sign every distinct object key once, bounded by `SIGN_CONCURRENCY`.
 *
 * A key that cannot be signed is simply absent from the returned map: the
 * builders below then keep the stored value (43I's "missing means original").
 */
async function signKeys(
  store: ObjectStore,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const unique = [...new Set(keys.filter(isObjectKey))];

  await mapWithLimit(unique, SIGN_CONCURRENCY, async (key) => {
    try {
      const signed = await store.signedReadUrl(
        { bucket: HOME_SEEDS_BUCKET, key },
        { ttlSeconds: SIGNED_URL_TTL_SECONDS },
      );
      urls.set(key, signed);
    } catch {
      // Intentionally swallowed: see the header comment — a preview that cannot
      // be signed keeps its stored key instead of failing the whole request.
    }
    return null;
  });

  return urls;
}

/** Replace a stored value with its signed URL when one was produced. */
function resolved(urls: Map<string, string>, value: string): string {
  return urls.get(value) ?? value;
}

function exampleKeys(rows: readonly ExampleRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    keys.push(...imageKeysOf(row));
    for (const mention of asMentions(row.input_mentions)) {
      const src = mentionImgSrc(mention);
      if (src !== null) keys.push(src);
    }
  }
  return keys;
}

function discoveryKeys(rows: readonly DiscoveryCaseRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    keys.push(row.cover_image_url, row.author_avatar_url);
  }
  return keys;
}

function toExamples(
  row: ExampleRow,
  urls: Map<string, string>,
): {
  title: string;
  prompt: string;
  previewImages: string[];
  inputMentions: InputMention[];
} {
  const previewImages = imageKeysOf(row).map((key) => resolved(urls, key));
  const inputMentions = asMentions(row.input_mentions).map((mention) => {
    const src = mentionImgSrc(mention);
    if (src === null) return mention;
    return { ...mention, imgSrc: resolved(urls, src) };
  });

  return {
    title: row.title,
    prompt: row.prompt,
    previewImages,
    inputMentions,
  };
}

function toCase(
  row: DiscoveryCaseRow,
  urls: Map<string, string>,
): {
  id: string;
  title: string;
  coverImage: string;
  authorName: string;
  authorAvatar: string;
  viewCount: number;
  likeCount: number;
  caseUrl: string;
  seedPrompt: string;
} {
  return {
    id: row.id,
    title: row.title,
    coverImage: resolved(urls, row.cover_image_url),
    authorName: row.author_name,
    authorAvatar: resolved(urls, row.author_avatar_url),
    viewCount: row.view_count,
    likeCount: row.like_count,
    caseUrl: row.case_url,
    seedPrompt: row.seed_prompt,
  };
}

export function registerHomeRoutes(
  app: FastifyInstance,
  options: HomeRouteOptions,
): void {
  app.get("/api/home/examples", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);

    try {
      const pool = options.pool();
      const categories = await pool.query<CategoryRow>(EXAMPLE_CATEGORIES_SQL);
      const examples = await pool.query<ExampleRow>(EXAMPLES_SQL);

      const urls = await signKeys(options.store, exampleKeys(examples.rows));

      const grouped = new Map<string, ReturnType<typeof toExamples>[]>();
      for (const row of examples.rows) {
        const entry = toExamples(row, urls);
        const bucket = grouped.get(row.category_key);
        if (bucket) {
          bucket.push(entry);
        } else {
          grouped.set(row.category_key, [entry]);
        }
      }

      return reply.send({
        categories: categories.rows.map((category) => ({
          key: category.key,
          label: category.label,
          examples: grouped.get(category.key) ?? [],
        })),
      });
    } catch (error) {
      request.log.error({ err: error }, "home examples read failed");
      return unavailable(reply);
    }
  });

  app.get("/api/home/discovery", async (request, reply) => {
    const user = await options.auth.authenticate(request);
    if (!user) return unauthorized(reply);

    try {
      const pool = options.pool();
      const categories = await pool.query<CategoryRow>(
        DISCOVERY_CATEGORIES_SQL,
      );
      const cases = await pool.query<DiscoveryCaseRow>(DISCOVERY_CASES_SQL);

      const urls = await signKeys(options.store, discoveryKeys(cases.rows));

      const grouped = new Map<string, ReturnType<typeof toCase>[]>();
      for (const row of cases.rows) {
        const entry = toCase(row, urls);
        const bucket = grouped.get(row.category_key);
        if (bucket) {
          bucket.push(entry);
        } else {
          grouped.set(row.category_key, [entry]);
        }
      }

      return reply.send({
        categories: categories.rows.map((category) => ({
          key: category.key,
          label: category.label,
          cases: grouped.get(category.key) ?? [],
        })),
      });
    } catch (error) {
      request.log.error({ err: error }, "home discovery read failed");
      return unavailable(reply);
    }
  });
}
