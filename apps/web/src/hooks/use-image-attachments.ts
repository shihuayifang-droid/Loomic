"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { checkUploadConstraint } from "@loomic/shared";

import { uploadFile } from "../lib/server-api";

export type ImageAttachmentState = {
  id: string;
  file?: File;
  preview: string;
  uploading: boolean;
  error?: string;
  assetId?: string;
  url?: string;
  mimeType: string;
  source: "upload" | "canvas-ref";
  name?: string;
};

export type CanvasImageRef = {
  assetId: string;
  url: string;
  mimeType: string;
  name?: string;
};

/** A fully-uploaded attachment ready to be sent, including its origin source. */
export type ReadyAttachment = {
  assetId: string;
  /**
   * This session's PREVIEW of the media — the object URL of the file just
   * uploaded, or the signature the canvas read happened to return. It is NOT the
   * submission's authority and NOT the address the model is shown: the server
   * re-signs from `assetId` and never reads this field (X-52, 工单14 fixup).
   *
   * Optional because a record that has an identity but no live projection is
   * still submittable. Omitting the key is deliberate — see `toReadyAttachments`.
   */
  url?: string;
  /**
   * Downscaled variant for on-screen rendering. Absent for plain uploads, where
   * no smaller variant exists yet; renderers fall back to `url`.
   */
  thumbnailUrl?: string;
  mimeType: string;
  source: "upload" | "canvas-ref";
  name?: string;
};

/**
 * X-52: what the browser is allowed to submit is decided by `assetId` alone.
 *
 * A URL is a short-lived signature and, in this hook, only ever a PREVIEW — the
 * object URL of the file being uploaded, or last read's signature for a canvas
 * reference. A record whose only handle on its media is a URL must never become
 * an attachment: the server would have nothing to authorise, and the run would
 * be refused (or worse, would trust a URL the client chose).
 *
 * Kept as a free function, not inlined into the hook, so the rule is testable on
 * its own rather than only through a rendered component.
 */
export function toReadyAttachments(
  attachments: ImageAttachmentState[],
): ReadyAttachment[] {
  const ready: ReadyAttachment[] = [];

  for (const attachment of attachments) {
    // The identity, and nothing else, decides eligibility.
    if (!attachment.assetId || attachment.error || attachment.uploading) continue;

    ready.push({
      assetId: attachment.assetId,
      // A missing url is not disqualifying: the server re-signs from the assetId
      // and IGNORES whatever url this request carries, so an absent projection is
      // sent as an absent KEY. An empty string would be a fabricated URL — the
      // exact confusion X-52 removes — and would fail `z.string().url()` at the
      // request schema before the server ever saw the assetId.
      ...(attachment.url ? { url: attachment.url } : {}),
      mimeType: attachment.mimeType,
      source: attachment.source,
      ...(attachment.name ? { name: attachment.name } : {}),
    });
  }

  return ready;
}

/**
 * One image a message refers to by chip.
 *
 * `refId` is the composer's own handle on it — the canvas ELEMENT id, and the id
 * carried inside the `[图片:<refId>]` token. `assetId` is the stored object's
 * identity, and it is the only thing an Agent run will authorise.
 */
export type CanvasReference = {
  refId: string;
  assetId?: string;
  url: string;
  thumbnailUrl?: string;
};

/**
 * Turn the chips a sentence points at into submittable attachments.
 *
 * `assetId` is the ONLY admissible identity here. The runtime resolves it against
 * the caller's own readable `asset_objects` rows and refuses the whole run when a
 * reference cannot be resolved, so an element id sent in its place does not
 * degrade the prompt — it kills the run with "attachment N references an asset
 * that is not available to this user". That was the observed behaviour: the
 * element id was passed as the asset id, and every message that referenced a
 * canvas image failed while plain text messages worked.
 *
 * A reference with no `assetId` (a canvas object that predates the server's file
 * projection) is therefore dropped rather than guessed at: the chip stays part of
 * the sentence and the run still happens.
 *
 * Kept as a free function, like `toReadyAttachments`, so the rule is testable on
 * its own instead of only through a rendered chat sidebar.
 */
export function toCanvasRefAttachments(
  refs: readonly CanvasReference[],
  existingAssetIds: ReadonlySet<string>,
): ReadyAttachment[] {
  const ready: ReadyAttachment[] = [];

  for (const ref of refs) {
    if (!ref.assetId) {
      console.warn(
        "[image-attachments] canvas reference has no assetId and is not attached:",
        ref.refId,
      );
      continue;
    }

    if (existingAssetIds.has(ref.assetId)) continue;

    ready.push({
      assetId: ref.assetId,
      url: ref.url,
      ...(ref.thumbnailUrl ? { thumbnailUrl: ref.thumbnailUrl } : {}),
      mimeType: "image/png",
      source: "canvas-ref",
      name: `Canvas ${ref.refId.slice(0, 6)}`,
    });
  }

  return ready;
}

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function useImageAttachments(accessToken: string, projectId?: string) {
  const [attachments, setAttachments] = useState<ImageAttachmentState[]>([]);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  // Use a ref mirror of attachments for retryUpload to avoid stale closures.
  // Without this, retryUpload would capture a snapshot of `attachments` at
  // the time it was called, potentially missing concurrent state updates.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Clean up all object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      for (const att of attachmentsRef.current) {
        if (att.preview && att.source === "upload") {
          URL.revokeObjectURL(att.preview);
        }
      }
    };
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const newAttachments: ImageAttachmentState[] = [];

      for (const file of files) {
        if (!ALLOWED_TYPES.has(file.type)) {
          console.warn("[image-attachments] Rejected file type:", file.type);
          continue;
        }
        const constraint = checkUploadConstraint({ mimeType: file.type, byteSize: file.size });
        if (!constraint.ok) {
          const id = crypto.randomUUID();
          newAttachments.push({
            id,
            file,
            preview: "",
            uploading: false,
            error: constraint.message,
            mimeType: file.type,
            source: "upload",
          });
          continue;
        }

        const id = crypto.randomUUID();
        const preview = URL.createObjectURL(file);
        newAttachments.push({
          id,
          file,
          preview,
          uploading: true,
          mimeType: file.type,
          source: "upload",
          name: file.name,
        });

        // Start upload
        uploadFile(accessTokenRef.current, file, projectId)
          .then((res) => {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? { ...a, uploading: false, assetId: res.asset.id, url: res.url }
                  : a,
              ),
            );
          })
          .catch((err) => {
            console.warn("[image-attachments] Upload failed:", err);
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? { ...a, uploading: false, error: err instanceof Error ? err.message : "Upload failed" }
                  : a,
              ),
            );
          });
      }

      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments]);
      }
    },
    [projectId],
  );

  const addCanvasRef = useCallback((ref: CanvasImageRef) => {
    const id = crypto.randomUUID();
    setAttachments((prev) => [
      ...prev,
      {
        id,
        // X-52: the canvas read's signed URL is a PREVIEW for this session only.
        // It is not the identity — `assetId` is, and a re-opened session or a new
        // Agent run re-signs from it.
        preview: ref.url,
        uploading: false,
        assetId: ref.assetId,
        url: ref.url,
        mimeType: ref.mimeType,
        source: "canvas-ref",
        ...(ref.name ? { name: ref.name } : {}),
      },
    ]);
  }, []);

  const retryUpload = useCallback(
    (id: string) => {
      // Read from ref to get the latest attachments state, avoiding stale closure
      const att = attachmentsRef.current.find((a) => a.id === id);
      if (!att?.file) return;

      setAttachments((prev) =>
        prev.map((a) =>
          a.id === id
            ? (() => {
                const { error: _error, ...rest } = a;
                return { ...rest, uploading: true };
              })()
            : a,
        ),
      );

      uploadFile(accessTokenRef.current, att.file, projectId)
        .then((res) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, uploading: false, assetId: res.asset.id, url: res.url }
                : a,
            ),
          );
        })
        .catch((err) => {
          console.warn("[image-attachments] Retry upload failed:", err);
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? { ...a, uploading: false, error: err instanceof Error ? err.message : "Upload failed" }
                : a,
            ),
          );
        });
    },
    [projectId],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview && att.source === "upload") {
        URL.revokeObjectURL(att.preview);
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setAttachments((prev) => {
      for (const att of prev) {
        if (att.preview && att.source === "upload") {
          URL.revokeObjectURL(att.preview);
        }
      }
      return [];
    });
  }, []);

  const isUploading = attachments.some((a) => a.uploading);

  // Annotated rather than inferred: the inferred object literal type silently
  // omits optional fields nothing in this file sets (thumbnailUrl), which then
  // makes them unassignable at the consumer even though ReadyAttachment has them.
  const readyAttachments: ReadyAttachment[] = toReadyAttachments(attachments);

  return {
    attachments,
    addFiles,
    addCanvasRef,
    retryUpload,
    removeAttachment,
    clearAll,
    isUploading,
    readyAttachments,
  };
}
