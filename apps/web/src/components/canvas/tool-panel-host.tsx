"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useToast } from "@/components/toast";

/**
 * ED-00d · 面板生命周期宿主（ToolPanelHost）
 *
 * 三条规格（ED-00d 正文 + 验收 2、3）：
 * 1. **同一时间只开一个面板**：开新面板自动关旧面板。
 * 2. 面板绑定**打开时的源对象 id**，不依赖当前选中状态 ——
 *    所以本宿主**根本不读选中状态**，连 `selection` 这个 prop 都没有。
 *    （Lovart 的反例是「选中丢失后面板仍开着、按钮变灰无提示」，根因就是面板跟着选中走。）
 * 3. 源对象被删时面板自动关闭，并 toast「源图已删除」；删的是别的对象时什么都不做。
 *
 * 本单**不接入画布**（`canvas-editor.tsx` 是脏文件，等 T-47 解决），所以只交付宿主本身。
 *
 * ## 面板内容怎么传
 *
 * 工单允许「`children` 或 render prop」二选一，这里选 **render prop（`renderPanel`）**：
 * `children` 要留给**应用子树** —— 触发器（打开调整 / 打开裁剪）本身就要调
 * `useToolPanelHost().openPanel()`，它必须在 Provider 里；若把 `children` 当成面板内容，
 * 触发器就只能放在 Provider 外面，反而调不到 hook。`renderPanel` 只在**开着**的时候被调用，
 * 关着时一个内容节点都不渲染。
 */

export type ToolPanelState = {
  /** 面板标识，例如 `adjust` / `crop`。由调用方定义，本模块只当字符串用。 */
  panelId: string;
  /** **打开时**的源对象 id。面板之后只认它，不认当前选中。 */
  sourceId: string;
};

export interface ToolPanelHostValue {
  /** 打开面板。已有面板时先关旧的再开新的，同一时刻最多一个。 */
  openPanel: (panelId: string, sourceId: string) => void;
  /** 关闭当前面板。没有面板时是空操作。 */
  closePanel: () => void;
  /**
   * 通知「某个源对象被删了」。与当前面板的 `sourceId` 相同时关闭面板并 toast；
   * 不同时什么都不做（删别的对象不该动这个面板）。
   */
  notifySourceDeleted: (sourceId: string) => void;
  /** 当前面板；`null` = 没开面板。 */
  current: ToolPanelState | null;
}

/** 源图被删时给用户看的文案（ED-00d 正文里的原话）。 */
export const SOURCE_DELETED_MESSAGE = "源图已删除";

export type ToolPanelHostProviderProps = {
  /** 应用子树。放在 Provider 里，触发器才能用 `useToolPanelHost()`。 */
  children?: ReactNode;
  /** 面板内容。只在开着的时候调用；入参是当前面板（`panelId` + 打开时的 `sourceId`）。 */
  renderPanel?: (current: ToolPanelState) => ReactNode;
};

const ToolPanelHostContext = createContext<ToolPanelHostValue | null>(null);

export function ToolPanelHostProvider({ children, renderPanel }: ToolPanelHostProviderProps) {
  const { toast } = useToast();

  const [current, setCurrentState] = useState<ToolPanelState | null>(null);
  /**
   * `notifySourceDeleted` 要读「最新的」current，但它的依赖里没有 current。
   * 不能在 `setCurrent` 的函数式更新里顺手 toast —— React 严格模式会把 updater 跑两遍，
   * toast 会发两次，所以用一个 ref 旁路存一份，ref 的写入只在下面这个 `setCurrent` 里发生。
   */
  const currentRef = useRef<ToolPanelState | null>(null);

  const setCurrent = useCallback((next: ToolPanelState | null) => {
    currentRef.current = next;
    setCurrentState(next);
  }, []);

  const openPanel = useCallback(
    (panelId: string, sourceId: string) => {
      // 直接替换整个 state：旧面板没有独立的「关闭」步骤，所以不存在两个面板同时存在的中间态。
      setCurrent({ panelId, sourceId });
    },
    [setCurrent],
  );

  const closePanel = useCallback(() => {
    setCurrent(null);
  }, [setCurrent]);

  const notifySourceDeleted = useCallback(
    (sourceId: string) => {
      const opened = currentRef.current;
      // 删的不是打开本面板的那张源图 → 本面板保持原样。
      if (opened === null || opened.sourceId !== sourceId) return;
      setCurrent(null);
      /**
       * variant 用 `info` 而不是 `error`：这不是一次失败（用户点删除是成功的），
       * 只是「面板之所以关掉」的解释，用红色报错会把一次正常操作说成出错。
       */
      toast(SOURCE_DELETED_MESSAGE, "info");
    },
    [setCurrent, toast],
  );

  const value = useMemo<ToolPanelHostValue>(
    () => ({ openPanel, closePanel, notifySourceDeleted, current }),
    [openPanel, closePanel, notifySourceDeleted, current],
  );

  return (
    <ToolPanelHostContext.Provider value={value}>
      {children}
      <div
        // 字面量而不是常量：`test/testid-lint.test.ts` 只校验**字面量** testid，
        // 写成表达式就会整条被跳过，这个 testid 也就不受 lint 保护了。
        data-testid="canvas-tool-panel-host"
        // 状态不进 testid（`CONVENTIONS.md` §1.2），开合写在 `data-state` 上。
        data-state={current === null ? "closed" : "open"}
        // 关着的时候没有「当前面板」，属性直接不出现，而不是留个空串。
        data-panel={current === null ? undefined : current.panelId}
      >
        {/* 关着就不渲染内容：面板挂的是源对象 id，源对象都没了就不该还画着它。 */}
        {current === null ? null : renderPanel?.(current)}
      </div>
    </ToolPanelHostContext.Provider>
  );
}

/** 读宿主状态。必须在 `ToolPanelHostProvider` 里用。 */
export function useToolPanelHost(): ToolPanelHostValue {
  const ctx = useContext(ToolPanelHostContext);
  if (ctx === null) {
    throw new Error("useToolPanelHost must be used within a ToolPanelHostProvider");
  }
  return ctx;
}
