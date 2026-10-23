import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AG-10 / 工单40N 验收 2：要求出 4 张 4K 时先出确认卡，点「取消」后流水与任务表
 * 均无新增 —— 前端这一侧能证明的就是「取消一个请求都不发」，所以这里只替换网络
 * 与等待两层，把确认 / 取消两条路都走一遍。
 */

const apiMock = vi.hoisted(() => ({
  submitImageJob: vi.fn(),
  submitVideoJob: vi.fn(),
}));
vi.mock("../src/lib/server-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/server-api")>();
  return { ...actual, ...apiMock };
});

const awaitMock = vi.hoisted(() => ({ awaitJobCompletion: vi.fn() }));
vi.mock("../src/lib/await-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/await-job")>();
  return { ...actual, awaitJobCompletion: awaitMock.awaitJobCompletion };
});

import {
  type PendingGenerationConfirmation,
  useGenerationConfirmation,
} from "../src/components/chat/use-generation-confirmation";

const PENDING: PendingGenerationConfirmation = {
  message: "将用 model-x 生成 4 张 4K（16:9），消耗 60 分",
  confirmation: {
    jobType: "image_generation",
    model: "model-x",
    count: 4,
    aspectRatio: "16:9",
    quality: "4k",
    creditsCost: 60,
    prompt: "a lighthouse at dusk",
    title: "灯塔",
  },
};

/** `imageResultFromJob` 只认 `result.signed_url`；尺寸有就用，没有就不插画布。 */
const SUCCEEDED_JOB = {
  id: "job-img-1",
  status: "succeeded",
  result: {
    signed_url: "https://cdn.test/confirmed.png",
    mime_type: "image/png",
    asset_id: "asset-1",
    width: 2048,
    height: 2048,
  },
};

beforeEach(() => {
  apiMock.submitImageJob.mockReset();
  apiMock.submitVideoJob.mockReset();
  awaitMock.awaitJobCompletion.mockReset();
});

afterEach(cleanup);

describe("useGenerationConfirmation (AG-10)", () => {
  it("AG-10: cancel drops the card and submits nothing", () => {
    const onImageGenerated = vi.fn();
    const { result } = renderHook(() =>
      useGenerationConfirmation({ accessToken: "tok", onImageGenerated }),
    );

    act(() => {
      result.current.request(PENDING);
    });
    expect(result.current.pending).not.toBeNull();

    act(() => {
      result.current.cancel();
    });

    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBeNull();
    expect(apiMock.submitImageJob).toHaveBeenCalledTimes(0);
    expect(apiMock.submitVideoJob).toHaveBeenCalledTimes(0);
    expect(awaitMock.awaitJobCompletion).toHaveBeenCalledTimes(0);
    expect(onImageGenerated).toHaveBeenCalledTimes(0);
  });

  it("AG-10: confirming submits exactly what the card showed, then hands the picture over", async () => {
    apiMock.submitImageJob.mockResolvedValue({
      jobId: "job-img-1",
      status: "queued",
      prompt: PENDING.confirmation.prompt,
    });
    awaitMock.awaitJobCompletion.mockResolvedValue(SUCCEEDED_JOB);

    const onImageGenerated = vi.fn();
    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useGenerationConfirmation({
        accessToken: "tok",
        onImageGenerated,
        onNotice,
      }),
    );

    act(() => {
      result.current.request(PENDING);
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(apiMock.submitImageJob).toHaveBeenCalledTimes(1);
    expect(apiMock.submitImageJob).toHaveBeenCalledWith(
      "tok",
      "a lighthouse at dusk",
      { model: "model-x", aspectRatio: "16:9", quality: "4k" },
    );
    expect(awaitMock.awaitJobCompletion).toHaveBeenCalledTimes(1);
    expect(onImageGenerated).toHaveBeenCalledTimes(1);
    expect(onImageGenerated).toHaveBeenCalledWith({
      type: "image",
      url: "https://cdn.test/confirmed.png",
      mimeType: "image/png",
      width: 2048,
      height: 2048,
      jobId: "job-img-1",
      assetId: "asset-1",
      title: "灯塔",
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it("AG-10: a video confirmation submits the video job and reports it", async () => {
    apiMock.submitVideoJob.mockResolvedValue({
      jobId: "job-vid-1",
      status: "queued",
      prompt: "a lighthouse",
    });
    awaitMock.awaitJobCompletion.mockResolvedValue({
      id: "job-vid-1",
      status: "succeeded",
      result: { signed_url: "https://cdn.test/confirmed.mp4" },
    });

    const onNotice = vi.fn();
    const { result } = renderHook(() =>
      useGenerationConfirmation({ accessToken: "tok", onNotice }),
    );

    act(() => {
      result.current.request({
        message: "将用 model-v 生成 1 个 16:9，消耗 100 分",
        confirmation: {
          jobType: "video_generation",
          model: "model-v",
          count: 1,
          aspectRatio: "16:9",
          quality: "1080p",
          creditsCost: 100,
          prompt: "a lighthouse",
        },
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(apiMock.submitVideoJob).toHaveBeenCalledTimes(1);
    expect(apiMock.submitVideoJob).toHaveBeenCalledWith("tok", "a lighthouse", {
      model: "model-v",
      aspectRatio: "16:9",
      resolution: "1080p",
    });
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it("AG-10: a failed submit keeps the card and shows the error", async () => {
    apiMock.submitImageJob.mockRejectedValue(new Error("credit pool exhausted"));

    const { result } = renderHook(() =>
      useGenerationConfirmation({ accessToken: "tok" }),
    );

    act(() => {
      result.current.request(PENDING);
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.pending).not.toBeNull();
    expect(result.current.error).toBe("credit pool exhausted");
    expect(result.current.submitting).toBe(false);
  });
});
