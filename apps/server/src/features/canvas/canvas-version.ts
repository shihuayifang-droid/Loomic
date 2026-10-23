// The only correct way to change canvases.content.
//
// THE BUG THIS EXISTS TO KILL
// All six writers of canvases.content did an unguarded read-modify-write:
//
//   const { data } = <select content from the canvases table via client>...
//   ...build a new elements array in JS...
//   await <update canvases set content = next via client>...
//
// Two writers reading the same row therefore each held a snapshot, and whoever
// wrote second replaced the whole array — erasing the other's work with no error
// anywhere. That is how generated images disappeared: the agent appended one,
// then a full save from the browser (which had read the canvas before the image
// existed) wrote its older array back over it. Nothing failed, nothing logged,
// and a reload made the loss permanent.
//
// TWO KINDS OF WRITE, TWO CORRECT ANSWERS TO A CONFLICT
//
//   Incremental (agent side: append an image, fill a placeholder, drop a failed
//   slot). The intent survives being re-applied to newer content, so on conflict
//   we re-read and re-apply. That is `mutateCanvasContent` below.
//
//   Whole-content replacement (the browser's PUT of its entire canvas state).
//   Re-applying is NOT possible: the new content IS the client's snapshot, so
//   retrying server-side would reinstate exactly the overwrite we are trying to
//   prevent. Only the client can merge. That is `replaceCanvasContent`, which
//   reports the conflict instead of resolving it.
//
// Getting this distinction wrong is how "optimistic concurrency" turns into the
// same data loss with extra steps.
import type { CanvasContent, Json } from "@loomic/shared";

// One definition of "safe to replay", shared with the agent-run, chat and project
// paths that hit the same proxy. It used to live in this file, back when the canvas
// was the only caller.
import { isTransportFailure } from "../../supabase/transport-retry.js";
import type { CanvasContentRepository } from "../../db/canvas-content-repository.js";

/** Minimal shape needed from a Supabase client, so tests can pass a fake. */
type CanvasClient = { from: (table: string) => any };

export type CanvasStoreRow = {
  id: string;
  name: string;
  project_id: string;
  content: unknown;
  version: number;
};

/**
 * Repository-backed storage. Accepted by the four exported functions below
 * beside the legacy client, so callers can migrate one at a time.
 */
export type CanvasStore = {
  readRow(canvasId: string): Promise<CanvasStoreRow | null>;
  writeIfUnchanged(
    canvasId: string,
    content: CanvasContent,
    expectedVersion: number,
  ): Promise<{ version: number } | null>;
};

/** Binds a canvas content repository and an actor into a CanvasStore. */
export function createRepositoryCanvasStore(
  repository: Pick<CanvasContentRepository, "readCanvasRow" | "writeIfUnchanged">,
  actorId: string,
): CanvasStore {
  return {
    readRow: (canvasId) => repository.readCanvasRow({ actorId, canvasId }),
    writeIfUnchanged: (canvasId, content, expectedVersion) =>
      repository.writeIfUnchanged({
        actorId,
        canvasId,
        content,
        expectedVersion,
      }),
  };
}

function isCanvasStore(x: CanvasClient | CanvasStore): x is CanvasStore {
  return typeof (x as CanvasStore).readRow === "function";
}

export class CanvasVersionConflictError extends Error {
  readonly code = "canvas_version_conflict";
  readonly statusCode = 409;
  /** Content as it actually is now, so the caller can merge against it. */
  readonly currentContent: CanvasContent;
  readonly currentVersion: number;

  constructor(
    message: string,
    currentContent: CanvasContent,
    currentVersion: number,
  ) {
    super(message);
    this.name = "CanvasVersionConflictError";
    this.currentContent = currentContent;
    this.currentVersion = currentVersion;
  }
}

export class CanvasNotFoundError extends Error {
  readonly code = "canvas_not_found";
  readonly statusCode = 404;
  constructor(canvasId: string) {
    super(`Canvas not found: ${canvasId}`);
    this.name = "CanvasNotFoundError";
  }
}

/**
 * The database could not be reached or refused to answer. NOT the same thing as
 * "no such canvas".
 *
 * THE BUG THIS EXISTS TO KILL
 * Every read of the canvases row did this:
 *
 *   const { data, error } = await <select from the canvases table>...single();
 *   if (error || !data) throw new CanvasNotFoundError(canvasId);
 *
 * `error` there covers a dropped TLS connection, a statement timeout, an RLS
 * misconfiguration — none of which say anything about whether the row exists.
 * Collapsing them into 404 meant a five-second proxy stall reached the user as a
 * red "Failed to load canvas.", i.e. an infrastructure blip impersonating data
 * loss on a product whose actual history includes losing canvas content. It also
 * removed the one signal that would have let the client retry: a 404 is final, a
 * 503 is not.
 *
 * 503 rather than 500 because nothing about the request was wrong; repeating it
 * is the correct response.
 */
export class CanvasUnavailableError extends Error {
  readonly code = "canvas_unavailable";
  readonly statusCode = 503;
  /** The underlying driver error, kept for logs. Not sent to clients. */
  readonly reason: unknown;
  constructor(canvasId: string, reason: unknown) {
    super(`Canvas is temporarily unavailable: ${canvasId}`);
    this.name = "CanvasUnavailableError";
    this.reason = reason;
  }
}

/** Read attempts, including the first. Transport failures only. */
const READ_MAX_ATTEMPTS = 3;

/**
 * The only correct way to read the canvases row.
 *
 * Three call sites used to hand-roll this — `readCanvasSnapshot`,
 * `canvas-service.getCanvas` and the `inspect_canvas` tool — and all three made
 * the same misclassification, because there was nowhere for the correct answer to
 * live. Add a reader here rather than a fourth `.single()`.
 *
 * `columns` is passed through to `select`, so callers still fetch only what they
 * need.
 */
export async function readCanvasRow<T>(
  client: CanvasClient | CanvasStore,
  canvasId: string,
  columns: string,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= READ_MAX_ATTEMPTS; attempt++) {
    if (isCanvasStore(client)) {
      // Store path: same classification, retry and logging as the legacy path.
      let row: CanvasStoreRow | null;
      try {
        row = await client.readRow(canvasId);
      } catch (err) {
        lastError = err;
        if (!isTransportFailure(err) || attempt >= READ_MAX_ATTEMPTS) break;
        const storeBackoffMs = attempt * 400;
        console.log(
          `[canvas-version] transport failure on read, retrying canvasId=${canvasId} ` +
            `attempt=${attempt} in=${storeBackoffMs}ms ` +
            `message=${(err as { message?: string }).message}`,
        );
        await new Promise((r) => setTimeout(r, storeBackoffMs));
        continue;
      }
      if (!row) throw new CanvasNotFoundError(canvasId);
      // Hand back only the columns the caller asked for, like `select(columns)`.
      const picked: Record<string, unknown> = {};
      for (const key of columns.split(",").map((c) => c.trim())) {
        if (key) picked[key] = (row as Record<string, unknown>)[key];
      }
      return picked as T;
    }
    // maybeSingle, NOT single. With `.single()` PostgREST reports "0 rows" as an
    // ERROR (code PGRST116) — so "this canvas does not exist" and "the
    // connection died" arrive in the same variable, and the only way to tell them
    // apart is to parse the message. That is precisely why the original code gave
    // up and treated both as 404. `.maybeSingle()` puts "no such row" in
    // `data === null` and leaves `error` meaning what it says.
    const { data, error } = await client
      .from("canvases")
      .select(columns)
      .eq("id", canvasId)
      .maybeSingle();

    if (!error) {
      if (!data) throw new CanvasNotFoundError(canvasId);
      return data as T;
    }

    lastError = error;
    if (!isTransportFailure(error) || attempt >= READ_MAX_ATTEMPTS) break;

    // Same rationale as the save path: one proxy blip must not be able to tell
    // the user their canvas is gone.
    const backoffMs = attempt * 400;
    console.log(
      `[canvas-version] transport failure on read, retrying canvasId=${canvasId} ` +
        `attempt=${attempt} in=${backoffMs}ms ` +
        `message=${(error as { message?: string }).message}`,
    );
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  const e = lastError as { code?: string; message?: string; details?: string } | null;
  // console.log, not console.error: stderr goes through PowerShell's error record
  // formatting in the tee'd dev log, which wraps and TRUNCATES the line.
  console.log(
    `[canvas-version] readCanvasRow failed canvasId=${canvasId} columns=${columns} ` +
      `pgCode=${e?.code ?? "?"} message=${e?.message ?? "?"} details=${e?.details ?? ""}`,
  );
  throw new CanvasUnavailableError(canvasId, lastError);
}

const EMPTY_CONTENT = {
  elements: [],
  appState: {},
  files: {},
} as unknown as CanvasContent;

export interface CanvasSnapshot {
  content: CanvasContent;
  version: number;
}

/**
 * Reads content together with the version it belongs to. Never read them apart.
 *
 * Throws CanvasNotFoundError (404) only when the row really is absent, and
 * CanvasUnavailableError (503) when the database could not answer — see
 * readCanvasRow.
 */
export async function readCanvasSnapshot(
  client: CanvasClient | CanvasStore,
  canvasId: string,
): Promise<CanvasSnapshot> {
  const row = await readCanvasRow<{ content?: unknown; version?: unknown }>(
    client,
    canvasId,
    "content, version",
  );

  return {
    content: (row.content as CanvasContent) ?? EMPTY_CONTENT,
    version: (row.version as number) ?? 0,
  };
}

/**
 * Applies `mutate` to the canvas content under optimistic concurrency.
 *
 * Return `null` from `mutate` to say "nothing to do" — no write is issued. That
 * is not an error: removeCanvasElement legitimately finds the element already
 * gone.
 *
 * On a version conflict the mutation is re-applied to freshly read content, up
 * to `maxAttempts`. This is safe only because every caller's intent is
 * incremental; see the note at the top of this file before adding a caller.
 */
export async function mutateCanvasContent(
  client: CanvasClient | CanvasStore,
  canvasId: string,
  mutate: (content: CanvasContent) => CanvasContent | null,
  opts: { maxAttempts?: number; label?: string } = {},
): Promise<CanvasSnapshot | null> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const label = opts.label ?? "mutateCanvasContent";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = await readCanvasSnapshot(client, canvasId);
    const next = mutate(snapshot.content);
    if (next === null) return null;

    const written = await writeIfUnchanged(client, canvasId, next, snapshot.version);
    if (written) {
      if (attempt > 1) {
        console.log(
          `[canvas-version] ${label} succeeded on attempt ${attempt} ` +
            `canvasId=${canvasId} version=${written.version}`,
        );
      }
      return written;
    }

    // Somebody else wrote between our read and our update. Their content is now
    // the base; re-apply on top of it. No backoff: the window is a single
    // round-trip and the retry is cheap compared to losing the write.
    console.log(
      `[canvas-version] ${label} version conflict, re-reading ` +
        `canvasId=${canvasId} staleVersion=${snapshot.version} attempt=${attempt}`,
    );
  }

  const latest = await readCanvasSnapshot(client, canvasId);
  throw new CanvasVersionConflictError(
    `${label}: could not apply change after ${maxAttempts} attempts — ` +
      `the canvas is being written to continuously`,
    latest.content,
    latest.version,
  );
}

/**
 * Replaces the entire content, but only if the caller's `baseVersion` is still
 * current. Throws CanvasVersionConflictError otherwise — deliberately WITHOUT
 * retrying, because a blind retry here is exactly the overwrite bug.
 *
 * `baseVersion` may be undefined for clients that have not been updated yet; in
 * that case the write is unconditional and the old lost-update behaviour applies.
 * Callers should log that case so it does not become permanent.
 */
export async function replaceCanvasContent(
  client: CanvasClient | CanvasStore,
  canvasId: string,
  content: CanvasContent,
  baseVersion: number | undefined,
): Promise<CanvasSnapshot> {
  if (baseVersion === undefined) {
    const snapshot = await readCanvasSnapshot(client, canvasId);
    const written = await writeIfUnchanged(
      client,
      canvasId,
      content,
      snapshot.version,
    );
    // Racing here is possible but no worse than before; we read-then-write with
    // the freshest version we can get.
    if (written) return written;
    const latest = await readCanvasSnapshot(client, canvasId);
    throw new CanvasVersionConflictError(
      "Canvas changed while saving.",
      latest.content,
      latest.version,
    );
  }

  const written = await writeIfUnchanged(client, canvasId, content, baseVersion);
  if (written) return written;

  const latest = await readCanvasSnapshot(client, canvasId);
  throw new CanvasVersionConflictError(
    `Canvas was modified by someone else (you had version ${baseVersion}, ` +
      `it is now ${latest.version}).`,
    latest.content,
    latest.version,
  );
}

/**
 * The conditional update itself. Returns null when the version moved, which is
 * how a conflict is detected: `.eq("version", expected)` matches no row, so the
 * `select` comes back empty. PostgREST reports no error for that — an update
 * that matches nothing is a successful update of zero rows — which is why the
 * returned row, not `error`, is what we test.
 */
async function writeIfUnchanged(
  client: CanvasClient | CanvasStore,
  canvasId: string,
  content: CanvasContent,
  expectedVersion: number,
): Promise<CanvasSnapshot | null> {
  const nextVersion = expectedVersion + 1;

  if (isCanvasStore(client)) {
    // Errors surface as-is; null means the version moved (or no write right).
    const result = await client.writeIfUnchanged(
      canvasId,
      content,
      expectedVersion,
    );
    if (!result) return null;
    return { content, version: result.version ?? nextVersion };
  }
  const { data, error } = await client
    .from("canvases")
    .update({
      content: content as unknown as Json,
      version: nextVersion,
    })
    .eq("id", canvasId)
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle();

  if (error) {
    // A real database answer (RLS, timeout, constraint). Let it surface; the
    // caller's own error handling and the transport retry in canvas-service
    // decide what to do.
    throw error;
  }

  if (!data) return null;

  return { content, version: (data.version as number) ?? nextVersion };
}
