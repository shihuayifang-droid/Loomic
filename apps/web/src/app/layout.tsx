import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

import { Providers } from "../components/providers";
import { DevErrorReporter } from "../components/dev-error-reporter";
import { buildContentSecurityPolicy } from "../lib/content-security-policy";
import { getServerBaseUrl } from "../lib/env";
import { BRAND } from "../lib/brand";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  /**
   * BR-07：`output: "export"` 下没有运行时，分享图只能是构建期就存在于
   * `public/` 的静态文件；`metadataBase` 负责给出站点域名，让
   * `openGraph.url` / og:image 解析成绝对地址（缺了它 Next 会输出相对路径，
   * 抓取方拿不到图）。说明见 `docs/brand/og.md`。
   */
  metadataBase: new URL("https://hahart.design"),
  title: BRAND.name,
  description: BRAND.description,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: BRAND.name,
    description: BRAND.description,
    url: "/",
    siteName: BRAND.name,
    type: "website",
    images: [
      {
        url: "/og/og-default.png",
        width: 1200,
        height: 630,
        alt: BRAND.name,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: BRAND.name,
    description: BRAND.description,
    images: ["/og/og-default.png"],
  },
};

/**
 * 工单40Y / OP-17：`output: "export"` 下没有服务端阶段可挂响应头，
 * `headers()` 不生效，CSP 只能以 meta 标签下发。值在构建时算好并内联。
 */
const contentSecurityPolicy = buildContentSecurityPolicy({
  serverBaseUrl: getServerBaseUrl(),
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn(geist.variable, "scroll-smooth")} suppressHydrationWarning>
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content={contentSecurityPolicy}
        />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <DevErrorReporter />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
