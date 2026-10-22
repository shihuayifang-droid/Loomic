"use client";

import type { GenerateVideoRequest, VideoResolution } from "@loomic/shared";
import { Lock, Plus, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useCompletionTitle } from "../../hooks/use-completion-title";
import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import {
  type VideoGeneratorData,
  resizeVideoGeneratorElement,
  updateVideoGeneratorElement,
} from "../../lib/canvas-video-generator";
import type { VideoModelInfo } from "../../lib/server-api";
import { cancelJob, fetchVideoModels, submitVideoJob } from "../../lib/server-api";
import { visibleOn } from "../../lib/model-visibility";
import { awaitJobCompletion, type JobProgress } from "../../lib/await-job";
import { errorCodeOf, lookupError } from "../../lib/error-catalog";
import { fitResultIntoSlot } from "../../lib/fit-result";
import { formatRetryLabel } from "../../lib/job-status";
import type { WebSocketHandle } from "../../hooks/use-websocket";

import { PriceTag } from "@/components/ui/price-tag";
import {
  useGenerationQuote,
  type GenerationQuoteInput,
} from "@/hooks/use-generation-quote";

// No longer needs poster frame extraction -- videos use embeddable elements

type VideoGeneratorPanelProps = {
  elementId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: VideoGeneratorData;
  excalidrawApi: any;
  accessToken: string;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
  onClose: () => void;
  /**
   * Used to receive `job.progress`. Optional: without it the slow poll in
   * awaitJobCompletion still delivers the result, just a few seconds later.
   */
  ws?: WebSocketHandle;
  /**
   * BL-45 / T-109: 三池可用额度（`useCredits().balance`），由宿主传入。
   * 不传 = 本面板既不询价也不做额度预检（宿主接 `useCredits` 是下一张单，
   * 现有三份渲染本面板的测试都不传它）。
   */
  availableCredits?: number | null;
};

const ASPECT_RATIOS = ["16:9", "9:16"] as const;
const DURATIONS = [4, 5, 6, 8] as const;
const VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;

function supportedResolutions(
  model?: VideoModelInfo,
): readonly VideoResolution[] {
  const max = model?.limits?.maxResolution;
  if (max === "2160p") return VIDEO_RESOLUTIONS;
  if (max === "1080p") return VIDEO_RESOLUTIONS.slice(0, 2);
  return VIDEO_RESOLUTIONS.slice(0, 1);
}

export function VideoGeneratorPanel({
  elementId,
  elementBounds,
  data,
  excalidrawApi,
  accessToken,
  canvasScrollZoom,
  onClose,
  ws,
  availableCredits,
}: VideoGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [aspectRatio, setAspectRatio] = useState(data.aspectRatio);
  const [duration, setDuration] = useState(data.duration);
  const [resolution, setResolution] = useState(data.resolution);
  const [loading, setLoading] = useState(data.status === "generating");
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  /**
   * GN-32 / CV-02：面板生成中可取消。`activeJobId` 是这一次等待的任务 id
   * （`submitVideoJob` 返回之后才有值），确认取消时只拿它调一次 `cancelJob`。
   */
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  /**
   * GN-30: the last status the job reported. Held in state (not only written to
   * customData) because the status line has to re-render on `retrying`, and the
   * canvas overlay reads the same facts off `customData`.
   */
  const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
  const [models, setModels] = useState<VideoModelInfo[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showParamsPopover, setShowParamsPopover] = useState(false);
  const [firstFrame, setFirstFrame] = useState<{
    dataUrl: string;
    file: File;
  } | null>(null);
  const [lastFrame, setLastFrame] = useState<{
    dataUrl: string;
    file: File;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  /**
   * X-40 二期：toast 上的两个入口。
   * - `editParams`：把焦点送回本面板的 prompt 输入框 —— `user_fixable` 的码
   *   要改的东西都在这一行文本里（时长/分辨率/比例是按钮，不从文本改）。
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
  /**
   * CV-10：本轮完成提醒。`begin` / `end` 回调身份稳定（模块级单例），
   * 面板只是把「提交成功 / 到达终态」这两件事告诉它，改不改标题由 hook 决定。
   */
  const { begin, end } = useCompletionTitle();
  // AbortController for in-flight generation requests so we can cancel on unmount
  const abortRef = useRef<AbortController | null>(null);

  // Fetch available models with error logging
  useEffect(() => {
    let cancelled = false;
    fetchVideoModels()
      .then((r) => {
        if (cancelled) return;
        const shown = visibleOn(r.models, "generator");
        setModels(shown);
        setModel((current) => {
          if (shown.length === 0 || shown.some((m) => m.id === current)) {
            return current;
          }
          const fallback = shown[0];
          if (!fallback) return current;
          const fallbackId = fallback.id;
          updateVideoGeneratorElement(excalidrawApi, elementId, {
            model: fallbackId,
          });
          return fallbackId;
        });
      })
      .catch((err) => {
        console.warn("[video-gen] Failed to fetch models:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [excalidrawApi, elementId]);

  // Close dropdowns when clicking outside the panel
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
        setShowParamsPopover(false);
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
  const screenY = (elementBounds.y + elementBounds.height + scrollY) * zoom + 8;

  const currentModel = models.find((m) => m.id === model);
  const durationOptions = currentModel?.limits?.allowedDurations ?? DURATIONS;
  const resolutionOptions = supportedResolutions(currentModel);
  const currentPriceRate = currentModel?.pricing?.rates.find(
    (rate) => rate.resolution === resolution,
  );

  /**
   * BL-45 / T-109：提交之前的「这次要花多少」与「够不够」，与图片面板同一口径。
   *
   * 只在宿主传了 `availableCredits` 时才启用：不传就整块关掉 —— 不发询价请求、
   * 不渲染价格、不拦提交。价格数字只来自询价（BL-14 验收 1：前端不算价），
   * `precheck` 只是把询价结果与余额比一下（口径在 `use-generation-quote` 里）。
   *
   * 询价请求体**不带 `inputImages`**：首尾帧是 data URL，体积大且不影响计价；
   * 服务端提交时仍按真实请求（含帧）扣费。
   */
  const quoteEnabled = availableCredits !== undefined;
  const quoteInput: GenerationQuoteInput | null =
    quoteEnabled && prompt.trim()
      ? {
          kind: "video_generation",
          request: {
            prompt: prompt.trim(),
            model,
            duration,
            // 面板状态是元素自定义数据里的字符串（旧数据可能是任意值），提交
            // 走的是 `submitVideoJob` 的宽松参数；询价请求体按契约收窄。
            resolution:
              resolution as NonNullable<GenerateVideoRequest["resolution"]>,
            aspectRatio:
              aspectRatio as NonNullable<GenerateVideoRequest["aspectRatio"]>,
          },
        }
      : null;
  const { price, precheck } = useGenerationQuote(
    accessToken,
    quoteInput,
    availableCredits ?? null,
  );
  /**
   * T-109：额度不够时按钮上方要写清「差多少」，而不是只把按钮变灰。
   * 这里同时在按钮的 `title` / `aria-label` 上说一遍，鼠标悬停与读屏都拿得到。
   */
  const precheckReason = precheck.ok
    ? null
    : `积分不足：本次需要 ${precheck.required}，当前可用 ${precheck.available}`;

  const handleAspectRatioChange = useCallback(
    (ratio: string) => {
      setAspectRatio(ratio);
      resizeVideoGeneratorElement(excalidrawApi, elementId, ratio);
      updateVideoGeneratorElement(excalidrawApi, elementId, {
        aspectRatio: ratio,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleDurationChange = useCallback(
    (d: number) => {
      setDuration(d);
      updateVideoGeneratorElement(excalidrawApi, elementId, { duration: d });
    },
    [excalidrawApi, elementId],
  );

  const handleResolutionChange = useCallback(
    (value: VideoResolution) => {
      setResolution(value);
      updateVideoGeneratorElement(excalidrawApi, elementId, {
        resolution: value,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleModelChange = useCallback(
    (m: string) => {
      const selected = models.find((candidate) => candidate.id === m);
      const nextDurations: readonly number[] =
        selected?.limits?.allowedDurations ?? DURATIONS;
      const nextDuration = nextDurations.includes(duration)
        ? duration
        : (nextDurations[0] ?? duration);
      const nextResolutions = supportedResolutions(selected);
      const nextResolution = nextResolutions.includes(
        resolution as VideoResolution,
      )
        ? (resolution as VideoResolution)
        : (nextResolutions[0] ?? "720p");
      setModel(m);
      setDuration(nextDuration);
      setResolution(nextResolution);
      setShowModelDropdown(false);
      updateVideoGeneratorElement(excalidrawApi, elementId, {
        model: m,
        duration: nextDuration,
        resolution: nextResolution,
      });
    },
    [duration, excalidrawApi, elementId, models, resolution],
  );

  const handleFrameUpload = useCallback(
    (
      _type: "first" | "last",
      setter: React.Dispatch<
        React.SetStateAction<{ dataUrl: string; file: File } | null>
      >,
    ) => {
      return (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          setter({ dataUrl: reader.result as string, file });
        };
        reader.readAsDataURL(file);
        e.target.value = "";
      };
    },
    [],
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    // T-109：键盘 Enter 走的也是这条路径，光把按钮 disabled 挡不住回车，
    // 所以预检在这里再拦一次（与按钮的 disabled 同一个口径）。
    if (!precheck.ok) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setJobProgress(null);
    updateVideoGeneratorElement(excalidrawApi, elementId, {
      status: "generating",
      prompt: prompt.trim(),
      model,
      aspectRatio,
      duration,
      resolution,
    });

    // CV-10：提交成功之后才登记本轮（jobId 在下面拿到）。成功、失败、取消都走同一个
    // 结算口；同一个 id 重复结算由 endTask 幂等挡掉（工单 30H T2「重复 end 只算一次」）。
    let jobId: string | null = null;
    const settleJob = (ok: boolean): void => {
      if (jobId !== null) end(jobId, ok);
      // GN-32：这一轮走到终态了，取消入口与确认条一起收起来。
      setActiveJobId(null);
      setConfirmingCancel(false);
    };

    try {
      const inputImages: string[] = [];
      if (firstFrame) inputImages.push(firstFrame.dataUrl);
      if (lastFrame) inputImages.push(lastFrame.dataUrl);

      // Two steps now: submit returns a jobId at once (HTTP 202), then we wait
      // for job.progress over the WebSocket with a slow poll as the safety net.
      // Previously this was one request held open for up to 300s, which any proxy
      // or sleeping laptop would kill — losing the result of a paid generation.
      const submitted = await submitVideoJob(
        accessTokenRef.current,
        prompt.trim(),
        {
          model,
          duration,
          resolution,
          aspectRatio,
          ...(inputImages.length ? { inputImages } : {}),
        },
      );
      // CV-10：job 提交成功即进入本轮，与该 job 最终成功与否无关。
      jobId = submitted.jobId;
      begin(jobId);
      // GN-32：任务已经落到服务端，从这里开始面板才有东西可取消。
      setActiveJobId(submitted.jobId);
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      const job = await awaitJobCompletion(
        accessTokenRef.current,
        submitted.jobId,
        {
          ws,
          signal: controller.signal,
          onProgress: ({ status, elapsedMs, attempt, maxAttempts }) => {
            // GN-30: `attempt` / `maxAttempts` ride along so the overlay can draw
            // 「重试中（2/3）」; `retrying` is not a failure and must not look like one.
            setJobProgress({
              status,
              ...(attempt !== undefined ? { attempt } : {}),
              ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            });
            updateVideoGeneratorElement(excalidrawApi, elementId, {
              status: "generating",
              prompt: prompt.trim(),
              model,
              aspectRatio,
              duration,
              resolution,
              ...(elapsedMs != null ? { elapsedMs } : {}),
              jobStatus: status,
              ...(attempt !== undefined ? { jobAttempt: attempt } : {}),
              ...(maxAttempts !== undefined ? { jobMaxAttempts: maxAttempts } : {}),
            } as any);
          },
        },
      );

      // Check if this generation was cancelled while awaiting
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      // The worker writes these into background_jobs.result.
      const jobResult = (job.result ?? {}) as {
        signed_url?: string;
        mime_type?: string;
        duration_seconds?: number;
        width?: number;
        height?: number;
      };
      if (!jobResult.signed_url) {
        throw new Error("Job succeeded but carried no video URL");
      }
      const result = {
        url: jobResult.signed_url,
        mimeType: jobResult.mime_type ?? "video/mp4",
        durationSeconds: jobResult.duration_seconds ?? duration,
      };

      // Create embeddable element for inline video playback on canvas.
      // Dynamic import -- excalidraw is client-only.
      const { convertToExcalidrawElements } = await import(
        "@excalidraw/excalidraw"
      );
      if (controller.signal.aborted) {
        settleJob(false);
        return;
      }

      // GN-02 (5): the slot was drawn from the ratio the request asked for and
      // the video that comes back can be another shape. Fit it inside the slot
      // instead of stretching it -- same rule as the image panel.
      const placed = fitResultIntoSlot(elementBounds, {
        ...(jobResult.width !== undefined ? { width: jobResult.width } : {}),
        ...(jobResult.height !== undefined ? { height: jobResult.height } : {}),
      });

      const newElements = convertToExcalidrawElements([
        {
          type: "embeddable",
          link: result.url,
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          customData: {
            isVideo: true,
            mimeType: result.mimeType,
            durationSeconds: result.durationSeconds,
            title: prompt.trim().slice(0, 60),
            prompt: prompt.trim(),
          },
        } as any,
      ]);

      // Replace generator placeholder with video embeddable element
      const elements = excalidrawApi
        .getSceneElements()
        .map((el: any) =>
          el.id === elementId ? { ...el, isDeleted: true } : el,
        );
      excalidrawApi.updateScene({
        elements: [...elements, ...newElements],
        captureUpdate: "IMMEDIATELY",
      });

      // CV-10：视频已经落到画布上 —— 这个任务成功结束。
      settleJob(true);
      onClose();
    } catch (err) {
      // CV-10：失败与取消都算「失败」（工单 §3 T4 已裁定）。中止也要结算，
      // 否则这条任务永远留在 pending 里，下一轮的「全部任务结束」再也不会触发。
      settleJob(false);
      // Ignore aborted requests (user cancelled or component unmounted)
      if (controller.signal.aborted) return;

      console.error("[video-gen] Generation error:", err);
      const handled = handleGenerationError(err);
      // X-40 一期: the copy comes from the catalogue by code, not from a string
      // written here — a job that failed with `timeout` now says so.
      const reason = lookupError(errorCodeOf(err)).message;
      if (!handled) {
        setError(reason);
      }
      setLoading(false);
      setJobProgress(null);
      updateVideoGeneratorElement(excalidrawApi, elementId, {
        status: "error",
        errorMessage: reason,
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    duration,
    resolution,
    firstFrame,
    lastFrame,
    excalidrawApi,
    elementId,
    elementBounds,
    onClose,
    handleGenerationError,
    begin,
    end,
    precheck,
  ]);

  /**
   * CV-02 / Q-17：点「取消」只弹确认条，不直接发请求 —— 这一步是不可逆的，
   * 而且文案要先把「已开始的任务不退积分」说清楚。
   */
  const handleCancelAsk = useCallback(() => {
    setCancelError(null);
    setConfirmingCancel(true);
  }, []);

  /** CV-02：「继续生成」= 什么都不做，只把确认条关掉。 */
  const handleCancelBack = useCallback(() => {
    setCancelError(null);
    setConfirmingCancel(false);
  }, []);

  /**
   * GN-32：确认之后才真正取消服务端任务。成功就把前端这条等待链一起断掉、
   * 面板回到「可再次提交」；失败留在确认条里，让人可以重试或继续等。
   * 退积分口径在服务端（未开始全额退，已开始不退），这里只管发请求。
   */
  const handleCancelConfirm = useCallback(async () => {
    const targetJobId = activeJobId;
    if (targetJobId === null) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelJob(accessTokenRef.current, targetJobId);
      abortRef.current?.abort();
      setActiveJobId(null);
      setConfirmingCancel(false);
      setLoading(false);
      updateVideoGeneratorElement(excalidrawApi, elementId, { status: "idle" });
    } catch (err) {
      console.error("[video-gen] Cancel error:", err);
      setCancelError("取消失败，请重试");
    } finally {
      setCancelling(false);
    }
  }, [activeJobId, excalidrawApi, elementId]);

  // X-40 二期: 「稍后重试」重新提交一次，走的还是上面那一条提交路径。
  retryRef.current = () => {
    void handleGenerate();
  };

  const resolutionLabel = currentPriceRate?.displayResolution ?? resolution;
  const paramsLabel = `${aspectRatio} \u00B7 ${duration}s \u00B7 ${resolutionLabel}`;

  /**
   * GN-30 status line. State goes in `data-state` (testid never changes with
   * state — CONVENTIONS.md §1.2); the text is what the user reads.
   * `retrying` gets the 「重试中（2/3）」 placeholder instead of a failure message.
   */
  const jobStatus = jobProgress?.status ?? (loading ? "running" : "idle");
  const jobStatusLabel =
    jobStatus === "retrying"
      ? formatRetryLabel(jobProgress?.attempt, jobProgress?.maxAttempts)
      : jobStatus === "queued"
        ? "排队中"
        : jobStatus === "running"
          ? "生成中"
          : "";

  return createPortal(
    <div data-testid="canvas-video-generator-panel"
      ref={panelRef}
      style={{ left: screenX, top: screenY }}
      className="fixed z-[100] w-[520px] rounded-[24px] border border-border bg-card/95 shadow-card backdrop-blur-lg"
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Frame upload area */}
      <div className="flex gap-2 p-2 pb-0">
        {/* First frame */}
        <input data-testid="canvas-video-generator-first-frame-input"
          ref={firstFrameInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFrameUpload("first", setFirstFrame)}
        />
        <button data-testid="canvas-video-generator-first-frame"
          type="button"
          onClick={() => firstFrameInputRef.current?.click()}
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {firstFrame ? (
            <img
              src={firstFrame.dataUrl}
              alt="首帧"
              className="h-full w-full rounded-2xl object-cover"
            />
          ) : (
            <>
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">首帧</span>
            </>
          )}
        </button>

        {/* Last frame */}
        <input data-testid="canvas-video-generator-last-frame-input"
          ref={lastFrameInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFrameUpload("last", setLastFrame)}
        />
        <button data-testid="canvas-video-generator-last-frame"
          type="button"
          onClick={() => lastFrameInputRef.current?.click()}
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {lastFrame ? (
            <img
              src={lastFrame.dataUrl}
              alt="尾帧"
              className="h-full w-full rounded-2xl object-cover"
            />
          ) : (
            <>
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">尾帧</span>
            </>
          )}
        </button>
      </div>

      {/* Prompt textarea */}
      <div className="px-4 py-3">
        <textarea data-testid="canvas-generator-prompt"
        data-mode="video"
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
          className="min-h-[44px] max-h-[140px] w-full resize-none border-none bg-transparent text-[14px] leading-[22px] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
        />
      </div>

      {jobStatusLabel && (
        <div
          data-testid="canvas-video-generator-status"
          data-state={jobStatus}
          className="mx-4 mb-2 text-[11px] tabular-nums text-muted-foreground"
        >
          {jobStatusLabel}
        </div>
      )}

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {currentPriceRate && (
        <div className="mx-4 mb-2 text-[10px] tabular-nums text-muted-foreground">
          {currentPriceRate.displayResolution} ·{" "}
          {currentPriceRate.providerPointsPerSecond}
          {" H3积分/秒 · 约 ¥"}
          {currentPriceRate.cnyPerSecond.min.toFixed(4)}–¥
          {currentPriceRate.cnyPerSecond.max.toFixed(4)}/秒
        </div>
      )}

      {/* GN-32 / CV-02: 取消前先确认，文案逐字固定（Q-17） */}
      {confirmingCancel && (
        <div
          data-testid="canvas-video-generator-cancel-confirm"
          className="mx-4 mb-2 rounded-lg border-[0.5px] border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground"
        >
          <div>取消这次生成？已开始的任务不退积分</div>
          {cancelError !== null && (
            <div className="mt-1 text-destructive">{cancelError}</div>
          )}
          <div className="mt-1 flex items-center gap-1">
            <button data-testid="canvas-video-generator-cancel-ok"
              type="button"
              onClick={() => void handleCancelConfirm()}
              disabled={cancelling}
              className="rounded-md bg-primary px-2 py-1 text-primary-foreground transition-colors hover:bg-primary/80 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            >
              确认取消
            </button>
            <button data-testid="canvas-video-generator-cancel-back"
              type="button"
              onClick={handleCancelBack}
              className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted"
            >
              继续生成
            </button>
          </div>
        </div>
      )}

      {/* T-109：额度不够时，按钮上方先写清原因（按钮变灰只说「不能点」） */}
      {precheckReason !== null && (
        <p data-testid="canvas-video-generator-precheck"
          className="mx-4 mb-2 text-right text-xs text-destructive"
        >
          {precheckReason}
        </p>
      )}

      {/* Bottom toolbar */}
      <div className="flex items-center justify-between px-2 pb-2">
        {/* Left: params button */}
        <div className="relative">
          <button data-testid="canvas-video-generator-params-trigger"
            type="button"
            onClick={() => setShowParamsPopover((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            <span className="text-foreground">{paramsLabel}</span>
            <svg
              className="h-3 w-3 text-muted-foreground"
              viewBox="0 0 12 24"
              fill="currentColor"
            >
              <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
            </svg>
          </button>
          {showParamsPopover && (
            <div data-testid="canvas-video-generator-params-menu" className="absolute bottom-full left-0 z-50 mb-1 w-[220px] rounded-xl border-[0.5px] border-border bg-card p-3 shadow-card">
              {/* Aspect ratio row */}
              <div className="mb-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Aspect Ratio
                </div>
                <div role="tablist" aria-label="Aspect Ratio" className="flex gap-1">
                  {ASPECT_RATIOS.map((r) => (
                    <button data-testid={`canvas-video-generator-params-ratio-${r.replace(/:/g, "-")}`}
                      role="tab" aria-selected={r === aspectRatio}
                      key={r}
                      type="button"
                      onClick={() => handleAspectRatioChange(r)}
                      className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                        r === aspectRatio
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {/* Duration row */}
              <div>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Duration
                </div>
                <div role="tablist" aria-label="Duration" className="flex flex-wrap gap-1">
                  {durationOptions.map((d) => (
                    <button data-testid={`canvas-video-generator-params-duration-${d}`}
                      role="tab" aria-selected={d === duration}
                      key={d}
                      type="button"
                      onClick={() => handleDurationChange(d)}
                      className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                        d === duration
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>
              {/* Resolution row */}
              <div className="mt-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Resolution
                </div>
                <div role="tablist" aria-label="Resolution" className="flex gap-1">
                  {resolutionOptions.map((value) => {
                    const providerLabel = currentModel?.pricing?.rates.find(
                      (rate) => rate.resolution === value,
                    )?.displayResolution;
                    return (
                      <button data-testid={`canvas-video-generator-params-resolution-${value}`}
                        role="tab" aria-selected={value === resolution}
                        key={value}
                        type="button"
                        onClick={() => handleResolutionChange(value)}
                        className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                          value === resolution
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/60"
                        }`}
                      >
                        {providerLabel ?? value}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: model selector + generate */}
        <div className="flex items-center gap-1">
          {/* Model selector */}
          <div className="relative">
            <button data-testid="canvas-video-generator-model-trigger"
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
              <div data-testid="canvas-video-generator-model-menu" className="absolute bottom-full right-0 z-50 mb-1 max-h-[280px] w-[260px] overflow-y-auto rounded-xl border-[0.5px] border-border bg-card py-1 shadow-card">
                {models.map((m) => (
                  <button data-testid={`canvas-video-generator-model-item-${m.id.replace(/\//g, "-")}`}
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

          {/* GN-32: 生成中才有东西可取消 —— 只有拿到 jobId 之后才显示 */}
          {loading && activeJobId !== null && (
            <button data-testid="canvas-video-generator-cancel"
              type="button"
              aria-label="取消这次生成"
              onClick={handleCancelAsk}
              className="flex h-8 items-center rounded-full border-[0.5px] border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              取消
            </button>
          )}

          {/* GN-01 / BL-45：提交前先让人看到这次要花多少（与「更多」菜单同一个组件） */}
          {quoteEnabled && <PriceTag state={price} variant="badge" />}

          {/* Generate button */}
          <button data-testid="canvas-video-generator-submit"
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || loading || !precheck.ok}
            title={precheckReason ?? undefined}
            aria-label={precheckReason ?? undefined}
            className="flex h-8 items-center justify-center gap-1 rounded-full bg-primary px-3 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-primary-foreground/30 border-t-primary-foreground dark:border-primary-foreground/30 dark:border-t-primary-foreground" />
            ) : (
              <>
                <svg
                  className="h-3.5 w-[9.3px] shrink-0"
                  viewBox="0 0 8 10"
                  fill="currentColor"
                >
                  <path d="M6.9 4.36H5.385V.76c0-.84-.447-1.01-.991-.38L4 .835.677 4.685c-.457.525-.265.955.422.955h1.517v3.6c0 .84.446 1.01.991.38L4 9.165l3.323-3.85c.456-.525.265-.955-.422-.955" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
