"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** ED-00b：下拉的展开方式只有一种 —— click。hover 只出 tooltip。 */
export type AppDropdownItem = {
  id: string;
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** disabled 的项用 tooltip 写明原因（X-P5） */
  disabledReason?: string;
  /** 在这一项前面画一条分隔线 */
  separatorBefore?: boolean;
};

export type AppDropdownProps = {
  /** 触发器 testid；菜单为 `${testid}-menu`，菜单项为 `${testid}-item-${itemId}` */
  testid: string;
  label: React.ReactNode;
  /** 触发器 hover 时的 tooltip；有它时 hover 只出 tooltip，不展开菜单 */
  tooltip?: string;
  ariaLabel?: string;
  items: readonly AppDropdownItem[];
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  triggerClassName?: string;
  menuClassName?: string;
};

const TRIGGER_CLASS =
  "inline-flex items-center justify-center rounded-md text-xs text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground";

function AppDropdownRow({
  testid,
  item,
}: {
  testid: string;
  item: AppDropdownItem;
}) {
  const itemTestid = `${testid}-item-${item.id}`;
  const reason = item.disabled === true ? item.disabledReason : undefined;
  const disabled = item.disabled === true;
  const onSelect = () => item.onSelect();

  // 只有「要说明为什么不可用」的行才挂 tooltip：其余行保持纯 menu item。
  // 挂在菜单项本身（整行触发）上，hover 落在行内任何位置都能出原因。
  if (reason === undefined) {
    return (
      <DropdownMenuItem data-testid={itemTestid} disabled={disabled} onClick={onSelect}>
        {item.label}
      </DropdownMenuItem>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <DropdownMenuItem data-testid={itemTestid} disabled={disabled} onClick={onSelect} />
        }
      >
        {item.label}
      </TooltipTrigger>
      <TooltipContent data-testid={`${itemTestid}-reason`}>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * ED-00b · 通用下拉
 *
 * - 强制 click 展开（`openOnHover={false}`），Enter/Space 可打开，Esc 或点击外部收起
 * - 触发器上有 `aria-expanded` / `aria-haspopup="menu"`（由 Base UI Menu 提供，测试实测）
 * - 触发器可以同时挂 tooltip：hover 只出 tooltip，不展开菜单
 * - 直接包在 `ui/dropdown-menu.tsx` 外面，不改它（它已有 3 处在用）
 */
export function AppDropdown({
  testid,
  label,
  tooltip,
  ariaLabel,
  items,
  side = "bottom",
  align = "start",
  triggerClassName,
  menuClassName,
}: AppDropdownProps) {
  const trigger = (
    <DropdownMenuTrigger
      data-testid={testid}
      aria-haspopup="menu"
      aria-label={ariaLabel}
      openOnHover={false}
      className={cn(TRIGGER_CLASS, triggerClassName)}
    />
  );

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger delay={150} render={trigger}>
          {label}
        </TooltipTrigger>
        {tooltip === undefined ? null : <TooltipContent>{tooltip}</TooltipContent>}
      </Tooltip>
      <DropdownMenuContent
        data-testid={`${testid}-menu`}
        side={side}
        align={align}
        className={menuClassName}
      >
        {items.map((item) => (
          <React.Fragment key={item.id}>
            {item.separatorBefore === true ? <DropdownMenuSeparator /> : null}
            <AppDropdownRow testid={testid} item={item} />
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
