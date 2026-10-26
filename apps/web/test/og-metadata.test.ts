import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { Fragment, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { metadata } from "../src/app/layout";
import { BRAND } from "../src/lib/brand";

/**
 * BR-07 OG / Twitter 分享元数据（工单 45DK）
 *
 * 断言口径：不看 layout.tsx 源码里出现过哪些字符串，而是把 layout 声明的
 * `metadata` 交给 **Next 自己的 og / twitter 渲染器**，渲染进真实的
 * `document.head`，再查渲染出来的 `<meta>` 标签 —— 分享抓取方读到的就是这些标签。
 *
 * 为什么测试里要「规范化」一次 metadata：Next 的元数据分两步，
 *   1. `resolve-metadata` 把 layout 声明的 `Metadata` 规范化成一个
 *      ResolvedMetadata（`title` 变成 `{ absolute }`，相对 url 用 metadataBase
 *      补成绝对地址）；
 *   2. `generate/opengraph` 把规范化后的对象渲染成 `<meta>` 标签。
 * 第 1 步的模块依赖 `server-only`（只在 Next 构建期可解析），测试环境拿不到，
 * 所以这里按第 1 步的产物形状组装（`title.absolute` + 绝对 url），**字段值全部
 * 取自 layout 的 `metadata`**，再走第 2 步真正的渲染器。这样断言的仍然是
 * 「layout 声明 → 渲染出的标签」这条链，而不是重抄一遍期望值。
 *
 * 为什么不用 `render(<RootLayout/>)`：根布局渲染的是 `<html>`，且它引入了
 * `next/font/google` 与客户端 Provider 树；这些与本用例无关，mock 掉以免把整棵
 * 组件树和字体加载拉进测试。
 */

// layout.tsx 的无关副作用：字体、客户端 Provider、开发期错误上报。
vi.mock("next/font/google", () => ({
  Geist: () => ({ className: "geist", variable: "--font-sans" }),
}));
vi.mock("../src/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../src/components/dev-error-reporter", () => ({
  DevErrorReporter: () => null,
}));

// Next 的公共 API 不导出这两个渲染器，但 dist 里有（带类型声明），直接拿来用：
// 它把规范化后的元数据渲染成 <meta> 标签，不涉及构建期逻辑。
import {
  OpenGraphMetadata,
  TwitterMetadata,
} from "next/dist/lib/metadata/generate/opengraph.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");

/** 全站分享图：路径与尺寸是一份契约，见 docs/brand/og.md。 */
const OG_IMAGE_PATH = "/og/og-default.png";
const OG_IMAGE_FILE = path.join(WEB_ROOT, "public", "og", "og-default.png");
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;
/** metadataBase 必须给出的站点绝对域名。 */
const SITE_ORIGIN = "https://hahart.design/";

/** Next 渲染器吃的参数类型（= Next 规范化之后的 ResolvedMetadata 形状）。 */
type OpenGraphProp = Parameters<typeof OpenGraphMetadata>[0]["openGraph"];
type TwitterProp = Parameters<typeof TwitterMetadata>[0]["twitter"];

function absolute(value: string): string {
  const base = metadata.metadataBase?.toString() ?? SITE_ORIGIN;
  return new URL(value, base).toString();
}

function resolveImages(
  images: unknown,
): Array<{ url: string } & Record<string, unknown>> {
  const list = images == null ? [] : Array.isArray(images) ? images : [images];
  return list.map((image: unknown) => {
    if (typeof image === "string") {
      return { url: absolute(image) };
    }
    if (image instanceof URL) {
      return { url: image.toString() };
    }
    const record = image as { url: string | URL } & Record<string, unknown>;
    return { ...record, url: absolute(String(record.url)) };
  });
}

/** metadata.openGraph → Next 渲染器吃的形状。 */
function resolvedOpenGraph(): OpenGraphProp {
  const og = metadata.openGraph;
  if (!og || Array.isArray(og)) {
    throw new Error("layout.tsx 没有声明单个 openGraph 对象");
  }
  return {
    ...og,
    title: { absolute: String(og.title) },
    url: og.url == null ? undefined : absolute(String(og.url)),
    images: resolveImages(og.images),
  } as unknown as OpenGraphProp;
}

/** metadata.twitter → Next 渲染器吃的形状。 */
function resolvedTwitter(): TwitterProp {
  const twitter = metadata.twitter;
  if (!twitter || Array.isArray(twitter)) {
    throw new Error("layout.tsx 没有声明单个 twitter 对象");
  }
  return {
    ...twitter,
    title: { absolute: String(twitter.title) },
    images: resolveImages(twitter.images),
  } as unknown as TwitterProp;
}

/** 把 layout 声明的 metadata 渲染进真实 <head>，等价于 Next 构建期做的事。 */
function renderMetadataHead(): void {
  render(
    createElement(
      Fragment,
      null,
      createElement(OpenGraphMetadata, { openGraph: resolvedOpenGraph() }),
      createElement(TwitterMetadata, { twitter: resolvedTwitter() }),
    ),
    { container: document.head },
  );
}

function metaContent(attribute: "property" | "name", key: string): string | null {
  return (
    document.head
      .querySelector(`meta[${attribute}="${key}"]`)
      ?.getAttribute("content") ?? null
  );
}

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});

describe("BR-07 OG share metadata", () => {
  it("BR-07: metadataBase is the absolute site origin", () => {
    // 静态导出下没有请求上下文，metadataBase 必须自己给出绝对域名，
    // 否则 og:image / og:url 会是相对路径，抓取方解析不了。
    expect(metadata.metadataBase, "metadataBase 缺失").toBeInstanceOf(URL);
    expect(
      metadata.metadataBase?.toString(),
      "metadataBase 不是站点绝对域名",
    ).toBe(SITE_ORIGIN);
  });

  it("BR-07: the rendered <head> carries og:* tags", () => {
    renderMetadataHead();

    // 文案来自唯一来源 BRAND（BR-19），layout 只负责交给 metadata。
    expect(metadata.openGraph?.title, "openGraph.title 不是品牌名").toBe(BRAND.name);
    expect(
      metadata.openGraph?.description,
      "openGraph.description 不是站点描述",
    ).toBe(BRAND.description);
    expect(metadata.openGraph?.url, "openGraph.url 不是根路径").toBe("/");

    expect(metaContent("property", "og:title"), "og:title 不是品牌名").toBe(
      BRAND.name,
    );
    expect(
      metaContent("property", "og:description"),
      "og:description 不是站点描述",
    ).toBe(BRAND.description);
    expect(metaContent("property", "og:type"), "og:type 不是 website").toBe(
      "website",
    );
    expect(
      metaContent("property", "og:site_name"),
      "og:site_name 不是品牌名",
    ).toBe(BRAND.name);
    // og:url 是相对 "/" + metadataBase 拼出来的站点绝对地址。
    // （Next 规范化时会去掉根路径的尾斜杠，所以这里只锁「域名 + 根路径」，
    //  不锁尾斜杠有无 —— 见 build 产物 out/index.html 里是 https://hahart.design）
    const ogUrl = metaContent("property", "og:url");
    expect(ogUrl, "og:url 缺失").not.toBeNull();
    expect(ogUrl?.replace(/\/$/, ""), "og:url 不是站点绝对地址").toBe(
      SITE_ORIGIN.replace(/\/$/, ""),
    );

    const image = metaContent("property", "og:image");
    expect(image, "og:image 缺失").not.toBeNull();
    expect(image, "og:image 不是全站固定图").toBe(absolute(OG_IMAGE_PATH));
    expect(
      metaContent("property", "og:image:width"),
      "og:image:width 不对",
    ).toBe(String(OG_IMAGE_WIDTH));
    expect(
      metaContent("property", "og:image:height"),
      "og:image:height 不对",
    ).toBe(String(OG_IMAGE_HEIGHT));
    expect(
      metaContent("property", "og:image:alt"),
      "og:image:alt 不是品牌名",
    ).toBe(BRAND.name);
  });

  it("BR-07: the rendered <head> carries twitter:* tags", () => {
    renderMetadataHead();

    expect(metadata.twitter?.title, "twitter.title 不是品牌名").toBe(BRAND.name);
    expect(
      metadata.twitter?.description,
      "twitter.description 不是站点描述",
    ).toBe(BRAND.description);

    expect(
      metaContent("name", "twitter:card"),
      "twitter:card 不是 summary_large_image",
    ).toBe("summary_large_image");
    expect(
      metaContent("name", "twitter:title"),
      "twitter:title 不是品牌名",
    ).toBe(BRAND.name);
    expect(
      metaContent("name", "twitter:description"),
      "twitter:description 不是站点描述",
    ).toBe(BRAND.description);
    expect(
      metaContent("name", "twitter:image"),
      "twitter:image 不是全站固定图",
    ).toBe(absolute(OG_IMAGE_PATH));
  });

  it("BR-07: the fixed share image exists at 1200x630", () => {
    expect(fs.existsSync(OG_IMAGE_FILE), `缺少分享图 ${OG_IMAGE_FILE}`).toBe(true);

    const png = fs.readFileSync(OG_IMAGE_FILE);
    // PNG 签名 + IHDR 里的宽高（大端），避免只断言「文件存在」漏掉尺寸漂移。
    expect(png.subarray(1, 4).toString("latin1"), "不是 PNG 文件").toBe("PNG");
    expect(png.readUInt32BE(16), "分享图宽度不对").toBe(OG_IMAGE_WIDTH);
    expect(png.readUInt32BE(20), "分享图高度不对").toBe(OG_IMAGE_HEIGHT);
  });
});
