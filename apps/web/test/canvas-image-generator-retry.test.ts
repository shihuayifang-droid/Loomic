import { describe, expect, it } from "vitest";

import { retryGeneratorFromFailedSlot } from "@/lib/canvas-image-generator";

/**
 * 工单 34Z T5：GN-19「重试」= 用原参数重新询价 + 确认后提交新任务，不复用旧 job。
 * 这里只验纯函数：失败占位带着 `retryRequest` 时，能不能造出一个已填好原参数的
 * 空闲图片生成器；造不出来（视频 / 没有 retryRequest / 参数不全）就返回 null，
 * 由调用方决定不显示「重试」。
 *
 * 断言用深等，顺带锁住返回对象的形状 —— editor 直接把它喂给
 * `buildImageGeneratorElement`，多一个少一个字段都会被这里看见。
 */

describe("GN-19 retry generator from a failed slot", () => {
  it("GN-19: an image failed slot becomes an idle generator with the original prompt and settings", () => {
    const slot = {
      x: 10,
      y: 20,
      width: 400,
      height: 300,
      customData: {
        kind: "image",
        failed: true,
        failureMessage: "图片生成失败，请重试",
        retryRequest: {
          kind: "image",
          prompt: "一只猫",
          model: "google/imagen-4",
          aspectRatio: "4:3",
          quality: "ultra",
        },
      },
    };

    expect(retryGeneratorFromFailedSlot(slot)).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
      data: {
        type: "image-generator",
        status: "idle",
        prompt: "一只猫",
        model: "google/imagen-4",
        aspectRatio: "4:3",
        quality: "ultra",
      },
    });
  });

  it("GN-19: missing aspect ratio and quality fall back to 1:1 and hd", () => {
    const slot = {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      customData: {
        kind: "image",
        failed: true,
        retryRequest: {
          kind: "image",
          prompt: "一只猫",
          model: "google/imagen-4",
        },
      },
    };

    expect(retryGeneratorFromFailedSlot(slot)).toEqual({
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      data: {
        type: "image-generator",
        status: "idle",
        prompt: "一只猫",
        model: "google/imagen-4",
        aspectRatio: "1:1",
        quality: "hd",
      },
    });
  });

  it("GN-19: a video failed slot is not retried here", () => {
    const slot = {
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      customData: {
        kind: "video",
        failed: true,
        retryRequest: {
          kind: "video",
          prompt: "一只猫在跑",
          model: "google/veo-3",
        },
      },
    };

    expect(retryGeneratorFromFailedSlot(slot)).toBeNull();
  });

  it("GN-19: a slot without retryRequest cannot be retried", () => {
    const slot = {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      customData: {
        kind: "image",
        failed: true,
        failureMessage: "图片生成失败，请重试",
      },
    };

    expect(retryGeneratorFromFailedSlot(slot)).toBeNull();
  });
});
