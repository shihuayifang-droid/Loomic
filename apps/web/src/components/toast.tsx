"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastVariant = "success" | "error" | "info";

/**
 * X-40 二期：toast 上可选的入口按钮（「修改参数」/「稍后重试」）。
 * 文案由调用方给（`lib/error-catalog.ts` 的常量），这里只负责渲染与关闭。
 */
interface ToastAction {
  label: string;
  onAction: () => void;
}

interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /**
   * `null` = 没有入口按钮。用必填的 `null` 而不是可选字段，是因为
   * tsconfig 开了 `exactOptionalPropertyTypes`，可选字段不能显式赋 undefined。
   */
  action: ToastAction | null;
}

/** 带入口按钮的 toast 的额外参数。不传就是旧行为（3 秒、无按钮）。 */
export interface ToastActionOptions {
  actionLabel: string;
  onAction: () => void;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
  /** 旧签名 `error(msg)` 保持不变；第二个参数只有入口按钮才传。 */
  error: (message: string, opts?: ToastActionOptions) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const TOAST_DURATION = 3000;
/**
 * 带入口按钮的 toast 给 6 秒：用户要先看清错在哪，再决定点「修改参数」
 * 还是「稍后重试」，3 秒不够点完。
 */
const TOAST_DURATION_WITH_ACTION = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const add = useCallback(
    (
      message: string,
      variant: ToastVariant = "info",
      opts?: ToastActionOptions,
    ) => {
      // Use crypto.randomUUID() for collision-safe IDs across concurrent renders
      const id = crypto.randomUUID();
      const action: ToastAction | null = opts
        ? { label: opts.actionLabel, onAction: opts.onAction }
        : null;
      setToasts((prev) => [...prev, { id, message, variant, action }]);
      setTimeout(
        () => remove(id),
        action ? TOAST_DURATION_WITH_ACTION : TOAST_DURATION,
      );
    },
    [remove],
  );

  const ctx = useMemo<ToastContextValue>(
    () => ({
      toast: add,
      success: (msg) => add(msg, "success"),
      error: (msg, opts) => add(msg, "error", opts),
    }),
    [add],
  );

  return (
    <ToastContext.Provider value={ctx}>
      {children}

      {/* Toast container — fixed bottom-center */}
      <div className="fixed bottom-6 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Toast item
// ---------------------------------------------------------------------------

const variantStyles: Record<ToastVariant, { bg: string; icon: ReactNode }> = {
  success: {
    bg: "bg-foreground text-background",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 shrink-0 text-success">
        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
      </svg>
    ),
  },
  error: {
    bg: "bg-foreground text-background",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 shrink-0 text-destructive">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5ZM8 11.5A.75.75 0 1 1 8 10a.75.75 0 0 1 0 1.5Z" />
      </svg>
    ),
  },
  info: {
    bg: "bg-foreground text-background",
    icon: (
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 shrink-0 text-info">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.5a.75.75 0 0 1 1.5 0v.5a.75.75 0 0 1-1.5 0v-.5ZM6.75 7.75A.75.75 0 0 1 7.5 7h.25a.75.75 0 0 1 .75.75v3h.25a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5H7.5V8.5h-.25a.75.75 0 0 1-.75-.75Z" />
      </svg>
    ),
  },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { bg, icon } = variantStyles[toast.variant];
  /**
   * 入口按钮只执行一次。点完之后 toast 会被移除，但退出动画期间按钮仍在
   * DOM 里 —— 连点两下就会把 onAction 跑两遍（重试会提交两次生成）。
   */
  const actionFiredRef = useRef(false);

  const handleAction = (event: MouseEvent<HTMLButtonElement>) => {
    // 不许冒泡到本体的 onClick，否则这一下会把 toast 关两次
    event.stopPropagation();
    if (actionFiredRef.current) return;
    actionFiredRef.current = true;
    toast.action?.onAction();
    onDismiss();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.95 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      data-testid="toast-item"
      data-variant={toast.variant}
      onClick={onDismiss}
      className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-sm ${bg}`}
    >
      {icon}
      {toast.message}
      {toast.action === null ? null : (
        <button
          type="button"
          data-testid="toast-action"
          onClick={handleAction}
          className="ml-1 shrink-0 cursor-pointer rounded-lg border border-background/40 px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/60"
        >
          {toast.action.label}
        </button>
      )}
    </motion.div>
  );
}
