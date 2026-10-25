import type { MetadataRoute } from "next";

import { BRAND } from "@/lib/brand";

// output: "export" 下元数据路由必须声明为静态，否则 next build 失败——见 45A
export const dynamic = "force-static";

/**
 * BR-06 PWA 清单（工单 40V）
 *
 * 图标素材由主 Agent 按品牌草稿 v1 生成，public/ 下为原样二进制。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.description,
    start_url: "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#E4F23A",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
