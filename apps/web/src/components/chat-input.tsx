"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { MessageMention } from "@loomic/shared";
import type { ImageAttachmentState } from "../hooks/use-image-attachments";
import type { CanvasSelectedElement } from "./canvas-editor";
import { useImageModelPreference } from "../hooks/use-image-model-preference";
import { useVideoModelPreference } from "../hooks/use-video-model-preference";
import { AgentModelSelector } from "./agent-model-selector";
import { ImageAttachmentBar } from "./image-attachment-bar";
import {
  ChatComposer,
  type ChatComposerHandle,
  type ComposerChip,
} from "./chat-composer";
import { ImageModelPreferencePopover } from "./image-model-preference";

/**
 * A canvas image referenced inline in the message, in document order.
 *
 * `url` is full resolution (it is what the model receives); `thumbnailUrl` is the
 * downscaled variant used for on-screen pills. They are carried separately so the
 * message bubble never has to decode a multi-megabyte original to draw a 16px pill.
 */
export type CanvasImageRef = {
  /**
   * The canvas ELEMENT id. It identifies the chip in the composer and the token
   * in the message text (`[图片:<refId>]`) — it is not an attachment identity.
   */
  refId: string;
  /**
   * The stored object's id (`asset_objects.id`), carried so the reference can
   * actually be attached. The runtime resolves this value against the caller's
   * own readable assets and refuses the whole run when it cannot; an element id
   * is not an asset id and never resolves.
   *
   * Optional on the type because a canvas that predates the X-52 projection has
   * no id to offer. Such a chip stays a readable reference and is deliberately
   * NOT turned into an attachment.
   */
  assetId?: string;
  url: string;
  thumbnailUrl?: string;
};

type ChatInputProps = {
  /**
   * `canvasRefs` are the images the message actually points at, read from the
   * chips before the box is cleared.
   *
   * They are passed out with the message rather than looked up afterwards because
   * the canvas selection is NOT a reliable source: clicking a second image
   * replaces the selection, so by send time the canvas may only know about the
   * last image while the sentence still references three.
   */
  onSend: (message: string, canvasRefs: CanvasImageRef[]) => void;
  disabled?: boolean;
  attachments?: ImageAttachmentState[];
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  isUploading?: boolean;
  onAtQuery?: (query: string | null) => void;
  mentions?: MessageMention[];
  onRemoveMention?: (mention: MessageMention) => void;
  selectedCanvasElements?: CanvasSelectedElement[];
};

export type ChatInputHandle = {
  /** Remove the @query text from input after picker selection */
  clearAtQuery: () => void;
  /** Drop an inline image reference at the caret. */
  insertImageChip: (chip: ComposerChip) => void;
  /**
   * Confirm the references currently previewing the canvas selection.
   *
   * Called when the user turns their attention to the chat panel. After this the
   * references stay put even if the canvas selection is cleared — see the
   * preview/confirm note on the selection effect below.
   */
  commitCanvasRefs: () => void;
};

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  onSend,
  disabled,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onRetryAttachment,
  isUploading,
  onAtQuery,
  mentions,
  onRemoveMention,
  selectedCanvasElements,
}, ref) {
  // `isEmpty` is the ONLY editor state React holds. The text itself lives in the
  // contenteditable DOM and is read on demand — see chat-composer.tsx for why
  // per-keystroke state would break Chinese input.
  const [isEmpty, setIsEmpty] = useState(true);
  const composerRef = useRef<ChatComposerHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { preference } = useImageModelPreference();
  const { preference: videoPreference } = useVideoModelPreference();
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  /**
   * refIds that are only *previewing* the canvas selection, not yet confirmed.
   *
   * Declared above the imperative handle because `commitCanvasRefs` empties it.
   */
  const pendingRefIdsRef = useRef<Set<string>>(new Set());

  /** The canvas selection as of the previous effect run — see the effect below. */
  const prevSelectedIdsRef = useRef<Set<string>>(new Set());

  useImperativeHandle(ref, () => ({
    clearAtQuery() {
      composerRef.current?.clearAtQuery();
    },
    insertImageChip(chip: ComposerChip) {
      composerRef.current?.insertChip(chip);
    },
    commitCanvasRefs() {
      pendingRefIdsRef.current.clear();
    },
  }));

  /**
   * refId -> what the chip remembered about the referenced image.
   *
   * Both URL variants are kept: `full` goes to the model, `thumb` is what the sent
   * message bubble renders. `assetId` is the part that authorises the attachment —
   * without it the runtime refuses the run, so it is remembered here, at the only
   * moment the canvas selection still carries it.
   */
  const canvasRefUrlsRef = useRef<
    Map<string, { full: string; thumb?: string; assetId?: string }>
  >(new Map());

  const handleSubmit = useCallback(() => {
    const composer = composerRef.current;
    const trimmed = composer?.getText().trim() ?? "";
    if ((!trimmed && (!attachments || attachments.length === 0)) || disabled || isUploading) return;

    // Read the chips BEFORE clearing: after clear() there is nothing to read.
    const canvasRefs: CanvasImageRef[] = (composer?.getChipRefIds() ?? [])
      .map((refId) => {
        const urls = canvasRefUrlsRef.current.get(refId);
        if (!urls) return null;
        return {
          refId,
          ...(urls.assetId ? { assetId: urls.assetId } : {}),
          url: urls.full,
          ...(urls.thumb ? { thumbnailUrl: urls.thumb } : {}),
        };
      })
      .filter((r): r is CanvasImageRef => r !== null);

    onSend(trimmed, canvasRefs);
    composer?.clear();
    // clear() wiped the chips, so nothing is pending any more. Without this the
    // next canvas deselection would try to withdraw chips that no longer exist.
    pendingRefIdsRef.current.clear();
  }, [disabled, isUploading, onSend, attachments]);

  /**
   * Mention detection now runs on the text BEFORE THE CARET rather than the whole
   * value. With a caret that can sit anywhere between chips, "the last @ in the
   * document" is the wrong anchor — it would reopen the picker when the user
   * edits earlier text.
   */
  const handleTextBeforeCaret = useCallback(
    (textBeforeCaret: string) => {
      if (!onAtQuery) return;

      const lastAtIdx = textBeforeCaret.lastIndexOf("@");
      if (lastAtIdx === -1) {
        onAtQuery(null);
        return;
      }

      // Only trigger if @ is at start or preceded by whitespace
      const charBefore = lastAtIdx > 0 ? textBeforeCaret[lastAtIdx - 1] : " ";
      if (
        charBefore !== " " &&
        charBefore !== "\n" &&
        charBefore !== "\u00A0" &&
        lastAtIdx !== 0
      ) {
        onAtQuery(null);
        return;
      }

      const query = textBeforeCaret.slice(lastAtIdx + 1);
      // Close once the mention run is finished
      if (/[\s\u00A0]/.test(query)) {
        onAtQuery(null);
        return;
      }

      onAtQuery(query);
    },
    [onAtQuery],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0 && onAddFiles) {
        onAddFiles(Array.from(files));
      }
      e.target.value = "";
    },
    [onAddFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!onAddFiles) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length > 0) {
        onAddFiles(files);
      }
    },
    [onAddFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Image paste is handled inside ChatComposer, which also has to sanitise
  // pasted markup — keeping a second paste handler here would double-fire.

  const hasContent = !isEmpty || (attachments && attachments.length > 0);

  /**
   * Selecting an image on the canvas drops it into the sentence, at the caret.
   *
   * WHY the chip and not a thumbnail strip above the box: with several images in
   * one prompt ("put a caterpillar on THIS apple, in the style of THIS one") the
   * reference only means something at a position in the sentence. A strip above
   * the input can say *which* images are involved but never *where* each one
   * belongs, and it costs an extra click to boot.
   *
   * ── Reacting to changes, not to state ──
   * A chip is inserted for an image that JUST ENTERED the selection, which is why
   * the previous selection is kept. Asking instead "is this image selected and
   * missing a chip?" reads as equivalent but is not: after the user deletes a chip
   * by hand the image is usually still selected, so the next re-render puts the
   * chip straight back and the reference looks undeletable.
   *
   * ── Preview, then confirm ──
   * A freshly selected image is only a PREVIEW: it is tracked in
   * `pendingRefIdsRef` and is withdrawn again as soon as it leaves the canvas
   * selection. Clicking empty canvas therefore cancels, which is what selecting
   * something and changing your mind should do — the earlier behaviour glued the
   * chip in on first sight and left deleting it by hand as the only way out.
   *
   * Attention moving to the chat panel confirms the preview
   * (`commitCanvasRefs`): from then on the reference survives the canvas
   * selection being cleared, because the user has moved on to writing the
   * sentence that points at it.
   */
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;

    const images = (selectedCanvasElements ?? []).filter(
      (el) => el.type === "image" && (el.thumbnailUrl || el.storageUrl || el.dataUrl),
    );
    const selectedIds = new Set(images.map((el) => el.id));
    const previouslySelected = prevSelectedIdsRef.current;
    prevSelectedIdsRef.current = selectedIds;

    // Withdraw previews that just left the selection. Confirmed references are
    // not in this set, so they are left alone.
    for (const refId of Array.from(pendingRefIdsRef.current)) {
      if (selectedIds.has(refId)) continue;
      composer.removeChip(refId);
      pendingRefIdsRef.current.delete(refId);
    }

    const alreadyReferenced = new Set(composer.getChipRefIds());

    for (const el of images) {
      if (previouslySelected.has(el.id)) continue;
      // Also referenced via @mention: one chip per image is enough.
      if (alreadyReferenced.has(el.id)) continue;
      const thumb = el.thumbnailUrl || el.storageUrl || el.dataUrl;
      const full = el.storageUrl || el.dataUrl;
      if (!thumb || !full) continue;
      composer.insertChip({ refId: el.id, thumbnailUrl: thumb, label: "图片" });
      canvasRefUrlsRef.current.set(el.id, {
        full,
        ...(thumb !== full ? { thumb } : {}),
        ...(el.assetId ? { assetId: el.assetId } : {}),
      });
      pendingRefIdsRef.current.add(el.id);
    }
  }, [selectedCanvasElements]);

  return (
    <div className="px-2 pb-2">
      <div
        className="flex min-h-[120px] flex-col justify-between gap-2 rounded-xl border-[0.5px] border-border bg-card p-2 transition-[border] focus-within:border-border"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {attachments && onRemoveAttachment && (
          <ImageAttachmentBar
            attachments={attachments}
            onRemove={onRemoveAttachment}
            {...(onRetryAttachment ? { onRetry: onRetryAttachment } : {})}
          />
        )}
        {mentions && mentions.length > 0 && onRemoveMention && (
          <div className="flex flex-wrap items-center gap-1 px-2 py-1">
            {mentions.map((mention) => (
              <button
                key={`${mention.mentionType}:${mention.id}`}
                type="button"
                onClick={() => onRemoveMention(mention)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-muted/80"
                title="Remove mention"
              >
                <span className="text-muted-foreground">@</span>
                <span className="max-w-[180px] truncate">
                  {mention.label}
                </span>
                <svg
                  className="h-3 w-3 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            ))}
          </div>
        )}
        <ChatComposer
          ref={composerRef}
          placeholder='Start with an idea, or type "@" to mention'
          {...(disabled ? { disabled } : {})}
          onSubmit={handleSubmit}
          onTextBeforeCaretChange={handleTextBeforeCaret}
          onEmptyChange={setIsEmpty}
          {...(onAddFiles ? { onPasteFiles: onAddFiles } : {})}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {onAddFiles && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Attach images"
                >
                  <svg
                    className="h-[14px] w-[14px]"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M16 1.1A4.9 4.9 0 0 1 20.9 6a4.9 4.9 0 0 1-1.429 3.457h.001l-8.414 8.587-.007.006a2.9 2.9 0 0 1-3.887.193l-.213-.192a2.9 2.9 0 0 1-.007-4.095l8.414-8.586a.9.9 0 0 1 1.286 1.26L8.23 15.216l-.007.006a1.1 1.1 0 0 0 1.556 1.555l8.407-8.579.007-.007a3.1 3.1 0 0 0 .105-4.271l-.105-.112a3.1 3.1 0 0 0-4.384 0L5.4 12.387l-.007.006a5.1 5.1 0 0 0 7.214 7.213l7.749-7.934a.9.9 0 0 1 1.288 1.256l-7.753 7.938q-.005.007-.012.014a6.9 6.9 0 0 1-9.758-9.76l8.408-8.578.007-.007A4.9 4.9 0 0 1 16 1.1" />
                  </svg>
                </button>
              </>
            )}
            {/* Agent model selector */}
            <AgentModelSelector compact />
            {/* Model preference button */}
            <div className="relative">
              <button
                ref={modelBtnRef}
                type="button"
                onClick={() => setModelPopoverOpen((prev) => !prev)}
                title="Image model"
                className={`flex h-8 w-8 items-center justify-center rounded-full border-[0.5px] transition-colors ${
                  preference.mode === "manual" || videoPreference.mode === "manual"
                    ? "border-accent bg-accent/20 text-accent-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <svg className="h-[14px] w-[14px]" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10.8 1.307a2.33 2.33 0 0 1 2.4 0l7.67 4.602A2.33 2.33 0 0 1 22 7.907v8.361a2.33 2.33 0 0 1-1.13 1.998l-7.67 4.602-.141.078a2.33 2.33 0 0 1-2.258-.078l-7.67-4.602A2.33 2.33 0 0 1 2 16.268V7.907a2.33 2.33 0 0 1 1.003-1.915l.128-.083z" />
                </svg>
              </button>
              <ImageModelPreferencePopover
                open={modelPopoverOpen}
                onClose={() => setModelPopoverOpen(false)}
                anchorRef={modelBtnRef}
              />
            </div>
          </div>
          <button
            onClick={handleSubmit}
            disabled={disabled || !hasContent || isUploading}
            className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/80 active:bg-primary/90 disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <svg
              className="h-[14px] w-[14px]"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
            >
              <path d="M7 11.5V2.5" />
              <path d="M3 6.5L7 2.5L11 6.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
});
