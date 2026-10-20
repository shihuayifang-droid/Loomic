/**
 * GN-37: turns a finished image job's `result` payload into what the canvas
 * needs to insert the picture.
 *
 * WHY THIS EXISTS
 * The image generator used to get a finished picture straight out of the HTTP
 * response. It now submits a job (202 + jobId) and waits, so the payload arrives
 * from `background_jobs.result` instead — same shape the video worker writes, but
 * with different field names on the way out. Keeping the translation here means
 * the panel stays a panel, and the "no URL means the job is broken, not empty"
 * rule is testable without mounting React.
 *
 * A job that reports success without a URL is an error, not an empty result: the
 * alternative is inserting a broken image element and letting the user guess why.
 */
export type ImageJobResult = {
  url: string;
  mimeType: string;
  assetId?: string;
  width?: number;
  height?: number;
};

export function imageResultFromJob(job: {
  result?: unknown;
}): ImageJobResult {
  const raw = (job.result ?? {}) as {
    signed_url?: unknown;
    mime_type?: unknown;
    asset_id?: unknown;
    width?: unknown;
    height?: unknown;
  };

  const url = typeof raw.signed_url === "string" ? raw.signed_url : "";
  if (!url) throw new Error("Job succeeded but carried no image URL");

  const mimeType =
    typeof raw.mime_type === "string" && raw.mime_type
      ? raw.mime_type
      : "image/png";

  return {
    url,
    mimeType,
    ...(typeof raw.asset_id === "string" ? { assetId: raw.asset_id } : {}),
    ...(typeof raw.width === "number" ? { width: raw.width } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
  };
}
