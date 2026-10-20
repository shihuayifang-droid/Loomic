"use client";

import { ImageUp, Lock, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageModelInfo } from "../../lib/server-api";
import { fetchImageModels, submitImageJob } from "../../lib/server-api";
import { visibleOn } from "../../lib/model-visibility";
import { qualityOptionsFor } from "../../lib/image-quality-options";
import { awaitJobCompletion } from "../../lib/await-job";
import { imageResultFromJob } from "../../lib/image-job-result";
import { useCompletionTitle } from "../../hooks/use-completion-title";
import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import type { WebSocketHandle } from "../../hooks/use-websocket";
import { errorCodeOf, lookupError } from "../../lib/error-catalog";
import {
  updateImageGeneratorElement,
  resizeImageGeneratorElement,
  type ImageGeneratorData,
} from "../../lib/canvas-image-generator";
import {
  createExcalidrawImageElement,
  fetchAsDataURL,
} from "../../lib/canvas-elements";

type ImageGeneratorPanelProps = {
  elementId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: ImageGeneratorData;
  excalidrawApi: any;
  accessToken: string;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
  onClose: () => void;
  /**
   * GN-37: used to receive `job.progress`. Optional: without it the slow poll in
   * awaitJobCompletion still delivers the result, just a few seconds later.
   */
  ws?: WebSocketHandle;
};

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

function generateId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 20);
}

export function ImageGeneratorPanel({
  elementId,
  elementBounds,
  data,
  excalidrawApi,
  accessToken,
  canvasScrollZoom,
  onClose,
  ws,
}: ImageGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [aspectRatio, setAspectRatio] = useState(data.aspectRatio);
  const [quality, setQuality] = useState(data.quality);
  const [loading, setLoading] = useState(data.status === "generating");
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  const [models, setModels] = useState<ImageModelInfo[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showRatioDropdown, setShowRatioDropdown] = useState(false);
  const [showQualityDropdown, setShowQualityDropdown] = useState(false);
  const [refImages, setRefImages] = useState<Array<{ id: string; dataUrl: string; file: File }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  /**
   * X-40 二期：toast 上的两个入口。
   * - `editParams`：把焦点送回本面板的 prompt 输入框 —— `user_fixable` 的码
   *   （invalid_request / resolution_not_allowed…）要改的东西都在这一行文本里。
   * - `retry`：走面板现有的提交函数（`handleGenerate`），不另写提交路径。
   *   它定义在下面，所以通过 ref 取「最新的那个」，避免闭包里拿到旧 prompt。
   */
  const retryRef = useRef<(() => void) | null>(null);
  const errorActions = useMemo(
    () => ({
      editParams: () => {
        textareaRef.current?.focus();
      },
      retry: () => {
        retryRef.current?.();
      },
    }),
    [],
  );
  const { handleGenerationError } = useGenerationErrorHandler(errorActions);
  // CV-10：本轮完成提醒，与视频面板同一写法。`begin` / `end` 回调身份稳定
  // （模块级单例），面板只报告「提交成功 / 到达终态」，改不改标题由 hook 决定。
  const { begin, end } = useCompletionTitle();
  // AbortController for in-flight generation requests so we can cancel on unmount
  const abortRef = useRef<AbortController | null>(null);

  // Fetch available models with error logging
  useEffect(() => {
    let cancelled = false;
    fetchImageModels()
      .then((r) => {
        if (!cancelled) setModels(visibleOn(r.models, "generator"));
      })
      .catch((err) => {
        console.warn("[image-gen] Failed to fetch models:", err);
      });
    return () => { cancelled = true; };
  }, []);

  // Close dropdowns when clicking outside the panel
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
        setShowRatioDropdown(false);
        setShowQualityDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cancel in-flight generation on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [prompt]);

  // Calculate panel screen position from canvas coordinates
  const { scrollX, scrollY, zoom } = canvasScrollZoom;
  const screenX = (elementBounds.x + scrollX) * zoom;
  const screenY =
    (elementBounds.y + elementBounds.height + scrollY) * zoom + 8;

  const currentModel = models.find((m) => m.id === model);
  // MD-03: null means this model has no resolution parameter at all — render no
  // selector and send no quality.
  const qualityOptions = qualityOptionsFor(currentModel);

  const handleAspectRatioChange = useCallback(
    (ratio: string) => {
      setAspectRatio(ratio);
      setShowRatioDropdown(false);
      resizeImageGeneratorElement(excalidrawApi, elementId, ratio);
      updateImageGeneratorElement(excalidrawApi, elementId, {
        aspectRatio: ratio,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleQualityChange = useCallback(
    (q: string) => {
      setQuality(q);
      setShowQualityDropdown(false);
      updateImageGeneratorElement(excalidrawApi, elementId, { quality: q });
    },
    [excalidrawApi, elementId],
  );

  const handleModelChange = useCallback(
    (m: string) => {
      setModel(m);
      setShowModelDropdown(false);
      updateImageGeneratorElement(excalidrawApi, elementId, { model: m });
    },
    [excalidrawApi, elementId],
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    updateImageGeneratorElement(excalidrawApi, elementId, {
      status: "generating",
      prompt: prompt.trim(),
      model,
      aspectRatio,
      quality,
    });

    // CV-10：提交成功之后才登记本轮（jobId 在下面拿到）。成功、失败、取消都走同一个
    // 结算口；同一个 id 重复结算由 endTask 幂等挡掉（工单 30H T2「重复 end 只算一次」）。
    let jobId: string | null = null;
    const settleJob = (ok: boolean): void => {
      if (jobId !== null) end(jobId, ok);
    };

    try {
      // GN-37: two steps now, same shape as the video panel — submit answers 202
      // with a jobId (the ledger entry is billed against that job), then we wait
      // for job.progress over the WebSocket with a slow poll as the safety net.
      // Previously this was one request held open for the whole generation.
      const submitted = await submitImageJob(
        accessTokenRef.current,
        prompt.trim(),
        { model, aspectRatio, ...(qualityOptions ? { quality } : {}) },
      );

      // CV-10：job 提交成功即进入本轮，与该 job 最终成功与否无关。
      jobId = submitted.jobId;
      begin(jobId);
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      const job = await awaitJobCompletion(
        accessTokenRef.current,
        submitted.jobId,
        { ...(ws ? { ws } : {}), signal: controller.signal },
      );

      // Check if this generation was cancelled while awaiting
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      const result = imageResultFromJob(job);

      // Download and insert as real image element at same position
      const dataURL = await fetchAsDataURL(result.url);
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      const fileId = generateId();
      excalidrawApi.addFiles([
        {
          id: fileId,
          dataURL,
          mimeType: result.mimeType,
          created: Date.now(),
        },
      ]);

      const imageElement = createExcalidrawImageElement({
        fileId,
        x: elementBounds.x,
        y: elementBounds.y,
        width: elementBounds.width,
        height: elementBounds.height,
        title: prompt.trim().slice(0, 60),
      });

      // Replace: delete placeholder, add image
      const elements = excalidrawApi
        .getSceneElements()
        .map((el: any) => {
          if (el.id === elementId) return { ...el, isDeleted: true };
          return el;
        });
      excalidrawApi.updateScene({
        elements: [...elements, imageElement],
        captureUpdate: "IMMEDIATELY",
      });

      // CV-10：图片已经落到画布上 —— 这个任务成功结束。必须在 `onClose()` 之前，
      // 否则面板卸载就再也没有机会结算，这条任务会永远留在 pending 里。
      settleJob(true);
      onClose();
    } catch (err) {
      // CV-10：失败与取消都算「失败」。中止也要结算，否则这条任务永远留在
      // pending 里，下一轮的「全部任务结束」再也不会触发。
      settleJob(false);
      // Ignore aborted requests (user cancelled or component unmounted)
      if (controller.signal.aborted) return;

      console.error("[image-gen] Generation error:", err);
      const handled = handleGenerationError(err);
      if (!handled) {
        // X-40 二期: same as the video panel — the copy comes from the catalogue
        // by code, not from a line written here (30B left this one hard-coded).
        setError(lookupError(errorCodeOf(err)).message);
      }
      setLoading(false);
      updateImageGeneratorElement(excalidrawApi, elementId, {
        status: "error",
        errorMessage: "生成失败",
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    quality,
    qualityOptions,
    excalidrawApi,
    elementId,
    elementBounds,
    onClose,
    handleGenerationError,
    begin,
    end,
    ws,
  ]);

  // X-40 二期: 「稍后重试」重新提交一次，走的还是上面那一条提交路径。
  retryRef.current = () => {
    void handleGenerate();
  };

  return createPortal(
    <div data-testid="canvas-image-generator-panel"
      ref={panelRef}
      style={{ left: screenX, top: screenY }}
      className="fixed z-[100] w-[450px] rounded-xl border-[0.5px] border-border bg-card/95 p-2 shadow-card backdrop-blur-lg"
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Prompt textarea */}
      <textarea data-testid="canvas-generator-prompt"
        data-mode="image"
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleGenerate();
          }
        }}
        placeholder="今天我们要创作什么"
        disabled={loading}
        style={{ scrollbarWidth: "none" }}
        className="min-h-[74px] max-h-[140px] w-full resize-none border-none bg-transparent p-1 text-[14px] leading-[18px] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
      />

      {error && (
        <div className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="mt-1 flex items-center justify-between">
        {/* Left: model + ref image */}
        <div className="flex items-center">
          {/* Model selector */}
          <div className="relative">
            <button data-testid="canvas-image-generator-model-trigger"
              type="button"
              onClick={() => setShowModelDropdown((v) => !v)}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              {currentModel?.iconUrl && (
                <img
                  src={currentModel.iconUrl}
                  alt=""
                  className="h-3.5 w-3.5 rounded-full"
                />
              )}
              <span className="text-foreground">
                {currentModel?.displayName ?? model.split("/").pop()}
              </span>
              <svg
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showModelDropdown && (
              <div data-testid="canvas-image-generator-model-menu" className="absolute bottom-full left-0 z-50 mb-1 max-h-[280px] w-[260px] overflow-y-auto rounded-xl border-[0.5px] border-border bg-card py-1 shadow-card">
                {models.map((m) => (
                  <button data-testid={`canvas-image-generator-model-item-${m.id.replace(/\//g, "-")}`}
                    key={m.id}
                    type="button"
                    onClick={() => handleModelChange(m.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${m.id === model ? "bg-muted" : ""} ${m.accessible === false ? "opacity-60" : ""}`}
                  >
                    {m.iconUrl && (
                      <img
                        src={m.iconUrl}
                        alt=""
                        className="h-3.5 w-3.5 rounded-full"
                      />
                    )}
                    <span className="flex-1 text-foreground">
                      {m.displayName}
                      {m.accessible === false && (
                        <Lock className="ml-1 inline h-2.5 w-2.5 text-muted-foreground" />
                      )}
                    </span>
                    {typeof m.creditCost === "number" && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums text-muted-foreground">
                        <Zap className="h-2.5 w-2.5" />
                        {m.creditCost}
                      </span>
                    )}
                    {m.id === model && (
                      <svg
                        className="h-3 w-3 text-foreground"
                        viewBox="0 0 14 14"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M12.08 3.087a.583.583 0 0 1 0 .825L5.661 10.33a.583.583 0 0 1-.824 0L1.92 7.412a.583.583 0 0 1 .825-.825L5.25 9.092l6.004-6.005a.583.583 0 0 1 .825 0"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reference image upload */}
          <input data-testid="canvas-image-generator-ref-input"
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (!files) return;
              Array.from(files).forEach((file) => {
                const reader = new FileReader();
                reader.onload = () => {
                  setRefImages((prev) => [
                    ...prev,
                    { id: generateId(), dataUrl: reader.result as string, file },
                  ]);
                };
                reader.readAsDataURL(file);
              });
              e.target.value = "";
            }}
          />
          <button data-testid="canvas-image-generator-ref-add"
            type="button"
            onClick={() => refInputRef.current?.click()}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
              refImages.length > 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
            title="Add reference image"
          >
            <ImageUp className="h-3.5 w-3.5" />
          </button>
          {/* Ref image thumbnails */}
          {refImages.length > 0 && (
            <div className="flex items-center gap-1 ml-1">
              {refImages.map((img) => (
                <div key={img.id} className="relative group">
                  <img
                    src={img.dataUrl}
                    alt="ref"
                    className="h-7 w-7 rounded object-cover border border-border"
                  />
                  <button data-testid="canvas-image-generator-ref-remove"
                    type="button"
                    onClick={() => setRefImages((prev) => prev.filter((r) => r.id !== img.id))}
                    className="absolute -top-1 -right-1 flex opacity-0 group-hover:opacity-100 focus-visible:opacity-100 h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[8px]"
                    aria-label="Remove reference image"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: quality + ratio + generate */}
        <div className="flex items-center gap-1">
          {/* Quality (1K/2K/4K) — MD-03: not rendered when the model has no quality tiers */}
          {qualityOptions && (
          <div className="relative">
            <button data-testid="canvas-image-generator-quality-trigger"
              type="button"
              onClick={() => setShowQualityDropdown((v) => !v)}
              className="flex h-8 items-center gap-0.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="text-foreground">
                {qualityOptions.find((q) => q.value === quality)?.label ??
                  qualityOptions[0]?.label}
              </span>
              <svg
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showQualityDropdown && (
              <div data-testid="canvas-image-generator-quality-menu" className="absolute bottom-full right-0 z-50 mb-1 rounded-lg border-[0.5px] border-border bg-card py-1 shadow-card">
                {qualityOptions.map((q) => (
                  <button data-testid={`canvas-image-generator-quality-item-${q.value}`}
                    key={q.value}
                    type="button"
                    onClick={() => handleQualityChange(q.value)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted ${q.value === quality ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {/* Aspect ratio */}
          <div className="relative">
            <button data-testid="canvas-image-generator-ratio-trigger"
              type="button"
              onClick={() => setShowRatioDropdown((v) => !v)}
              className="flex h-8 items-center gap-0.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="text-foreground">{aspectRatio}</span>
              <svg
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showRatioDropdown && (
              <div data-testid="canvas-image-generator-ratio-menu" className="absolute bottom-full right-0 z-50 mb-1 rounded-lg border-[0.5px] border-border bg-card py-1 shadow-card">
                {ASPECT_RATIOS.map((r) => (
                  <button data-testid={`canvas-image-generator-ratio-item-${r.replace(/:/g, "-")}`}
                    key={r}
                    type="button"
                    onClick={() => handleAspectRatioChange(r)}
                    className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors hover:bg-muted ${r === aspectRatio ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Generate button */}
          <button data-testid="canvas-image-generator-submit"
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || loading}
            className="flex h-8 min-w-12 items-center justify-center gap-1 rounded-full bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/80 hover:accent-glow disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
            ) : (
              <svg
                className="h-3.5 w-[9.3px] shrink-0"
                viewBox="0 0 8 10"
                fill="currentColor"
              >
                <path d="M6.9 4.36H5.385V.76c0-.84-.447-1.01-.991-.38L4 .835.677 4.685c-.457.525-.265.955.422.955h1.517v3.6c0 .84.446 1.01.991.38L4 9.165l3.323-3.85c.456-.525.265-.955-.422-.955" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
