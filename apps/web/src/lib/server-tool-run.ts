/**
 * ED-00m / ED-07: one click on a server-side ("direct execution") tool.
 *
 * ## Why this is a separate, dependency-injected module
 *
 * The interesting behaviour is not the network call, it is the *guard*: ED-00m
 * requires that hammering the button three times while the first run is still in
 * flight produces ONE job (one charge), not three. That is a promise-keyed
 * dedupe, and it can only be exercised honestly if the test can hold the run
 * open — so the fetch, the wait, the byte loading and the request id all arrive
 * through `ServerToolRunDeps`.
 *
 * ## Why the OUTPUT is never uploaded
 *
 * GN-24: the tool runs on the server and its result is already an asset in
 * storage, so the client must not download the bytes and push them back up to
 * get an asset id it ALREADY has. The result therefore carries the server's
 * `asset_id` verbatim; `loadAsDataUrl` exists only to give the canvas something
 * to draw (`files[fileId].dataURL`), never to produce a new upload.
 */

/** The body sent to `POST /api/tools/:toolId/run` (40Q). */
export type ServerToolRunBody = {
  artifact_id: string;
  client_request_id: string;
  project_id?: string;
  canvas_id?: string;
  params?: Record<string, unknown>;
};

/** What the runner needs from the outside world. All of it is injected so the guard is testable. */
export type ServerToolRunDeps = {
  run: (toolId: string, body: ServerToolRunBody) => Promise<{ jobId: string }>;
  wait: (jobId: string) => Promise<{ result?: unknown }>;
  loadAsDataUrl: (url: string) => Promise<string>;
  newRequestId: () => string;
};

export type ServerToolRunInput = {
  artifactId: string;
  projectId?: string;
  canvasId?: string;
  params?: Record<string, unknown>;
};

export type ServerToolRunResult = {
  /** The asset the SERVER produced — taken from the job, never from an upload. */
  assetId: string;
  /** Bytes for the canvas file record; scanned from the signed URL, not uploaded. */
  dataUrl: string;
  width?: number;
  height?: number;
  mimeType: string;
};

/** ED-07: a job that succeeded without an output asset is a defect, not an empty result. */
export const TOOL_NO_OUTPUT_MESSAGE = "工具没有返回产物";

/** Only a real number is a size; a string or `null` must not become `NaN`px. */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * ED-00m: while a run for `key` is in flight, another call with the SAME key gets
 * that very promise back — the second click re-uses the first request (and its
 * `client_request_id`), it does not bill a second job. The key is released the
 * moment the run settles, so a failure or a finished result leaves the button
 * usable again.
 */
export function createServerToolRunner(deps: ServerToolRunDeps): {
  /** 同一个 key（elementId:toolId）在途时再次调用 → 返回同一个 Promise，不发第二个请求 */
  runOnce(
    key: string,
    toolId: string,
    input: ServerToolRunInput,
  ): Promise<ServerToolRunResult>;
} {
  const inFlight = new Map<string, Promise<ServerToolRunResult>>();

  const start = async (
    toolId: string,
    input: ServerToolRunInput,
  ): Promise<ServerToolRunResult> => {
    const job = await deps.run(toolId, {
      artifact_id: input.artifactId,
      client_request_id: deps.newRequestId(),
      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      ...(input.canvasId === undefined ? {} : { canvas_id: input.canvasId }),
      ...(input.params === undefined ? {} : { params: input.params }),
    });

    const finished = await deps.wait(job.jobId);
    const result = (finished.result ?? {}) as Record<string, unknown>;
    const assetId = readText(result["asset_id"]);
    const signedUrl = readText(result["signed_url"]);
    if (assetId === undefined || signedUrl === undefined) {
      throw new Error(TOOL_NO_OUTPUT_MESSAGE);
    }

    const dataUrl = await deps.loadAsDataUrl(signedUrl);
    const width = readNumber(result["width"]);
    const height = readNumber(result["height"]);

    return {
      assetId,
      dataUrl,
      // A tool that reports no size keeps the element's current one (like adjust).
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      mimeType: readText(result["mime_type"]) ?? "image/png",
    };
  };

  return {
    runOnce(key, toolId, input) {
      const running = inFlight.get(key);
      if (running !== undefined) return running;

      const promise = start(toolId, input).finally(() => {
        // After settle the key is free again: the next click is a new run.
        inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
  };
}
