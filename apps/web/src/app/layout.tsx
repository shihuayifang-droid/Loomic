import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

import { Providers } from "../components/providers";
import { DevErrorReporter } from "../components/dev-error-reporter";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "HaHart",
  description: "HaHart · AI 创意画布",
  icons: {
    icon: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "HaHart",
    description: "HaHart · AI 创意画布",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "HaHart",
    description: "HaHart · AI 创意画布",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn(geist.variable, "scroll-smooth")} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <DevErrorReporter />
        <Providers>{children}</Providers>
        <Script
          src="https://app.lemonsqueezy.com/js/lemon.js"
          strategy="lazyOnload"
        />
      </body>
    </html>
  );
}
