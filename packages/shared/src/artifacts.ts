import { z } from "zod";

export const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const imageArtifactSchema = z.object({
  type: z.literal("image"),
  title: z.string().optional(),
  url: z.string(),
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
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export type ToolArtifact = z.infer<typeof toolArtifactSchema>;
