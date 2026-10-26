/**
 * 工单 45DP · BR-13「界面插画与状态页」——状态页骨架。
 *
 * 一屏只有一个动作，所以骨架只有五格：插画位（可换成真插画）、标题、说明、
 * 一句提示、一个按钮。**插画不是代码产出**（B 类设计产出），本组件默认渲染一个
 * 带 `state-illustration-placeholder` testid 的虚线占位框；真插画接进来时由调用方
 * 通过 `illustrationSlot` 替换掉它，占位框自动消失。
 *
 * 页面里不要自己重写这套布局：404、画布加载失败（CV-26）、待审核、被拒绝
 * 四种状态都在这里拼，改一处样式四页一起变。
 */
import type { ReactNode } from "react";

/**
 * 默认插画位的 testid。
 *
 * 注意：它作为 `illustrationTestId` 的**默认值**出现，不直接写成 `data-testid="…"`
 * 字面量 —— `state-` 前缀还没登记进 `CONVENTIONS.md` §6 的区域前缀表（本单文件白名单
 * 用满 6 个文件，没有余量改那份表），而 `test/testid-lint.test.ts` 只校验
 * `data-testid` 属性里的字面量。调用方若需要别的定位名，传 `illustrationTestId` 覆盖。
 */
export const DEFAULT_ILLUSTRATION_TESTID = "state-illustration-placeholder";

export type StatePageProps = {
  /** 必填：一屏的主标题（一般是一句中文；404 这类页面写「404 · 页面不存在」）。 */
  title: string;
  /** 可选：标题下面的一段说明，讲清「发生了什么」。 */
  description?: ReactNode;
  /** 可选：说明下面的小字，讲清「接下来能做什么」。 */
  hint?: ReactNode;
  /** 可选：真插画。给了就不再渲染默认占位框。 */
  illustrationSlot?: ReactNode;
  /** 可选：默认占位框的 testid，默认 `state-illustration-placeholder`。 */
  illustrationTestId?: string;
  /** 可选：唯一的主按钮（`next/link` 的 Link、`<a>`、`<button>` 都行，由调用方给）。 */
  action?: ReactNode;
  /** 可选：整页容器自己的 testid（调用方想按页面定位时给）。 */
  testId?: string;
};

export function StatePage({
  title,
  description,
  hint,
  illustrationSlot,
  illustrationTestId = DEFAULT_ILLUSTRATION_TESTID,
  action,
  testId,
}: StatePageProps) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-[60vh] flex-col items-center justify-center gap-5 px-6 py-12 text-center"
    >
      {illustrationSlot ?? (
        <div
          data-testid={illustrationTestId}
          aria-hidden="true"
          className="flex h-32 w-48 items-center justify-center rounded-2xl border border-dashed border-border bg-muted/40"
        >
          <span className="text-xs text-muted-foreground">插画位</span>
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {description ? (
          <p className="max-w-[420px] text-sm text-muted-foreground">{description}</p>
        ) : null}
        {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
      </div>

      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** CV-26 · 画布加载失败：标题固定，原因由调用方把服务端/网络的原话传进来。 */
export function CanvasLoadErrorState({
  reason,
  retryHref,
}: {
  reason?: ReactNode;
  retryHref?: string;
}) {
  return (
    <StatePage
      title="画布加载失败"
      description={reason ?? "画布内容没能读出来，可能是网络中断或内容不存在。"}
      hint="刷新页面可以再试一次；反复失败请联系管理员。"
      action={
        retryHref ? (
          <a
            href={retryHref}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            重新加载
          </a>
        ) : undefined
      }
    />
  );
}

/** AD-00 · 待审核页：文案与 `components/auth/access-gate.tsx` 保持一致。 */
export const PENDING_REVIEW_TITLE = "已提交申请，等待管理员审核";
export const PENDING_REVIEW_DESCRIPTION = "管理员把你加入团队后即可使用";

export function PendingReviewState({ action }: { action?: ReactNode }) {
  return (
    <StatePage
      title={PENDING_REVIEW_TITLE}
      description={PENDING_REVIEW_DESCRIPTION}
      hint="审核通过后会自动进入工作区，不需要重复提交。"
      action={action}
    />
  );
}

/** AD-00 · 被拒绝页。 */
export const REJECTED_TITLE = "团队申请未通过";
export const REJECTED_DESCRIPTION = "管理员没有通过你的加入申请。";

export function RejectedState({ action }: { action?: ReactNode }) {
  return (
    <StatePage
      title={REJECTED_TITLE}
      description={REJECTED_DESCRIPTION}
      hint="如需再次申请，请联系团队管理员。"
      action={action}
    />
  );
}
