import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { CANVAS_URL, mockApi, seedSession } from "./fixtures";

/**
 * QA-10 无障碍扫描（axe-core）。
 *
 * 约定见 `apps/web/e2e/README.md`：只用 testid 定位、禁坐标点击、真实输入、全部 `/api/**` mock。
 * 门槛、区域映射、已知问题表都在同目录 `A11Y.md` —— **改这里要同步那个文件**。
 *
 * 判定门槛（工单第 2 点）：`violations` 里 `impact` 为 `critical` / `serious` 的必须为 0；
 * `moderate` / `minor` 允许存在，但每次运行都逐条打到控制台（`A11Y-scan` 行的 `recorded`），
 * 并登记在 `A11Y.md` 的已知问题表里。
 */

/** 阻断级 impact：出现即不合格 —— 按工单第 4 点用 `test.fixme` 停用该用例，并登记待修项。 */
const BLOCKING_IMPACTS = ["critical", "serious"];

/** 画布首屏要等 Excalidraw + 一次画布接口，冷启动可超过默认 5s。 */
const PAGE_TIMEOUT = 45_000;

/** 入场动画（framer-motion）跑完再扫：动画中途的 opacity 会被 color-contrast 误判。 */
const SETTLE_MS = 2000;

type ScanResult = {
  region: string;
  page: string;
  selectors: string[];
  blocking: string[];
  recorded: string[];
};

function describeViolation(violation: {
  id: string;
  impact?: string | null;
  nodes: { target: string[]; html: string }[];
}): { head: string; detail: string } {
  const head = `[${violation.impact ?? "null"}] ${violation.id} (${violation.nodes.length} node)`;
  const detail = violation.nodes
    .map((node) => `    ${node.target.join(" ")} :: ${node.html}`)
    .join("\n");
  return { head, detail };
}

/**
 * 扫一个区域：`selectors` 是该区域 **testid 的 CSS 选择器**（`[data-testid="x"]`
 * 或 `[data-testid^="x-"]` 前缀），交给 `AxeBuilder.include()` 限定扫描范围。
 *
 * 用前缀而不是精确 testid 的原因见 `A11Y.md`「区域映射」：这几个区域的容器本身
 * 没有 data-testid（加容器 testid 要改组件，超出本工单白名单），容器里的控件都有。
 */
async function scanRegion(
  page: Page,
  region: string,
  path: string,
  selectors: string[],
): Promise<ScanResult> {
  const results = await new AxeBuilder({ page })
    .include(selectors)
    // 只扫本工单要求的 WCAG 2.0 / 2.1 A + AA，别让 best-practice 规则混进门槛。
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking: string[] = [];
  const recorded: string[] = [];
  for (const violation of results.violations) {
    const { head, detail } = describeViolation(violation);
    if (BLOCKING_IMPACTS.includes(violation.impact ?? "")) {
      blocking.push(`${head}\n${detail}`);
    } else {
      recorded.push(`${head}\n${detail}`);
    }
  }

  const result: ScanResult = { region, page: path, selectors, blocking, recorded };
  // moderate / minor 必须逐条记录，所以每次运行都把本区域结果整行打出来。
  console.log(`A11Y-scan ${JSON.stringify(result)}`);
  return result;
}

function assertNoBlocking(result: ScanResult): void {
  expect(
    result.blocking.join("\n\n"),
    `${result.page} 的「${result.region}」区域存在 critical/serious 违规（门槛见 A11Y.md）`,
  ).toBe("");
}

/** 登录页：整页扫描（该页没有区域容器 testid，见 A11Y.md）。 */
async function openLogin(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page.getByTestId("account-login-submit")).toBeVisible({ timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(SETTLE_MS);
}

/** 首页（`app/(workspace)/home`）：输入条 + 发现区 + 模型菜单。 */
async function openHome(page: Page): Promise<void> {
  await seedSession(page);
  await mockApi(page);
  await page.goto("/home");
  await expect(page.getByTestId("home-prompt-input")).toBeVisible({ timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(SETTLE_MS);
}

/** 画布（工作区页面）：工具条 / 面板 / 菜单 / 对话区都在这一页。 */
async function openCanvas(page: Page): Promise<void> {
  await seedSession(page);
  await mockApi(page);
  await page.goto(CANVAS_URL);
  await expect(page.getByTestId("chat-input-send")).toBeVisible({ timeout: PAGE_TIMEOUT });
  await expect(page.getByTestId("canvas-tool-menu-tool-selection")).toBeVisible({
    timeout: PAGE_TIMEOUT,
  });
  await page.waitForTimeout(SETTLE_MS);
}

// ---- 区域映射（每个都是 testid，没有 CSS 结构选择器、没有坐标）----------------
/** 首页输入条（工具条）。 */
const HOME_TOOLBAR = ['[data-testid^="home-prompt-"]'];
/** 首页发现区（面板：tab + 卡片网格）。 */
const HOME_PANEL = ['[data-testid^="home-discovery-"]'];
/** 首页模型菜单的入口。 */
const HOME_MENU = ['[data-testid="agent-model-selector-trigger"]'];
/** 画布左侧工具条：选择 / 矩形 / 椭圆 / 箭头 / 直线 / 自由绘制 / 文本 / 图片 / 手型。 */
const CANVAS_TOOLBAR = ['[data-testid^="canvas-tool-menu-tool-"]'];
/** 画布上的菜单入口：主菜单、更多、缩放、品牌套件、模型。 */
const CANVAS_MENU = [
  '[data-testid="main-menu-trigger"]',
  '[data-testid="dropdown-menu-button"]',
  '[data-testid="canvas-zoom-dropdown"]',
  '[data-testid="brand-kit-selector-trigger"]',
  '[data-testid="agent-model-selector-trigger"]',
];
/** 对话区（聊天侧栏）的所有 testid 控件。 */
const CANVAS_CHAT = ['[data-testid^="chat-"]'];
/** 图片生成面板：点工具条上的「创建图片」打开，面板容器自己有 testid。 */
const CANVAS_PANEL = ['[data-testid="canvas-image-generator-panel"]'];

// 待修 R1（A11Y.md「待修项」）：serious `color-contrast` 3 个节点 —— 登录页左侧特性列表
// `li:nth-child(1..3)` 的白点/文字与浅色底对比度不足。按工单第 4 点先 fixme，不做 disableRules。
test.fixme("A11Y 登录页 · 整页", async ({ page }) => {
  await openLogin(page);
  assertNoBlocking(await scanRegion(page, "登录页整页", "/login", ["html"]));
});

test("A11Y 首页 · 工具条（输入条）", async ({ page }) => {
  await openHome(page);
  assertNoBlocking(await scanRegion(page, "工具条（首页输入条）", "/home", HOME_TOOLBAR));
});

// 待修 R2（A11Y.md「待修项」）：serious `label-content-name-mismatch` 8 个节点 ——
// `home-discovery-case-*` 卡片的 aria-label（英文案例名）与卡片内可见标题不一致。
test.fixme("A11Y 首页 · 面板（发现区）", async ({ page }) => {
  await openHome(page);
  assertNoBlocking(await scanRegion(page, "面板（首页发现区）", "/home", HOME_PANEL));
});

test("A11Y 首页 · 菜单（模型菜单入口）", async ({ page }) => {
  await openHome(page);
  assertNoBlocking(await scanRegion(page, "菜单（首页模型菜单入口）", "/home", HOME_MENU));
});

test("A11Y 画布 · 工具条", async ({ page }) => {
  await openCanvas(page);
  assertNoBlocking(await scanRegion(page, "工具条（画布左侧工具条）", "/canvas", CANVAS_TOOLBAR));
});

test("A11Y 画布 · 菜单", async ({ page }) => {
  await openCanvas(page);
  assertNoBlocking(await scanRegion(page, "菜单（画布菜单入口）", "/canvas", CANVAS_MENU));
});

// 待修 R3（A11Y.md「待修项」）：critical `button-name` 1 个节点 ——
// `chat-input-send` 是只有图标的按钮，禁用态下没有可访问名称（无 aria-label / title）。
test.fixme("A11Y 画布 · 对话区", async ({ page }) => {
  await openCanvas(page);
  assertNoBlocking(await scanRegion(page, "对话区（聊天侧栏）", "/canvas", CANVAS_CHAT));
});

// 待修 R4（A11Y.md「待修项」）：critical `button-name` 1 个节点 ——
// 图片生成面板里 `min-w-12` 的提交按钮（`canvas-image-generat*`）禁用态下没有可访问名称。
test.fixme("A11Y 画布 · 面板（图片生成面板）", async ({ page }) => {
  await openCanvas(page);
  await page.getByTestId("canvas-tool-menu-create-image").click();
  await expect(page.getByTestId("canvas-image-generator-panel")).toBeVisible({
    timeout: PAGE_TIMEOUT,
  });
  assertNoBlocking(await scanRegion(page, "面板（图片生成面板）", "/canvas", CANVAS_PANEL));
});
