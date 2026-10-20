// @upload-constraints — AS-02: the single upload constraint table, shared by the
// client (checked before the file leaves the browser) and the server (checked
// again when the file arrives). Nothing else in the repo may hard-code an
// upload limit: change the table here and both sides follow.
//
// Scope note (AS-02 vs the asset library): *which* media types a given asset
// kind may hold (a character may take audio/video, a brand kit only images and
// PDFs) belongs to AS-01 / AS-06 and is deliberately not encoded here. Nor is
// the "video no longer than 15s" rule — that needs the media parsed, not just
// the byte size.

export type UploadMediaType = "image" | "pdf" | "audio" | "video";

const MB = 1024 * 1024;

/** AS-02: one table, read by the client (before upload) and the server (on upload). */
export const UPLOAD_CONSTRAINTS: Readonly<
  Record<
    UploadMediaType,
    { label: string; mimeTypes: readonly string[]; maxBytes: number }
  >
> = {
  image: {
    label: "图片",
    mimeTypes: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/svg+xml",
    ],
    maxBytes: 20 * MB,
  },
  pdf: { label: "PDF", mimeTypes: ["application/pdf"], maxBytes: 20 * MB },
  audio: {
    label: "音频",
    mimeTypes: ["audio/wav", "audio/x-wav", "audio/mpeg"],
    maxBytes: 15 * MB,
  },
  video: {
    label: "视频",
    mimeTypes: ["video/mp4", "video/quicktime"],
    maxBytes: 50 * MB,
  },
};

/** The largest per-type limit — what the transport layer has to admit. */
export const UPLOAD_MAX_BYTES = Math.max(
  ...Object.values(UPLOAD_CONSTRAINTS).map((constraint) => constraint.maxBytes),
);

export function mediaTypeOfMime(mimeType: string): UploadMediaType | null {
  const normalized = mimeType.trim().toLowerCase();
  for (const [mediaType, constraint] of Object.entries(UPLOAD_CONSTRAINTS)) {
    if (constraint.mimeTypes.includes(normalized)) {
      return mediaType as UploadMediaType;
    }
  }
  return null;
}

export type UploadConstraintResult =
  | { ok: true; mediaType: UploadMediaType }
  | { ok: false; reason: "unsupported_type" | "too_large"; message: string };

export function checkUploadConstraint(input: {
  mimeType: string;
  byteSize: number;
}): UploadConstraintResult {
  const mediaType = mediaTypeOfMime(input.mimeType);
  if (!mediaType) {
    return {
      ok: false,
      reason: "unsupported_type",
      message: "不支持的文件类型",
    };
  }

  const constraint = UPLOAD_CONSTRAINTS[mediaType];
  if (input.byteSize > constraint.maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      message: `${constraint.label}最大 ${constraint.maxBytes / MB}MB`,
    };
  }

  return { ok: true, mediaType };
}

/** ED-00i: tool outputs the browser renders and uploads itself. Anything else is refused. */
export const TOOL_OUTPUT_SOURCES = ["tool:adjust", "tool:crop"] as const;
export type ToolOutputSource = (typeof TOOL_OUTPUT_SOURCES)[number];

export function isToolOutputSource(value: unknown): value is ToolOutputSource {
  return (
    typeof value === "string" &&
    (TOOL_OUTPUT_SOURCES as readonly string[]).includes(value)
  );
}
