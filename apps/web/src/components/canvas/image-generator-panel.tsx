"use client";

import { ImageUp, Lock, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageModelInfo } from "../../lib/server-api";
import { cancelJob, fetchImageModels, submitImageJob } from "../../lib/server-api";
import { visibleOn } from "../../lib/model-visibility";
import { qualityOptionsFor } from "../../lib/image-quality-options";
import { awaitJobCompletion } from "../../lib/await-job";
import { imageResultFromJob } from "../../lib/image-job-result";
import { fitResultIntoSlot } from "../../lib/fit-result";
import { addBatchPlaceholders } from "../../lib/batch-slots";
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
import type { GenerateImageRequest, GeneratorParam } from "@loomic/shared";

import {
  GeneratorParamControls,
  type GeneratorParamValue,
} from "@/components/canvas/generator-param-controls";
import { PriceTag } from "@/components/ui/price-tag";
import { useToast } from "@/components/toast";
import {
  useGenerationQuote,
  type GenerationQuoteInput,
} from "@/hooks/use-generation-quote";

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
  /**
   * BL-45 / T-109: 三池可用额度（`useCredits().balance`），由宿主传入。
   * 不传 = 本面板既不询价也不做额度预检（宿主接 `useCredits` 是下一张单，
   * 现有三份渲染本面板的测试都不传它）。
   */
  availableCredits?: number | null;
};

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

/** AG-07: one value per parameter id, as the shared control component speaks it. */
type ParamValues = Record<string, GeneratorParamValue>;

/**
 * AG-07 / MD-03: what the schema-driven parameters contribute to the quote and
 * the submit body. `null` = this model publishes no schema, so the old
 * `aspectRatio` / `quality` state and the old request shape stay in force.
 */
type ParamRequest = { aspectRatio?: string; quality?: string; size?: string };

/**
 * AG-07: every parameter enters at the value the server declared as its default.
 * That is also what "switching models falls back to the new model's default"
 * needs — the old model's values are not carried over.
 */
function defaultParamValues(params: readonly GeneratorParam[]): ParamValues {
  const values: ParamValues = {};
  for (const param of params) {
    if (param.type === "discrete" || param.type === "continuous") {
      values[param.id] = param.default;
    } else if (param.type === "text") {
      values[param.id] = param.default ?? "";
    }
    // `custom_size` declares no default: the pair is entered, then snapped on blur.
  }
  return values;
}

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
  availableCredits,
}: ImageGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [aspectRatio, setAspectRatio] = useState(data.aspectRatio);
  const [quality, setQuality] = useState(data.quality);
  /**
   * AG-07: the values of the parameters the server declared for this model. Empty
   * for a model without a schema (the old dropdowns keep using `aspectRatio` /
   * `quality` above).
   */
  const [paramValues, setParamValues] = useState<ParamValues>({});
  /** AG-07: how many images to generate (1 = the old single-job path). */
  const [count, setCount] = useState(1);
  const { toast } = useToast();
  const [loading, setLoading] = useState(data.status === "generating");
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  /**
   * GN-32 / CV-02：面板生成中可取消。`activeJobId` 是这一次等待的任务 id
   * （`submitImageJob` 返回之后才有值），确认取消时只拿它调一次 `cancelJob`。
   * 只 abort 前端等待是不够的 —— 服务端任务照样计费。
   */
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
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

  /**
   * AG-07 / MD-03: the parameter schema the server declared for this model (41A).
   * `null` = no schema → the panel behaves exactly as before this ticket.
   */
  const paramDefs = currentModel?.params?.params ?? null;
  const paramDefaults = useMemo(
    () => (paramDefs ? defaultParamValues(paramDefs) : {}),
    [paramDefs],
  );
  /**
   * 进入一个模型（首次选中或切换模型）时把 `paramValues` 重置为各参数的下发默认值：
   * 新模型不支持的旧取值不能带过来。`paramDefaults` 的身份只在换模型时变一次，
   * 所以这个 effect 不会每帧重跑。
   */
  useEffect(() => {
    setParamValues(paramDefaults);
  }, [paramDefaults]);
  /**
   * AG-07: the count control exists only for a model that allows more than one
   * image; switching models always goes back to 1.
   */
  const maxCount = currentModel?.params?.maxCount ?? 1;
  const countParams = useMemo<GeneratorParam[]>(
    () =>
      maxCount > 1
        ? [
            {
              type: "discrete",
              id: "count",
              label: "张数",
              options: Array.from({ length: maxCount }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              })),
              default: "1",
            },
          ]
        : [],
    [maxCount],
  );
  useEffect(() => {
    setCount(1);
  }, [model]);
  const effectiveCount = maxCount > 1 ? Math.min(count, maxCount) : 1;
  const handleCountChange = useCallback((_id: string, value: GeneratorParamValue) => {
    setCount(Number(value) || 1);
  }, []);
  /**
   * 渲染 / 询价 / 提交一律读这份合并值：某个参数还没有值（首帧、或换了模型而
   * effect 尚未落地）就当场回落默认值，不会出现「未选中任何项」的空档。
   */
  const effectiveParamValues = useMemo(() => {
    const merged: ParamValues = {};
    if (!paramDefs) return merged;
    for (const param of paramDefs) {
      const value = paramValues[param.id] ?? paramDefaults[param.id];
      if (value !== undefined) merged[param.id] = value;
    }
    return merged;
  }, [paramDefs, paramValues, paramDefaults]);
  /**
   * AG-07：schema 参数怎么落到请求体里。
   * - 有 `size` 离散参数：`size` = 所选值，`quality` = 该选项的计价档 `tier`
   *   （没有 tier 就不带 quality）；**不带** `aspectRatio` —— 服务端按 `size`
   *   自行推出比例写进 payload，而 shared 的 `aspectRatio` 枚举里没有 `3:2` /
   *   `2:3`，带上去会被请求校验 400；
   * - 否则有 `aspectRatio` 参数：只用它的取值，不带 quality；
   * - 两者都没有：`null`，退回旧的 `aspectRatio` / `quality` 口径。
   */
  const paramRequest = useMemo<ParamRequest | null>(() => {
    if (!paramDefs) return null;
    const sizeParam = paramDefs.find(
      (param): param is Extract<GeneratorParam, { type: "discrete" }> =>
        param.type === "discrete" && param.id === "size",
    );
    if (sizeParam) {
      const value = String(effectiveParamValues[sizeParam.id] ?? sizeParam.default);
      const chosen = sizeParam.options.find((option) => option.value === value);
      const request: ParamRequest = { size: value };
      if (chosen?.tier) request.quality = chosen.tier;
      return request;
    }
    const ratioParam = paramDefs.find(
      (param): param is Extract<GeneratorParam, { type: "discrete" }> =>
        param.type === "discrete" && param.id === "aspectRatio",
    );
    if (ratioParam) {
      return {
        aspectRatio: String(effectiveParamValues[ratioParam.id] ?? ratioParam.default),
      };
    }
    return null;
  }, [paramDefs, effectiveParamValues]);

  /**
   * BL-45 / T-109：提交之前的「这次要花多少」与「够不够」。
   *
   * 只在宿主传了 `availableCredits` 时才启用：不传就整块关掉 —— 不发询价请求、
   * 不渲染价格、不拦提交。价格数字只来自询价（BL-14 验收 1：前端不算价），
   * `precheck` 只是把询价结果与余额比一下（口径在 `use-generation-quote` 里，
   * 本面板不重复算）。询价请求体与提交同构，参数跟面板当前状态一致。
   */
  const quoteEnabled = availableCredits !== undefined;
  const quoteInput: GenerationQuoteInput | null =
    quoteEnabled && prompt.trim()
      ? {
          kind: "image_generation",
          request: {
            prompt: prompt.trim(),
            model,
            // 面板状态是元素自定义数据里的字符串（旧数据可能是任意值），提交
            // 走的是 `submitImageJob` 的宽松参数；询价请求体按契约收窄。
            ...(paramRequest !== null
              ? {
                  ...(paramRequest.aspectRatio
                    ? {
                        aspectRatio:
                          paramRequest.aspectRatio as NonNullable<GenerateImageRequest["aspectRatio"]>,
                      }
                    : {}),
                  ...(paramRequest.quality
                    ? { quality: paramRequest.quality as NonNullable<GenerateImageRequest["quality"]> }
                    : {}),
                  ...(paramRequest.size ? { size: paramRequest.size } : {}),
                }
              : {
                  aspectRatio:
                    aspectRatio as NonNullable<GenerateImageRequest["aspectRatio"]>,
                  ...(qualityOptions
                    ? { quality: quality as NonNullable<GenerateImageRequest["quality"]> }
                    : {}),
                }),
            ...(effectiveCount > 1 ? { count: effectiveCount } : {}),
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

  /** AG-07：schema 参数变了只改面板状态，询价 / 提交自己跟着重算。 */
  const handleParamChange = useCallback((id: string, value: GeneratorParamValue) => {
    setParamValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  /**
   * AG-07: waits for one extra batch job and puts its picture into the placeholder
   * `slotId` (or marks that placeholder as failed). Not tied to this panel's abort
   * controller: these jobs are already billed and finish even if the panel closes.
   */
  const fillBatchSlot = useCallback(
    async (slotId: string, batchJobId: string): Promise<void> => {
      const promptText = prompt.trim();
      begin(batchJobId);
      try {
        const job = await awaitJobCompletion(accessTokenRef.current, batchJobId, {
          ...(ws ? { ws } : {}),
        });
        const result = imageResultFromJob(job);
        const dataURL = await fetchAsDataURL(result.url);
        const slot = excalidrawApi
          .getSceneElements()
          .find((el: any) => el.id === slotId);
        if (!slot) {
          end(batchJobId, true);
          return;
        }
        const fileId = generateId();
        excalidrawApi.addFiles([
          { id: fileId, dataURL, mimeType: result.mimeType, created: Date.now() },
        ]);
        const placed = fitResultIntoSlot(
          { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
          result,
        );
        const imageElement = createExcalidrawImageElement({
          fileId,
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          title: promptText.slice(0, 60),
        });
        const elements = excalidrawApi
          .getSceneElements()
          .map((el: any) => (el.id === slotId ? { ...el, isDeleted: true } : el));
        excalidrawApi.updateScene({
          elements: [...elements, imageElement],
          captureUpdate: "IMMEDIATELY",
        });
        end(batchJobId, true);
      } catch (err) {
        end(batchJobId, false);
        console.error("[image-gen] Batch slot error:", err);
        updateImageGeneratorElement(excalidrawApi, slotId, {
          status: "error",
          errorMessage: lookupError(errorCodeOf(err)).message,
        });
      }
    },
    [prompt, begin, end, ws, excalidrawApi],
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
      // GN-32：这一轮走到终态了，取消入口与确认条一起收起来。
      setActiveJobId(null);
      setConfirmingCancel(false);
    };

    try {
      // GN-37: two steps now, same shape as the video panel — submit answers 202
      // with a jobId (the ledger entry is billed against that job), then we wait
      // for job.progress over the WebSocket with a slow poll as the safety net.
      // Previously this was one request held open for the whole generation.
      const submitted = await submitImageJob(
        accessTokenRef.current,
        prompt.trim(),
        paramRequest !== null
          ? {
              model,
              ...(paramRequest.aspectRatio ? { aspectRatio: paramRequest.aspectRatio } : {}),
              ...(paramRequest.quality ? { quality: paramRequest.quality } : {}),
              ...(paramRequest.size ? { size: paramRequest.size } : {}),
              ...(effectiveCount > 1 ? { count: effectiveCount } : {}),
            }
          : { model, aspectRatio, ...(qualityOptions ? { quality } : {}) },
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

      // AG-07: N images = N independent jobs. jobIds[0] fills this slot through the
      // path below (unchanged); the rest get their own placeholders and run on their
      // own — cancelling or closing this panel only touches the current slot's job,
      // the others are already billed and keep going in the background.
      const batchIds = submitted.jobIds;
      if (batchIds && batchIds.length > 1) {
        const extraSlotIds = addBatchPlaceholders(excalidrawApi, elementId, batchIds.length);
        extraSlotIds.forEach((slotId, i) => {
          const extraJobId = batchIds[i + 1];
          if (extraJobId !== undefined) void fillBatchSlot(slotId, extraJobId);
        });
      }
      if (submitted.partial) {
        toast(
          `已创建 ${submitted.partial.created} 张，剩余 ${submitted.partial.requested - submitted.partial.created} 张未能提交`,
          "info",
        );
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

      // GN-02 ⑤: the placeholder was drawn from the requested ratio; the picture
      // that came back may be a different shape. Fit it into the slot instead of
      // stretching it, and keep the slot untouched when the size is unknown.
      const placed = fitResultIntoSlot(elementBounds, result);

      const imageElement = createExcalidrawImageElement({
        fileId,
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: placed.height,
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
      // X-40 二期: same as the video panel — the copy comes from the catalogue
      // by code, not from a line written here (30B left this one hard-coded).
      const reason = lookupError(errorCodeOf(err)).message;
      if (!handled) {
        setError(reason);
      }
      setLoading(false);
      updateImageGeneratorElement(excalidrawApi, elementId, {
        status: "error",
        errorMessage: reason,
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    quality,
    qualityOptions,
    paramRequest,
    excalidrawApi,
    elementId,
    elementBounds,
    onClose,
    handleGenerationError,
    begin,
    end,
    ws,
    precheck,
    effectiveCount,
    fillBatchSlot,
    toast,
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
      updateImageGeneratorElement(excalidrawApi, elementId, { status: "idle" });
    } catch (err) {
      console.error("[image-gen] Cancel error:", err);
      setCancelError("取消失败，请重试");
    } finally {
      setCancelling(false);
    }
  }, [activeJobId, excalidrawApi, elementId]);

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

      {/* GN-32 / CV-02: 取消前先确认，文案逐字固定（Q-17） */}
      {confirmingCancel && (
        <div
          data-testid="canvas-image-generator-cancel-confirm"
          className="mb-2 rounded-lg border-[0.5px] border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground"
        >
          <div>取消这次生成？已开始的任务不退积分</div>
          {cancelError !== null && (
            <div className="mt-1 text-destructive">{cancelError}</div>
          )}
          <div className="mt-1 flex items-center gap-1">
            <button data-testid="canvas-image-generator-cancel-ok"
              type="button"
              onClick={() => void handleCancelConfirm()}
              disabled={cancelling}
              className="rounded-md bg-primary px-2 py-1 text-primary-foreground transition-colors hover:bg-primary/80 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            >
              确认取消
            </button>
            <button data-testid="canvas-image-generator-cancel-back"
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
        <p data-testid="canvas-image-generator-precheck"
          className="mt-1 px-1 text-right text-xs text-destructive"
        >
          {precheckReason}
        </p>
      )}

      {/* AG-07 / MD-03：服务端下发了参数 schema 就按 schema 渲染整行参数组，
          每组带标题；原来挤在底部工具栏那一行的质量 / 比例下拉不再渲染。
          没有 schema 的模型仍旧用下面那两个下拉（行为与改动前一致）。 */}
      {paramDefs !== null && (
        <div
          data-testid="canvas-image-generator-params"
          className="mt-2 border-t-[0.5px] border-border pt-2"
        >
          <GeneratorParamControls
            params={paramDefs}
            values={effectiveParamValues}
            onChange={handleParamChange}
          />
          {countParams.length > 0 && (
            <div className="mt-2">
              <GeneratorParamControls
                params={countParams}
                values={{ count: String(effectiveCount) }}
                onChange={handleCountChange}
              />
            </div>
          )}
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
          {/* AG-07：有 schema 时质量 / 比例这两个旧下拉都不渲染 —— 参数由上面
              的 GeneratorParamControls 接管；无 schema 的模型行为与改动前一致。 */}
          {paramDefs === null && (
            <>
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

            </>
          )}

          {/* GN-32: 生成中才有东西可取消 —— 只有拿到 jobId 之后才显示 */}
          {loading && activeJobId !== null && (
            <button data-testid="canvas-image-generator-cancel"
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
          <button data-testid="canvas-image-generator-submit"
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || loading || !precheck.ok}
            title={precheckReason ?? undefined}
            aria-label={precheckReason ?? undefined}
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
