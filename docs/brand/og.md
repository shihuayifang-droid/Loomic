# OG 分享预览图（BR-07）

本文件说明：分享链接（微信 / Slack / X / iMessage 等）时看到的预览图与文案从哪来，
以及为什么现在只有一张全站固定图。

## 1. 固定图

| 项 | 值 |
|---|---|
| 文件 | `apps/web/public/og/og-default.png` |
| 访问路径 | `/og/og-default.png` |
| 尺寸 | 1200 × 630（OG 大图推荐尺寸，1.91:1） |
| 用途 | 全站所有页面共用的一张分享预览图（含品牌名与标语） |

构建后该文件被复制到静态产物里（`apps/web/out/og/og-default.png`），与
`public/` 下其他资源一样由 Next 静态导出直接搬运，不经过图片处理管线。

改图时**不要改文件名和尺寸**：`layout.tsx` 里的 `width` / `height` 与图片实际
尺寸不一致时，部分抓取方会裁切或拒绝出图。

## 2. 元数据在哪定义

唯一来源是 `apps/web/src/app/layout.tsx` 的 `metadata` 导出（全站根布局）：

- `metadataBase`：`https://hahart.design` —— 静态导出必须给绝对域名，
  否则 `og:image` 会输出成相对路径，抓取方无法解析。
- `openGraph`：`title` / `description` / `url`（`/`，由 `metadataBase` 解析成
  `https://hahart.design/`）/ `siteName` / `type: "website"` /
  `images: [{ url, width, height, alt }]`。
- `twitter`：`card: "summary_large_image"` / `title` / `description` / `images`。

文案一律取自 `apps/web/src/lib/brand.ts` 的 `BRAND`（品牌名与站点描述的唯一
来源），这里不重复拼写品牌名；改文案改 `BRAND` 即可。

## 3. 为什么动态项目封面模板现在用不了

需求里的「项目封面动态模板」（把某个项目的封面当作分享图）在当前架构下做不到，
原因是这个 web 是 **Next 静态导出**（`next.config.ts` 里 `output: "export"`）：

1. **不能在运行时生成图片。** `ImageResponse`（`next/og`）需要服务端运行时在请求
   到达时渲染出 PNG。静态导出没有服务端进程，构建产物只是 `out/` 目录里的一堆
   文件，所以 `ImageResponse` 这条路在本项目不可用。
2. **不能按运行时 id 出 metadata。** 分享链接打开时才知道是哪个项目，而
   `generateMetadata({ params })` 在 `output: "export"` 下只在**构建期**执行一次
   每个静态路径。`/p/[id]` 这类路径的 id 是运行时才有的（项目由用户在应用里创建），
   构建期不存在这些 id，也就生成不出对应页面和对应 metadata。
3. **`opengraph-image.tsx` 文件约定同样走构建期。** 它在导出模式下同样需要在构建
   时确定内容，只能覆盖已知的固定路由。

结论：现在只能做「全站一张固定图 + 正确的 OG / Twitter 元数据」，私有项目分享时
也用这张固定图（这也符合「私有项目用固定图」的要求）。动态项目封面模板登记为后续项。

## 4. 将来改成 SSR 时的接入点

如果后续把 web 改成服务端渲染（去掉 `output: "export"`，由 Node 服务运行），按下面
顺序接：

1. **删掉 `next.config.ts` 的 `output: "export"`**，让应用拥有运行时（自托管 Node 或
   平台托管均可）。
2. **给 `/p/[id]` 加 `generateMetadata`**：按 id 取项目，把 `openGraph.images` 换成
   该项目的封面地址；取不到、或项目是私有的，回落到 `/og/og-default.png`。
   私有项目保持固定图，避免把封面泄漏给外部抓取方。
3. **要动态模板时再加 `opengraph-image.tsx`**（用 `ImageResponse` 画标题 + 封面）：
   放在 `app/p/[id]/opengraph-image.tsx`，运行时按 id 渲染，这张图也是公开可访问的，
   同样要自己判断私有项目并回落。
4. **缓存**：动态图按 id + 封面版本给 `Cache-Control`（CDN 缓存 + 短 TTL），避免每次
   抓取都跑一次图渲染。
5. 改完后 `apps/web/test/og-metadata.test.ts` 的断言要跟着改成「按 id 出图 + 回落」
   的口径，并把本文第 3 节改成历史说明。
