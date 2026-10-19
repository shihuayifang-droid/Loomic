import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PricingToggle } from "../src/app/pricing/components/pricing-toggle";
import { ImageLightbox } from "../src/components/chat/image-lightbox";

/**
 * X-06 状态 ARIA 的行为测试（工单 30I T5）
 *
 * 三条：
 *   1) `PricingToggle` 的 `aria-selected` 随 `value` 翻转，tablist 有 aria-label；
 *   2) `ImageLightbox` 里的下载按钮按**可访问名称**「下载」能找到（T3 把 `\uXXXX` 换成中文 + 加 aria-label）；
 *   3) T1 六个文件的 `aria-pressed=` / `aria-selected=` 出现行数等于工单 §5 的表。
 *
 * `LightboxBtn` 没有导出，所以走渲染 `ImageLightbox` 这条路（工单 T5 允许二选一：
 * 「渲染成本过高时退而用源码断言」—— 这里实测渲染成功，用的是渲染 + getByRole）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");

function readSource(relFromSrc: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relFromSrc), "utf8");
}

/** 逐行计数：`aria-pressed=` 与 `aria-selected=` 各占几行（一行只放一个属性，见工单 §3 T1）。 */
function countAriaStateLines(source: string): { pressed: number; selected: number; total: number } {
  let pressed = 0;
  let selected = 0;
  for (const line of source.split("\n")) {
    const hasPressed = line.includes("aria-pressed=");
    const hasSelected = line.includes("aria-selected=");
    if (!hasPressed && !hasSelected) continue;
    // 一行里同时写两个属性会让 `git grep -c` 的「行数」口径失去意义，直接判失败
    expect(hasPressed && hasSelected, `同一行里同时出现了两个状态属性：${line.trim()}`).toBe(false);
    if (hasPressed) pressed += 1;
    if (hasSelected) selected += 1;
  }
  return { pressed, selected, total: pressed + selected };
}

describe("X-06 状态 ARIA", () => {
  it("PricingToggle：monthly 的 tab 是 aria-selected=true、yearly 是 false，rerender 成 yearly 后翻转", () => {
    const { rerender } = render(<PricingToggle value="monthly" onChange={() => {}} />);

    const tablist = screen.getByRole("tablist", { name: "计费周期" });
    expect(tablist).toBeTruthy();

    const monthly = screen.getByRole("tab", { name: "月付" });
    const yearly = screen.getByRole("tab", { name: /年付/ });
    expect(monthly.getAttribute("aria-selected")).toBe("true");
    expect(yearly.getAttribute("aria-selected")).toBe("false");

    rerender(<PricingToggle value="yearly" onChange={() => {}} />);
    expect(monthly.getAttribute("aria-selected")).toBe("false");
    expect(yearly.getAttribute("aria-selected")).toBe("true");
  });

  it("ImageLightbox：按可访问名称「下载」能找到下载按钮，且标题已是中文（不是 \\uXXXX 原文）", () => {
    render(<ImageLightbox src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="预览图" onClose={() => {}} />);

    const download = screen.getByRole("button", { name: "下载" });
    expect(download.getAttribute("title")).toBe("下载");

    // 顺带钉住其余几个按钮：都是 T3 转换过的中文，不是原文
    for (const name of ["关闭 (Esc)", "缩小 (-)", "放大 (+)", "左右翻转", "上下翻转", "逆时针旋转", "顺时针旋转 (R)", "重置"]) {
      expect(screen.getByRole("button", { name }), `按名称找不到按钮：${name}`).toBeTruthy();
    }
  });

  it("源码断言：T1 六个文件的 aria-pressed= / aria-selected= 行数等于工单 §5 的表", () => {
    const expected: ReadonlyArray<{
      file: string;
      pressed: number;
      selected: number;
    }> = [
      // §5「合计7个文件、13行」里的 6 个本单改动文件（第 7 个 home-example-browser 是原有 2 行，不归 T5 管）
      { file: "app/pricing/components/pricing-toggle.tsx", pressed: 0, selected: 1 },
      { file: "components/image-model-preference.tsx", pressed: 2, selected: 1 },
      { file: "app/(workspace)/skills/page.tsx", pressed: 0, selected: 1 },
      { file: "components/canvas/video-generator-panel.tsx", pressed: 0, selected: 3 },
      { file: "components/canvas-tool-menu.tsx", pressed: 2, selected: 0 },
      { file: "components/canvas-bottom-bar.tsx", pressed: 1, selected: 0 },
    ];

    let total = 0;
    for (const entry of expected) {
      const counts = countAriaStateLines(readSource(entry.file));
      expect(
        { file: entry.file, pressed: counts.pressed, selected: counts.selected },
        `${entry.file} 的状态属性行数与 §5 不符`,
      ).toEqual({ file: entry.file, pressed: entry.pressed, selected: entry.selected });
      total += counts.total;
    }
    // §5 表的合计：13 行（含 home-example-browser 的 2 行）
    expect(total + 2).toBe(13);
  });

  it("源码断言：tablist 的 aria-label 与 T1 表一致（6 个，含 video 面板三行）", () => {
    const expected: ReadonlyArray<[string, string[]]> = [
      ["app/pricing/components/pricing-toggle.tsx", ["计费周期"]],
      ["components/image-model-preference.tsx", ["Model type"]],
      ["app/(workspace)/skills/page.tsx", ["技能分类"]],
      ["components/canvas/video-generator-panel.tsx", ["Aspect Ratio", "Duration", "Resolution"]],
    ];
    for (const [file, labels] of expected) {
      const source = readSource(file);
      const lines = source.split("\n").filter((line) => line.includes('role="tablist"'));
      expect(lines.length, `${file} 的 tablist 行数`).toBe(labels.length);
      for (const label of labels) {
        expect(source.includes(`aria-label="${label}"`), `${file} 缺 aria-label="${label}"`).toBe(true);
      }
    }
  });
});
