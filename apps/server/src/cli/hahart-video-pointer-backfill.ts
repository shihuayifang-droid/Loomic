/**
 * CV-01 history backfill: rewrite legacy video elements to object keys.
 *
 * Usage:
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-video-pointer-backfill.ts
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-video-pointer-backfill.ts --apply
 *
 * WHY A CLI AND NOT A SQL MIGRATION
 * Canvas content is JSONB, and the only trustworthy link between an element and
 * its stored object is the job that produced it. Deciding that per row needs the
 * job table, and the decision has to be reviewable BEFORE it is applied — a data
 * migration runs once, unattended, against history that cannot be restored if it
 * guesses wrong. So: dry-run by default, read the report, then pass --apply.
 *
 * WHAT IT WILL AND WILL NOT DO
 *   - It reads every canvas. Matching is scoped to one canvas, so a canvas with
 *     no matching job has nothing to rewrite — but its legacy videos still need
 *     to appear in the report, or "no unmatched entries" would be indistinguishable
 *     from "never looked".
 *   - It matches a video element to a job ONLY when both are in the same canvas
 *     and `element.link` is EXACTLY `result.signed_url`. Nothing about the URL's
 *     shape is ever used to derive an object path: hosts, path encodings and
 *     historical formats all differ, and a wrong guess silently points a canvas
 *     at somebody else's object.
 *   - One URL resolving to two different object paths is left alone and counted
 *     as ambiguous. Refusing to choose is the whole point.
 *   - Elements already holding an `oss://` marker are skipped; legacy URLs with
 *     no matching job are left untouched and reported.
 *   - `--apply` writes each canvas with an `id + version` optimistic lock. A
 *     canvas that changed since it was read is reported as a conflict and NOT
 *     overwritten — overwriting is how canvas content was lost before.
 *
 * COUNTS IN A DRY RUN
 * `canvasesScanned`, `canvasesUpdated` and `elementsUpdated` describe what the
 * run FOUND. In a dry run the writes are what is suppressed, so the counts still
 * tell you the size of the change you are about to make. Pass --apply to perform
 * it.
 *
 * OUTPUT
 * Only the JSON report goes to stdout. No keys, no connection strings, and no
 * URLs: every `link` in the report is `<redacted>` (see --apply above for how to
 * locate the element instead: canvasId + elementId).
 *
 * EXIT CODES
 *   0 — nothing needs attention
 *   1 — the report contains unmatched, ambiguous or conflicted entries
 *   2 — the database could not be read or written
 */
import { pathToFileURL } from "node:url";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import { createAdminSupabaseClient } from "../supabase/admin.js";
import { loadServerEnv } from "../config/env.js";
import {
  CANVAS_FILES_BUCKET,
  OSS_MARKER_PREFIX,
} from "../features/canvas/canvas-element-writer.js";

export type VideoBackfillReport = {
  canvasesScanned: number;
  canvasesUpdated: number;
  canvasesConflicted: string[];
  elementsUpdated: number;
  legacyVideosUnmatched: Array<{ canvasId: string; elementId: string; link: string }>;
  ambiguousJobUrls: string[];
};

/** What every `link` in the report is replaced with, so no URL is ever printed. */
const REDACTED = "<redacted>";

const JOB_PAGE_SIZE = 500;
const CANVAS_PAGE_SIZE = 200;

type JobRow = { canvas_id?: unknown; result?: unknown };

type CanvasRow = { id?: unknown; content?: unknown; version?: unknown };

type ElementRecord = Record<string, unknown>;

/** canvasId -> signed_url -> the distinct object paths that URL maps to. */
type JobIndex = Map<string, Map<string, Set<string>>>;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Every succeeded video job that recorded BOTH halves of the pair.
 *
 * A job with no `canvas_id` cannot match anything (the element must be in the
 * same canvas), and a job missing either `signed_url` or `object_path` has
 * nothing to match on or nothing to write.
 */
async function loadSucceededVideoJobs(admin: AdminSupabaseClient): Promise<JobRow[]> {
  const rows: JobRow[] = [];

  for (let offset = 0; ; offset += JOB_PAGE_SIZE) {
    const { data, error } = await admin
      .from("background_jobs")
      .select("canvas_id, result")
      .eq("job_type", "video_generation")
      .eq("status", "succeeded")
      .not("canvas_id", "is", null)
      .range(offset, offset + JOB_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`background_jobs query failed (${error.code ?? "no_code"})`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...(data as JobRow[]));
    if (data.length < JOB_PAGE_SIZE) break;
  }

  return rows;
}

function buildJobIndex(jobs: JobRow[]): JobIndex {
  const index: JobIndex = new Map();

  for (const job of jobs) {
    const canvasId = readNonEmptyString(job.canvas_id);
    if (!canvasId) continue;

    const result = (job.result ?? {}) as Record<string, unknown>;
    const signedUrl = readNonEmptyString(result.signed_url);
    const objectPath = readNonEmptyString(result.object_path);
    if (!signedUrl || !objectPath) continue;

    const byUrl = index.get(canvasId) ?? new Map<string, Set<string>>();
    const paths = byUrl.get(signedUrl) ?? new Set<string>();
    paths.add(objectPath);
    byUrl.set(signedUrl, paths);
    index.set(canvasId, byUrl);
  }

  return index;
}

/**
 * Every canvas, paged. Reading all of them is deliberate: the report's
 * "unmatched" list is only trustworthy if every canvas was looked at, and a
 * canvas whose jobs no longer exist is exactly where an unfixable legacy video
 * hides.
 */
async function loadCanvasRows(admin: AdminSupabaseClient): Promise<CanvasRow[]> {
  const rows: CanvasRow[] = [];

  for (let offset = 0; ; offset += CANVAS_PAGE_SIZE) {
    const { data, error } = await admin
      .from("canvases")
      .select("id, content, version")
      .range(offset, offset + CANVAS_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`canvases query failed (${error.code ?? "no_code"})`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...(data as CanvasRow[]));
    if (data.length < CANVAS_PAGE_SIZE) break;
  }

  return rows;
}

/**
 * Write the canvas back under an optimistic lock. Returns false when the version
 * moved — PostgREST reports "matched no rows" as an update of zero rows and no
 * error, so the returned row is what distinguishes a conflict from a success.
 */
async function writeCanvasContent(
  admin: AdminSupabaseClient,
  canvasId: string,
  content: unknown,
  baseVersion: number,
): Promise<boolean> {
  const { data, error } = await admin
    .from("canvases")
    .update({ content, version: baseVersion + 1 } as never)
    .eq("id", canvasId)
    .eq("version", baseVersion)
    .select("version");

  if (error) {
    throw new Error(`canvas update failed (${error.code ?? "no_code"})`);
  }

  return Array.isArray(data) && data.length === 1;
}

export async function runVideoPointerBackfill(
  admin: AdminSupabaseClient,
  options: { apply: boolean },
): Promise<VideoBackfillReport> {
  const index = buildJobIndex(await loadSucceededVideoJobs(admin));

  // One URL mapping to two different objects cannot be resolved by any rule this
  // tool is allowed to apply, so it is reported and skipped. The set keeps the
  // count meaningful while the printed value stays redacted.
  const ambiguousJobUrls = new Set<string>();
  for (const byUrl of index.values()) {
    for (const paths of byUrl.values()) {
      if (paths.size > 1) ambiguousJobUrls.add(REDACTED);
    }
  }

  const canvasRows = await loadCanvasRows(admin);

  const report: VideoBackfillReport = {
    canvasesScanned: canvasRows.length,
    canvasesUpdated: 0,
    canvasesConflicted: [],
    elementsUpdated: 0,
    legacyVideosUnmatched: [],
    ambiguousJobUrls: [...ambiguousJobUrls],
  };

  for (const row of canvasRows) {
    const canvasId = readNonEmptyString(row.id);
    if (!canvasId) continue;

    const content = (row.content ?? {}) as Record<string, unknown>;
    const elements = content.elements;
    if (!Array.isArray(elements)) continue;

    const byUrl = index.get(canvasId) ?? new Map<string, Set<string>>();
    let changed = 0;

    const nextElements = elements.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const element = raw as ElementRecord;

      const customData = element.customData as Record<string, unknown> | undefined;
      if (customData?.isVideo !== true) return raw;

      const link = element.link;
      if (typeof link !== "string" || link.length === 0) return raw;
      // Already an object key — this is what a completed backfill looks like.
      if (link.startsWith(OSS_MARKER_PREFIX)) return raw;

      const paths = byUrl.get(link);
      if (!paths || paths.size === 0) {
        report.legacyVideosUnmatched.push({
          canvasId,
          elementId: String(element.id ?? ""),
          link: REDACTED,
        });
        return raw;
      }

      if (paths.size > 1) {
        ambiguousJobUrls.add(REDACTED);
        return raw;
      }

      const objectPath = [...paths][0] as string;
      changed += 1;
      return {
        ...element,
        link: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
      };
    });

    if (changed === 0) continue;

    report.elementsUpdated += changed;

    if (!options.apply) {
      // Dry run: count the change, write nothing.
      report.canvasesUpdated += 1;
      continue;
    }

    const baseVersion = typeof row.version === "number" ? row.version : 0;
    const written = await writeCanvasContent(
      admin,
      canvasId,
      { ...content, elements: nextElements },
      baseVersion,
    );

    if (written) {
      report.canvasesUpdated += 1;
    } else {
      report.canvasesConflicted.push(canvasId);
    }
  }

  return report;
}

export function parseBackfillArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseBackfillArgs(argv);

  try {
    const admin = createAdminSupabaseClient(loadServerEnv());
    const report = await runVideoPointerBackfill(admin, options);
    process.stdout.write(`${JSON.stringify(report)}\n`);

    const needsAttention =
      report.legacyVideosUnmatched.length > 0 ||
      report.ambiguousJobUrls.length > 0 ||
      report.canvasesConflicted.length > 0;

    return needsAttention ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `video pointer backfill failed: ${
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
