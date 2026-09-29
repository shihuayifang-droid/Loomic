import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { tool } from "@langchain/core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

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
  createUserClient: (accessToken: string) => SupabaseClient;
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

export function createPersistSandboxFileTool(deps: PersistSandboxFileDeps) {
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

        const client = deps.createUserClient(accessToken);

        // Resolve workspace ID from canvas for Storage RLS compliance.
        // RLS requires: storage.foldername(name)[1] = workspace_id
        let workspaceId: string | null = null;
        if (canvasId) {
          const { data: canvas } = await client
            .from("canvases")
            .select("project:projects(workspace_id)")
            .eq("id", canvasId)
            .single();
          workspaceId = (canvas?.project as any)?.workspace_id ?? null;
        }

        const storagePath = workspaceId
          ? `${workspaceId}/generated/${Date.now()}-${fileName}`
          : `uploads/${Date.now()}-${fileName}`;
        const { data, error } = await client.storage
          .from("project-assets")
          .upload(storagePath, fileBuffer, {
            contentType: mimeType,
            upsert: false,
          });

        if (error) {
          return `Error uploading file: ${error.message}`;
        }

        const signedResult = await client.storage
          .from("project-assets")
          .createSignedUrl(data.path, 3600);

        if (signedResult.error || !signedResult.data) {
          return `Error creating signed URL: ${signedResult.error?.message ?? "unknown"}`;
        }

        return JSON.stringify({
          summary: `File uploaded successfully: ${fileName}`,
          url: signedResult.data.signedUrl,
          path: data.path,
          mimeType,
          size: fileBuffer.length,
        });
      } catch (err: any) {
        return `Error reading or uploading file: ${err.message}`;
      }
    },
    {
      name: "persist_sandbox_file",
      description:
        "Upload a file the agent wrote into the sandbox (e.g., a PDF or PNG created with write_file) " +
        "to persistent storage. Returns a signed URL the user can access. " +
        "Pass the sandbox path you wrote to, e.g. /output.png.",
      schema: persistSandboxFileSchema,
    },
  );
}
