import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ParamSlider } from "../src/components/ui/param-slider";
import {
  type ParamSliderConfig,
  snap,
  stepValues,
  toDisplay,
} from "../src/lib/param-slider";

/** 多角度工具的「缩放」：三档离散，内部值域默认 0~100 */
const STEPS_CFG: ParamSliderConfig = {
  id: "zoom",
  label: "缩放",
  defaultValue: 0,
  display: { kind: "steps", labels: ["特写", "中等", "广角"] },
};

/** 同一组件的另一份「完全不同」的配置：linear，显示 -45°~45° */
const LINEAR_CFG: ParamSliderConfig = {
  id: "exposure",
  label: "曝光",
  defaultValue: 50,
  display: { kind: "linear", a: -45, k: 0.9, round: 0, unit: "°" },
};

/** 滑块本体是 testid 节点，ARIA 值在它内部的原生 range 输入框（role=slider）上 */
function sliderOf(testid: string): HTMLElement {
  return within(screen.getByTestId(testid)).getByRole("slider");
}

// 本仓 vitest 没开 globals，RTL 不会自动 cleanup，每个文件自己收
afterEach(() => {
  cleanup();
});

describe("toDisplay", () => {
  it("linear：a=-45 / k=0.9 时 v=0→-45、v=100→45，取整正确", () => {
    expect(toDisplay(LINEAR_CFG, 0)).toEqual({ text: "-45°", value: -45 });
    expect(toDisplay(LINEAR_CFG, 100)).toEqual({ text: "45°", value: 45 });
    expect(toDisplay(LINEAR_CFG, 50)).toEqual({ text: "0°", value: 0 });
  });

  it("linear：按 round 位小数取整，unit 只进 text 不进 value", () => {
    const cfg: ParamSliderConfig = {
      id: "exposure-bias",
      label: "曝光补偿",
      defaultValue: 0,
      display: { kind: "linear", a: 0, k: 0.5, round: 1, unit: "EV" },
    };
    expect(toDisplay(cfg, 3)).toEqual({ text: "1.5EV", value: 1.5 });
  });

  it("steps：v=100→「广角」、v=0→「特写」", () => {
    expect(toDisplay(STEPS_CFG, 100)).toEqual({ text: "广角", value: "广角" });
    expect(toDisplay(STEPS_CFG, 0)).toEqual({ text: "特写", value: "特写" });
  });

  it("steps：提交值就是档位文字（不是内部值）", () => {
    expect(toDisplay(STEPS_CFG, 52)).toEqual({ text: "中等", value: "中等" });
  });
});

describe("snap / stepValues", () => {
  it("snap：3 档时 v=40 吸附到 50，v=80 吸附到 100", () => {
    expect(snap(STEPS_CFG, 40)).toBe(50);
    expect(snap(STEPS_CFG, 80)).toBe(100);
  });

  it("snap：linear 夹到值域，不取整", () => {
    expect(snap(LINEAR_CFG, -10)).toBe(0);
    expect(snap(LINEAR_CFG, 140)).toBe(100);
    expect(snap(LINEAR_CFG, 42)).toBe(42);
  });

  it("stepValues：默认 0~100 三档等距，首末为 min/max", () => {
    expect(stepValues(STEPS_CFG)).toEqual([0, 50, 100]);
  });

  it("stepValues：档位数不整除值域时是小数（所以吸附不靠原语的 step）", () => {
    const cfg: ParamSliderConfig = {
      id: "quality",
      label: "画质",
      defaultValue: 0,
      display: { kind: "steps", labels: ["低", "中", "高", "超高"] },
    };
    const values = stepValues(cfg);
    expect(values).toHaveLength(4);
    expect(values[0]).toBe(0);
    expect(values[3]).toBe(100);
    expect(values[1]).toBeCloseTo(100 / 3, 10);
    expect(snap(cfg, 20)).toBeCloseTo(100 / 3, 10);
  });
});

describe("ParamSlider 组件", () => {
  it("验收1：把多角度「缩放」（steps 三档）拖到最右，aria-valuetext=「广角」", () => {
    // jsdom 没有布局，拖拽的等价结果是 range 的 change 事件（真实浏览器里拖到底也走这条路径）
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} />);
    const input = sliderOf("multi-angle-slider-zoom");
    fireEvent.change(input, { target: { value: "100" } });
    expect(input).toHaveAttribute("aria-valuetext", "广角");
    expect(input).toHaveAttribute("aria-valuenow", "100");
  });

  it("吸附：拖到 40 落在 50 这一档，aria-valuetext=「中等」", () => {
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} />);
    const input = sliderOf("multi-angle-slider-zoom");
    fireEvent.change(input, { target: { value: "40" } });
    expect(input).toHaveAttribute("aria-valuenow", "50");
    expect(input).toHaveAttribute("aria-valuetext", "中等");
  });

  it("验收4：双击之后，值回到 defaultValue", () => {
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} />);
    const root = screen.getByTestId("multi-angle-slider-zoom");
    const input = sliderOf("multi-angle-slider-zoom");
    fireEvent.change(input, { target: { value: "100" } });
    expect(input).toHaveAttribute("aria-valuenow", "100");
    fireEvent.doubleClick(root);
    expect(input).toHaveAttribute("aria-valuenow", "0");
    expect(input).toHaveAttribute("aria-valuetext", "特写");
  });

  it("aria-valuenow/min/max 写的是内部值（默认 0~100）", () => {
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} />);
    const input = sliderOf("multi-angle-slider-zoom");
    expect(input).toHaveAttribute("aria-valuenow", "0");
    expect(input).toHaveAttribute("aria-valuemin", "0");
    expect(input).toHaveAttribute("aria-valuemax", "100");
    // 显示值单独走 aria-valuetext，不污染 valuenow
    expect(input).toHaveAttribute("aria-valuetext", "特写");
  });

  it("testid 为 {tool}-slider-{config.id}", () => {
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} />);
    expect(screen.getByTestId("multi-angle-slider-zoom")).toBeInTheDocument();
  });

  it("onChange 的第二个参数等于显示值（steps → 档位文字）", () => {
    const onChange = vi.fn();
    render(<ParamSlider tool="multi-angle" config={STEPS_CFG} onChange={onChange} />);
    fireEvent.change(sliderOf("multi-angle-slider-zoom"), {
      target: { value: "100" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(100, "广角");
  });

  it("onChange 的第二个参数等于显示值（linear → 取整后的数字）", () => {
    const onChange = vi.fn();
    render(<ParamSlider tool="multi-angle" config={LINEAR_CFG} onChange={onChange} />);
    fireEvent.change(sliderOf("multi-angle-slider-exposure"), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenCalledWith(0, -45);
  });

  it("验收2（可执行版）：同一个组件分别吃 linear 和 steps 两份配置，都给出正确的 aria-valuetext", () => {
    render(
      <>
        <ParamSlider tool="multi-angle" config={STEPS_CFG} />
        <ParamSlider tool="multi-angle" config={LINEAR_CFG} />
      </>,
    );
    const steps = sliderOf("multi-angle-slider-zoom");
    const linear = sliderOf("multi-angle-slider-exposure");
    fireEvent.change(steps, { target: { value: "100" } });
    fireEvent.change(linear, { target: { value: "100" } });
    expect(steps).toHaveAttribute("aria-valuetext", "广角");
    expect(linear).toHaveAttribute("aria-valuetext", "45°");
    expect(screen.getByTestId("multi-angle-slider-zoom-value")).toHaveTextContent("广角");
    expect(screen.getByTestId("multi-angle-slider-exposure-value")).toHaveTextContent("45°");
  });

  it("受控：传了 value 就以 value 为准，onChange 仍给显示值", () => {
    const onChange = vi.fn();
    render(
      <ParamSlider tool="multi-angle" config={LINEAR_CFG} value={100} onChange={onChange} />,
    );
    const input = sliderOf("multi-angle-slider-exposure");
    expect(input).toHaveAttribute("aria-valuetext", "45°");
    fireEvent.change(input, { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledWith(0, -45);
    // 父组件没更新 value，组件不自己改
    expect(input).toHaveAttribute("aria-valuenow", "100");
  });
});

/** MD-03：模型只支持 3 / 5 / 10 时，滑块只能停在这三个数上 */
describe("values 显示（离散取值表）", () => {
  const VALUES_CFG: ParamSliderConfig = {
    id: "duration",
    label: "时长",
    min: 3,
    max: 10,
    defaultValue: 5,
    display: { kind: "values", values: [3, 5, 10], unit: "s" },
  };

  it("values：4.2 吸附到 5、7 吸附到 5、8 吸附到 10", () => {
    expect(snap(VALUES_CFG, 4.2)).toBe(5);
    expect(snap(VALUES_CFG, 7)).toBe(5);
    expect(snap(VALUES_CFG, 8)).toBe(10);
  });

  it("values：stepValues 就是升序去重的取值表", () => {
    const cfg: ParamSliderConfig = {
      ...VALUES_CFG,
      display: { kind: "values", values: [10, 3, 5, 3] },
    };
    expect(stepValues(cfg)).toEqual([3, 5, 10]);
  });

  it("values：toDisplay 带单位", () => {
    expect(toDisplay(VALUES_CFG, 5)).toEqual({ text: "5s", value: 5 });
  });
});
