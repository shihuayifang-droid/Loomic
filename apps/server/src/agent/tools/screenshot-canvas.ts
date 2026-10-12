import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

import type { ConnectionManager } from "../../ws/connection-manager.js";
import type { PersistImageFn } from "./image-generate.js";
import type { AgentAssetReference, ScreenshotResult } from "@loomic/shared";

const screenshotCanvasSchema = z.object({
  mode: z
    .enum(["full", "region", "viewport"])
    .describe("full: all elements; region: specific area; viewport: current user view"),
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional()
    .describe("Required when mode is 'region'. Defines the crop rectangle."),
  max_dimension: z
    .number()
    .default(1024)
    .describe("Max width or height in pixels. 512=low, 1024=medium, 2048=high quality"),
});

export function createScreenshotCanvasTool(deps: {
  connectionManager: ConnectionManager;
  persistImage?: PersistImageFn;
  rpcTimeout?: number;
}) {
  const timeout = deps.rpcTimeout ?? 10_000;

  return new DynamicStructuredTool({
    name: "screenshot_canvas",
    description:
      "Take a visual screenshot of the canvas to inspect layout, design quality, color harmony, and spatial relationships. Use this to visually verify your changes or understand the current canvas state. Supports full canvas, specific region, or current viewport capture.",
    schema: screenshotCanvasSchema,
    func: async (input, _runManager, config): Promise<string> => {
      const userId = (config as any)?.configurable?.user_id;

      if (!userId) {
        return JSON.stringify({
          error: "no_user_context",
          message: "screenshot_canvas requires a user context to communicate with the browser.",
        });
      }

      try {
        const result = await deps.connectionManager.rpc<ScreenshotResult>(
          userId,
          "canvas.screenshot",
          {
            mode: input.mode,
            ...(input.region ? { region: input.region } : {}),
            max_dimension: input.max_dimension,
          },
          timeout,
        );

        // Upload the screenshot so it has a stable project-asset identity.
        //
        // Returning the raw data: URI (~1-2 MB base64) in the ToolMessage would
        // be serialized as text by LangChain adapters (Google Gemini, OpenAI)
        // since tool responses only support string content — this causes the
        // conversation to instantly exceed the model's token limit.
        //
        // X-52: the JSON now carries `screenshotAsset` — the STABLE fields
        // (assetId / objectPath / mimeType) plus this read's `url`. A bare
        // `screenshotUrl` string was the old shape and could not survive the
        // bucket going private: nothing in it could be authorised or re-signed.
        let screenshotAsset: AgentAssetReference | undefined;
        if (deps.persistImage) {
          try {
            screenshotAsset = await deps.persistImage(
              result.url,
              "image/png",
              `canvas-screenshot-${input.mode}`,
            );
          } catch {
            // Non-fatal: fall back to a text-only summary. Deliberately NOT a
            // fallback to the raw data URI — see above.
          }
        }

        const output: Record<string, unknown> = {
          summary: `Canvas screenshot captured (${result.width}x${result.height}, mode: ${input.mode})`,
          width: result.width,
          height: result.height,
        };

        if (screenshotAsset) {
          // `url` is the projection for this turn; the caller that persists the
          // screenshot must keep assetId/objectPath instead.
          output.screenshotAsset = {
            assetId: screenshotAsset.assetId,
            objectPath: screenshotAsset.objectPath,
            bucket: screenshotAsset.bucket,
            mimeType: screenshotAsset.mimeType,
            byteSize: screenshotAsset.byteSize,
            ...(screenshotAsset.signedUrl
              ? { url: screenshotAsset.signedUrl }
              : {}),
          };
        }

        return JSON.stringify(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Screenshot failed";
        return JSON.stringify({
          error: "screenshot_failed",
          message: `Screenshot failed: ${message}`,
        });
      }
    },
  });
}
