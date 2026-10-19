import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * X-06 a11y 静态 lint（工单 30I T4）
 *
 * 扫描 `src/**\/*.tsx`，**逐行**检查。检查对象是空白分隔的 token，并且**精确匹配**
 * （`overflow-hidden`、`md:hidden` 都不算 `hidden`）。
 *
 *   R1：同行有 `opacity-0` 与 `group-hover(/name)?:opacity-100`，就必须同时有
 *       `focus-visible:opacity-100` / `focus-within:opacity-100` / `group-focus-within:opacity-100`。
 *   R2：同行有 `hidden` 与 `group-hover(/name)?:(flex|block|inline-flex|inline-block|grid)` → 不合规。
 *       `display:none` 的元素不可能被 Tab 聚焦，所以「悬停才显形」在键盘上等于不存在。不设豁免。
 *   R3：同行有 `invisible` 与 `group-hover(/name)?:visible`，就必须同时有
 *       `focus-visible:visible` 或 `focus-within:visible`。
 *   R4：JSX 属性的双引号字符串里出现 `\u` + 4 位十六进制 → 不合规。
 *       JSX 属性字符串字面量不处理 JS 转义，`title="\u4e0b\u8f7d"` 渲染出来就是那 12 个字符的原文
 *       （30I T0 探针实测：`getAttribute("title")` = `\u4e0b\u8f7d`）。
 *
 * 文本级扫描而不是 AST 级：本仓 web 侧没有装 ESLint/Babel 解析器，引 parser 就等于给这张单加依赖。
 * 行号口径与 `git grep -n` 一致（1 起），方便和工单 §5 的验收命令对照。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");

export type A11yRule = "R1" | "R2" | "R3" | "R4";

export type A11yViolation = {
  rule: A11yRule;
  /** 1 起，与 `git grep -n` 对齐 */
  line: number;
  text: string;
};

/** 豁免表：只有一条。命中数必须恒为 1，否则说明豁免表失效了（见下面的断言）。 */
const EXEMPTIONS: ReadonlyArray<{ rule: A11yRule; file: string; reason: string }> = [
  {
    rule: "R1",
    file: "components/landing/showcase-gallery.tsx",
    reason: "纯装饰浮层，无可交互子元素",
  },
];

// --- 四条规则的 token 判据 ---------------------------------------------------

const OPACITY_0 = /^opacity-0$/;
const HOVER_OPACITY_100 = /^group-hover(?:\/[a-z0-9-]+)?:opacity-100$/;
const FOCUS_OPACITY_100 = new Set([
  "focus-visible:opacity-100",
  "focus-within:opacity-100",
  "group-focus-within:opacity-100",
]);

const HIDDEN = /^hidden$/;
const HOVER_DISPLAY = /^group-hover(?:\/[a-z0-9-]+)?:(?:flex|block|inline-flex|inline-block|grid)$/;

const INVISIBLE = /^invisible$/;
const HOVER_VISIBLE = /^group-hover(?:\/[a-z0-9-]+)?:visible$/;
const FOCUS_VISIBLE = new Set(["focus-visible:visible", "focus-within:visible"]);

/** JSX 属性双引号字符串里的 `\uXXXX` 原文。与工单 §5 的 grep（`="[^"]*\\uXXXX`）同一个形状：
 *  不加 `\s*`、并排除 `==` / `!=` 这类比较运算符，否则 `charBefore !== "\u00A0"` 这种
 *  **JS 表达式里的正常转义**会被误报（它不在 JSX 属性里，转义是正确的）。 */
const UNICODE_ESCAPE_IN_ATTR = /(?<![=!<>])="[^"]*\\u[0-9a-fA-F]{4}/;

// --- 规则引擎（纯函数：源码进，违例出） --------------------------------------

/**
 * 空白分隔的 token，去掉**定界符**（引号 / 反引号 / 花括号 / 圆括号 / 分号 / 逗号）和
 * 粘在头部的属性名（`className=`、`aria-label=` …）。
 *
 * 为什么必须去：class 列表在 JSX 里长这样——
 *   `className="opacity-0 group-hover:opacity-100"` / `` className={`... ${x} ...`} `` / `cn("...")`
 * 第一个 class 前面粘着 `className="`，最后一个后面粘着 `"`。不去掉这两端，头尾两个 class
 * 就永远匹配不上，lint 会在最常见的写法上静默失效（T4 第一版就是这么漏的）。
 *
 * 去完之后仍是**精确匹配**：`overflow-hidden`、`md:hidden` 都不等于 `hidden`，
 * 不做任何前缀/后缀包含判断。
 */
const EDGE_LEADING = /^["'`{}();,]+/;
const EDGE_TRAILING = /["'`{}();,]+$/;
const ATTR_PREFIX = /^[A-Za-z][A-Za-z0-9_:.-]*=/;

function normalizeToken(token: string): string {
  let current = token;
  for (let round = 0; round < 4; round += 1) {
    const next = current.replace(ATTR_PREFIX, "").replace(EDGE_LEADING, "").replace(EDGE_TRAILING, "");
    if (next === current) return current;
    current = next;
  }
  return current;
}

function tokensOf(line: string): string[] {
  return line
    .split(/\s+/)
    .map(normalizeToken)
    .filter((token) => token !== "");
}

function hasMatching(tokens: readonly string[], pattern: RegExp): boolean {
  return tokens.some((token) => pattern.test(token));
}

function hasAnyOf(tokens: readonly string[], allowed: ReadonlySet<string>): boolean {
  return tokens.some((token) => allowed.has(token));
}

/** 一行源码里的违例（空数组 = 合规）。 */
export function lintLine(raw: string, line: number): A11yViolation[] {
  const tokens = tokensOf(raw);
  const violations: A11yViolation[] = [];

  if (hasMatching(tokens, OPACITY_0) && hasMatching(tokens, HOVER_OPACITY_100)) {
    if (!hasAnyOf(tokens, FOCUS_OPACITY_100)) violations.push({ rule: "R1", line, text: raw.trim() });
  }

  if (hasMatching(tokens, HIDDEN) && hasMatching(tokens, HOVER_DISPLAY)) {
    violations.push({ rule: "R2", line, text: raw.trim() });
  }

  if (hasMatching(tokens, INVISIBLE) && hasMatching(tokens, HOVER_VISIBLE)) {
    if (!hasAnyOf(tokens, FOCUS_VISIBLE)) violations.push({ rule: "R3", line, text: raw.trim() });
  }

  if (UNICODE_ESCAPE_IN_ATTR.test(raw)) {
    violations.push({ rule: "R4", line, text: raw.trim() });
  }

  return violations;
}

/** 一段假源码里的全部违例（给反向自检用）。 */
export function lintSource(source: string): A11yViolation[] {
  return source.split("\n").flatMap((line, index) => lintLine(line, index + 1));
}

// --- 真实扫描 ---------------------------------------------------------------

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsxFiles(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function relPath(full: string): string {
  return path.relative(SRC_ROOT, full).split(path.sep).join("/");
}

const allTsx = collectTsxFiles(SRC_ROOT);

type FileReport = {
  file: string;
  violations: A11yViolation[];
};

const report: FileReport[] = allTsx.map((full) => ({
  file: relPath(full),
  violations: lintSource(fs.readFileSync(full, "utf8")),
}));

/** 命中豁免表的历史遗留行（它们**仍然**违规，只是本单裁定不改）。 */
function exemptedViolations(entry: FileReport): A11yViolation[] {
  return entry.violations.filter((violation) =>
    EXEMPTIONS.some((exemption) => exemption.rule === violation.rule && exemption.file === entry.file),
  );
}

function formatViolations(entries: ReadonlyArray<{ file: string; violation: A11yViolation }>): string {
  return entries.map(({ file, violation }) => `${file}:${violation.line} ${violation.rule} ${violation.text}`).join("\n");
}

describe("X-06 a11y lint", () => {
  it("扫描规模自检：src 下的 tsx 都被扫到了", () => {
    expect(allTsx.length).toBeGreaterThan(100);
    expect(report.length).toBe(allTsx.length);
  });

  it("R1：悬停才显形的元素必须同时有 focus 显形，且豁免表仍恰好命中 1 行", () => {
    const exempted = report.flatMap((entry) =>
      exemptedViolations(entry).map((violation) => ({ file: entry.file, violation })),
    );
    const failures = report
      .flatMap((entry) =>
        entry.violations
          .filter((violation) => violation.rule === "R1")
          .filter((violation) => !exempted.some((hit) => hit.violation === violation))
          .map((violation) => ({ file: entry.file, violation })),
      );

    expect(failures, `R1 违例（缺 focus 显形）：\n${formatViolations(failures)}`).toEqual([]);

    // 豁免表自检：showcase-gallery 的那一行必须**仍然命中**，且只有 1 行。
    // 一旦有人给它补上 focus 显形（或删了那段浮层），这里会先失败，提醒把豁免摘掉。
    expect(
      exempted.length,
      `豁免表命中了 ${exempted.length} 行，应为 1 行；豁免表失效就该摘掉：\n${formatViolations(exempted)}`,
    ).toBe(1);
    expect(exempted[0]?.file).toBe(EXEMPTIONS[0]!.file);
    expect(EXEMPTIONS[0]!.reason.length).toBeGreaterThan(0);
  });

  it("R2：`hidden` 配合 `group-hover` 显形一律不合规（display:none 无法被 Tab 聚焦）", () => {
    const failures = report.flatMap((entry) =>
      entry.violations
        .filter((violation) => violation.rule === "R2")
        .map((violation) => ({ file: entry.file, violation })),
    );
    expect(failures, `R2 违例（hidden + group-hover 显形）：\n${formatViolations(failures)}`).toEqual([]);
  });

  it("R3：`invisible` 配合 `group-hover:visible` 必须同时有 focus 显形", () => {
    const failures = report.flatMap((entry) =>
      entry.violations
        .filter((violation) => violation.rule === "R3")
        .map((violation) => ({ file: entry.file, violation })),
    );
    expect(failures, `R3 违例（缺 focus 显形）：\n${formatViolations(failures)}`).toEqual([]);
  });

  it("R4：JSX 属性里不许写 `\\uXXXX` 原文（JSX 字符串字面量不处理 JS 转义）", () => {
    const failures = report.flatMap((entry) =>
      entry.violations
        .filter((violation) => violation.rule === "R4")
        .map((violation) => ({ file: entry.file, violation })),
    );
    expect(failures, `R4 违例（属性里是 \\uXXXX 原文，不是中文）：\n${formatViolations(failures)}`).toEqual([]);
  });

  it("反向自检：四条规则都能拒绝违例、放行合规写法（8 例）", () => {
    // R1：拒 / 放（三种 focus 写法都算合规）
    expect(lintSource(`<div className="opacity-0 group-hover:opacity-100" />`)).toEqual([
      { rule: "R1", line: 1, text: `<div className="opacity-0 group-hover:opacity-100" />` },
    ]);
    for (const focus of [
      "focus-visible:opacity-100",
      "focus-within:opacity-100",
      "group-focus-within:opacity-100",
    ]) {
      expect(lintSource(`<div className="opacity-0 group-hover:opacity-100 ${focus}" />`)).toEqual([]);
    }
    // 只有一条 `opacity-0` 而**没有** group-hover：不归 R1 管
    expect(lintSource(`<div className="opacity-0 transition-opacity" />`)).toEqual([]);

    // R2：拒（含具名 group）/ 放（`md:block` 不是 group-hover、`overflow-hidden` 不是 `hidden`）
    expect(lintSource(`<button className="hidden group-hover:flex" />`)).toHaveLength(1);
    expect(lintSource(`<button className="hidden group-hover/layer:inline-flex" />`)[0]?.rule).toBe("R2");
    expect(lintSource(`<button className="hidden md:block overflow-hidden" />`)).toEqual([]);

    // R3：拒 / 放
    expect(lintSource(`<div className="invisible group-hover:visible" />`)[0]?.rule).toBe("R3");
    expect(lintSource(`<div className="invisible group-hover:visible focus-visible:visible" />`)).toEqual([]);

    // R4：拒 / 放
    expect(lintSource(`<button title="\\u4e0b\\u8f7d" />`)[0]?.rule).toBe("R4");
    expect(lintSource(`<button title="下载" aria-label="下载" />`)).toEqual([]);

    // 行号口径：违例落在真实那一行
    expect(lintSource(["const a = 1;", "<div", `  className="hidden group-hover:flex"`, "/>"].join("\n"))).toEqual([
      { rule: "R2", line: 3, text: `className="hidden group-hover:flex"` },
    ]);
  });
});
