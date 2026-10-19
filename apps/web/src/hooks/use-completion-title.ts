"use client";

import {
  beginTask,
  completionTitle,
  endTask,
  type RoundState,
} from "@/lib/completion-title";

/**
 * CV-10 完成提醒（工单 30H T3）
 *
 * 用法：面板在任务**提交成功**时 `begin(jobId)`，在到达终态时 `end(jobId, ok)`。
 * 一轮（同时提交的多个任务）里最后一个任务结束时，才决定要不要改标题。
 *
 * ## 为什么要模块级单例
 *
 * 「本轮」是**全页面**的概念：用户可能同时提交了 3 个任务，它们分属不同组件实例
 * （甚至不同面板）。状态放在组件里就会各算各的轮，永远凑不齐「本轮全部任务结束」，
 * 于是每个任务各闪一次标题 —— 正是 CV-10 第 3 条禁止的行为。
 * 所以「轮」与「被改前的原标题」都放在模块作用域；组件只是拿 `{ begin, end }`。
 *
 * ## 什么时候改标题（CV-10 第 1 条 + 验收 1、2）
 *
 * - 页面**隐藏**（`document.visibilityState === "hidden"`）时才改：先记下此刻的
 *   `document.title`，再写成本轮结果的文案；监听 `visibilitychange`，一旦回到
 *   visible 立刻还原（不等轮询，所以「1 秒内复原」自然成立）。
 * - 页面在前台时**什么都不做**（验收 2）—— 连原标题都不记，避免留一个永远用不上的快照。
 * - 还原后移除监听；`savedTitle` 置空，同一轮里不会重复改。
 *
 * **复原目标是「改标题之前那一刻的 `document.title`」，不是写死的产品名**：
 * 规格原文写的是「{项目名} · HaHart」，但改名（BR-20）还没做，本单不猜产品名。
 *
 * 第二轮在**仍然隐藏**的情况下结束时：`savedTitle` 还是最初那份，只把标题文案换成
 * 新一轮的计数 —— 否则标签栏会一直挂着上一轮的「2 项完成」。还原目标不变。
 */

const EMPTY_ROUND: RoundState = { pending: new Set<string>(), succeeded: 0, failed: 0 };

let round: RoundState = EMPTY_ROUND;

/** 改标题之前的原标题；`null` = 当前没有改过标题。 */
let savedTitle: string | null = null;

function handleVisibilityChange(): void {
  // 回到前台就立刻复原（验收 1：切回后 1 秒内回到原标题）。
  if (document.visibilityState === "visible") restoreTitle();
}

function restoreTitle(): void {
  if (savedTitle === null) return;
  document.title = savedTitle;
  savedTitle = null;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function announceRoundEnd(succeeded: number, failed: number): void {
  // 前台不改标题（验收 2）：连原标题都不记。
  if (document.visibilityState !== "hidden") return;
  if (savedTitle === null) {
    savedTitle = document.title;
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  document.title = completionTitle(succeeded, failed);
}

function begin(id: string): void {
  round = beginTask(round, id);
}

function end(id: string, ok: boolean): void {
  const { state, finishedRound } = endTask(round, id, ok);
  round = state;
  if (!finishedRound) return;
  announceRoundEnd(state.succeeded, state.failed);
}

export type CompletionTitleControls = {
  /** 任务提交成功后调用（一份 job 一个 id）。 */
  begin: (id: string) => void;
  /** 任务到达终态时调用：`ok = false` 表示失败或取消。 */
  end: (id: string, ok: boolean) => void;
};

/**
 * 回调是模块级常量，身份稳定 —— 放进 `useCallback` 依赖数组不会引起重建。
 * 本 hook 不持有 React 状态，因此不需要 `useEffect`；监听器的生命周期跟着「一轮」走。
 */
const CONTROLS: CompletionTitleControls = { begin, end };

export function useCompletionTitle(): CompletionTitleControls {
  return CONTROLS;
}

/**
 * **仅测试用**：把模块级单例复位（RTL 每例之间必须调一次，否则上一例的
 * `pending` / `savedTitle` 会漏到下一例）。
 *
 * 不写 `document.title`：测试里那通常是 defineProperty 出来的假实现，
 * 复位动作不该产生一次「标题写入」，否则「前台不改标题」这类断言会被自己的清理逻辑污染。
 */
export function resetCompletionTitleForTests(): void {
  round = EMPTY_ROUND;
  savedTitle = null;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}
