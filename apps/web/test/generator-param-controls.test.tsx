import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { GeneratorParam } from "@loomic/shared";

import { GeneratorParamControls } from "../src/components/canvas/generator-param-controls";

/**
 * AG-07 / MD-03 — 参数面板只按服务端下发的 schema 渲染。
 *
 * 这里的用例只驱动前端组件，断言的是「下发的选项 / 数值被原样渲染」，
 * 不测服务端的表（那在 apps/server 的 tool-definitions.test.ts 里）。
 */

/** GPT Image 2 的 7 档（41A 的 value / label，来源 openai-image.ts 的 GPT_IMAGE_2_SIZES） */
const GPT_IMAGE_2_SIZE_OPTIONS = [
  { value: "1:1", label: "1:1" },
  { value: "3:2", label: "3:2" },
  { value: "2:3", label: "2:3" },
  { value: "1:1-2k", label: "1:1 · 2K" },
  { value: "16:9-2k", label: "16:9 · 2K" },
  { value: "16:9-4k", label: "16:9 · 4K" },
  { value: "9:16-4k", label: "9:16 · 4K" },
];

const SIZE_PARAM: GeneratorParam = {
  type: "discrete",
  id: "size",
  label: "尺寸",
  options: GPT_IMAGE_2_SIZE_OPTIONS,
  default: "1:1",
};

const DURATION_PARAM: GeneratorParam = {
  type: "continuous",
  id: "duration",
  label: "时长",
  min: 5,
  max: 10,
  step: 1,
  values: [5, 10],
  default: 5,
  unit: "s",
};

const TEXT_PARAM: GeneratorParam = {
  type: "text",
  id: "prompt",
  label: "提示词",
  maxLength: 200,
  default: "",
};

const CUSTOM_SIZE_PARAM: GeneratorParam = {
  type: "custom_size",
  id: "size",
  label: "尺寸",
  maxEdge: 3840,
  multiple: 16,
  maxRatio: 3,
  minMegapixels: 1,
  maxMegapixels: 8.3,
};

/** 同一个 custom_size 换一个 id，供「每个参数都有标题」那条用例和其他类型并列 */
const CUSTOM_SIZE_PARAM_TITLED: GeneratorParam = {
  type: "custom_size",
  id: "custom_size",
  label: "自定义尺寸",
  maxEdge: 3840,
  multiple: 16,
  maxRatio: 3,
  minMegapixels: 1,
  maxMegapixels: 8.3,
};

afterEach(() => {
  cleanup();
});

describe("GeneratorParamControls", () => {
  it("AG-07: a discrete group renders exactly the options it is given", () => {
    const onChange = vi.fn();
    render(<GeneratorParamControls params={[SIZE_PARAM]} values={{}} onChange={onChange} />);

    // 恰好 7 个选项，且不组合出模型不接受的档位
    expect(screen.getAllByTestId(/^generator-size-option-/)).toHaveLength(7);
    expect(screen.queryByTestId("generator-size-option-3:2-4k")).toBeNull();

    // 默认值那一项选中，其余未选中
    expect(screen.getByTestId("generator-size-option-1:1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const option of GPT_IMAGE_2_SIZE_OPTIONS) {
      if (option.value === "1:1") continue;
      expect(screen.getByTestId(`generator-size-option-${option.value}`)).toHaveAttribute(
        "aria-selected",
        "false",
      );
    }

    fireEvent.click(screen.getByTestId("generator-size-option-16:9-4k"));
    expect(onChange).toHaveBeenCalledWith("size", "16:9-4k");
  });

  it("AG-07: a 5s/10s duration slider can only land on 5 or 10", () => {
    const onChange = vi.fn();
    render(<GeneratorParamControls params={[DURATION_PARAM]} values={{}} onChange={onChange} />);

    const input = within(screen.getByTestId("generator-slider-duration")).getByRole("slider");
    expect(input).toHaveAttribute("aria-valuemin", "5");
    expect(input).toHaveAttribute("aria-valuemax", "10");
    expect(input).toHaveAttribute("aria-valuenow", "5");

    fireEvent.change(input, { target: { value: "8" } });
    expect(onChange).toHaveBeenLastCalledWith("duration", 10);

    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenLastCalledWith("duration", 5);
  });

  it("AG-07: a custom size is snapped and the user is told", () => {
    const onChange = vi.fn();
    render(<GeneratorParamControls params={[CUSTOM_SIZE_PARAM]} values={{}} onChange={onChange} />);

    fireEvent.change(screen.getByTestId("generator-size-width"), { target: { value: "3850" } });
    fireEvent.change(screen.getByTestId("generator-size-height"), { target: { value: "1000" } });
    fireEvent.blur(screen.getByTestId("generator-size-height"));

    const width = Number(
      (screen.getByTestId("generator-size-width") as HTMLInputElement).value,
    );
    const height = Number(
      (screen.getByTestId("generator-size-height") as HTMLInputElement).value,
    );

    // 约束：每边 ≤3840、为 16 的倍数、长短边比 ≤3
    expect(width).toBeLessThanOrEqual(3840);
    expect(height).toBeLessThanOrEqual(3840);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(3);

    expect(screen.getByTestId("generator-size-notice").textContent ?? "").toMatch(/^已修正为/);
    expect(onChange).toHaveBeenCalledWith("size", { width, height });
  });

  it("every group has a title", () => {
    render(
      <GeneratorParamControls
        params={[SIZE_PARAM, DURATION_PARAM, TEXT_PARAM, CUSTOM_SIZE_PARAM_TITLED]}
        values={{}}
        onChange={() => {}}
      />,
    );

    for (const id of ["size", "duration", "prompt", "custom_size"]) {
      expect(screen.getByTestId(`generator-${id}-label`)).toBeInTheDocument();
    }
  });
});
