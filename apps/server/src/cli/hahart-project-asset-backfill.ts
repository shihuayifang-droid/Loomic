/**
 * X-52 prep: backfill project ownership for objects that were stored before
 * `record_project_asset` existed.
 *
 * Usage:
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-project-asset-backfill.ts
 *   node --env-file=../../.env.local --import tsx src/cli/hahart-project-asset-backfill.ts --apply
 *
 * DRY RUN BY DEFAULT, and `--apply` must be an explicit, authorised act: it
 * rewrites ownership rows that a private bucket will authorise against, so the
 * report has to be clean and a human has to have read it first.
 *
 * WHERE OWNERSHIP MAY COME FROM
 * Only from relations that the database can prove:
 *   1. a succeeded image/video job with `result.object_path` (project from the job,
 *      or from its canvas when the job predates `project_id`);
 *   2. a canvas's stored content — `oss://project-assets/<key>` files and video
 *      element links (project from the canvas it sits in);
 *   3. `projects.thumbnail_path` (project from the project itself);
 *   4. an existing `asset_objects` row with no project, when exactly one of the
 *      above names the same object.
 *
 * The object PATH is never used to guess a project: a path carries a workspace,
 * a timestamp and a job id, none of which identify a project. When two sources
 * disagree about an object, the object is reported as a conflict and left alone.
 *
 * A NOTE ON WHAT IT DOES NOT DO
 * It never overwrites a row that already names a different project, never deletes
 * anything, and never touches `projects` / `canvases` — it only calls the same
 * `record_project_asset` RPC the live workers use.
 *
 * OUTPUT
 * Only the JSON report goes to stdout. Object keys are bucket-relative and every
 * value that could carry a URL or a secret is `<redacted>`.
 *
 * EXIT CODES
 *   0 — nothing left to do (no conflicts, no unmatched objects)
 *   1 — conflicts or unmatched objects need a human
 *   2 — the database or storage could not be read/written
 */
import { pathToFileURL } from "node:url";

import type { AdminSupabaseClient } from "../supabase/admin.js";
import { createAdminSupabaseClient } from "../supabase/admin.js";
import { loadServerEnv } from "../config/env.js";

export type ProjectAssetBackfillReport = {
  discovered: number;
  recorded: number;
  alreadyCorrect: number;
  conflicts: string[];
  unmatched: string[];
  apply: boolean;
};

const BUCKET = "project-assets";
const OSS_MARKER_PREFIX = "oss://";
const REDACTED = "<redacted>";

const LIST_PAGE_SIZE = 100;
const ROW_PAGE_SIZE = 200;

type AdminClient = AdminSupabaseClient;

type Candidate = {
  objectPath: string;
  /** Where this candidate came from, for the operator reading the report. */
  source: "job" | "canvas-file" | "canvas-video" | "thumbnail";
  projectId: string | null;
  canvasId: string | null;
  createdBy: string | null;
  mimeType: string | null;
  byteSize: number | null;
};

type ExistingRow = {
  object_path: string;
  project_id: string | null;
  workspace_id: string;
  created_by: string | null;
};

type Plan = {
  objectPath: string;
  projectId: string;
  canvasId: string | null;
  createdBy: string;
  mimeType: string | null;
  byteSize: number | null;
  existing: ExistingRow | null;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `oss://project-assets/<key>` → `<key>`; anything else → undefined. */
function objectPathFromMarker(value: string): string | undefined {
  if (!value.startsWith(OSS_MARKER_PREFIX)) return undefined;
  const rest = value.slice(OSS_MARKER_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  if (rest.slice(0, slash) !== BUCKET) return undefined;
  const key = rest.slice(slash + 1);
  return key.length > 0 ? key : undefined;
}

/** Every `oss://` reference inside a stored canvas document. */
function collectCanvasMarkers(
  content: unknown,
  into: {
    files: Array<{ objectPath: string; mimeType: string | null }>;
    videos: string[];
  },
): void {
  if (!content || typeof content !== "object") return;
  const document = content as {
    files?: Record<string, { dataURL?: unknown; mimeType?: unknown }>;
    elements?: Array<{ type?: unknown; link?: unknown }>;
  };

  for (const file of Object.values(document.files ?? {})) {
    const dataURL = readString(file?.dataURL);
    if (!dataURL) continue;

    // base64 payloads and plain URLs are not stored objects; the helper returns
    // undefined for both, so only a real `oss://` marker is collected.
    const marked = objectPathFromMarker(dataURL);
    if (marked) {
      into.files.push({
        objectPath: marked,
        mimeType: readString(file?.mimeType) ?? null,
      });
    }
  }

  for (const element of document.elements ?? []) {
    const link = readString(element?.link);
    if (!link) continue;
    const marked = objectPathFromMarker(link);
    if (marked) into.videos.push(marked);
  }
}

async function loadAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: unknown;
    error: { code?: string } | null;
  }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = [];

  for (let offset = 0; ; offset += ROW_PAGE_SIZE) {
    const { data, error } = await fetchPage(offset, offset + ROW_PAGE_SIZE - 1);

    if (error) throw new Error(`${label} query failed (${error.code ?? "no_code"})`);
    if (!Array.isArray(data) || data.length === 0) break;

    rows.push(...(data as T[]));
    if (data.length < ROW_PAGE_SIZE) break;
  }

  return rows;
}

/** Paged `list` of one folder, so "does this object exist" is a real check. */
async function listFolder(admin: AdminClient, prefix: string): Promise<string[]> {
  const keys: string[] = [];

  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await admin.storage
      .from(BUCKET)
      .list(prefix, { limit: LIST_PAGE_SIZE, offset });

    if (error) {
      throw new Error(`list ${prefix || "."} failed: ${error.message ?? "no message"}`);
    }
    if (!Array.isArray(data) || data.length === 0) break;

    for (const entry of data as Array<{ name: string; id: string | null }>) {
      if (entry.id === null) continue;
      keys.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
    if (data.length < LIST_PAGE_SIZE) break;
  }

  return keys;
}

/** Objects that actually exist, resolved per referenced folder. */
async function existingObjects(
  admin: AdminClient,
  objectPaths: string[],
): Promise<Set<string>> {
  const folders = new Set<string>();
  for (const objectPath of objectPaths) {
    const slash = objectPath.lastIndexOf("/");
    folders.add(slash < 0 ? "" : objectPath.slice(0, slash));
  }

  const found = new Set<string>();
  for (const folder of folders) {
    for (const key of await listFolder(admin, folder)) found.add(key);
  }
  return found;
}

export async function runProjectAssetBackfill(
  admin: AdminClient,
  options: { apply: boolean },
): Promise<ProjectAssetBackfillReport> {
  // ---- the relations ownership may be derived from -------------------------
  const projects = await loadAllRows<{ id: string; workspace_id: string }>(
    (from, to) => admin.from("projects").select("id, workspace_id").range(from, to),
    "projects",
  );
  const projectWorkspace = new Map(projects.map((p) => [p.id, p.workspace_id]));

  const canvases = await loadAllRows<{
    id: string;
    project_id: string;
    content: unknown;
    created_by: string | null;
  }>(
    (from, to) =>
      admin.from("canvases").select("id, project_id, content, created_by").range(from, to),
    "canvases",
  );
  const canvasProject = new Map(canvases.map((c) => [c.id, c.project_id]));

  const candidates = new Map<string, Candidate[]>();
  const addCandidate = (candidate: Candidate) => {
    const list = candidates.get(candidate.objectPath) ?? [];
    list.push(candidate);
    candidates.set(candidate.objectPath, list);
  };

  // 1. succeeded generation jobs
  const jobs = await loadAllRows<{
    project_id: string | null;
    canvas_id: string | null;
    created_by: string | null;
    result: unknown;
  }>(
    (from, to) =>
      admin
        .from("background_jobs")
        .select("project_id, canvas_id, created_by, result")
        .eq("status", "succeeded")
        .range(from, to),
    "background_jobs",
  );

  for (const job of jobs) {
    const result = (job.result ?? {}) as { object_path?: unknown; mime_type?: unknown };
    const objectPath = readString(result.object_path);
    if (!objectPath) continue;

    const projectId =
      job.project_id ?? (job.canvas_id ? (canvasProject.get(job.canvas_id) ?? null) : null);

    addCandidate({
      objectPath,
      source: "job",
      projectId,
      canvasId: job.canvas_id,
      createdBy: job.created_by,
      mimeType: readString(result.mime_type) ?? null,
      byteSize: null,
    });
  }

  // 2. canvas documents (files + videos) and 3. project thumbnails
  for (const canvas of canvases) {
    const collected = { files: [], videos: [] } as {
      files: Array<{ objectPath: string; mimeType: string | null }>;
      videos: string[];
    };
    collectCanvasMarkers(canvas.content, collected);

    for (const file of collected.files) {
      addCandidate({
        objectPath: file.objectPath,
        source: "canvas-file",
        projectId: canvas.project_id,
        canvasId: canvas.id,
        createdBy: canvas.created_by,
        mimeType: file.mimeType,
        byteSize: null,
      });
    }
    for (const objectPath of collected.videos) {
      addCandidate({
        objectPath,
        source: "canvas-video",
        projectId: canvas.project_id,
        canvasId: canvas.id,
        createdBy: canvas.created_by,
        mimeType: "video/mp4",
        byteSize: null,
      });
    }
  }

  const thumbnails = await loadAllRows<{
    id: string;
    thumbnail_path: string | null;
    created_by: string | null;
  }>(
    (from, to) =>
      admin.from("projects").select("id, thumbnail_path, created_by").range(from, to),
    "projects.thumbnail_path",
  );

  for (const project of thumbnails) {
    if (!project.thumbnail_path) continue;
    addCandidate({
      objectPath: project.thumbnail_path,
      source: "thumbnail",
      projectId: project.id,
      canvasId: null,
      createdBy: project.created_by,
      mimeType: null,
      byteSize: null,
    });
  }

  // ---- existing rows --------------------------------------------------------
  const assets = await loadAllRows<ExistingRow>(
    (from, to) =>
      admin
        .from("asset_objects")
        .select("object_path, project_id, workspace_id, created_by")
        .eq("bucket", BUCKET)
        .range(from, to),
    "asset_objects",
  );
  const existingByPath = new Map(assets.map((row) => [row.object_path, row]));

  // A row with no project is itself a reason to look, even when nothing else
  // references the object.
  for (const row of assets) {
    if (row.project_id === null && !candidates.has(row.object_path)) {
      candidates.set(row.object_path, []);
    }
  }

  const discovered = candidates.size;
  const present = await existingObjects(admin, [...candidates.keys()]);

  const conflicts: string[] = [];
  const unmatched: string[] = [];
  let alreadyCorrect = 0;
  const plans: Plan[] = [];

  for (const [objectPath, list] of candidates) {
    const existing = existingByPath.get(objectPath) ?? null;

    if (!present.has(objectPath)) {
      unmatched.push(objectPath);
      continue;
    }

    const projectIds = new Set(
      list.map((candidate) => candidate.projectId).filter((id): id is string => id !== null),
    );

    if (projectIds.size === 0) {
      // Nothing in the database says which project owns this object.
      unmatched.push(objectPath);
      continue;
    }
    if (projectIds.size > 1) {
      // Two sources disagree. Picking one would be a guess.
      conflicts.push(objectPath);
      continue;
    }

    const projectId = [...projectIds][0]!;
    const workspaceId = projectWorkspace.get(projectId);

    if (!workspaceId) {
      conflicts.push(objectPath);
      continue;
    }

    if (existing) {
      if (existing.project_id === projectId && existing.workspace_id === workspaceId) {
        alreadyCorrect += 1;
        continue;
      }
      if (existing.project_id !== null) {
        // A different project already owns it — never reassign silently.
        conflicts.push(objectPath);
        continue;
      }
    }

    const best = list[0]!;
    const createdBy = existing?.created_by ?? best.createdBy;

    if (!createdBy) {
      // Without an author there is nobody to authorise the object against.
      unmatched.push(objectPath);
      continue;
    }

    plans.push({
      objectPath,
      projectId,
      canvasId: best.canvasId,
      createdBy,
      mimeType: best.mimeType,
      byteSize: best.byteSize,
      existing,
    });
  }

  // ---- write (or not) --------------------------------------------------------
  let recorded = 0;

  if (options.apply) {
    for (const plan of plans) {
      // Optimistic guard: the row must still look the way it did when the plan
      // was made, or a concurrent worker has already claimed the object.
      const { data: current } = await admin
        .from("asset_objects")
        .select("project_id, workspace_id")
        .eq("bucket", BUCKET)
        .eq("object_path", plan.objectPath)
        .maybeSingle();

      const currentRow = current as { project_id: string | null } | null;
      const expectedProject = plan.existing?.project_id ?? null;

      if ((currentRow?.project_id ?? null) !== expectedProject) {
        conflicts.push(plan.objectPath);
        continue;
      }

      const { error } = await admin.rpc("record_project_asset", {
        p_bucket: BUCKET,
        p_object_path: plan.objectPath,
        p_created_by: plan.createdBy,
        p_fallback_workspace_id: projectWorkspace.get(plan.projectId)!,
        p_project_id: plan.projectId,
        p_canvas_id: plan.canvasId,
        p_mime_type: plan.mimeType,
        p_byte_size: plan.byteSize,
      });

      if (error) throw new Error(`record_project_asset failed: ${error.message}`);
      recorded += 1;
    }
  } else {
    // Dry run: the counts describe the change; no writes happen.
    recorded = plans.length;
  }

  return {
    discovered,
    recorded,
    alreadyCorrect,
    conflicts: [...new Set(conflicts)],
    unmatched: [...new Set(unmatched)],
    apply: options.apply,
  };
}

export function parseBackfillArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseBackfillArgs(argv);

  try {
    const admin = createAdminSupabaseClient(loadServerEnv());
    const report = await runProjectAssetBackfill(admin, options);
    process.stdout.write(`${JSON.stringify(report)}\n`);

    const needsAttention = report.conflicts.length > 0 || report.unmatched.length > 0;
    return needsAttention ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `project asset backfill failed: ${
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
