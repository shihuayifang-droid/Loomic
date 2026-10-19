import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { tool } from "@langchain/core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { z } from "zod";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { AssetWriteRepository } from "../../db/asset-write-repository.js";
import type { CanvasReadRepository } from "../../db/canvas-read-repository.js";
import {
  AgentProjectAssetError,
  createAgentProjectAssetService,
} from "../../features/storage/agent-project-assets.js";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const OUTSIDE_SANDBOX_ERROR =
  "Error: filePath must be inside the sandbox directory.";

/**
 * X-52: a sandbox file can only become a project asset if we know which canvas
 * it belongs to. Without one there is no owner to derive, and the old behaviour
 * — writing to an unowned `uploads/...` key — produced an object nobody could
 * ever be authorised to read once the bucket is private. Refusing is the honest
 * answer; inventing a path is not.
 */
const NO_CANVAS_ERROR =
  "Error: no canvas context available, so this file cannot be persisted as a project asset. " +
  "Ask the user to open the canvas this file belongs to.";

const persistSandboxFileSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Path of the file inside the sandbox, as the file tools see it (e.g., /output.png)",
    ),
  title: z
    .string()
    .optional()
    .describe("Optional human-readable title for the file"),
});

export type PersistSandboxFileDeps = {
  /**
   * The canvas → project link behind the object key's workspace (workorder 21AC).
   * Required for the same reason the admin client is: without it the asset
   * service cannot name an owner's workspace, and this tool uploads a host file.
   */
  canvasReadRepository: CanvasReadRepository;
  /** The compensated row delete when signing fails (workorder 21AC). */
  assetWriteRepository: AssetWriteRepository;
  createUserClient: (accessToken: string) => SupabaseClient;
  /**
   * Service-role client getter. Required: ownership is recorded through the
   * service_role-only `record_project_asset`, which the user client cannot call.
   */
  getAdminClient: () => AdminSupabaseClient;
  /**
   * Sandbox root. Required on purpose: without it there is no range we can
   * prove a path belongs to, and this tool reads a host file and uploads it.
   */
  sandboxDir: string;
};

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Uses `path.relative` rather than `startsWith`: a prefix test lets
 * `/tmp/x/run1` admit `/tmp/x/run10/...`, which is a real escape.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  // Different drive on Windows — `relative` then hands back an absolute path.
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * The `sub` claim of the caller's JWT — the user id every asset row is filed
 * under. Local decode only: the token was already verified before the run was
 * accepted, and re-verifying here would add a round trip to a tool call.
 *
 * Exported because the `get_brand_kit` tool needs the SAME answer (workorder
 * 21AC): its reads are owner-keyed, so the actor must come from the token that
 * authorises the call and nowhere else. Two decoders would be two chances to
 * disagree.
 */
export function readSubject(accessToken: string): string | null {
  try {
    const payload = decodeJwt(accessToken);
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

export function createPersistSandboxFileTool(deps: PersistSandboxFileDeps) {
  const agentAssets = createAgentProjectAssetService({
    canvasReadRepository: deps.canvasReadRepository,
    assetWriteRepository: deps.assetWriteRepository,
    createUserClient: (accessToken) =>
      deps.createUserClient(accessToken) as unknown as UserSupabaseClient,
    getAdminClient: deps.getAdminClient,
  });

  return tool(
    async (input, config) => {
      const accessToken = (config as any)?.configurable?.access_token as
        | string
        | undefined;
      const canvasId = (config as any)?.configurable?.canvas_id as
        | string
        | undefined;

      if (!accessToken) {
        return "Error: No access token available. Cannot upload file.";
      }

      // `created_by` on the asset row. Taken from the caller's own token `sub`
      // rather than a `configurable` field so it cannot disagree with the JWT
      // that authorises the write, and without a second network round trip.
      const createdBy = readSubject(accessToken);
      if (!createdBy) {
        return "Error: the access token carries no subject claim. Cannot record asset ownership.";
      }

      // Refused up front rather than after reading and uploading the file: see
      // NO_CANVAS_ERROR. The canvas id is what `record_project_asset` derives
      // the project and team workspace from.
      if (!canvasId) {
        return NO_CANVAS_ERROR;
      }

      const sandboxRoot = resolve(deps.sandboxDir);

      // `filePath` is a sandbox path (same shape the agent's file tools see).
      // `"." + filePath` anchors a leading "/" to the sandbox root instead of the
      // drive root, so "/output.png" -> "<sandbox>/output.png" and ".." cannot
      // climb out of the sandbox.
      const resolvedPath = resolve(sandboxRoot, "." + input.filePath);
      if (!isInsideRoot(sandboxRoot, resolvedPath)) {
        return OUTSIDE_SANDBOX_ERROR;
      }

      // Second pass on the realpath result, so a symlink inside the sandbox
      // cannot point back out of it.
      let realSandboxRoot = sandboxRoot;
      try {
        realSandboxRoot = realpathSync(sandboxRoot);
      } catch {
        // Root itself is not resolvable; the lexical check above already passed.
      }

      let realPath: string;
      try {
        realPath = realpathSync(resolvedPath);
      } catch {
        return "Error: filePath does not exist or is not accessible.";
      }
      if (!isInsideRoot(realSandboxRoot, realPath)) {
        return OUTSIDE_SANDBOX_ERROR;
      }

      try {
        const fileStats = await stat(resolvedPath);
        if (fileStats.size > MAX_FILE_SIZE) {
          return `Error: File too large (${fileStats.size} bytes). Maximum: ${MAX_FILE_SIZE} bytes.`;
        }

        const fileBuffer = await readFile(resolvedPath);
        const ext = extname(resolvedPath).toLowerCase();
        const mimeType = MIME_MAP[ext] ?? "application/octet-stream";
        const safeTitle = input.title
          ? input.title.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "_").slice(0, 100)
          : null;
        const fileName = safeTitle
          ? `${safeTitle}${ext}`
          : basename(resolvedPath);

        // The ONE persistence path (X-52): upload with the user's JWT, record
        // ownership from the canvas through the service role, sign for this
        // read. Nothing here builds a storage path of its own — an unowned
        // `uploads/...` key is exactly what this ticket removes.
        const asset = await agentAssets.persist({
          accessToken,
          canvasId,
          createdBy,
          content: fileBuffer,
          mimeType,
          fileName,
          pathPrefix: "generated",
        });

        return JSON.stringify({
          summary: `File uploaded successfully: ${fileName}`,
          // Stable fields first: they are what a persisted record keeps.
          assetId: asset.assetId,
          objectPath: asset.objectPath,
          bucket: asset.bucket,
          mimeType: asset.mimeType,
          size: asset.byteSize,
          // This read's projection only.
          ...(asset.signedUrl ? { url: asset.signedUrl } : {}),
        });
      } catch (err: any) {
        if (err instanceof AgentProjectAssetError) {
          return `Error uploading file: ${err.message}`;
        }
        return `Error reading or uploading file: ${err.message}`;
      }
    },
    {
      name: "persist_sandbox_file",
      description:
        "Upload a file the agent wrote into the sandbox (e.g., a PDF or PNG created with write_file) " +
        "to persistent project storage. Returns the asset's stable id (assetId/objectPath) and a " +
        "short-lived URL for this turn. Pass the sandbox path you wrote to, e.g. /output.png.",
      schema: persistSandboxFileSchema,
    },
  );
}
