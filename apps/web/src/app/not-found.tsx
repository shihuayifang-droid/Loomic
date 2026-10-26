import Link from "next/link";

import { StatePage } from "@/components/states/state-page";

/**
 * 工单 45DP · BR-13：404 页改成用共享状态页骨架（`StatePage`）。
 *
 * 以前这里自己拼了一套 `flex h-screen` 布局加英文文案；现在结构、插画位、
 * 文案层级都由 `components/states/state-page.tsx` 决定，四种状态页保持一致。
 * 文案走中文（BR-13 要求不得出现占位英文），唯一的动作是回工作区。
 */
export default function NotFound() {
  return (
    <StatePage
      title="404 · 页面不存在"
      description="这个地址没有对应的页面，可能是链接过期或输入有误。"
      hint="检查地址是否正确，或者回到工作区继续。"
      action={
        <Link
          href="/home"
          className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          回到工作区
        </Link>
      }
    />
  );
}
