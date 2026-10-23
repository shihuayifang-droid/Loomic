// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { ApiApplicationError, confirmationOf } from "../src/lib/server-api";

/**
 * 工单 41H：`confirmationOf` —— 从 409 `confirmation_required` 里把这一批的数字读出来。
 *
 * 它是纯函数，只有两种结果：
 *   - 认得的 409 且字段齐全 → 那一组数字（面板拿它摆确认卡）；
 *   - 别的错误 / 字段缺一个 → `null`（面板退回原来的错误路径，不摆卡）。
 */

/** 41F 的 409 体。`error.message` 是英文，卡上显示的是 `confirmation` 里的数字。 */
const BODY = {
  error: {
    code: "confirmation_required",
    message: "Confirmation required: 10 images cost 80 credits",
  },
  confirmation: {
    jobType: "image_generation",
    model: "kwjm/gpt-image-2",
    count: 10,
    creditsCost: 80,
    prompt: "cat",
    size: "1:1",
  },
};

function confirmationError(
  body: unknown = BODY,
  code = "confirmation_required",
): ApiApplicationError {
  return new ApiApplicationError(code, "Confirmation required", 409, body);
}

describe("confirmationOf（工单 41H）", () => {
  it("returns the batch a 409 confirmation_required carries", () => {
    expect(confirmationOf(confirmationError())).toEqual({
      model: "kwjm/gpt-image-2",
      count: 10,
      creditsCost: 80,
      prompt: "cat",
      size: "1:1",
    });
  });

  it("carries the optional ratio and quality when the server sent them", () => {
    const body = {
      ...BODY,
      confirmation: {
        ...BODY.confirmation,
        aspectRatio: "16:9",
        quality: "hd",
      },
    };
    expect(confirmationOf(confirmationError(body))).toEqual({
      model: "kwjm/gpt-image-2",
      count: 10,
      creditsCost: 80,
      prompt: "cat",
      size: "1:1",
      aspectRatio: "16:9",
      quality: "hd",
    });
  });

  it("is null for a different error code", () => {
    expect(
      confirmationOf(confirmationError(BODY, "insufficient_credits")),
    ).toBeNull();
  });

  it("is null when creditsCost is missing", () => {
    const body = {
      ...BODY,
      confirmation: {
        jobType: "image_generation",
        model: "kwjm/gpt-image-2",
        count: 10,
        prompt: "cat",
      },
    };
    expect(confirmationOf(confirmationError(body))).toBeNull();
  });

  it("is null when the body has no confirmation object", () => {
    expect(confirmationOf(confirmationError({ error: BODY.error }))).toBeNull();
  });

  it("is null for something that is not an ApiApplicationError", () => {
    expect(confirmationOf(new Error("confirmation_required"))).toBeNull();
    expect(confirmationOf(null)).toBeNull();
    expect(confirmationOf(undefined)).toBeNull();
  });

  it("keeps status and body on the error it was read from", () => {
    const err = confirmationError();
    expect(err.status).toBe(409);
    expect(err.body).toEqual(BODY);
  });

  it("leaves the old three-argument construction unchanged", () => {
    const err = new ApiApplicationError("invalid_request", "bad", 400);
    expect(err.code).toBe("invalid_request");
    expect(err.status).toBe(400);
    expect(err.body).toBeUndefined();
    expect(confirmationOf(err)).toBeNull();
  });
});
