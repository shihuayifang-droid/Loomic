/**
 * X-52 prep: copy the PUBLIC home-seed objects out of the user-asset bucket.
 *
 * Usage:
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-home-seeds-migrate.ts
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-home-seeds-migrate.ts --apply
 *
 * DRY RUN BY DEFAULT. `--apply` must be an explicit, authorised act: it is the
 * step that makes the home page depend on the new bucket, so the report has to be
 * clean (no conflicts, no unmatched URLs) and a human has to have read it first.
 *
 * THE OBJECT-KEY ARITHMETIC (the part that is easy to get wrong)
 * A seed lives in `project-assets` under the key `home-seeds/discovery/x.webp`,
 * and its public URL ends `/object/public/project-assets/home-seeds/discovery/x.webp`.
 * After the prefix rewrite the URL becomes `/object/public/home-seeds/discovery/x.webp`,
 * so the object in the NEW bucket must be keyed `discovery/x.webp` — the leading
 * `home-seeds/` belongs to the OLD bucket's key, not to the new one. Copying to
 * the unchanged key would produce `home-seeds/home-seeds/…` and 404 the home page.
 *
 * WHAT IT WILL NOT DO
 *   - It never writes to `project-assets` and never deletes a source object: the
 *     old bucket stays public and stays the only copy until the real cutover is
 *     verified separately.
 *   - It only rewrites the EXACT public seed prefix in the four URL columns. Any
 *     other text — including a string that merely mentions `home-seeds` — is left
 *     byte-for-byte alone.
 *   - It never overwrites a target object: a key that exists with a different size
 *     is reported as a conflict and skipped.
 *
 * COUNTS IN A DRY RUN
 * `sourceObjects`, `targetCreated`, `targetAlreadyPresent`, the row counters and
 * `unmatchedSeedUrls` describe what the run FOUND; the writes are what a dry run
 * suppresses. So the report still tells you the size of the change.
 *
 * OUTPUT
 * Only the JSON report goes to stdout. No keys, no connection strings, and no
 * URLs: object lists use bucket-relative keys and every URL is `<redacted>`.
 *
 * EXIT CODES
 *   0 — nothing left to do (no conflicts, no unmatched URLs)
 *   1 — conflicts or unmatched URLs need a human
 *   2 — the storage or database could not be read/written
 */
import { pathToFileURL } from "node:url";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import { createAdminSupabaseClient } from "../supabase/admin.js";
import { loadServerEnv } from "../config/env.js";

export type HomeSeedsMigrationReport = {
  sourceObjects: number;
  targetCreated: number;
  targetAlreadyPresent: number;
  targetConflicts: string[];
  exampleRowsUpdated: number;
  discoveryRowsUpdated: number;
  unmatchedSeedUrls: string[];
  apply: boolean;
};

const SOURCE_BUCKET = "project-assets";
const TARGET_BUCKET = "home-seeds";
/** Key prefix inside the SOURCE bucket; also the leading segment the target drops. */
const SEED_KEY_PREFIX = "home-seeds/";

const SOURCE_PUBLIC_PREFIX = "/storage/v1/object/public/project-assets/home-seeds/";
const TARGET_PUBLIC_PREFIX = "/storage/v1/object/public/home-seeds/";

/** What every URL and every report entry that could leak one is replaced with. */
const REDACTED = "<redacted>";

const LIST_PAGE_SIZE = 100;
const ROW_PAGE_SIZE = 200;

type StorageEntry = {
  name: string;
  id: string | null;
  metadata?: { size?: number | null } | null;
};

type SourceObject = { key: string; targetKey: string; size: number };

type ExampleRow = {
  id?: unknown;
  image_urls?: unknown;
  input_mentions?: unknown;
};

type DiscoveryRow = {
  id?: unknown;
  cover_image_url?: unknown;
  author_avatar_url?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Anything that is not a seeded object URL is left exactly as it is. */
export function projectSeedUrl(url: string): string {
  return url.split(SOURCE_PUBLIC_PREFIX).join(TARGET_PUBLIC_PREFIX);
}

/**
 * Classify one string so the report can distinguish "already migrated" from
 * "unmatched, needs a human". A string is only ever `unmatched` when it looks
 * like a seed URL (http + a `home-seeds/` segment) but carries a prefix this tool
 * is not allowed to rewrite — never for prose that merely mentions the word.
 */
function classify(value: string): "rewrite" | "already" | "unmatched" | "ignore" {
  if (value.includes(SOURCE_PUBLIC_PREFIX)) return "rewrite";
  if (value.includes(TARGET_PUBLIC_PREFIX)) return "already";
  if (/^https?:\/\//i.test(value) && value.includes(SEED_KEY_PREFIX)) {
    return "unmatched";
  }
  return "ignore";
}

/**
 * Rewrite every seeded URL inside an arbitrary JSON value (input_mentions is a
 * jsonb array of `{ imgSrc }` objects), collecting the ones that need a human.
 */
function rewriteJsonValue(
  value: unknown,
  unmatched: Set<string>,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const kind = classify(value);
    if (kind === "rewrite") return { value: projectSeedUrl(value), changed: true };
    if (kind === "unmatched") unmatched.add(REDACTED);
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = rewriteJsonValue(entry, unmatched);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = rewriteJsonValue(entry, unmatched);
      changed = changed || result.changed;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }

  return { value, changed: false };
}

/** Rewrite a `text[]` column, reporting how many entries changed. */
function rewriteTextArray(
  value: unknown,
  unmatched: Set<string>,
): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };

  let changed = false;
  const next = value.map((entry) => {
    const text = readString(entry);
    if (text === undefined) return entry;
    const kind = classify(text);
    if (kind === "rewrite") {
      changed = true;
      return projectSeedUrl(text);
    }
    if (kind === "unmatched") unmatched.add(REDACTED);
    return entry;
  });

  return { value: changed ? next : value, changed };
}

/** One folder's worth of entries, following the storage list pagination. */
async function listFolder(
  admin: AdminSupabaseClient,
  bucket: string,
  prefix: string,
): Promise<StorageEntry[]> {
  const entries: StorageEntry[] = [];

  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await admin.storage
      .from(bucket)
      .list(prefix, { limit: LIST_PAGE_SIZE, offset });

    if (error) {
      throw new Error(`list ${bucket}/${prefix || "."} failed: ${error.message ?? "no message"}`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    entries.push(...(data as StorageEntry[]));
    if (data.length < LIST_PAGE_SIZE) break;
  }

  return entries;
}

/**
 * Every seeded object, walking the folder tree. `id === null` marks a folder in
 * the storage API's response, which is the only signal it gives for one.
 */
async function walkSourceObjects(
  admin: AdminSupabaseClient,
  prefix: string,
  into: SourceObject[],
): Promise<void> {
  for (const entry of await listFolder(admin, SOURCE_BUCKET, prefix)) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.id === null) {
      await walkSourceObjects(admin, key, into);
      continue;
    }

    const targetKey = key.startsWith(SEED_KEY_PREFIX)
      ? key.slice(SEED_KEY_PREFIX.length)
      : key;
    into.push({ key, targetKey, size: Number(entry.metadata?.size ?? -1) });
  }
}

/** Target keys already present, with the size the copy would have to match. */
async function loadTargetSizes(
  admin: AdminSupabaseClient,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await listFolder(admin, TARGET_BUCKET, prefix)) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        await walk(key);
        continue;
      }
      sizes.set(key, Number(entry.metadata?.size ?? -1));
    }
  };
  await walk("");
  return sizes;
}

async function copyObject(
  admin: AdminSupabaseClient,
  source: SourceObject,
): Promise<void> {
  const { data, error } = await admin.storage.from(SOURCE_BUCKET).download(source.key);
  if (error || data === null || data === undefined) {
    throw new Error(`download ${source.key} failed: ${error?.message ?? "no data"}`);
  }

  const { error: uploadError } = await admin.storage
    .from(TARGET_BUCKET)
    .upload(source.targetKey, data, { upsert: false });

  if (uploadError) {
    throw new Error(`upload ${source.targetKey} failed: ${uploadError.message ?? "no message"}`);
  }
}

type SeedTable = "home_example_examples" | "home_discovery_cases";

/** The two seed tables are read with literal names so the generated types apply. */
async function loadExampleRows(admin: AdminSupabaseClient): Promise<ExampleRow[]> {
  const rows: ExampleRow[] = [];

  for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
    const { data, error } = await admin
      .from("home_example_examples")
      .select("id, image_urls, input_mentions")
      .range(offset, offset + ROW_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`home_example_examples query failed (${error.code ?? "no_code"})`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...(data as ExampleRow[]));
    if (data.length < ROW_PAGE_SIZE) break;
  }

  return rows;
}

async function loadDiscoveryRows(admin: AdminSupabaseClient): Promise<DiscoveryRow[]> {
  const rows: DiscoveryRow[] = [];

  for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
    const { data, error } = await admin
      .from("home_discovery_cases")
      .select("id, cover_image_url, author_avatar_url")
      .range(offset, offset + ROW_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`home_discovery_cases query failed (${error.code ?? "no_code"})`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...(data as DiscoveryRow[]));
    if (data.length < ROW_PAGE_SIZE) break;
  }

  return rows;
}

async function updateRow(
  admin: AdminSupabaseClient,
  table: SeedTable,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // The patch is built dynamically from whichever columns actually changed, which
  // the generated per-table Update type cannot express.
  const { error } = await admin
    .from(table)
    .update(patch as never)
    .eq("id", id);

  if (error) throw new Error(`${table} update failed (${error.code ?? "no_code"})`);
}

export async function runHomeSeedsMigration(
  admin: AdminSupabaseClient,
  options: { apply: boolean },
): Promise<HomeSeedsMigrationReport> {
  const unmatchedSeedUrls = new Set<string>();

  // ---- storage: what to copy -------------------------------------------------
  const sources: SourceObject[] = [];
  await walkSourceObjects(admin, "home-seeds", sources);

  const targetSizes = await loadTargetSizes(admin);

  const toCreate: SourceObject[] = [];
  const targetConflicts: string[] = [];
  let targetAlreadyPresent = 0;

  for (const source of sources) {
    const existing = targetSizes.get(source.targetKey);

    if (existing === undefined) {
      toCreate.push(source);
      continue;
    }
    if (existing === source.size) {
      targetAlreadyPresent += 1;
      continue;
    }
    // Same key, different bytes: overwriting is how a published seed would be
    // silently replaced, so it is a conflict for a human to resolve.
    targetConflicts.push(source.targetKey);
  }

  // ---- database: which rows still carry the old public prefix ----------------
  const exampleRows = await loadExampleRows(admin);
  const examplePatches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  for (const row of exampleRows) {
    const id = readString(row.id);
    if (!id) continue;

    const images = rewriteTextArray(row.image_urls, unmatchedSeedUrls);
    const mentions = rewriteJsonValue(row.input_mentions, unmatchedSeedUrls);
    if (!images.changed && !mentions.changed) continue;

    examplePatches.push({
      id,
      patch: {
        ...(images.changed ? { image_urls: images.value } : {}),
        ...(mentions.changed ? { input_mentions: mentions.value } : {}),
      },
    });
  }

  const discoveryRows = await loadDiscoveryRows(admin);
  const discoveryPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  for (const row of discoveryRows) {
    const id = readString(row.id);
    if (!id) continue;

    const patch: Record<string, unknown> = {};
    for (const column of ["cover_image_url", "author_avatar_url"] as const) {
      const text = readString(row[column]);
      if (text === undefined) continue;

      const kind = classify(text);
      if (kind === "rewrite") patch[column] = projectSeedUrl(text);
      else if (kind === "unmatched") unmatchedSeedUrls.add(REDACTED);
    }

    if (Object.keys(patch).length > 0) discoveryPatches.push({ id, patch });
  }

  // ---- write (or not) --------------------------------------------------------
  let targetCreated = 0;

  if (options.apply) {
    for (const source of toCreate) {
      await copyObject(admin, source);
      targetCreated += 1;
    }
    for (const entry of examplePatches) {
      await updateRow(admin, "home_example_examples", entry.id, entry.patch);
    }
    for (const entry of discoveryPatches) {
      await updateRow(admin, "home_discovery_cases", entry.id, entry.patch);
    }
  } else {
    // Dry run: the counts describe the change, the writes do not happen.
    targetCreated = toCreate.length;
  }

  return {
    sourceObjects: sources.length,
    targetCreated,
    targetAlreadyPresent,
    targetConflicts,
    exampleRowsUpdated: examplePatches.length,
    discoveryRowsUpdated: discoveryPatches.length,
    unmatchedSeedUrls: [...unmatchedSeedUrls],
    apply: options.apply,
  };
}

export function parseHomeSeedsArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseHomeSeedsArgs(argv);

  try {
    const admin = createAdminSupabaseClient(loadServerEnv());
    const report = await runHomeSeedsMigration(admin, options);
    process.stdout.write(`${JSON.stringify(report)}\n`);

    const needsAttention =
      report.targetConflicts.length > 0 || report.unmatchedSeedUrls.length > 0;

    return needsAttention ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `home seeds migration failed: ${
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
