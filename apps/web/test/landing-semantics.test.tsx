// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FeatureShowcase } from "@/components/landing/feature-showcase";
import { FinalCTA } from "@/components/landing/final-cta";
import { FloatingNav } from "@/components/landing/floating-nav";
import { HeroSection } from "@/components/landing/hero-section";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingFooter } from "@/components/landing/landing-footer";
import { ShowcaseGallery } from "@/components/landing/showcase-gallery";
import { TrustBar } from "@/components/landing/trust-bar";

/**
 * BR-11 落地页结构（工单 45DR）
 *
 * 只断言结构与语义：恰好一个 h1、nav/footer/main 三个地标存在、
 * 每张 img 都有 alt、没有「可点的 div」。不断言任何视觉（颜色/间距/字体）。
 *
 * 渲染顺序与 `src/app/page.tsx` 保持一致（那里的 below-fold 区块走
 * `next/dynamic({ ssr: false })`，在 jsdom 里是异步 chunk，不可靠；
 * 这里改用静态 import + 同样的 DOM 顺序渲染，断言的是同一批组件产出的 DOM）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const LANDING_DIR = path.join(WEB_ROOT, "src", "components", "landing");
const PAGE_SOURCE = path.join(WEB_ROOT, "src", "app", "page.tsx");

/** 落地页 DOM 顺序，逐行对照 `app/page.tsx` 的 return 块。 */
function LandingPageComposition() {
  return (
    <div>
      <FloatingNav />
      <main>
        <HeroSection />
        <TrustBar />
        <FeatureShowcase />
        <ShowcaseGallery />
        <HowItWorks />
        <FinalCTA />
      </main>
      <LandingFooter />
    </div>
  );
}

function renderLanding() {
  return render(<LandingPageComposition />);
}

beforeAll(() => {
  // framer-motion 的 whileInView / useReducedMotion 依赖这两个浏览器 API，
  // jsdom 都没有实现；stub 成「永不进入视口 / 不要求减弱动效」。
  if (typeof globalThis.IntersectionObserver === "undefined") {
    class NoopIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = "";
      readonly thresholds: ReadonlyArray<number> = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
  }

  if (!("matchMedia" in window) || typeof window.matchMedia !== "function") {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }
});

afterEach(() => {
  cleanup();
});

describe("BR-11 landing page semantics", () => {
  it("renders exactly one h1", () => {
    const { container } = renderLanding();

    expect(container.querySelectorAll("h1").length, "落地页 h1 不是恰好一个").toBe(1);
    expect(container.querySelector("h1")?.textContent ?? "", "h1 没有可读文本").not.toBe("");
  });

  it("exposes nav, main and footer landmarks", () => {
    const pageSource = fs.readFileSync(PAGE_SOURCE, "utf8");
    expect(pageSource, "app/page.tsx 没有 <main> 地标").toContain("<main>");
    expect(pageSource.split("<nav").length - 1, "app/page.tsx 不该自带 nav").toBe(0);

    const { container } = renderLanding();

    expect(container.querySelectorAll("nav").length, "落地页没有 <nav>").toBeGreaterThan(0);
    expect(container.querySelectorAll("footer").length, "落地页没有 <footer>").toBe(1);
    expect(container.querySelectorAll("main").length, "落地页没有 <main>").toBe(1);

    // 主内容之外不许有第二个 main：nav/footer 必须是 main 的兄弟，不是子节点。
    const main = container.querySelector("main");
    expect(main?.querySelector("nav") ?? null, "nav 被放进了 main").toBeNull();
    expect(main?.querySelector("footer") ?? null, "footer 被放进了 main").toBeNull();
  });

  it("gives every img an alt attribute", () => {
    const { container } = renderLanding();
    const images = Array.from(container.querySelectorAll("img"));

    expect(images.length, "落地页一张图都没有渲染，断言会是空转").toBeGreaterThan(0);
    for (const img of images) {
      expect(img.hasAttribute("alt"), `img 缺 alt：${img.getAttribute("src") ?? "(no src)"}`).toBe(
        true,
      );
    }

    // 装饰图必须 alt="" 且 aria-hidden="true"：alt 为空却没隐藏，等于对读屏器
    // 报一张没有名字的图。
    for (const img of images) {
      if (img.getAttribute("alt") === "") {
        expect(
          img.getAttribute("aria-hidden"),
          `装饰图 alt="" 但没有 aria-hidden="true"：${img.getAttribute("src") ?? "(no src)"}`,
        ).toBe("true");
      }
    }
  });

  it("has no clickable div: no div carries onClick (source) or a button role (DOM)", () => {
    // React 把事件委托挂在根节点上，渲染后的 DOM 里没有 onclick 属性，
    // 所以「div 上挂了 onClick」只能在源码层面查；而 DOM 层面查的是
    // 有没有把 div 伪装成可点元素（role="button"/tabindex/onclick 属性）。
    const offenders: string[] = [];
    for (const file of fs.readdirSync(LANDING_DIR)) {
      if (!file.endsWith(".tsx")) continue;
      const source = fs.readFileSync(path.join(LANDING_DIR, file), "utf8");
      const clickableDiv = /<(?:motion\.)?div\b[^>]*\bonClick\b/;
      if (clickableDiv.test(source)) offenders.push(file);
    }
    expect(offenders, "这些组件的 div 上挂了 onClick，应换成 <a href> 或 <button>").toEqual([]);

    const { container } = renderLanding();
    const fakeInteractive = Array.from(
      container.querySelectorAll('div[onclick], div[role="button"], div[role="link"], div[tabindex]'),
    ).map((el) => el.outerHTML.slice(0, 160));

    expect(fakeInteractive, "有 div 被伪装成可点元素").toEqual([]);
  });

  it("does not skip heading levels (h1 -> h2 -> h3)", () => {
    const { container } = renderLanding();
    const levels = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) =>
      Number(el.tagName.slice(1)),
    );

    expect(levels[0], "第一个标题不是 h1").toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      const previous = levels[i - 1]!;
      const current = levels[i]!;
      expect(current - previous, `标题层级从 h${previous} 跳到 h${current}`).toBeLessThanOrEqual(1);
    }
  });
});
