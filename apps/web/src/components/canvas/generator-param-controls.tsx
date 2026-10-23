"use client";

import * as React from "react";

import { type CustomSizeGeneratorParam, type GeneratorParam, snapCustomSize } from "@loomic/shared";

import { ParamSlider } from "@/components/ui/param-slider";
import { type ParamDisplay } from "@/lib/param-slider";
import { cn } from "@/lib/utils";

/**
 * AG-07 / MD-03 · 生成器参数面板
 *
 * 面板里不出现任何具体参数名：每个参数长什么样、有哪些选项、默认值是多少，
 * 全部来自服务端下发的 `GeneratorParam[]`。图片与视频共用这一个组件，
 * 差别只在 schema。
 *
 * - `discrete`：`role="listbox"` + 每项 `role="option"`，**只渲染下发的选项**——
 *   前端不做任何组合 / 补全，否则会造出模型不接受的取值。
 * - `continuous`：交给通用的 `ParamSlider`；带 `values` 的模型只停在那几个数上。
 * - `text`：自由文本。
 * - `custom_size`：宽高两个数字输入，失焦时用 shared 的 `snapCustomSize` 修正，
 *   修正后回填并给出提示，约束说明常显。
 */

/** 一个参数的当前值：离散 / 文本是字符串，连续是数字，自定义尺寸是宽高对 */
export type GeneratorParamValue = string | number | { width: number; height: number };

export type GeneratorParamControlsProps = {
  params: readonly GeneratorParam[];
  values: Readonly<Record<string, GeneratorParamValue>>;
  onChange: (id: string, value: GeneratorParamValue) => void;
};

export function GeneratorParamControls({ params, values, onChange }: GeneratorParamControlsProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="generator-params">
      {params.map((param) => (
        <div
          key={param.id}
          data-testid={`generator-${param.id}-group`}
          className="flex flex-col gap-1.5"
        >
          <div
            data-testid={`generator-${param.id}-label`}
            className="text-xs font-medium text-foreground"
          >
            {param.label}
          </div>
          <GeneratorParamControl param={param} raw={values[param.id]} onChange={onChange} />
        </div>
      ))}
    </div>
  );
}

function GeneratorParamControl({
  param,
  raw,
  onChange,
}: {
  param: GeneratorParam;
  raw: GeneratorParamValue | undefined;
  onChange: (id: string, value: GeneratorParamValue) => void;
}) {
  if (param.type === "discrete") {
    const selected = typeof raw === "string" ? raw : param.default;

    return (
      <div
        role="listbox"
        aria-label={param.label}
        data-testid={`generator-${param.id}`}
        className="flex flex-wrap gap-1.5"
      >
        {param.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === selected}
            data-testid={`generator-${param.id}-option-${option.value}`}
            onClick={() => onChange(param.id, option.value)}
            className={cn(
              "rounded-md border px-2 py-1 text-xs transition-colors",
              option.value === selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  if (param.type === "continuous") {
    return (
      <ParamSlider
        tool="generator"
        config={{
          id: param.id,
          label: param.label,
          min: param.min,
          max: param.max,
          defaultValue: param.default,
          display: continuousDisplay(param),
        }}
        onChange={(internal, submit) => {
          onChange(param.id, typeof submit === "number" ? submit : internal);
        }}
      />
    );
  }

  if (param.type === "text") {
    const value = typeof raw === "string" ? raw : (param.default ?? "");

    return (
      <textarea
        data-testid={`generator-${param.id}-input`}
        value={value}
        maxLength={param.maxLength}
        onChange={(event) => onChange(param.id, event.target.value)}
        className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    );
  }

  return <CustomSizeControl param={param} raw={raw} onChange={onChange} />;
}

/**
 * `continuous` 的显示规则：有 `values` 就用离散取值表（只停在那儿），
 * 否则线性映射。`unit` 用条件展开写，`exactOptionalPropertyTypes` 下不允许显式 `undefined`。
 */
function continuousDisplay(
  param: Extract<GeneratorParam, { type: "continuous" }>,
): ParamDisplay {
  if (param.values) {
    return param.unit === undefined
      ? { kind: "values", values: param.values }
      : { kind: "values", values: param.values, unit: param.unit };
  }
  return param.unit === undefined
    ? { kind: "linear", a: 0, k: 1, round: 0 }
    : { kind: "linear", a: 0, k: 1, round: 0, unit: param.unit };
}

function CustomSizeControl({
  param,
  raw,
  onChange,
}: {
  param: CustomSizeGeneratorParam;
  raw: GeneratorParamValue | undefined;
  onChange: (id: string, value: GeneratorParamValue) => void;
}) {
  const initial = typeof raw === "object" && raw !== null ? raw : null;
  const [width, setWidth] = React.useState(initial === null ? "" : String(initial.width));
  const [height, setHeight] = React.useState(initial === null ? "" : String(initial.height));
  const [notice, setNotice] = React.useState<string | null>(null);

  // 失焦才修正：边输边改会把用户正在敲的数字当场改掉。
  const commit = React.useCallback(() => {
    const rawWidth = Number(width);
    const rawHeight = Number(height);
    const snapped = snapCustomSize(
      param,
      Number.isFinite(rawWidth) ? rawWidth : param.multiple,
      Number.isFinite(rawHeight) ? rawHeight : param.multiple,
    );

    setWidth(String(snapped.width));
    setHeight(String(snapped.height));
    setNotice(snapped.notice);
    onChange(param.id, { width: snapped.width, height: snapped.height });
  }, [height, onChange, param, width]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          data-testid={`generator-${param.id}-width`}
          aria-label={`${param.label} 宽`}
          value={width}
          onChange={(event) => setWidth(event.target.value)}
          onBlur={commit}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="text-xs text-muted-foreground">×</span>
        <input
          type="number"
          data-testid={`generator-${param.id}-height`}
          aria-label={`${param.label} 高`}
          value={height}
          onChange={(event) => setHeight(event.target.value)}
          onBlur={commit}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className="text-[11px] leading-tight text-muted-foreground">
        {`每边 ≤${param.maxEdge} 且为 ${param.multiple} 的倍数，长短边比 ≤${param.maxRatio}，总像素 ${param.minMegapixels}~${param.maxMegapixels}MP`}
      </p>
      {notice === null ? null : (
        <p data-testid={`generator-${param.id}-notice`} className="text-[11px] text-amber-600">
          {notice}
        </p>
      )}
    </div>
  );
}
