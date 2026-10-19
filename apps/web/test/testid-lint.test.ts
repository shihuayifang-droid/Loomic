import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * X-05 testid lint（工单 30C T5）
 *
 * 三条断言：
 *   1) `src/**\/*.tsx` 里所有 `data-testid` 字面量都匹配 `^[a-z0-9]+(-[a-z0-9]+)+$`；
 *   2) 第一段前缀都在 `CONVENTIONS.md` §6 的「已落地的区域前缀表」里（表在测试里解析）；
 *   3) 非脏文件里可交互元素的 testid 覆盖率 = 100%。
 *
 * 扫描是文本级而不是 AST 级：本仓 web 侧没有装 ESLint/Babel 解析器，
 * 引 parser 就等于给这张单加依赖。文本级扫描的两个坑都在下面处理：
 *   - `/* … *\/` 注释里可能写着标签或 testid → 先抹掉（保留换行，行号才不漂）；
 *   - 行注释不能靠「删 // 到行尾」处理：`/\\//g` 这种正则里的 `//` 会被误当成注释，
 *     所以只在「该行去掉前缀空白后以 // 开头」时整行跳过。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");
const CONVENTIONS_PATH = path.join(WEB_ROOT, "CONVENTIONS.md");

/**
 * 脏文件：用户正在改，本单一行都不许碰（工单 §1 的脏文件清单里的 .tsx）。
 * **等这些文件提交后移出清单。**
 */
const DIRTY_TSX = new Set(["canvas-editor.tsx", "chat-input.tsx", "chat-sidebar.tsx"]);

/** 可交互元素：工单 30C T4 的范围（`<Button>` 是渲染成本 `<button>` 的组件，同样要能定位）。 */
const INTERACTIVE_TAG_RE = /<(button|input|textarea|select|Button)\b/g;
const INTERACTIVE_ROLE_RE = /role="(menuitem|tab|option|dialog)"/g;
const BLOCK_COMMENT_RE = /\{?\/\*[\s\S]*?\*\//g;
const TESTID_ATTR_RE = /data-testid\s*=\s*(\{`([^`]*)`\}|"([^"]*)"|\{[^}]*\})/g;

const TESTID_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;

type TestidValue = {
  file: string;
  line: number;
  raw: string;
  /** 模板字面量里 `${...}` 换成 `x` 之后的值；`null` = 属性值是表达式而不是字面量 */
  value: string | null;
};

// --- 源码处理 ---------------------------------------------------------------

/** 抹掉块注释（含 JSX 的 `{/* … *\/}`），用等量换行代替，保住行号。 */
function stripBlockComments(source: string): string {
  return source.replace(BLOCK_COMMENT_RE, (match) => match.replace(/[^\n]/g, " "));
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/** 命中位置是否落在一条 `//` 行注释里（行首到命中位置只有空白）。 */
function isLineComment(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const prefix = source.slice(lineStart, index);
  return prefix.trim() === "" && source.slice(lineStart).trimStart().startsWith("//");
}

/** 从 `<tag` 的 `<` 开始，返回开标签结束位置（`>` 之后），跳过引号与 `{}` 里的 `>`。 */
function openingTagEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === ">" && depth <= 0) {
      return i + 1;
    }
  }
  return -1;
}

function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsxFiles(full, out);
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function relPath(full: string): string {
  return path.relative(SRC_ROOT, full).split(path.sep).join("/");
}

// --- 三条断言各自的实现 ------------------------------------------------------

/** 抽出一个源文件里所有 `data-testid` 的字面量（表达式属性值不算：那是 props 透传）。 */
export function collectTestidValues(source: string): TestidValue[] {
  const text = stripBlockComments(source);
  const values: TestidValue[] = [];
  for (const match of text.matchAll(TESTID_ATTR_RE)) {
    const index = match.index ?? 0;
    if (isLineComment(text, index)) continue;
    const template = match[2];
    const literal = match[3];
    let value: string | null = null;
    if (literal !== undefined) {
      value = literal;
    } else if (template !== undefined) {
      // 模板里的 ${...} 静态说不出来，换成 x 之后只校验形态
      value = template.replace(/\$\{[^}]*\}/g, "x");
    }
    values.push({ file: "", line: lineAt(text, index), raw: match[0], value });
  }
  return values;
}

/** 「前缀由调用方给」：模板第一段就是 `${...}`，换 x 之后长相是 `x-…`。 */
function hasCallerPrefix(template: string | undefined): boolean {
  return template !== undefined && template.startsWith("${");
}

/** CONVENTIONS §6 的表格 → 前缀列表（不含结尾连字符）。 */
export function parsePrefixTable(markdown: string): string[] {
  const start = markdown.indexOf("## 6. 已落地的区域前缀表");
  if (start < 0) {
    throw new Error("CONVENTIONS.md 里找不到「## 6. 已落地的区域前缀表」一节");
  }
  const section = markdown.slice(start);
  const prefixes: string[] = [];
  for (const line of section.split("\n")) {
    // 只认表格里「第一格是 `xxx-`」的行
    const match = /^\|\s*`([a-z0-9]+(?:-[a-z0-9]+)*)-`\s*\|/.exec(line.trim());
    if (match !== null && match[1] !== undefined) prefixes.push(match[1]);
  }
  return prefixes;
}

/** 单个 testid 值的两条静态检查结果（空数组 = 通过）。 */
export function testidValueErrors(
  value: string,
  prefixes: readonly string[],
  callerPrefix: boolean,
): string[] {
  const errors: string[] = [];
  if (!TESTID_NAME_RE.test(value)) {
    errors.push(`不符合 {区域}-{组件}-{元素}[-{值}] 的字符集/段数：${value}`);
    return errors;
  }
  if (callerPrefix) return errors;
  if (!prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix}-`))) {
    errors.push(`前缀不在 CONVENTIONS §6 的表里：${value}`);
  }
  return errors;
}

/** 一个源文件里所有可交互元素开标签，以及它们有没有 testid。 */
function scanInteractive(source: string): Array<{ line: number; tag: string; hasTestid: boolean }> {
  const text = stripBlockComments(source);
  const found: Array<{ line: number; tag: string; hasTestid: boolean }> = [];
  for (const match of text.matchAll(INTERACTIVE_TAG_RE)) {
    const index = match.index ?? 0;
    if (isLineComment(text, index)) continue;
    const end = openingTagEnd(text, index);
    const body = end === -1 ? text.slice(index) : text.slice(index, end);
    found.push({
      line: lineAt(text, index),
      tag: match[1] ?? "?",
      hasTestid: /data-testid/.test(body),
    });
  }
  for (const match of text.matchAll(INTERACTIVE_ROLE_RE)) {
    const index = match.index ?? 0;
    if (isLineComment(text, index)) continue;
    const lt = text.lastIndexOf("<", index);
    const end = lt === -1 ? -1 : openingTagEnd(text, lt);
    const body = lt === -1 ? text.slice(index) : end === -1 ? text.slice(lt) : text.slice(lt, end);
    found.push({
      line: lineAt(text, index),
      tag: `role=${match[1] ?? "?"}`,
      hasTestid: /data-testid/.test(body),
    });
  }
  return found;
}

// --- 缓存：一次扫描供三个用例共用 --------------------------------------------

const prefixes = parsePrefixTable(fs.readFileSync(CONVENTIONS_PATH, "utf8"));
const allTsx = collectTsxFiles(SRC_ROOT);
const liveTsx = allTsx.filter((full) => !DIRTY_TSX.has(path.basename(full)));

const testidReport = allTsx.flatMap((full) =>
  collectTestidValues(fs.readFileSync(full, "utf8")).map((entry) => ({
    ...entry,
    file: relPath(full),
  })),
);

const coverageReport = liveTsx.map((full) => ({
  file: relPath(full),
  elements: scanInteractive(fs.readFileSync(full, "utf8")),
}));

describe("X-05 testid lint", () => {
  it("CONVENTIONS §6 的前缀表能被解析出来（表没了这条会先失败）", () => {
    expect(prefixes.length).toBeGreaterThanOrEqual(10);
    expect(prefixes).toContain("canvas");
    expect(prefixes).toContain("skills");
  });

  it("src 下的 tsx 都被扫到了（约 132 个），脏文件确实在清单里", () => {
    expect(allTsx.length).toBeGreaterThan(100);
    const dirtyPresent = allTsx.filter((full) => DIRTY_TSX.has(path.basename(full))).length;
    expect(dirtyPresent, "脏文件清单里的文件一个都没扫到，清单写错了").toBe(DIRTY_TSX.size);
  });

  it("断言1：所有 testid 字面量匹配 ^[a-z0-9]+(-[a-z0-9]+)+$", () => {
    const failures = testidReport
      .filter((entry) => entry.value !== null)
      .filter((entry) => !TESTID_NAME_RE.test(entry.value as string))
      .map((entry) => `${entry.file}:${entry.line} ${String(entry.value)}`);
    expect(failures, `不合格的 testid：\n${failures.join("\n")}`).toEqual([]);
  });

  it("断言2：所有 testid 的前缀都在 CONVENTIONS §6 的表里", () => {
    const failures: string[] = [];
    for (const full of allTsx) {
      const source = fs.readFileSync(full, "utf8");
      const text = stripBlockComments(source);
      for (const match of text.matchAll(TESTID_ATTR_RE)) {
        const index = match.index ?? 0;
        if (isLineComment(text, index)) continue;
        const template = match[2];
        const literal = match[3];
        const value = literal ?? template?.replace(/\$\{[^}]*\}/g, "x");
        if (value === undefined) continue; // 表达式属性值：props 透传，没有静态前缀
        const errors = testidValueErrors(
          value,
          prefixes,
          literal === undefined && hasCallerPrefix(template),
        );
        for (const error of errors) {
          failures.push(`${relPath(full)}:${lineAt(text, index)} ${error}`);
        }
      }
    }
    expect(failures, `前缀不合格：\n${failures.join("\n")}`).toEqual([]);
  });

  it("断言3：非脏文件里可交互元素的 testid 覆盖率为 100%", () => {
    let total = 0;
    const missing: string[] = [];
    for (const { file, elements } of coverageReport) {
      for (const element of elements) {
        total += 1;
        if (!element.hasTestid) missing.push(`${file}:${element.line} <${element.tag}>`);
      }
    }
    expect(total, "一个可交互元素都没扫到，扫描器失效了").toBeGreaterThan(150);
    expect(missing, `缺 testid 的可交互元素：\n${missing.join("\n")}`).toEqual([]);
  });

  it("反向自检：内存里的假源码 data-testid=\"BadName\" 会被检出", () => {
    const fake = [
      "export function Widget() {",
      '  return <button data-testid="BadName" type="button" />;',
      "}",
    ].join("\n");
    const found = collectTestidValues(fake);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe("BadName");
    // 同一条检查在真实扫描里也必须报错
    expect(testidValueErrors("BadName", prefixes, false).length).toBeGreaterThan(0);
    // 反过来：一个正常的 testid 不许被误报
    expect(testidValueErrors("canvas-zoom-dropdown", prefixes, false)).toEqual([]);
  });

  it("装饰值 `${testid}-menu` 按「前缀由调用方给」放行，但没传前缀的裸值仍被拦", () => {
    const decorated = collectTestidValues(
      ["const a = <div data-testid={`${testid}-menu`} />;"].join("\n"),
    );
    expect(decorated[0]?.value).toBe("x-menu");
    expect(testidValueErrors("x-menu", prefixes, true)).toEqual([]);
    // 不豁免的话它该被拦（证明豁免是唯一原因）
    expect(testidValueErrors("x-menu", prefixes, false).length).toBeGreaterThan(0);
  });
});
