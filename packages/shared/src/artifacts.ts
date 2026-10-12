import { z } from "zod";

export const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/**
 * X-52: the stable identity of a project asset, as produced by the one
 * persistence entry point on the server (`agent-project-assets.ts`) and carried
 * on every artifact an Agent produces.
 *
 * `assetId` + `objectPath` are the identity; `signedUrl` is a read-time
 * PROJECTION of it, valid for about an hour. Anything that persists an artifact
 * must persist the first two and must be able to re-derive the third — a record
 * whose only handle on its media is `signedUrl` becomes a broken image the
 * moment the bucket stops serving public objects, which is exactly what X-52
 * removes.
 */
export const agentAssetReferenceSchema = z.object({
  /** Primary identity: `asset_objects.id`, the row RLS authorises reads against. */
  assetId: z.string().min(1),
  /** Diagnostic / canvas-marker key: the storage object key inside `bucket`. */
  objectPath: z.string().min(1),
  bucket: z.string().min(1),
  mimeType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  /**
   * This read's short-lived URL. Optional because the same reference is echoed
   * back on a later read, where the URL is re-signed for that caller instead of
   * being reused.
   */
  signedUrl: z.string().optional(),
});

export const imageArtifactSchema = z.object({
  type: z.literal("image"),
  title: z.string().optional(),
  url: z.string(),
  /**
   * X-52: the stable identity of the image, alongside the read-time `url`.
   * Optional so artifacts minted before this ticket (and the direct-provider
   * test path) still parse.
   */
  assetId: z.string().optional(),
  objectPath: z.string().optional(),
  mimeType: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  placement: placementSchema.optional(),
  jobId: z.string().optional(),
});

export const videoArtifactSchema = z.object({
  type: z.literal("video"),
  title: z.string().optional(),
  url: z.string(),
  /**
   * X-52: primary identity, same meaning as on the image artifact. Both this and
   * `objectPath` travel with the artifact so a chat row never has to fall back
   * to the URL to find its media again.
   */
  assetId: z.string().optional(),
  /**
   * Storage object key for the video (`<bucket>/<objectPath>` lives behind the
   * `oss://` marker the canvas persists). Optional so artifacts produced before
   * CV-01, and the direct-provider path used by tests, still parse — but only an
   * artifact that carries it may be written onto a canvas, because `url` is a
   * public URL that dies the moment the bucket goes private (X-52).
   */
  objectPath: z.string().optional(),
  mimeType: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationSeconds: z.number().optional(),
  placement: placementSchema.optional(),
  jobId: z.string().optional(),
});

export const toolArtifactSchema = z.discriminatedUnion("type", [
  imageArtifactSchema,
  videoArtifactSchema,
]);

export type Placement = z.infer<typeof placementSchema>;
export type AgentAssetReference = z.infer<typeof agentAssetReferenceSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export type ToolArtifact = z.infer<typeof toolArtifactSchema>;
