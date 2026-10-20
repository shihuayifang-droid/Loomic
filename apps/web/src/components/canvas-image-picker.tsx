"use client";

import { useEffect, useRef, useState } from "react";

import { isMentionTextTruncated } from "@/lib/mention-kinds";

export type CanvasImageItem = {
  kind: "canvas-image";
  id: string;
  name: string;
  thumbnailUrl: string;
  assetId: string;
  url: string;
  mimeType: string;
};

export type BrandKitMentionItem = {
  kind: "brand-kit-asset";
  id: string;
  label: string;
  assetType: "color" | "font" | "logo" | "image";
  textContent?: string | null;
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
};

export type ImageModelMentionItem = {
  kind: "image-model";
  id: string;
  label: string;
  description?: string;
  iconUrl?: string;
};

export type SkillMentionItem = {
  kind: "skill";
  id: string;
  label: string;
  slug: string;
  description?: string;
};

export type MessageMentionPickerItem =
  | CanvasImageItem
  | BrandKitMentionItem
  | ImageModelMentionItem
  | SkillMentionItem;

type MessageMentionPickerProps = {
  items: MessageMentionPickerItem[];
  query?: string;
  onSelect: (item: MessageMentionPickerItem) => void;
  onClose: () => void;
};

function itemLabel(item: MessageMentionPickerItem): string {
  return item.kind === "canvas-image" ? item.name : item.label;
}

function itemKeywords(item: MessageMentionPickerItem): string[] {
  if (item.kind === "canvas-image") return [item.name];
  if (item.kind === "image-model") return [item.label, item.description ?? ""];
  if (item.kind === "skill") return [item.label, item.slug, item.description ?? ""];
  return [item.label, item.assetType, item.textContent ?? ""];
}

function groupTitle(kind: MessageMentionPickerItem["kind"]): string {
  if (kind === "canvas-image") return "画布对象";
  if (kind === "brand-kit-asset") return "我的素材";
  if (kind === "skill") return "技能";
  return "模型";
}

/** 渲染顺序即分组顺序，键盘上下移动按这个顺序拍平后计数。 */
const GROUP_KINDS = [
  "canvas-image",
  "brand-kit-asset",
  "image-model",
  "skill",
] as const;

export function MessageMentionPicker({
  items,
  query,
  onSelect,
  onClose,
}: MessageMentionPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredItems = query
    ? items.filter((item) =>
        itemKeywords(item).some((keyword) =>
          keyword.toLowerCase().includes(query.toLowerCase()),
        ),
      )
    : items;

  const groupedItems = filteredItems.reduce<
    Record<MessageMentionPickerItem["kind"], MessageMentionPickerItem[]>
  >(
    (acc, item) => {
      acc[item.kind].push(item);
      return acc;
    },
    {
      "canvas-image": [],
      "brand-kit-asset": [],
      "image-model": [],
      "skill": [],
    },
  );

  /** 按渲染顺序拍平（组内顺序不变），activeIndex 就是这个数组的下标。 */
  const flatItems = GROUP_KINDS.flatMap((kind) => groupedItems[kind]);
  const indexByKey = new Map<string, number>();
  flatItems.forEach((item, index) => {
    indexByKey.set(`${item.kind}:${item.id}`, index);
  });

  /**
   * query 或 items 变化时把当前项重置到第一个。
   * 依赖用内容签名而不是数组引用：父组件每次渲染都会重建 items 数组，
   * 直接用数组会让任何一次父渲染都把选中项重置掉。
   */
  const resetKey = `${query ?? ""}\u0000${items
    .map((item) => `${item.kind}:${item.id}`)
    .join("\u0001")}`;
  useEffect(() => {
    setActiveIndex(0);
  }, [resetKey]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  /**
   * 键盘：↑↓ 循环移动、Enter 插入当前项、Esc 关闭。
   * 必须用**捕获阶段**监听：输入框自身的 onKeyDown 遇到 Enter 会直接提交，
   * 冒泡阶段拿到的 Enter 已经先被输入框处理掉了。捕获阶段再加
   * preventDefault + stopPropagation，事件就到不了输入框。
   */
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown" &&
        e.key !== "Enter" &&
        e.key !== "Escape"
      ) {
        return;
      }
      // 这四个键由列表独占：既阻止默认行为，也阻止事件传到输入框 / 外层。
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (flatItems.length === 0) return;
      if (e.key === "ArrowDown") {
        setActiveIndex((prev) => (prev + 1) % flatItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        setActiveIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
        return;
      }
      const item = flatItems[activeIndex] ?? flatItems[0];
      if (!item) return;
      onSelect(item);
      onClose();
    }
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [activeIndex, flatItems, onClose, onSelect]);

  // 当前项滚进可视区；jsdom 没有 scrollIntoView，用可选调用
  useEffect(() => {
    const active = containerRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, resetKey]);

  if (filteredItems.length === 0) {
    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-2 mb-2 w-56 rounded-xl border border-border bg-popover p-3 shadow-lg"
      >
        <p className="text-xs text-muted-foreground">
          {items.length === 0 ? "暂无可引用的内容" : `没有匹配「${query}」的内容`}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-2 mb-2 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg"
    >
      <div className="p-2">
        {GROUP_KINDS.map((kind) => {
          const sectionItems = groupedItems[kind];
          if (!sectionItems.length) return null;
          return (
            <div
              key={kind}
              data-testid="agent-mention-group"
              data-group={kind}
              className="mb-2 last:mb-0"
            >
              <div className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">
                {groupTitle(kind)}
              </div>
              {sectionItems.map((item) => {
                const index = indexByKey.get(`${item.kind}:${item.id}`) ?? 0;
                const isActive = index === activeIndex;
                return (
                <button data-testid="canvas-image-picker-item"
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  data-active={isActive ? "true" : "false"}
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(item);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <PickerLeadingVisual item={item} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {itemLabel(item)}
                    </div>
                    {item.kind === "brand-kit-asset" && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {item.assetType}
                        {item.textContent ? ` · ${item.textContent}` : ""}
                        {isMentionTextTruncated(item.textContent) && (
                          <span data-testid="agent-mention-truncated-hint">
                            {" · 将截断至 4000 字"}
                          </span>
                        )}
                      </div>
                    )}
                    {item.kind === "image-model" && item.description && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {item.description}
                      </div>
                    )}
                    {item.kind === "skill" && item.description && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {item.description}
                      </div>
                    )}
                  </div>
                </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PickerLeadingVisual({ item }: { item: MessageMentionPickerItem }) {
  if (item.kind === "canvas-image") {
    return (
      <img
        src={item.thumbnailUrl}
        alt={item.name}
        className="h-8 w-8 shrink-0 rounded border border-border object-cover"
      />
    );
  }

  if (item.kind === "brand-kit-asset" && item.thumbnailUrl) {
    return (
      <img
        src={item.thumbnailUrl}
        alt={item.label}
        className="h-8 w-8 shrink-0 rounded border border-border object-cover"
      />
    );
  }

  if (item.kind === "image-model" && item.iconUrl) {
    return (
      <img
        src={item.iconUrl}
        alt={item.label}
        className="h-8 w-8 shrink-0 rounded-full border border-border object-cover"
      />
    );
  }

  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-muted text-[10px] font-medium uppercase text-muted-foreground">
      {item.kind === "brand-kit-asset"
        ? item.assetType.slice(0, 2)
        : item.kind === "skill"
          ? "SK"
          : "AI"}
    </div>
  );
}
