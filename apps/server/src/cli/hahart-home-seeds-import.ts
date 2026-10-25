/**
 * T-128 slice 1 (OP-04): import the home-page seed libraries.
 *
 * Usage:
 *   pnpm --filter @loomic/server run home:seeds:import
 *   pnpm --filter @loomic/server run home:seeds:import -- --apply
 *
 * DRY RUN BY DEFAULT. A dry run reads the seed modules, plans every object, and
 * prints the five counters the ticket asks for; it writes no row and no object.
 * `--apply` is the act that fills the database and the private volume.
 *
 * WHERE THE BYTES COME FROM
 * The seed modules ship PUBLIC URLs (no local files), so this tool downloads
 * each image ONCE over plain HTTPS and stores the bytes in our own bucket. That
 * removes the long-term dependency on the old Supabase project without deleting
 * anything there: the old bucket stays public and untouched.
 *
 * The URLs the modules export are already projected onto the `home-seeds` bucket
 * (see `apps/web/src/lib/home-seeds-url.ts`), but that bucket does not exist in
 * the old project yet — the bytes still live under
 * `project-assets/home-seeds/<key>`. So a fetch tries the URL it was given, and
 * if that fails tries the legacy location for the SAME key. Both attempts are
 * plain HTTPS GETs with a timeout and one retry.
 *
 * WHAT GOES INTO THE DATABASE
 * Object keys only (`image_urls`, `input_mentions[].imgSrc`, `cover_image_url`,
 * `author_avatar_url`). A remote URL is never written to a row, so a bucket
 * change is a storage move and not a data migration.
 *
 * IDEMPOTENT
 * `apps/server/db/canonical/0012_brand_skills_home.sql` gives every table a
 * natural key (`key`, `id`, `(category_key, sort_order)`). Every write is
 * "look first, insert only when absent", and an object is uploaded only when the
 * store has no object at that key, so a second `--apply` changes nothing.
 *
 * A FAILED DOWNLOAD IS NOT A FAILED RUN
 * A URL that 404s or times out is collected, reported at the end, and the rest of
 * the run continues. The exit code only speaks about the database and the store.
 *
 * OUTPUT (stdout)
 * One counters line, then the write summary, then the failure list:
 *   categories=<n> examples=<n> discovery_categories=<n> discovery_cases=<n> objects=<n> fetched_bytes=<n>
 *   apply=<bool> uploaded=<n> skipped_existing=<n> rows_inserted=<n>
 *   failed=<n>
 *   FAIL <url> :: <reason>
 *
 * EXIT CODES
 *   0 — the run finished (download failures are reported, not fatal)
 *   2 — the seed modules, the object volume or the database could not be used
 */
import { pathToFileURL } from "node:url";

import { loadServerEnv } from "../config/env.js";
import { createDatabasePool, resolveDatabaseUrl } from "../db/pool.js";
import { createFsObjectStore } from "../features/storage/fs-object-store.js";
import { objectUrlSecretFrom } from "../features/storage/object-url-signature.js";
import type { ObjectStore } from "../features/storage/object-store.js";

/** The bucket the imported seeds live in (same one the seed modules project to). */
export const HOME_SEEDS_BUCKET = "home-seeds";

/** Public path of the NEW bucket, i.e. the URL shape the seed modules export. */
const HOME_SEEDS_PUBLIC_PATH = "/storage/v1/object/public/home-seeds/";

/** Public path of the OLD location that still holds the bytes today. */
const LEGACY_HOME_SEEDS_PUBLIC_PATH =
  "/storage/v1/object/public/project-assets/home-seeds/";

/** Per-request timeout, per the ticket. */
const REQUEST_TIMEOUT_MS = 30_000;

/** One retry per URL, per the ticket. */
const ATTEMPTS_PER_URL = 2;

const DEFAULT_CONCURRENCY = 8;

const SEED_MODULE_URLS = {
  examples: "../../../web/src/lib/home-example-seeds.ts",
  discovery: "../../../web/src/lib/home-discovery-seeds.ts",
} as const;

// ---------------------------------------------------------------------------
// Seed module shapes (structural copies of the loader's types)
// ---------------------------------------------------------------------------

export type HomeSeedInputMention = {
  type: string;
  name: string;
  imgSrc: string;
};

export type HomeSeedCard = {
  title: string;
  prompt: string;
  previewImages: string[];
  inputMentions: HomeSeedInputMention[];
};

export type HomeSeedCategory = {
  key: string;
  label: string;
  dataType: string;
  accent?: "special";
  examples: HomeSeedCard[];
};

export type HomeSeedDiscoveryCase = {
  id: string;
  title: string;
  coverImageUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  viewCount: number;
  likeCount: number;
  prompt: string;
  sourceUrl?: string;
};

export type HomeSeedDiscoveryCategory = {
  key: string;
  label: string;
  cases: HomeSeedDiscoveryCase[];
};

export type HomeSeedSources = {
  exampleCategories: HomeSeedCategory[];
  discoveryCategories: HomeSeedDiscoveryCategory[];
};

// ---------------------------------------------------------------------------
// The plan: rows and objects, computed without touching anything
// ---------------------------------------------------------------------------

/** One object to put, plus the remote URL its bytes come from. */
export type PlannedObject = {
  url: string;
  bucket: string;
  key: string;
  contentType: string;
};

export type ExampleCategoryRow = {
  key: string;
  label: string;
  dataType: string;
  accent: string | null;
  sortOrder: number;
};

export type ExampleRow = {
  categoryKey: string;
  title: string;
  prompt: string;
  imageUrls: string[];
  sortOrder: number;
  inputMentions: HomeSeedInputMention[];
};

export type DiscoveryCategoryRow = {
  key: string;
  label: string;
  sortOrder: number;
};

export type DiscoveryCaseRow = {
  id: string;
  categoryKey: string;
  title: string;
  coverImageUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  viewCount: number;
  likeCount: number;
  caseUrl: string;
  sortOrder: number;
  seedPrompt: string;
};

export type SeedPlan = {
  exampleCategories: ExampleCategoryRow[];
  examples: ExampleRow[];
  discoveryCategories: DiscoveryCategoryRow[];
  discoveryCases: DiscoveryCaseRow[];
  objects: PlannedObject[];
};

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  bin: "application/octet-stream",
};

/**
 * The extension of a URL, lowercased, without query string or fragment. Falls
 * back to `bin` so a URL without an extension still gets a stable object key.
 */
export function extensionOf(url: string): string {
  const withoutQuery = url.split("?")[0] ?? "";
  const path = withoutQuery.split("#")[0] ?? "";
  const tail = path.slice(path.lastIndexOf("/") + 1);
  const dot = tail.lastIndexOf(".");
  if (dot <= 0 || dot === tail.length - 1) {
    return "bin";
  }
  const raw = tail.slice(dot + 1).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]/g, "");
  return cleaned.length > 0 ? cleaned : "bin";
}

export function contentTypeOf(url: string): string {
  const extension = extensionOf(url);
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * The legacy location of the same object key, or an empty list when the URL is
 * not one of our seed URLs. Kept pure so the mapping is testable.
 */
export function legacySeedUrlCandidates(url: string): string[] {
  const index = url.indexOf(HOME_SEEDS_PUBLIC_PATH);
  if (index < 0) {
    return [];
  }
  const key = url.slice(index + HOME_SEEDS_PUBLIC_PATH.length);
  const origin = url.slice(0, index);
  return [`${origin}${LEGACY_HOME_SEEDS_PUBLIC_PATH}${key}`];
}

function exampleObjectKey(
  categoryKey: string,
  cardIndex: number,
  suffix: string,
  extension: string,
): string {
  return `examples/${categoryKey}/${cardIndex}-${suffix}.${extension}`;
}

function discoveryObjectKey(
  caseId: string,
  name: string,
  extension: string,
): string {
  return `discovery/${caseId}/${name}.${extension}`;
}

/**
 * Turn the seed modules into rows and object plans. Pure: no I/O, so the shape
 * of the import is testable without a network, a store or a database.
 */
export function buildSeedPlan(sources: HomeSeedSources): SeedPlan {
  const objects: PlannedObject[] = [];
  const exampleCategories: ExampleCategoryRow[] = [];
  const examples: ExampleRow[] = [];
  const discoveryCategories: DiscoveryCategoryRow[] = [];
  const discoveryCases: DiscoveryCaseRow[] = [];

  const planObject = (url: string, key: string): string => {
    objects.push({
      url,
      bucket: HOME_SEEDS_BUCKET,
      key,
      contentType: contentTypeOf(url),
    });
    return key;
  };

  sources.exampleCategories.forEach((category, categoryIndex) => {
    exampleCategories.push({
      key: category.key,
      label: category.label,
      dataType: category.dataType,
      accent: category.accent ?? null,
      sortOrder: categoryIndex,
    });

    category.examples.forEach((card, cardIndex) => {
      const imageUrls = card.previewImages.map((url, imageIndex) =>
        planObject(
          url,
          exampleObjectKey(
            category.key,
            cardIndex,
            String(imageIndex),
            extensionOf(url),
          ),
        ),
      );

      const inputMentions = card.inputMentions.map((mention, mentionIndex) => ({
        type: mention.type,
        name: mention.name,
        imgSrc: planObject(
          mention.imgSrc,
          exampleObjectKey(
            category.key,
            cardIndex,
            `m${mentionIndex}`,
            extensionOf(mention.imgSrc),
          ),
        ),
      }));

      examples.push({
        categoryKey: category.key,
        title: card.title,
        prompt: card.prompt,
        imageUrls,
        sortOrder: cardIndex,
        inputMentions,
      });
    });
  });

  sources.discoveryCategories.forEach((category, categoryIndex) => {
    discoveryCategories.push({
      key: category.key,
      label: category.label,
      sortOrder: categoryIndex,
    });

    category.cases.forEach((entry, caseIndex) => {
      const coverKey = planObject(
        entry.coverImageUrl,
        discoveryObjectKey(entry.id, "cover", extensionOf(entry.coverImageUrl)),
      );
      const avatarKey = planObject(
        entry.authorAvatarUrl,
        discoveryObjectKey(
          entry.id,
          "avatar",
          extensionOf(entry.authorAvatarUrl),
        ),
      );

      discoveryCases.push({
        id: entry.id,
        categoryKey: category.key,
        title: entry.title,
        coverImageUrl: coverKey,
        authorName: entry.authorName,
        authorAvatarUrl: avatarKey,
        viewCount: entry.viewCount,
        likeCount: entry.likeCount,
        caseUrl: entry.sourceUrl ?? "",
        sortOrder: caseIndex,
        seedPrompt: entry.prompt,
      });
    });
  });

  return {
    exampleCategories,
    examples,
    discoveryCategories,
    discoveryCases,
    objects,
  };
}

// ---------------------------------------------------------------------------
// HTTPS downloads
// ---------------------------------------------------------------------------

/** Downloads the bytes at a URL. Injected so tests never touch the network. */
export type FetchBytes = (url: string) => Promise<Buffer>;

async function getOnce(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.arrayBuffer();
    return Buffer.from(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The production fetcher: the URL it was given first, then the legacy location
 * of the same key, one retry each. The error that is thrown names the last URL
 * that failed and why.
 */
export function createSeedFetchBytes(
  options: {
    requestTimeoutMs?: number;
    attemptsPerUrl?: number;
  } = {},
): FetchBytes {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const attempts = options.attemptsPerUrl ?? ATTEMPTS_PER_URL;

  return async (url: string): Promise<Buffer> => {
    const candidates = [url, ...legacySeedUrlCandidates(url)];
    let lastReason = "no candidate URL";

    for (const candidate of candidates) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await getOnce(candidate, timeoutMs);
        } catch (error) {
          lastReason =
            error instanceof Error ? error.message : String(error);
        }
      }
    }

    throw new Error(lastReason);
  };
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

/** The one thing this tool needs from `pg`: a statement with positional params. */
export type SqlExecutor = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

/**
 * "Look first, insert only when absent", one method per natural key in 0012.
 * Kept as an interface so a test can watch every write.
 */
export type HomeSeedsRepository = {
  hasExampleCategory(key: string): Promise<boolean>;
  insertExampleCategory(row: ExampleCategoryRow): Promise<void>;
  hasExample(categoryKey: string, sortOrder: number): Promise<boolean>;
  insertExample(row: ExampleRow): Promise<void>;
  hasDiscoveryCategory(key: string): Promise<boolean>;
  insertDiscoveryCategory(row: DiscoveryCategoryRow): Promise<void>;
  hasDiscoveryCase(id: string): Promise<boolean>;
  insertDiscoveryCase(row: DiscoveryCaseRow): Promise<void>;
};

export function createPgHomeSeedsRepository(
  db: SqlExecutor,
): HomeSeedsRepository {
  const exists = async (sql: string, params: unknown[]): Promise<boolean> => {
    const result = await db.query(sql, params);
    return result.rows.length > 0;
  };

  return {
    hasExampleCategory: (key) =>
      exists(
        "select 1 from public.home_example_categories where key = $1",
        [key],
      ),

    insertExampleCategory: async (row) => {
      await db.query(
        "insert into public.home_example_categories " +
          "(key, label, data_type, accent, sort_order) " +
          "values ($1, $2, $3, $4, $5)",
        [row.key, row.label, row.dataType, row.accent, row.sortOrder],
      );
    },

    hasExample: (categoryKey, sortOrder) =>
      exists(
        "select 1 from public.home_example_examples " +
          "where category_key = $1 and sort_order = $2",
        [categoryKey, sortOrder],
      ),

    insertExample: async (row) => {
      await db.query(
        "insert into public.home_example_examples " +
          "(category_key, title, prompt, image_urls, sort_order, input_mentions) " +
          "values ($1, $2, $3, $4, $5, $6::jsonb)",
        [
          row.categoryKey,
          row.title,
          row.prompt,
          row.imageUrls,
          row.sortOrder,
          JSON.stringify(row.inputMentions),
        ],
      );
    },

    hasDiscoveryCategory: (key) =>
      exists(
        "select 1 from public.home_discovery_categories where key = $1",
        [key],
      ),

    insertDiscoveryCategory: async (row) => {
      await db.query(
        "insert into public.home_discovery_categories " +
          "(key, label, sort_order) values ($1, $2, $3)",
        [row.key, row.label, row.sortOrder],
      );
    },

    hasDiscoveryCase: (id) =>
      exists("select 1 from public.home_discovery_cases where id = $1", [id]),

    insertDiscoveryCase: async (row) => {
      await db.query(
        "insert into public.home_discovery_cases " +
          "(id, category_key, title, cover_image_url, author_name, " +
          "author_avatar_url, view_count, like_count, case_url, sort_order, " +
          "seed_prompt) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [
          row.id,
          row.categoryKey,
          row.title,
          row.coverImageUrl,
          row.authorName,
          row.authorAvatarUrl,
          row.viewCount,
          row.likeCount,
          row.caseUrl,
          row.sortOrder,
          row.seedPrompt,
        ],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type HomeSeedsImportDeps = {
  plan: SeedPlan;
  store: ObjectStore;
  /** Absent in a dry run, and absent in a test that only watches the plan. */
  repository: HomeSeedsRepository | null;
  fetchBytes: FetchBytes;
  apply: boolean;
  concurrency?: number;
  log?: (line: string) => void;
};

export type HomeSeedsImportSummary = {
  categories: number;
  examples: number;
  discoveryCategories: number;
  discoveryCases: number;
  objects: number;
  fetchedBytes: number;
  uploaded: number;
  skippedExisting: number;
  rowsInserted: number;
  failures: { url: string; reason: string }[];
  apply: boolean;
};

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined || index >= items.length) {
        return;
      }
      await run(item);
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
}

/**
 * Plan counters for the report. Pure, and the only definition of what the five
 * numbers on the counters line mean.
 */
export function countersOf(plan: SeedPlan): {
  categories: number;
  examples: number;
  discoveryCategories: number;
  discoveryCases: number;
  objects: number;
} {
  return {
    categories: plan.exampleCategories.length,
    examples: plan.examples.length,
    discoveryCategories: plan.discoveryCategories.length,
    discoveryCases: plan.discoveryCases.length,
    objects: plan.objects.length,
  };
}

/**
 * Download and store every planned object, then write the rows that are absent.
 * A dry run stops after the download pass: no `put`, no insert.
 */
export async function runHomeSeedsImport(
  deps: HomeSeedsImportDeps,
): Promise<HomeSeedsImportSummary> {
  const { plan, store, repository, fetchBytes, apply } = deps;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const counters = countersOf(plan);

  let fetchedBytes = 0;
  let uploaded = 0;
  let skippedExisting = 0;
  const failures: { url: string; reason: string }[] = [];

  // The same remote URL can back several objects (an icon reused by many
  // cards), so the bytes are downloaded once per run and reused.
  const downloaded = new Map<string, Buffer>();

  await mapWithConcurrency(
    plan.objects,
    deps.concurrency ?? DEFAULT_CONCURRENCY,
    async (object) => {
      const ref = { bucket: object.bucket, key: object.key };

      let present = false;
      try {
        present = (await store.head(ref)) !== null;
      } catch (error) {
        failures.push({
          url: object.url,
          reason: `head failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        return;
      }

      if (present) {
        skippedExisting += 1;
        return;
      }

      let bytes = downloaded.get(object.url);
      if (bytes === undefined) {
        try {
          bytes = await fetchBytes(object.url);
        } catch (error) {
          failures.push({
            url: object.url,
            reason: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        downloaded.set(object.url, bytes);
        fetchedBytes += bytes.length;
      }

      if (!apply) {
        return;
      }

      try {
        await store.put(ref, bytes, { contentType: object.contentType });
        uploaded += 1;
      } catch (error) {
        failures.push({
          url: object.url,
          reason: `put failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    },
  );

  let rowsInserted = 0;

  if (apply && repository) {
    for (const row of plan.exampleCategories) {
      if (await repository.hasExampleCategory(row.key)) continue;
      await repository.insertExampleCategory(row);
      rowsInserted += 1;
    }

    for (const row of plan.examples) {
      if (await repository.hasExample(row.categoryKey, row.sortOrder)) continue;
      await repository.insertExample(row);
      rowsInserted += 1;
    }

    for (const row of plan.discoveryCategories) {
      if (await repository.hasDiscoveryCategory(row.key)) continue;
      await repository.insertDiscoveryCategory(row);
      rowsInserted += 1;
    }

    for (const row of plan.discoveryCases) {
      if (await repository.hasDiscoveryCase(row.id)) continue;
      await repository.insertDiscoveryCase(row);
      rowsInserted += 1;
    }
  }

  log(
    `categories=${counters.categories} ` +
      `examples=${counters.examples} ` +
      `discovery_categories=${counters.discoveryCategories} ` +
      `discovery_cases=${counters.discoveryCases} ` +
      `objects=${counters.objects} ` +
      `fetched_bytes=${fetchedBytes}`,
  );
  log(
    `apply=${apply ? "true" : "false"} ` +
      `uploaded=${uploaded} ` +
      `skipped_existing=${skippedExisting} ` +
      `rows_inserted=${rowsInserted}`,
  );
  log(`failed=${failures.length}`);
  for (const failure of failures) {
    log(`FAIL ${failure.url} :: ${failure.reason}`);
  }

  return {
    ...counters,
    fetchedBytes,
    uploaded,
    skippedExisting,
    rowsInserted,
    failures,
    apply,
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function seedModuleUrl(relative: string): string {
  return new URL(relative, import.meta.url).href;
}

/**
 * Load the two seed modules. The paths are computed at run time and imported
 * dynamically because they live in another workspace (`apps/web`), which the
 * server's TypeScript project does not include.
 */
export async function loadSeedSources(): Promise<HomeSeedSources> {
  const exampleModule = (await import(seedModuleUrl(SEED_MODULE_URLS.examples))) as {
    homeExampleSeedCategories: HomeSeedCategory[];
  };
  const discoveryModule = (await import(
    seedModuleUrl(SEED_MODULE_URLS.discovery)
  )) as { homeDiscoverySeedCategories: HomeSeedDiscoveryCategory[] };

  return {
    exampleCategories: exampleModule.homeExampleSeedCategories,
    discoveryCategories: discoveryModule.homeDiscoverySeedCategories,
  };
}

export type HomeSeedsCliOptions = { apply: boolean; concurrency: number };

export function parseHomeSeedsArgs(argv: readonly string[]): HomeSeedsCliOptions {
  let concurrency = DEFAULT_CONCURRENCY;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--concurrency") {
      const raw = argv[index + 1];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        concurrency = parsed;
        index += 1;
      }
    }
  }

  return { apply: argv.includes("--apply"), concurrency };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseHomeSeedsArgs(argv);

  try {
    const env = loadServerEnv();

    if (env.storageProvider !== "fs") {
      process.stderr.write(
        "home seeds import needs the fs object volume " +
          "(set HAHART_STORAGE_PROVIDER=fs): the Supabase storage client is gone " +
          "(ticket 45BO).\n",
      );
      return 2;
    }

    const sources = await loadSeedSources();
    const plan = buildSeedPlan(sources);

    const store = createFsObjectStore({
      rootDir: env.objectRoot!,
      secret: objectUrlSecretFrom(env.objectUrlSecret!),
      publicBase: env.objectPublicBase!,
    });

    const pool = options.apply
      ? createDatabasePool(resolveDatabaseUrl())
      : null;

    try {
      const repository = pool
        ? createPgHomeSeedsRepository(pool)
        : null;

      await runHomeSeedsImport({
        plan,
        store,
        repository,
        fetchBytes: createSeedFetchBytes(),
        apply: options.apply,
        concurrency: options.concurrency,
      });
    } finally {
      if (pool) {
        await pool.end();
      }
    }

    return 0;
  } catch (error) {
    process.stderr.write(
      `home seeds import failed: ${
        error instanceof Error ? error.message : "unknown error"
      }\n`,
    );
    return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
