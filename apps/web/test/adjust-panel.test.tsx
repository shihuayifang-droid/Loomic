import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ToolDefinition } from "@loomic/shared";

import { AdjustPanel, type AdjustParamGroup } from "../src/components/canvas/adjust-panel";
import {
  ADJUST_PARAM_IDS,
  ZERO_ADJUST,
  type AdjustParams,
} from "../src/lib/adjust-render";
import type { ParamSliderConfig } from "../src/lib/param-slider";

/**
 * 工单 30K T4 · ED-01 调整面板。
 *
 * 覆盖规格 ED-01 的验收 1（17 个 testid 齐全）与验收 2 的网络部分（拖滑块不发请求），
 * 以及工单 §3-T3 点名的其余行为：完成不可点的文案来自工具定义、「重置」回到 defaultValue、
 * 关闭等于取消。
 *
 * **分组与滑块配置都是 fixture**：web 代码里不许出现参数的中文标签和值域数字表
 * （工单 §2 裁决 1，X-P11 / MD-03：配置由服务端下发，登记在 T-66），所以中文标签只在这里。
 * 值域照规格 ED-01 的表：光 7 项与色 4 项是 −100~+100；效果 6 项里清晰度/晕影 −100~+100，
 * 锐化/颗粒/柔光/辉光 0~100。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup。
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 规格 ED-01 的三组：光 7 / 色 4 / 效果 6。 */
function groups(): AdjustParamGroup[] {
  const slider = (id: string, label: string, min: number, max: number): ParamSliderConfig => ({
    id,
    label,
    min,
    max,
    defaultValue: 0,
    display: { kind: "linear", a: 0, k: 1, round: 0 },
  });

  return [
    {
      id: "light",
      label: "光",
      params: [
        slider("light", "光线", -100, 100),
        slider("exposure", "曝光", -100, 100),
        slider("contrast", "对比度", -100, 100),
        slider("highlights", "高光", -100, 100),
        slider("shadows", "阴影", -100, 100),
        slider("whites", "白色", -100, 100),
        slider("blacks", "黑色", -100, 100),
      ],
    },
    {
      id: "color",
      label: "色",
      params: [
        slider("vibrance", "自然饱和度", -100, 100),
        slider("saturation", "饱和度", -100, 100),
        slider("temperature", "色温", -100, 100),
        slider("tint", "色调", -100, 100),
      ],
    },
    {
      id: "effect",
      label: "效果",
      params: [
        slider("sharpen", "锐化", 0, 100),
        slider("clarity", "清晰度", -100, 100),
        slider("grain", "颗粒", 0, 100),
        slider("vignette", "晕影", -100, 100),
        slider("glamour", "柔光", 0, 100),
        slider("bloom", "辉光", 0, 100),
      ],
    },
  ];
}

/** 工具定义：照 30F 的夹具形状，「调整」这条带 no_adjustment 规则。 */
function makeTool(disabledRules: ToolDefinition["disabled_rules"]): ToolDefinition {
  return {
    id: "adjust",
    label: "调整",
    icon: "adjust",
    testid: "image-toolbar-adjust",
    form: "panel",
    default_slot: "more",
    removable: true,
    consumes: false,
    pricing: null,
    output_kind: "image",
    output_format: null,
    file_prefix: null,
    event_type: null,
    disabled_rules: disabledRules,
    eta_seconds: null,
    agent_callable: false,
    availability: "enabled",
  };
}

const TOOL = makeTool([{ id: "no_adjustment", message: "未做任何调整" }]);
/** 缺 no_adjustment 规则的同一份工具定义（裁决 2 的第二种情况）。 */
const TOOL_WITHOUT_RULE = makeTool([]);

type HarnessProps = {
  tool?: ToolDefinition;
  initial?: AdjustParams;
  onDone?: (values: AdjustParams) => void;
  onCancel?: () => void;
  onAuto?: () => void;
  onChange?: (next: AdjustParams) => void;
};

/**
 * 受控外壳：面板自己不持有值，测试要「改一个滑块 → 完成变可点」这种连续流程，
 * 就得有一个真的会把 `onChange` 写回去的父组件。
 */
function Harness({ tool = TOOL, initial = ZERO_ADJUST, ...callbacks }: HarnessProps) {
  const [values, setValues] = useState<AdjustParams>(initial);
  return (
    <AdjustPanel
      tool={tool}
      groups={groups()}
      values={values}
      onChange={(next) => {
        setValues(next);
        callbacks.onChange?.(next);
      }}
      onAuto={callbacks.onAuto ?? (() => {})}
      onCancel={callbacks.onCancel ?? (() => {})}
      onDone={callbacks.onDone ?? (() => {})}
    />
  );
}

/** 一个滑块的内部值节点（ARIA 在 `ParamSlider` 里的原生 range 上）。 */
function sliderOf(id: string): HTMLElement {
  return within(screen.getByTestId(`adjust-slider-${id}`)).getByRole("slider");
}

describe("AdjustPanel（ED-01）", () => {
  it("验收 1：17 个 adjust-slider-* 都在，且集合与 ADJUST_PARAM_IDS 相等", () => {
    render(<Harness />);

    expect(screen.getByTestId("adjust-panel")).toBeTruthy();
    const rendered = ADJUST_PARAM_IDS.filter(
      (id) => screen.queryByTestId(`adjust-slider-${id}`) !== null,
    );
    expect(rendered).toEqual([...ADJUST_PARAM_IDS]);
    expect(rendered).toHaveLength(17);
    // 按 id 取出来的节点确实在面板里（不是别的 testid 撞上）
    for (const id of ADJUST_PARAM_IDS) {
      expect(sliderOf(id), `${id} 的滑块节点`).toBeTruthy();
    }
  });

  it("六个固定 testid 齐全；标题取 tool.label；三组各有 role=group 与组名", () => {
    render(<Harness />);

    for (const testid of [
      "adjust-panel",
      "adjust-reset-button",
      "adjust-close-button",
      "adjust-auto-button",
      "adjust-cancel-button",
      "adjust-done-button",
    ]) {
      expect(screen.getByTestId(testid), testid).toBeTruthy();
    }
    // 标题栏用 tool.label
    expect(screen.getByText("调整")).toBeTruthy();
    for (const group of groups()) {
      expect(screen.getByRole("group", { name: group.label })).toBeTruthy();
    }
    // 图标按钮必须有 aria-label（a11y-lint / X-06）
    expect(screen.getByTestId("adjust-reset-button").getAttribute("aria-label")).toBe("重置");
    expect(screen.getByTestId("adjust-close-button").getAttribute("aria-label")).toBe("关闭");
  });

  it("全部为 0 时「完成」disabled，title 取工具定义里的文案；改一项后变可点", () => {
    render(<Harness />);

    const done = screen.getByTestId("adjust-done-button");
    expect(done).toBeDisabled();
    expect(done.getAttribute("title")).toBe("未做任何调整");

    fireEvent.change(sliderOf("exposure"), { target: { value: "40" } });

    expect(done).not.toBeDisabled();
    expect(done.getAttribute("title")).toBeNull();
  });

  it("工具定义里没有 no_adjustment 规则时：「完成」仍然 disabled，title 为空", () => {
    render(<Harness tool={TOOL_WITHOUT_RULE} />);

    const done = screen.getByTestId("adjust-done-button");
    expect(done).toBeDisabled();
    expect(done.getAttribute("title")).toBe("");
  });

  it("「重置」把 17 项全部写回 defaultValue（fixture 全为 0，即 ZERO_ADJUST）", () => {
    const onChange = vi.fn();
    // 从一个非零初值开始，才看得出重置真的写了 17 项
    const nonZero: AdjustParams = { ...ZERO_ADJUST, exposure: 40, clarity: 25, tint: -10 };
    render(<Harness initial={nonZero} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("adjust-reset-button"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(ZERO_ADJUST);
    // 面板确实回到了「全 0」状态
    expect(screen.getByTestId("adjust-done-button")).toBeDisabled();
  });

  it("「关闭」调 onCancel、不调 onDone；「取消」同样", () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();
    render(<Harness onCancel={onCancel} onDone={onDone} initial={{ ...ZERO_ADJUST, exposure: 20 }} />);

    fireEvent.click(screen.getByTestId("adjust-close-button"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("adjust-cancel-button"));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("「自动调整」调 onAuto（面板自己不碰图像）", () => {
    const onAuto = vi.fn();
    render(<Harness onAuto={onAuto} />);

    fireEvent.click(screen.getByTestId("adjust-auto-button"));

    expect(onAuto).toHaveBeenCalledTimes(1);
  });

  it("「完成」可点时把当前 17 项交给 onDone", () => {
    const onDone = vi.fn();
    const initial: AdjustParams = { ...ZERO_ADJUST, saturation: -20 };
    render(<Harness onDone={onDone} initial={initial} />);

    fireEvent.click(screen.getByTestId("adjust-done-button"));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(initial);
  });

  it("验收 2（网络部分）：拖滑块不发任何请求", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.change(sliderOf("exposure"), { target: { value: "40" } });
    fireEvent.change(sliderOf("saturation"), { target: { value: "-20" } });

    expect(fetchSpy).not.toHaveBeenCalled();
    // 顺带确认这两次调整真的写回了（不是空操作）
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1]![0]).toMatchObject({ exposure: 40, saturation: -20 });
  });

  it("滑块改动只覆盖被拖的那一项，其余 16 项原样带出去", () => {
    const onChange = vi.fn();
    const initial: AdjustParams = { ...ZERO_ADJUST, tint: -15, grain: 30 };
    render(<Harness initial={initial} onChange={onChange} />);

    fireEvent.change(sliderOf("clarity"), { target: { value: "25" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual({ ...initial, clarity: 25 });
  });
});
