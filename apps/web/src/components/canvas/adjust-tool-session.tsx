"use client";

import { useState } from "react";

import type { ToolDefinition } from "@loomic/shared";

import type { AutoAdjustResult } from "@/lib/adjust-auto";
import { ZERO_ADJUST, type AdjustParams } from "@/lib/adjust-render";

import { AdjustPanel, type AdjustParamGroup } from "./adjust-panel";

/**
 * ED-01: holds the slider values for one adjust session and hosts {@link AdjustPanel}.
 *
 * The groups come from the tool definition (`param_groups`, MD-03); the panel never
 * touches pixels, so `onAuto` / `onDone` are supplied by the layer.
 */
export function AdjustToolSession(props: {
  tool: ToolDefinition;
  onAuto: () => Promise<AutoAdjustResult>;
  onCancel: () => void;
  onDone: (params: AdjustParams) => void;
}) {
  const { tool, onAuto, onCancel, onDone } = props;
  const [values, setValues] = useState<AdjustParams>(ZERO_ADJUST);
  const groups: AdjustParamGroup[] = (tool.param_groups ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    // Same shape as ParamSliderConfig; zod types optional keys as `T | undefined`,
    // which `exactOptionalPropertyTypes` rejects, hence the one cast.
    params: group.params as unknown as AdjustParamGroup["params"],
  }));

  return (
    <AdjustPanel
      tool={tool}
      groups={groups}
      values={values}
      onChange={setValues}
      onAuto={() => {
        void onAuto()
          .then((result) => setValues((current) => ({ ...current, ...result })))
          .catch(() => {});
      }}
      onCancel={onCancel}
      onDone={onDone}
    />
  );
}
