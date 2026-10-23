"use client";

/**
 * AG-10 / 工单40N: the submit half of the chat confirmation card.
 *
 * WHY A HOOK
 * The card itself is one render of "a question", but answering it is a
 * two-request submit (`submitImageJob` / `submitVideoJob`, then
 * `awaitJobCompletion`) that must not duplicate the generator panels' rules. The
 * panels are canvas-side components; this one lives in the chat panel and hands
 * the finished artifact to the same `onImageGenerated` / `onVideoGenerated`
 * callbacks the Agent path already uses, so a confirmed generation lands on the
 * canvas exactly like one the Agent produced.
 *
 * WHY IT IS SEPARATE FROM `chat-sidebar.tsx`
 * The sidebar is ~1200 lines and cannot be mounted cheaply in a test. Keeping
 * the decision — which endpoint, which parameters, is anything submitted on
 * cancel (nothing) — here means the cancel path is provable: `cancel` never
 * touches the network.
 */
import { useCallback, useState } from "react";
import type { ImageArtifact } from "@loomic/shared";

import { awaitJobCompletion } from "../../lib/await-job";
import { imageResultFromJob } from "../../lib/image-job-result";
import { submitImageJob, submitVideoJob } from "../../lib/server-api";

/** The `confirmation` payload the server attaches to `billing.error`. */
export type GenerationConfirmation = {
  jobType: "image_generation" | "video_generation";
  model: string;
  count: number;
  /*
   * `| undefined` on the optional fields is deliberate: the payload arrives as
   * a Zod-inferred object, whose optional keys are `x?: T | undefined` under the
   * web app's `exactOptionalPropertyTypes`, and a narrower `x?: T` here would
   * reject it at the call site (TS2375).
   */
  aspectRatio?: string | undefined;
  quality?: string | undefined;
  creditsCost: number;
  prompt: string;
  title?: string | undefined;
};

/** What the card shows: the server's sentence plus the numbers to submit with. */
export type PendingGenerationConfirmation = {
  message: string;
  confirmation: GenerationConfirmation;
};

type AwaitOptions = Parameters<typeof awaitJobCompletion>[2];

export type UseGenerationConfirmationProps = {
  accessToken: string;
  /** `{ ws }` — the socket `awaitJobCompletion` prefers over polling. */
  awaitOptions?: AwaitOptions;
  onImageGenerated?: (artifact: ImageArtifact) => void;
  /** One-line feedback for the paths that hand off without inserting anything. */
  onNotice?: (text: string) => void;
};

export type UseGenerationConfirmation = {
  pending: PendingGenerationConfirmation | null;
  submitting: boolean;
  error: string | null;
  /** The server asked; show the card. */
  request: (next: PendingGenerationConfirmation) => void;
  /** The user answered yes: submit exactly what the confirmation described. */
  confirm: () => Promise<void>;
  /** The user answered no: drop the card and send NOTHING. */
  cancel: () => void;
};

export function useGenerationConfirmation({
  accessToken,
  awaitOptions,
  onImageGenerated,
  onNotice,
}: UseGenerationConfirmationProps): UseGenerationConfirmation {
  const [pending, setPending] = useState<PendingGenerationConfirmation | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((next: PendingGenerationConfirmation) => {
    // A new question replaces the old one: the server has just priced a
    // different run, and submitting the stale numbers would charge for one the
    // user was never shown.
    setPending(next);
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    // Deliberately no request: a refusal to pay must not create a job, and the
    // ticket's acceptance is "no new ledger entry and no new job row".
    setPending(null);
    setError(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!pending || submitting) return;
    const { confirmation } = pending;
    setSubmitting(true);
    setError(null);
    try {
      if (confirmation.jobType === "image_generation") {
        const submitted = await submitImageJob(accessToken, confirmation.prompt, {
          model: confirmation.model,
          ...(confirmation.aspectRatio
            ? { aspectRatio: confirmation.aspectRatio }
            : {}),
          ...(confirmation.quality ? { quality: confirmation.quality } : {}),
        });
        const job = await awaitJobCompletion(
          accessToken,
          submitted.jobId,
          awaitOptions,
        );
        const result = imageResultFromJob(job);
        // `imageArtifactSchema` requires real dimensions; a provider that
        // reported none leaves them out rather than inventing 0x0, and an
        // artifact without them cannot be inserted. Say so instead of dropping
        // the finished picture silently.
        if (
          onImageGenerated &&
          typeof result.width === "number" &&
          typeof result.height === "number"
        ) {
          onImageGenerated({
            type: "image",
            url: result.url,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            jobId: submitted.jobId,
            ...(result.assetId ? { assetId: result.assetId } : {}),
            ...(confirmation.title ? { title: confirmation.title } : {}),
          });
        } else {
          onNotice?.("图片已生成，但任务没有返回尺寸，未自动插入画布");
        }
      } else {
        const submitted = await submitVideoJob(accessToken, confirmation.prompt, {
          model: confirmation.model,
          ...(confirmation.aspectRatio
            ? { aspectRatio: confirmation.aspectRatio }
            : {}),
          ...(confirmation.quality ? { resolution: confirmation.quality } : {}),
        });
        await awaitJobCompletion(accessToken, submitted.jobId, awaitOptions);
        // The video artifact needs `objectPath` before the canvas will accept
        // it (`insertVideoOnCanvas` refuses a URL-backed element), and the chat
        // panel has no mapping from a job to that key — so the video branch
        // submits and reports, and does not pretend to insert.
        onNotice?.("已提交生成");
      }
      setPending(null);
    } catch (err) {
      // Keep the card: the user may retry, and the sentence says what broke.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    pending,
    submitting,
    accessToken,
    awaitOptions,
    onImageGenerated,
    onNotice,
  ]);

  return { pending, submitting, error, request, confirm, cancel };
}
