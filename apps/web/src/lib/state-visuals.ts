/**
 * BR-15 · 状态视觉规范的唯一来源（纯数据 + 纯函数，无 React）。
 *
 * 价格五态、占位六态、四种标识、透明棋盘格都在这里定义一次；组件只引用、不再各写各的。
 * 对应的一页规范稿：docs/design/state-visuals.md（test/state-visuals.test.ts 会核对两边一致）。
 *
 * 取值规则：
 *  - 文案与现有实现逐字一致（价格文案取自 price-display.ts 导出的常量）。
 *  - TONE_CLASSES 以组件里现有的 Tailwind 类名为准（不改视觉）。
 */
import {
  ESTIMATING_TEXT,
  FREE_TEXT,
  PENDING_TEXT,
  RETRY_TEXT,
  type PriceState,
} from "./price-display";

export type StateTone =
  | "neutral"
  | "progress"
  | "warning"
  | "danger"
  | "success"
  | "info";

export type StateVisual = {
  label: string;
  tone: StateTone;
  icon:
    | "none"
    | "spinner"
    | "clock"
    | "refresh"
    | "alert"
    | "check"
    | "ban"
    | "sparkle"
    | "eye"
    | "stop";
  animated: boolean;
};

/** 价格五态。priced 的文案是询价返回的数字，这里的 label 为空串。 */
export const PRICE_STATE_VISUALS: Record<PriceState["status"], StateVisual> = {
  estimating: {
    label: ESTIMATING_TEXT,
    tone: "progress",
    icon: "spinner",
    animated: true,
  },
  priced: { label: "", tone: "neutral", icon: "none", animated: false },
  free: { label: FREE_TEXT, tone: "success", icon: "none", animated: false },
  pending: {
    label: PENDING_TEXT,
    tone: "warning",
    icon: "none",
    animated: false,
  },
  error: { label: RETRY_TEXT, tone: "danger", icon: "none", animated: false },
};

/** 占位六态（任务状态的六个公开值，见 job-status.ts）。 */
export const SLOT_STATE_VISUALS: Record<
  "queued" | "running" | "retrying" | "failed" | "canceled" | "succeeded",
  StateVisual
> = {
  queued: { label: "排队中", tone: "neutral", icon: "clock", animated: false },
  running: { label: "生成中", tone: "progress", icon: "spinner", animated: true },
  retrying: { label: "重试中", tone: "warning", icon: "refresh", animated: true },
  failed: { label: "生成失败", tone: "danger", icon: "alert", animated: false },
  canceled: { label: "已取消", tone: "neutral", icon: "ban", animated: false },
  succeeded: { label: "完成", tone: "success", icon: "check", animated: false },
};

/** 标识四种（P1/P2 功能，先定规范）。 */
export const BADGE_VISUALS: Record<
  "trial" | "demo" | "stopped" | "readonly_share",
  StateVisual
> = {
  trial: { label: "试用", tone: "info", icon: "sparkle", animated: false },
  demo: { label: "演示模式", tone: "warning", icon: "none", animated: false },
  stopped: { label: "已停止", tone: "neutral", icon: "stop", animated: false },
  readonly_share: { label: "只读", tone: "info", icon: "eye", animated: false },
};

/**
 * 色调 → Tailwind 类名。
 * progress 取 GenerationShimmer 现有的 border-border / bg-muted；
 * danger 取 FailedGenerationSlot 现有的 destructive 三件套。
 */
export const TONE_CLASSES: Record<
  StateTone,
  { text: string; border: string; bg: string }
> = {
  neutral: {
    text: "text-muted-foreground",
    border: "border-border",
    bg: "bg-muted",
  },
  progress: {
    text: "text-muted-foreground",
    border: "border-border",
    bg: "bg-muted",
  },
  warning: {
    text: "text-amber-600",
    border: "border-amber-500",
    bg: "bg-amber-500/5",
  },
  danger: {
    text: "text-destructive",
    border: "border-destructive",
    bg: "bg-destructive/5",
  },
  success: {
    text: "text-emerald-600",
    border: "border-emerald-500",
    bg: "bg-emerald-500/5",
  },
  info: {
    text: "text-sky-600",
    border: "border-sky-500",
    bg: "bg-sky-500/5",
  },
};

/** 透明棋盘格的唯一定义（画布底栏「透明」色块等处引用）。 */
export const TRANSPARENT_CHECKERBOARD_STYLE: {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
} = {
  backgroundImage:
    "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0,0 4px,4px -4px,-4px 0px",
};
