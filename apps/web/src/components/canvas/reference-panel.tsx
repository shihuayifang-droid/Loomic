"use client";

/**
 * 工单 34P · AS-06「参考」面板（需求：参考 tab = 本项目已上传文件列表）。
 *
 * 职责边界（工单目标 3）：本单只交付组件本身 —— **不挂到画布页**，也不做
 * 「拖到画布插入」/「点击插入对话」。列表项的 `onDragStart` 只负责把资产信息
 * 写进 dataTransfer（`application/x-hahart-asset`），接收端是另一张单。
 *
 * 上传拦截不在这里重写：`uploadFile`（34B）发请求前已按 AS-02 的共享表拦一次，
 * 本项目拒绝时抛 `ApiApplicationError`，其 `message` 就是给用户看的中文原因，
 * 所以这里只把 `err.message` 原样交给 toast。
 */

import { useEffect, useRef, useState } from "react";
import type { DragEvent, JSX } from "react";

import { useToast } from "@/components/toast";
import { fetchProjectUploads, uploadFile } from "@/lib/server-api";
import type { ProjectUploadItem } from "@/lib/server-api";

/** 落到画布上的接收端（另单）读这个类型。 */
const ASSET_DRAG_MIME = "application/x-hahart-asset";

type SortOrder = "newest" | "oldest";
type FilterType = "" | "image" | "video" | "pdf";

function typeLabel(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return "图片";
  if (mimeType.startsWith("video/")) return "视频";
  return "文件";
}

export function ReferencePanel(props: { accessToken: string; projectId: string }): JSX.Element {
  const { accessToken, projectId } = props;
  const { toast } = useToast();

  const [uploads, setUploads] = useState<ProjectUploadItem[]>([]);
  const [order, setOrder] = useState<SortOrder>("newest");
  const [filter, setFilter] = useState<FilterType>("");
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 挂载即取一次；`order` / `filter` 变化重新取；上传成功后靠 `reloadToken` 再取一次。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const opts: { order?: SortOrder; type?: "image" | "video" | "pdf" } = { order };
    if (filter !== "") opts.type = filter;

    fetchProjectUploads(accessToken, projectId, opts)
      .then((result) => {
        if (cancelled) return;
        setUploads(result.uploads);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setUploads([]);
        setLoading(false);
        toast(err instanceof Error ? err.message : "参考列表加载失败");
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, projectId, order, filter, reloadToken, toast]);

  const uploadOne = (file: File) => {
    void uploadFile(accessToken, file, projectId)
      .then(() => {
        // 列表要显示服务端返回的名字与签名 url，所以成功后就重新取，不在本地拼一条。
        setReloadToken((n) => n + 1);
      })
      .catch((err: unknown) => {
        toast(err instanceof Error ? err.message : "上传失败");
      });
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) uploadOne(file);
  };

  return (
    <section className="flex h-full flex-col gap-3 p-3">
      <button
        type="button"
        data-testid="ref-upload-card"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        className="flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-border px-4 py-6 text-sm hover:bg-accent"
      >
        <span className="font-medium">拖入上传</span>
        <span className="text-xs text-muted-foreground">或点击选择文件</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        data-testid="ref-upload-input"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) uploadOne(file);
        }}
      />

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">筛选和排序</span>
        <select
          data-testid="ref-sort"
          value={order}
          onChange={(event) => setOrder(event.target.value === "oldest" ? "oldest" : "newest")}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="newest">新→旧</option>
          <option value="oldest">旧→新</option>
        </select>
        <select
          data-testid="ref-filter"
          value={filter}
          onChange={(event) => {
            const next = event.target.value;
            setFilter(next === "image" || next === "video" || next === "pdf" ? next : "");
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="">全部</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="pdf">PDF</option>
        </select>
      </div>

      <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {uploads.map((item) => (
          <li
            key={item.id}
            data-testid="ref-item"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                ASSET_DRAG_MIME,
                JSON.stringify({ assetId: item.id, mimeType: item.mimeType, name: item.name }),
              );
            }}
            className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
          >
            {item.url && item.mimeType.startsWith("image/") ? (
              <img src={item.url} alt={item.name} className="h-8 w-8 shrink-0 rounded object-cover" />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold"
              >
                {typeLabel(item.mimeType)}
              </span>
            )}
            <span className="truncate">{item.name}</span>
          </li>
        ))}
      </ul>

      {!loading && uploads.length === 0 ? (
        <p data-testid="ref-empty" className="py-6 text-center text-xs text-muted-foreground">
          还没有参考图，拖入或点击上传
        </p>
      ) : null}
    </section>
  );
}
