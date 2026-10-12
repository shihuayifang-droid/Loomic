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

/**
 * X-52 (工单14 fixup2): a projection is optional; the IDENTITY is not.
 *
 * `url` is optional so that "the identity is present but no signature could be
 * minted on THIS read" is a legal, complete artifact instead of a Zod failure —
 * the same verdict `imageBlockSchema` reached in 工单14 fixup T2, and the shape
 * `chat-service.projectBlockUrls()` produces on purpose when the caller may not
 * read the asset or the signer refuses it. Requiring the field turned that safe
 * answer into a 500 on `/api/sessions/:id/messages`.
 *
 * What must NOT move is the other direction: an artifact with neither a url nor
 * an `assetId` has no identity to ever re-derive one from, so it stays invalid
 * data rather than becoming "a projection that is merely missing".
 */
function requireIdentityWithoutProjection(
  artifact: { url?: string | undefined; assetId?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (artifact.url !== undefined) return;

  const assetId = artifact.assetId;
  if (typeof assetId === "string" && assetId.length > 0) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["assetId"],
    message:
      "an artifact without a url must carry its stable identity (assetId)",
  });
}

export const imageArtifactSchema = z
  .object({
    type: z.literal("image"),
    title: z.string().optional(),
    /**
     * This read's short-lived projection of the image.
     *
     * X-52 (工单14 fixup2): OPTIONAL. The X-52 rule is that `assetId` is the
     * authority and a url is re-derived per read, so the read that cannot
     * project one answers with the stable artifact and no url. A url that IS
     * present is still a real url — the format check below is unchanged, and an
     * empty string or a pseudo-url is still refused.
     */
    url: z.string().url().optional(),
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
  })
  .superRefine(requireIdentityWithoutProjection);

export const videoArtifactSchema = z
  .object({
    type: z.literal("video"),
    title: z.string().optional(),
    /**
     * X-52 (工单14 fixup2): OPTIONAL, exactly as on the image artifact — a
     * stored video whose signature could not be minted for this caller is a
     * legal artifact, not a malformed one, and the url that IS present must
     * still parse as a url.
     */
    url: z.string().url().optional(),
    /**
     * X-52: primary identity, same meaning as on the image artifact. Both this
     * and `objectPath` travel with the artifact so a chat row never has to fall
     * back to the URL to find its media again.
     */
    assetId: z.string().optional(),
    /**
     * Storage object key for the video (`<bucket>/<objectPath>` lives behind the
     * `oss://` marker the canvas persists). Optional so artifacts produced
     * before CV-01, and the direct-provider path used by tests, still parse —
     * but only an artifact that carries it may be written onto a canvas, because
     * `url` is a public URL that dies the moment the bucket goes private (X-52).
     */
    objectPath: z.string().optional(),
    mimeType: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().optional(),
    placement: placementSchema.optional(),
    jobId: z.string().optional(),
  })
  .superRefine(requireIdentityWithoutProjection);

/**
 * X-52 (工单14 fixup2): `z.union`, not `z.discriminatedUnion`.
 *
 * Both options now carry a cross-field refinement, and in Zod 3 that makes them
 * `ZodEffects`. A discriminated union unwraps those at RUNTIME but its TYPE only
 * accepts `ZodObject` options, so the discriminated form would need a cast that
 * hides exactly the check this ticket adds. `type` is still a literal on each
 * option, so the two shapes stay mutually exclusive at parse time.
 */
export const toolArtifactSchema = z.union([
  imageArtifactSchema,
  videoArtifactSchema,
]);

export type Placement = z.infer<typeof placementSchema>;
export type AgentAssetReference = z.infer<typeof agentAssetReferenceSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;
export type ToolArtifact = z.infer<typeof toolArtifactSchema>;
