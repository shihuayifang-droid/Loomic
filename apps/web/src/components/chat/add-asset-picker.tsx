"use client";

import { useState } from "react";

import {
  MessageMentionPicker,
  type MessageMentionPickerItem,
} from "@/components/canvas-image-picker";

type AddAssetPickerProps = {
  /** 只传「我的素材」那一组。 */
  items: MessageMentionPickerItem[];
  onSelect: (item: MessageMentionPickerItem) => void;
  disabled?: boolean;
};

/**
 * AG-03「添加素材」第二入口。
 *
 * 这里**不做任何转换**：挑中的 item 原样交给调用方的 onSelect，和键入 `@` 走的是
 * 同一个 handleMentionSelect → mentionFromPickerItem，两条入口因此逐字段一致。
 */
export function AddAssetPicker({
  items,
  onSelect,
  disabled,
}: AddAssetPickerProps) {
  const [open, setOpen] = useState(false);
  const isDisabled = disabled === true || items.length === 0;

  const close = () => {
    setOpen(false);
  };

  return (
    <div className="relative flex items-center px-2 pt-2">
      <button data-testid="chat-input-add-asset"
        type="button"
        aria-label="添加素材"
        title="添加素材"
        disabled={isDisabled}
        // MessageMentionPicker 在 document 上监听 mousedown 判断「点了外面」。
        // 按钮不拦住这个事件的话，点按钮会先被当成外部点击关掉列表，切换就打不开了。
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        className="flex h-8 items-center gap-1.5 rounded-full border-[0.5px] border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          className="h-[14px] w-[14px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M12 8v8M8 12h8" />
        </svg>
        <span>添加素材</span>
      </button>
      {open && !isDisabled && (
        <MessageMentionPicker
          items={items}
          query=""
          onSelect={(item) => {
            onSelect(item);
            close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
