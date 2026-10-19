"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";
import {
  type ParamSliderConfig,
  type ParamSubmitValue,
  snap,
  toDisplay,
} from "@/lib/param-slider";

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 100;

export type ParamSliderProps = {
  /** 工具/场景标识，用来拼 testid：`{tool}-slider-{config.id}` */
  tool: string;
  config: ParamSliderConfig;
  /** 受控的内部值；不传则组件自己维护 */
  value?: number;
  onChange?: (internal: number, submit: ParamSubmitValue) => void;
};

/**
 * ED-00h · 通用参数滑块
 *
 * - 组件里不出现任何具体参数名，新增参数只改配置
 * - `aria-valuenow/min/max` 写内部值，`aria-valuetext` 写显示值
 * - 双击滑块回到 `config.defaultValue`
 */
export function ParamSlider({ tool, config, value, onChange }: ParamSliderProps) {
  const [internal, setInternal] = React.useState(config.defaultValue);
  const current = value ?? internal;
  const testid = `${tool}-slider-${config.id}`;
  const min = config.min ?? DEFAULT_MIN;
  const max = config.max ?? DEFAULT_MAX;

  // 配置换了（id 变了）时，未受控的实例回到新配置的默认值
  React.useEffect(() => {
    setInternal(config.defaultValue);
  }, [config.id, config.defaultValue]);

  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Base UI 只把 aria-valuenow 写成字面属性，min/max 走的是原生 range 的 min/max。
  // 这里把 aria-valuemin/max 也显式写上，让 ARIA 契约可被断言、与 valuenow 保持一致。
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute("aria-valuemin", String(min));
    input.setAttribute("aria-valuemax", String(max));
  });

  const commit = React.useCallback(
    (next: number) => {
      const snapped = snap(config, next);
      setInternal(snapped);
      onChange?.(snapped, toDisplay(config, snapped).value);
    },
    [config, onChange],
  );

  const display = toDisplay(config, current);

  return (
    <SliderPrimitive.Root
      data-testid={testid}
      data-param={config.id}
      min={min}
      max={max}
      step={1}
      value={current}
      onValueChange={(next) => commit(next as number)}
      onDoubleClick={() => commit(config.defaultValue)}
      className={cn("flex w-full items-center gap-2 select-none")}
    >
      <SliderPrimitive.Label className="shrink-0 text-xs text-muted-foreground">
        {config.label}
      </SliderPrimitive.Label>
      <SliderPrimitive.Control className="relative flex h-5 flex-1 items-center">
        <SliderPrimitive.Track className="relative h-1 w-full overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          inputRef={inputRef}
          getAriaLabel={() => config.label}
          getAriaValueText={(_formatted, next) => toDisplay(config, next).text}
          className="block h-3.5 w-3.5 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </SliderPrimitive.Control>
      <span
        data-testid={`${testid}-value`}
        className="w-10 shrink-0 text-right text-xs tabular-nums text-foreground"
      >
        {display.text}
      </span>
    </SliderPrimitive.Root>
  );
}
