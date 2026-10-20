import { describe, expect, it } from "vitest";

import {
  buildVideoGeneratorElement,
  retryVideoGeneratorFromFailedSlot,
} from "@/lib/canvas-video-generator";

/**
 * 工单 35H T3：GN-19「重试」= 用原参数重新询价 + 确认后提交新任务（视频部分）。
 * 这里只验纯函数：视频失败占位带着 `retryRequest` 时，能不能造出一个已填好原参数
 * 的空闲视频生成器；造不出来（图片 / 没有 retryRequest / 参数不全）就返回 null，
 * 由调用方决定不显示「重试」。
 *
 * 断言用深等，顺带锁住返回对象的形状 —— editor 直接把它喂给
 * `buildVideoGeneratorElement`，多一个少一个字段都会被这里看见。
 */

describe("GN-19 retry video generator from a failed slot", () => {
  it("GN-19: a video failed slot becomes an idle video generator with the original settings", () => {
    const slot = {
      x: 10,
      y: 20,
      width: 640,
      height: 360,
      customData: {
        kind: "video",
        failed: true,
        failureMessage: "视频生成失败，请重试",
        retryRequest: {
          kind: "video",
          prompt: "海浪",
          model: "google-official/veo-3.1-generate-preview",
          aspectRatio: "9:16",
          duration: 8,
          resolution: "1080p",
        },
      },
    };

    expect(retryVideoGeneratorFromFailedSlot(slot)).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 360,
      data: {
        type: "video-generator",
        status: "idle",
        prompt: "海浪",
        model: "google-official/veo-3.1-generate-preview",
        aspectRatio: "9:16",
        duration: 8,
        resolution: "1080p",
      },
    });
  });

  it("GN-19: missing video settings fall back to the generator defaults", () => {
    const slot = {
      x: 0,
      y: 0,
      width: 512,
      height: 288,
      customData: {
        kind: "video",
        failed: true,
        retryRequest: {
          kind: "video",
          prompt: "海浪",
          model: "google-official/veo-3.1-generate-preview",
        },
      },
    };

    expect(retryVideoGeneratorFromFailedSlot(slot)).toEqual({
      x: 0,
      y: 0,
      width: 512,
      height: 288,
      data: {
        type: "video-generator",
        status: "idle",
        prompt: "海浪",
        model: "google-official/veo-3.1-generate-preview",
        aspectRatio: "16:9",
        duration: 5,
        resolution: "720p",
      },
    });
  });

  it("GN-19: an image failed slot is not a video retry", () => {
    const slot = {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
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

    expect(retryVideoGeneratorFromFailedSlot(slot)).toBeNull();
  });

  it("GN-19: buildVideoGeneratorElement keeps the position and carries the data", () => {
    const data = {
      type: "video-generator" as const,
      status: "idle" as const,
      prompt: "海浪",
      model: "google-official/veo-3.1-generate-preview",
      aspectRatio: "9:16",
      duration: 8,
      resolution: "1080p",
    };

    const element = buildVideoGeneratorElement(
      { x: 10, y: 20, width: 576, height: 400 },
      data,
    );

    expect(element.type).toBe("rectangle");
    expect(element.x).toBe(10);
    expect(element.y).toBe(20);
    expect(element.width).toBe(576);
    expect(element.height).toBe(400);
    expect(element.customData).toEqual(data);
    expect(element.isDeleted).toBe(false);
  });
});
