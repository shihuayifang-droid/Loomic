import type {
  AssetSignedUrlResponse,
  CanvasDetail,
  ChatMessageCreateRequest,
  JobCreditsResponse,
  JobResponse,
  MarketplaceDetail,
  MarketplaceSearchResponse,
  MessageCreateResponse,
  MessageListResponse,
  ModelListResponse,
  PricingQuoteRequest,
  PricingQuoteResponse,
  ProfileUpdateResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectListResponse,
  ProjectUpdateRequest,
  RecoverableArtifact,
  RunCreateRequest,
  RunCreateResponse,
  SessionCreateResponse,
  SessionListResponse,
  SkillCreateRequest,
  SkillDetailResponse,
  SkillListResponse,
  SkillUpdateRequest,
  ToolDefinition,
  UploadResponse,
  ViewerResponse,
  WorkspaceSettingsResponse,
  WorkspaceSkillListResponse,
} from "@loomic/shared";

import { checkUploadConstraint, toolListResponseSchema } from "@loomic/shared";

import { dedupeRequest } from "./dedupe-request";
import { getServerBaseUrl } from "./env";
import { getSupabaseBrowserClient } from "./supabase-browser";

// --- Error types ---

export class ApiAuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "ApiAuthError";
  }
}

export class ApiApplicationError extends Error {
  code: string;
  /**
   * HTTP status the server replied with, when known. Callers need it to tell a
   * retriable server fault (5xx) from a request that will fail identically
   * every time (4xx).
   */
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "ApiApplicationError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// --- Existing ---

export async function createRun(
  payload: RunCreateRequest,
  options?: { accessToken?: string },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options?.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(`${getServerBaseUrl()}/api/agent/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Run creation failed with status ${response.status}`);
  }

  return (await response.json()) as RunCreateResponse;
}

// --- Authenticated API ---

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function authJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
}

/**
 * Run an authenticated request; if the server rejects the token, get a fresh
 * one from Supabase and try again exactly once.
 *
 * LOCAL FORK. Access tokens live one hour. The canvas auto-saves on a debounce,
 * so a save routinely fires moments after expiry — especially in a background
 * tab, where Supabase's refresh timer is throttled. Upstream let the resulting
 * ApiAuthError escape to a console.error and silently dropped the user's edit.
 *
 * Retrying is safe here because a 401 means the request never reached the
 * database, so nothing was half-written.
 */
async function withFreshToken<T>(
  accessToken: string,
  run: (token: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(accessToken);
  } catch (err) {
    if (!(err instanceof ApiAuthError)) throw err;

    const auth = getSupabaseBrowserClient().auth;
    // getSession refreshes an expired token; if it hands back the same one
    // (not yet considered expired locally, but rejected by the server) force a
    // refresh so we are not just replaying the rejected token.
    let fresh = (await auth.getSession()).data.session?.access_token;
    if (!fresh || fresh === accessToken) {
      fresh = (await auth.refreshSession()).data.session?.access_token;
    }
    if (!fresh || fresh === accessToken) throw err;

    return await run(fresh);
  }
}

async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) {
    throw new ApiAuthError();
  }
  const body = await response.json().catch(() => null);
  const code = body?.error?.code ?? "application_error";
  const message = body?.error?.message ?? "Request failed";
  throw new ApiApplicationError(code, message, response.status);
}

export async function fetchViewer(
  accessToken: string,
): Promise<ViewerResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ViewerResponse;
}

export async function fetchProjects(
  accessToken: string,
): Promise<ProjectListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectListResponse;
}

export async function createProject(
  accessToken: string,
  data: ProjectCreateRequest,
): Promise<ProjectCreateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/projects`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProjectCreateResponse;
}

export async function deleteProject(
  accessToken: string,
  projectId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchProject(
  accessToken: string,
  projectId: string,
): Promise<{
  project: { id: string; name: string; brand_kit_id: string | null };
}> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as {
    project: { id: string; name: string; brand_kit_id: string | null };
  };
}

export async function updateProject(
  accessToken: string,
  projectId: string,
  data: ProjectUpdateRequest,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Canvas API ---

export async function fetchCanvas(
  accessToken: string,
  canvasId: string,
): Promise<{ canvas: CanvasDetail }> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { canvas: CanvasDetail };
}

export type CanvasContentPayload = {
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, Record<string, unknown>>;
};

/**
 * Thrown on HTTP 409: the canvas moved on since `baseVersion` was read, so this
 * save would have erased whatever landed in between (typically an image the agent
 * just generated). Carries the server's current state so the caller can merge.
 */
export class CanvasVersionConflict extends Error {
  readonly currentVersion: number;
  readonly currentContent: CanvasContentPayload;
  constructor(
    message: string,
    currentVersion: number,
    currentContent: CanvasContentPayload,
  ) {
    super(message);
    this.name = "CanvasVersionConflict";
    this.currentVersion = currentVersion;
    this.currentContent = currentContent;
  }
}

export async function saveCanvas(
  accessToken: string,
  canvasId: string,
  content: CanvasContentPayload,
  /**
   * The version this content was built from. Send it so a stale save is rejected
   * rather than silently overwriting newer content. Omitting it falls back to the
   * old unconditional write, which can lose a concurrent update.
   */
  baseVersion?: number,
): Promise<{ version?: number }> {
  const body = JSON.stringify({
    content,
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  });
  return withFreshToken(accessToken, async (token) => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}`,
      {
        method: "PUT",
        headers: authJsonHeaders(token),
        body,
      },
    );
    if (response.status === 409) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
        currentVersion?: number;
        currentContent?: CanvasContentPayload;
      } | null;
      throw new CanvasVersionConflict(
        payload?.error?.message ?? "Canvas was modified by someone else.",
        payload?.currentVersion ?? 0,
        payload?.currentContent ?? { elements: [], appState: {}, files: {} },
      );
    }
    if (!response.ok) return handleErrorResponse(response);
    const json = (await response.json().catch(() => null)) as {
      version?: number;
    } | null;
    return json?.version !== undefined ? { version: json.version } : {};
  });
}

/**
 * Images this canvas generated successfully that no element shows any more.
 * See apps/server/src/features/canvas/canvas-recovery.ts for how that happens.
 */
export async function fetchRecoverableArtifacts(
  accessToken: string,
  canvasId: string,
): Promise<RecoverableArtifact[]> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}/recoverable`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  const json = (await response.json()) as { artifacts: RecoverableArtifact[] };
  return json.artifacts;
}

export async function recoverArtifacts(
  accessToken: string,
  canvasId: string,
  jobIds: string[],
): Promise<{ recovered: number; skipped: string[]; version?: number }> {
  return withFreshToken(accessToken, async (token) => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}/recover`,
      {
        method: "POST",
        headers: authJsonHeaders(token),
        body: JSON.stringify({ jobIds }),
      },
    );
    if (!response.ok) return handleErrorResponse(response);
    return (await response.json()) as {
      recovered: number;
      skipped: string[];
      version?: number;
    };
  });
}

export async function uploadThumbnail(
  accessToken: string,
  projectId: string,
  blob: Blob,
): Promise<void> {
  const formData = new FormData();
  formData.append("file", blob, "thumbnail.webp");
  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}/thumbnail`,
    {
      method: "PUT",
      headers: authHeaders(accessToken),
      body: formData,
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Settings API ---

export async function updateProfile(
  accessToken: string,
  data: { displayName: string },
): Promise<ProfileUpdateResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/viewer/profile`, {
    method: "PATCH",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as ProfileUpdateResponse;
}

export async function fetchWorkspaceSettings(
  accessToken: string,
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export async function updateWorkspaceSettings(
  accessToken: string,
  data: { defaultModel: string },
): Promise<WorkspaceSettingsResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspace/settings`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSettingsResponse;
}

export async function fetchModels(): Promise<ModelListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status}`);
  }
  return (await response.json()) as ModelListResponse;
}

// --- Chat Session API ---

export function fetchSessions(
  accessToken: string,
  canvasId: string,
): Promise<SessionListResponse> {
  return dedupeRequest(`sessions:${canvasId}`, async () => {
    const response = await fetch(
      `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
      { headers: authHeaders(accessToken) },
    );
    if (!response.ok) return handleErrorResponse(response);
    return (await response.json()) as SessionListResponse;
  });
}

export async function createSession(
  accessToken: string,
  canvasId: string,
  title?: string,
): Promise<SessionCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/canvases/${canvasId}/sessions`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(title ? { title } : {}),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SessionCreateResponse;
}

export async function updateSessionTitle(
  accessToken: string,
  sessionId: string,
  title: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function deleteSession(
  accessToken: string,
  sessionId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchMessages(
  accessToken: string,
  sessionId: string,
): Promise<MessageListResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageListResponse;
}

export async function saveMessage(
  accessToken: string,
  sessionId: string,
  data: ChatMessageCreateRequest,
): Promise<MessageCreateResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MessageCreateResponse;
}

// --- Upload API ---

export async function uploadFile(
  accessToken: string,
  file: File,
  projectId?: string,
): Promise<UploadResponse> {
  // AS-02: the shared table decides before a byte leaves the browser.
  const constraint = checkUploadConstraint({ mimeType: file.type, byteSize: file.size });
  if (!constraint.ok) {
    throw new ApiApplicationError("upload_failed", constraint.message, 400);
  }

  const formData = new FormData();
  formData.append("file", file);
  if (projectId) {
    formData.append("projectId", projectId);
  }

  const response = await fetch(`${getServerBaseUrl()}/api/uploads`, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: formData,
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

/** ED-00i: upload a browser-rendered tool result as a child of `parentArtifactId`. */
export async function uploadToolOutput(
  accessToken: string,
  input: {
    file: File;
    source: "tool:adjust" | "tool:crop";
    parentArtifactId: string;
  },
): Promise<UploadResponse> {
  // AS-02 / ED-00i: the shared table still decides before a byte leaves the
  // browser — a tool output is just another upload, only its provenance differs.
  const constraint = checkUploadConstraint({
    mimeType: input.file.type,
    byteSize: input.file.size,
  });
  if (!constraint.ok) {
    throw new ApiApplicationError("upload_failed", constraint.message, 400);
  }

  const formData = new FormData();
  formData.append("file", input.file);
  formData.append("source", input.source);
  formData.append("parentArtifactId", input.parentArtifactId);

  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/tool-output`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
      body: formData,
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as UploadResponse;
}

export async function getAssetUrl(
  accessToken: string,
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/${assetId}/url`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AssetSignedUrlResponse;
}

/** ED-05: a signed URL that makes the browser save the original under its own name. */
export async function getAssetDownloadUrl(
  accessToken: string,
  assetId: string,
): Promise<AssetSignedUrlResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/uploads/${assetId}/url?download=1`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as AssetSignedUrlResponse;
}

/**
 * ED-05: ask the server to zip these originals; resolves with the file and how
 * many it skipped.
 *
 * `POST /api/uploads/zip`（34G）回的是 zip 流而不是 JSON：包名在 `Content-Disposition`
 * 的 `filename*=UTF-8''…` 里，被跳过的未完成对象数在 `X-Skipped-Count` 里。
 * 包名取不到时退回一个固定名，调用方不必再判空。
 */
export async function downloadAssetsZip(
  accessToken: string,
  input: { assetIds: string[]; projectName: string },
): Promise<{ blob: Blob; fileName: string; skipped: number }> {
  const response = await fetch(`${getServerBaseUrl()}/api/uploads/zip`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({
      assetIds: input.assetIds,
      projectName: input.projectName,
    }),
  });
  if (!response.ok) return handleErrorResponse(response);

  const disposition = response.headers.get("content-disposition") ?? "";
  return {
    blob: await response.blob(),
    fileName: fileNameFromContentDisposition(disposition) ?? "download.zip",
    skipped: Number(response.headers.get("x-skipped-count")) || 0,
  };
}

/** `attachment; filename*=UTF-8''<percent-encoded>` → 解码后的文件名；没有就是 null。 */
function fileNameFromContentDisposition(header: string): string | null {
  const match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const raw = match?.[1];
  if (raw === undefined || raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 不合法百分号编码时原样给出去，不为一个文件名让整次下载失败。
    return raw;
  }
}

export async function deleteAsset(
  accessToken: string,
  assetId: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/uploads/${assetId}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

/** AS-06: one row of the project's own uploaded references (34O 列表接口). */
export type ProjectUploadItem = {
  id: string;
  name: string;
  /** T-92：服务端可能拿不到（返回 null），调用方不得当必有值用。 */
  mimeType: string | null;
  /** T-92：同上。 */
  byteSize: number | null;
  createdAt: string;
  /** 签名 url；非图片资产可能拿不到（服务端返回 null）。 */
  url: string | null;
};

/**
 * AS-06: the project's own uploads, newest first by default.
 *
 * 查询串只在调用方给了参数时才加 —— 缺省排序由服务端定，前端不重复一份默认值，
 * 免得两边口径漂移。
 */
export async function fetchProjectUploads(
  accessToken: string,
  projectId: string,
  opts?: { order?: "newest" | "oldest"; type?: "image" | "video" | "pdf" },
): Promise<{ uploads: ProjectUploadItem[] }> {
  const query = new URLSearchParams();
  if (opts?.order) query.set("order", opts.order);
  if (opts?.type) query.set("type", opts.type);
  const search = query.toString();

  const response = await fetch(
    `${getServerBaseUrl()}/api/projects/${projectId}/uploads${search ? `?${search}` : ""}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as { uploads: ProjectUploadItem[] };
}

// --- Canvas-Native Generation API ---

// GN-37 removed the old synchronous image call and the response type that was
// its only reader: POST /api/agent/generate-image now answers 410, and the
// canvas submits through `submitImageJob` below instead.

export type ImageModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
  /**
   * What the model accepts, declared server-side per model. Optional because an
   * older server build may not send it.
   *
   * `maxInputImages: "unbounded"` means several references are accepted but no
   * documented cap was found — treat it as "no client-side limit", not as a
   * number.
   */
  limits?: {
    maxInputImages: number | "unbounded";
    allowedAspectRatios?: string[];
    supportsOutputFormat: boolean;
  };
  /**
   * MD-03: the quality tiers this model can actually produce, declared
   * server-side. A model with no resolution parameter sends no `quality` key at
   * all, so the panel renders no quality selector for it.
   */
  quality?: Array<{
    key: "standard" | "hd" | "ultra";
    output: string;
    label: string;
  }>;
};

export async function fetchImageModels(): Promise<{
  models: ImageModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/image-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch image models: ${response.status}`);
  }
  return (await response.json()) as { models: ImageModelInfo[] };
}

export type VideoModelInfo = {
  id: string;
  displayName: string;
  description: string;
  provider: string;
  iconUrl?: string;
  creditCost?: number;
  accessible?: boolean;
  minTier?: string;
  capabilities?: {
    textToVideo: boolean;
    imageToVideo: boolean;
    videoToVideo: boolean;
    audio: boolean;
  };
  limits?: {
    maxDuration: number;
    allowedDurations?: number[];
    maxResolution: "480p" | "720p" | "1080p" | "2160p";
    maxInputImages: number;
  };
  pricing?: {
    currency: "CNY";
    billingUnit: "generated_second";
    providerPointsName: string;
    evidenceDate: string;
    rates: Array<{
      resolution: "720p" | "1080p";
      displayResolution: string;
      providerPointsPerSecond: number;
      cnyPerSecond: { min: number; max: number };
    }>;
  };
};

export async function fetchVideoModels(): Promise<{
  models: VideoModelInfo[];
}> {
  const response = await fetch(`${getServerBaseUrl()}/api/video-models`);
  if (!response.ok) {
    throw new Error(`Failed to fetch video models: ${response.status}`);
  }
  return (await response.json()) as { models: VideoModelInfo[] };
}

/** 202 body of POST /api/agent/generate-image-job — the work is accepted, not done. */
export type SubmitImageResponse = {
  jobId: string;
  status: string;
  prompt: string;
};

/**
 * Submits an image generation job and returns immediately (HTTP 202).
 *
 * GN-37: the canvas toolbar image generator used to hold the request open for
 * the whole generation through the old synchronous path, which billed without a
 * `job_id`. That path is retired (it answers 410 now), so the route takes a job
 * and bills it with `job_id` on the ledger entry, and the waiting belongs to
 * `awaitJobCompletion`, exactly like the video panel.
 */
export async function submitImageJob(
  accessToken: string,
  prompt: string,
  options?: { model?: string; aspectRatio?: string; quality?: string },
): Promise<SubmitImageResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-image-job`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.quality ? { quality: options.quality } : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SubmitImageResponse;
}

/**
 * The fields a finished job is guaranteed to expose to a waiter, whichever way
 * it learned the job finished. Deliberately narrower than shared's
 * `BackgroundJob`: awaitJobCompletion can settle from a `job.progress` socket
 * event, which carries the status and result but not the full row. Widening this
 * to BackgroundJob would claim fields that path does not have.
 */
export type JobRecord = {
  id: string;
  status: string;
  job_type?: string;
  result?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  /**
   * GN-30 (`attempt_count` / `max_attempts` on shared's `BackgroundJob`): the
   * poll path can report "attempt 2 of 3" straight off the REST row. They stay
   * optional because the socket path shapes a JobRecord out of a
   * `job.progress` event, which carries neither.
   */
  attempt_count?: number;
  max_attempts?: number;
};

export type GenerateVideoResponse = {
  url: string;
  assetId: string;
  prompt: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
};

/** 202 body of POST /api/agent/generate-video — the work is accepted, not done. */
export type SubmitVideoResponse = {
  jobId: string;
  status: string;
  prompt: string;
};

/**
 * Submits a video generation job and returns immediately (HTTP 202).
 *
 * Renamed from `generateVideoDirect` because it no longer generates anything by
 * the time it returns — waiting for the outcome is `awaitJobCompletion`'s job.
 * The old name promised a finished video and would have made the caller's `await`
 * look correct while silently doing something else.
 */
export async function submitVideoJob(
  accessToken: string,
  prompt: string,
  options?: {
    model?: string;
    duration?: number;
    resolution?: string;
    aspectRatio?: string;
    inputImages?: string[];
  },
): Promise<SubmitVideoResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/agent/generate-video`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({
        prompt,
        ...(options?.model ? { model: options.model } : {}),
        ...(options?.duration != null ? { duration: options.duration } : {}),
        ...(options?.resolution ? { resolution: options.resolution } : {}),
        ...(options?.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options?.inputImages?.length
          ? { inputImages: options.inputImages }
          : {}),
      }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SubmitVideoResponse;
}

// --- Jobs API ---

export async function fetchJob(
  accessToken: string,
  jobId: string,
): Promise<JobResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/jobs/${jobId}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

/**
 * `POST /api/jobs/:jobId/cancel` — GN-32 / CV-02 占位上的「取消」。
 *
 * 退积分规则在服务端（未开始全额退，已开始不退），这里只发请求、把整行交回；
 * 返回类型与 `fetchJob` 一致（`{ job }`）。
 */
export async function cancelJob(
  accessToken: string,
  jobId: string,
): Promise<JobResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobResponse;
}

/**
 * `GET /api/jobs/:jobId/credits` — 36K, read by CV-02 / GN-35's refund line.
 *
 * The route answers what the job was charged AND what actually came back, so the
 * client never has to infer a refund from the price: `credits_cost` is null for a
 * job that was never billed, and `credits_refunded` is 0 when nothing landed.
 * Only the latter may be announced to the user.
 */
export async function fetchJobCredits(
  accessToken: string,
  jobId: string,
): Promise<JobCreditsResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/jobs/${encodeURIComponent(jobId)}/credits`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as JobCreditsResponse;
}

// --- Tool definitions API ---

/**
 * `GET /api/tools` — the ED-00k tool definition table (ED-00 工具条的唯一数据源).
 *
 * 返回值走 `toolListResponseSchema.parse` 而不是 `as ToolListResponse`：这张表是
 * 前后端共用的契约（21AB），字段缺失、枚举越界、id 重复都必须在这里抛错。
 * 静默降级（`as` 断言）的后果不是「少显示一个按钮」，而是拿半条定义去渲染工具条，
 * 看起来像「这个工具没实现」，排查会往错的方向走。
 */
export async function fetchToolDefinitions(
  accessToken: string,
): Promise<ToolDefinition[]> {
  const response = await fetch(`${getServerBaseUrl()}/api/tools`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  const body: unknown = await response.json();
  return toolListResponseSchema.parse(body).tools;
}

// --- Pricing API ---

/**
 * `POST /api/pricing/quote` — ED-00f / GN-01 询价接口（工单31D 的后端）。
 *
 * 前端不算价（BL-14 验收 1）：菜单项与按钮上的 `⚡N` 只能来自这次询价的响应。
 * 请求体原样交给服务端，客户端不拼价格、不带入口（入口由服务端按条目种类决定）。
 */
export async function fetchPriceQuote(
  accessToken: string,
  body: PricingQuoteRequest,
): Promise<PricingQuoteResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/pricing/quote`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as PricingQuoteResponse;
}

// --- Skills API ---

export async function fetchSkills(
  accessToken: string,
): Promise<SkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillListResponse;
}

export async function fetchSkillDetail(
  accessToken: string,
  id: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function createSkill(
  accessToken: string,
  data: SkillCreateRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function updateSkill(
  accessToken: string,
  id: string,
  data: SkillUpdateRequest,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    method: "PUT",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify(data),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function deleteSkill(
  accessToken: string,
  id: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/${id}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function fetchSkillFiles(
  accessToken: string,
  skillId: string,
): Promise<{
  files: Array<{
    id: string;
    filePath: string;
    content: string;
    mimeType: string;
    createdAt: string;
    updatedAt: string;
  }>;
}> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/${skillId}/files`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as any;
}

// --- Workspace Skills API ---

export async function fetchWorkspaceSkills(
  accessToken: string,
): Promise<WorkspaceSkillListResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspaces/skills`, {
    headers: authHeaders(accessToken),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as WorkspaceSkillListResponse;
}

export async function installSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  const response = await fetch(`${getServerBaseUrl()}/api/workspaces/skills`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ skillId }),
  });
  if (!response.ok) return handleErrorResponse(response);
}

export async function uninstallSkill(
  accessToken: string,
  skillId: string,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspaces/skills/${skillId}`,
    {
      method: "DELETE",
      headers: authHeaders(accessToken),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

export async function toggleSkill(
  accessToken: string,
  skillId: string,
  enabled: boolean,
): Promise<void> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/workspaces/skills/${skillId}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ enabled }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
}

// --- Marketplace API ---

export async function searchMarketplace(
  accessToken: string,
  query: string,
  page = 1,
  limit = 20,
): Promise<MarketplaceSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    page: String(page),
    limit: String(limit),
  });
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/search?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MarketplaceSearchResponse;
}

export async function getMarketplaceDetail(
  accessToken: string,
  packageName: string,
): Promise<MarketplaceDetail> {
  const params = new URLSearchParams({ name: packageName });
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/detail?${params}`,
    { headers: authHeaders(accessToken) },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as MarketplaceDetail;
}

export async function installMarketplaceSkill(
  accessToken: string,
  packageName: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(
    `${getServerBaseUrl()}/api/skills/marketplace/install`,
    {
      method: "POST",
      headers: authJsonHeaders(accessToken),
      body: JSON.stringify({ packageName }),
    },
  );
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}

export async function importSkillFromUrl(
  accessToken: string,
  url: string,
): Promise<SkillDetailResponse> {
  const response = await fetch(`${getServerBaseUrl()}/api/skills/import`, {
    method: "POST",
    headers: authJsonHeaders(accessToken),
    body: JSON.stringify({ url }),
  });
  if (!response.ok) return handleErrorResponse(response);
  return (await response.json()) as SkillDetailResponse;
}
