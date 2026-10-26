/**
 * 工单 45DP · BR-13「界面插画与状态页」——统一的空状态。
 *
 * 空状态和状态页（`state-page.tsx`）共用同一套结构和同一句文案口径，区别只有
 * 两点：标题是 `<p>` 而不是 `<h1>`（它嵌在已经有标题的面板里），并且**自己判断
 * 有没有数据**：`isEmpty` 为假时整块不渲染，调用方不用在外面再包一层三元。
 *
 * 空列表的调用写法（形态固定，别在别处重写）：
 *
 *   <EmptyState isEmpty={items.length === 0} title="还没有参考图，拖入或点击上传" />
 *
 * 需要真插画时传 `illustrationSlot`，需要按位置定位时传 `testId`。
 */
import type { ReactNode } from "react";

export type EmptyStateProps = {
  /** 必填：列表是否为空。为 `true` 才渲染，为 `false` 直接返回 `null`。 */
  isEmpty: boolean;
  /** 必填：一句话说清「这里为什么是空的」。 */
  title: string;
  /** 可选：标题下面的一句补充。 */
  description?: ReactNode;
  /** 可选：空状态里唯一的动作（新建、上传、去别处看看）。 */
  action?: ReactNode;
  /** 可选：真插画（不传就只有文字，不渲染占位框）。 */
  illustrationSlot?: ReactNode;
  /** 可选：容器 testid，供既有测试沿用原来的定位名。 */
  testId?: string;
};

export function EmptyState({
  isEmpty,
  title,
  description,
  action,
  illustrationSlot,
  testId,
}: EmptyStateProps) {
  if (!isEmpty) return null;

  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center"
    >
      {illustrationSlot ? <div className="mb-1">{illustrationSlot}</div> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
