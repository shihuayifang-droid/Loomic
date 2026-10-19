"use client";

/**
 * ED-00m 前端 · `useDirectExecute`（工单 30M T2）
 *
 * 把一个「直接执行」入口需要的四件事收在一处：
 *   1. 不可点的原因与 tooltip（T1 的纯函数，这里只转调）
 *   2. **同步**提交锁（裁决 3）—— 连点 3 次只提交 1 次（验收 1 前端那一半）
 *   3. `clientRequestId` 的生成与复用（裁决 4，对齐 GN-38 的 24 小时去重）
 *   4. 点击当拍的 `onStart` 同步回调（裁决 5 / 验收 3）
 *
 * ## 为什么锁是模块级的
 *
 * 同一张图、同一个工具在工具条和「更多」菜单各有一个入口，两个入口是两个 hook 实例。
 * 状态放组件里就互不可见，所以要放在模块级，键是 `(sourceId, toolId)`。
 *
 * ## 为什么必须是模块变量而不是 React state
 *
 * `setState` 是异步的：同一个 `act` 里连点 3 次，三次都会读到旧的 `loading = false`，
 * 于是三次全部穿过锁 —— 这正是验收 1 要防的。所以锁在 `execute()` 的第一段里
 * **同步**检查 + 同步置位，`notify()` 只负责通知订阅者去重渲染，不参与判定。
 *
 * ## 为什么 resolve 和 reject 都要放锁，但 id 只在一半清
 *
 * - 放锁：不放就会永久卡住（`submit` 抛错后入口再也点不动）。
 * - id：**reject 后保留**，下次重试复用同一个 —— 网络失败时请求可能其实已经落地，
 *   复用 id 让服务端能去重，避免扣两次（裁决 4）。**resolve 后清掉**，下一次是新的一单。
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  directExecuteBlockReason,
  directExecuteTooltip,
  inFlightKey,
} from "@/lib/direct-execute";
import type { PriceState } from "@/lib/price-display";

export type DirectExecuteResult =
  | { status: "submitted"; jobId: string }
  | { status: "blocked"; reason: string }
  | { status: "in_flight" }
  | { status: "failed"; error: unknown };

/** 调用方传进来的提交函数（真正的网络请求在调用方，本单不接画布）。 */
export type DirectExecuteSubmit = (req: { clientRequestId: string }) => Promise<{ jobId: string }>;

/** 点击当拍的通知：调用方据此在 200ms 内放置占位（验收 3）。 */
export type DirectExecuteOnStart = (info: {
  clientRequestId: string;
  etaSeconds: number | null;
}) => void;

export type UseDirectExecuteInput = {
  toolId: string;
  sourceId: string;
  price: PriceState;
  available: number | null;
  etaSeconds: number | null;
  submit: DirectExecuteSubmit;
  /**
   * 显式带上 `| undefined`：本仓 `exactOptionalPropertyTypes: true`，
   * 不写的话调用方把「可能没有的 prop」原样转传进来会报类型错。
   */
  onStart?: DirectExecuteOnStart | undefined;
};

export type UseDirectExecuteReturn = {
  disabled: boolean;
  reason: string | null;
  tooltip: string | null;
  loading: boolean;
  execute: () => Promise<DirectExecuteResult>;
};

/** 一格锁：`(sourceId, toolId)` 一条。 */
type LockEntry = {
  /** 已生成但还没被服务端确认的请求 id；resolve 后清空，reject 后保留待复用 */
  clientRequestId: string | null;
  /** 正在等 `submit` 的结果 */
  inFlight: boolean;
};

const locks = new Map<string, LockEntry>();

/**
 * 订阅者集合：两个入口要**同时**显示 loading，所以锁的变化必须能被跨实例感知。
 * 用 `useSyncExternalStore` + 一个 Set 就够，不为此引任何依赖。
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isInFlight(key: string): boolean {
  return locks.get(key)?.inFlight === true;
}

/**
 * 测试专用：清掉模块级锁。
 *
 * 锁是模块级的，会在用例之间残留 —— 上一例的 `inFlight = true` 会让下一例一进来就是
 * `disabled`。`afterEach` 里必须先 `cleanup()`（卸掉订阅）再调它。
 */
export function __resetDirectExecuteLocksForTest(): void {
  locks.clear();
  notify();
}

/**
 * 裁决 3 + 4 + 5 的实现。
 *
 * `execute()` 的返回契约（裁决 6）：
 * - 被拦 → `{ status: "blocked", reason }`，**不调** `submit`、**不调** `onStart`
 * - 被锁 → `{ status: "in_flight" }`
 * - 提交成功 → `{ status: "submitted", jobId }`
 * - 提交失败 → `{ status: "failed", error }`（不抛，调用方不必 try/catch）
 */
export function useDirectExecute(input: UseDirectExecuteInput): UseDirectExecuteReturn {
  const { toolId, sourceId, price, available, etaSeconds, submit, onStart } = input;

  const key = inFlightKey(sourceId, toolId);

  // 订阅模块锁：同一个 key 的两个 hook 实例会一起变 loading。
  const getSnapshot = useCallback(() => isInFlight(key), [key]);
  const getServerSnapshot = useCallback(() => false, []);
  const loading = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // 每次渲染都重算：价格与余额都可能变（询价回来、余额刷新）。
  const reason = directExecuteBlockReason({ price, available });
  const tooltip = directExecuteTooltip(price);

  const execute = useCallback(async (): Promise<DirectExecuteResult> => {
    // ① 先判价格与余额。被拦时一个副作用都不要有（裁决 6）。
    const blockedReason = directExecuteBlockReason({ price, available });
    if (blockedReason !== null) {
      return { status: "blocked", reason: blockedReason };
    }

    // ② 锁：同步检查 + 同步置位，中间不许有 await（裁决 3 / 已知坑第 1 条）。
    const entry: LockEntry = locks.get(key) ?? { clientRequestId: null, inFlight: false };
    if (entry.inFlight) {
      return { status: "in_flight" };
    }
    if (entry.clientRequestId === null) {
      entry.clientRequestId = crypto.randomUUID();
    }
    entry.inFlight = true;
    locks.set(key, entry);
    notify();

    const clientRequestId = entry.clientRequestId;

    // ③ 占位回调：点击的同一拍同步调用，早于 `submit` 被 await（裁决 5 / 验收 3）。
    onStart?.({ clientRequestId, etaSeconds });

    try {
      const { jobId } = await submit({ clientRequestId });
      // ④ 成功：一单结束，下一次执行换新 id。
      entry.clientRequestId = null;
      return { status: "submitted", jobId };
    } catch (error) {
      // ⑤ 失败：id 留着，下次重试复用（GN-38 去重）；锁无论如何都要放。
      return { status: "failed", error };
    } finally {
      entry.inFlight = false;
      notify();
    }
  }, [key, price, available, etaSeconds, submit, onStart]);

  return {
    disabled: reason !== null || loading,
    reason,
    tooltip,
    loading,
    execute,
  };
}
