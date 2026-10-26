import { expect, test, type Page } from "@playwright/test";

import {
  BRAND_ASSET_NAME,
  CANVAS_IMAGE_TITLE,
  CANVAS_URL,
  IDS,
  MODEL_NAME,
  PNG_1X1_BASE64,
  SKILL_NAMES,
  mockApi,
  seedSession,
  type ApiLog,
} from "./fixtures";

/**
 * QA-09 快捷键全表 E2E。
 *
 * 约定见 `apps/web/e2e/README.md`：只用 data-testid（或 role + 名称）定位、禁坐标点击、
 * 真实按键输入、全部 `/api/**` mock。快捷键清单与作用域见 `apps/web/e2e/SHORTCUTS.md`，
 * **改这里要同步 spec**。
 *
 * 每条用例断言的都是「按下组合键之后的用户可见结果」，不是「没崩」。
 */

const INPUT_NAME = "输入消息";
/** `@` / `/` 列表的数据来自多条异步接口，冷启动可能超过默认 5s。 */
const PICKER_TIMEOUT = 15_000;
const CANVAS_TIMEOUT = 45_000;
/** canvas-empty-hint.tsx 在画布无元素时渲染的空态提示。 */
const EMPTY_CANVAS_HINT = "输入你的想法开始创作";

function input(page: Page) {
  return page.getByRole("textbox", { name: INPUT_NAME }).first();
}

async function openCanvas(page: Page): Promise<ApiLog> {
  await seedSession(page);
  const log = await mockApi(page);
  await page.goto(CANVAS_URL);
  await input(page).first().waitFor({ timeout: CANVAS_TIMEOUT });
  return log;
}

/**
 * 让画布成为「无可见元素」的空场景：`C` 快捷键只在空场景上挂监听
 * （`canvas-empty-hint.tsx:42` 一有元素就 return），而 fixtures.ts 的默认 mock 画布
 * 固定带 1 张图。
 *
 * 做法不是返回空数组，而是把 fixtures 里那张图原样返回、只把 `isDeleted` 置为
 * true：Excalidraw 的 `getSceneElements()` 不返回已删除元素，于是 hint 认为画布是空的，
 * 而画布本身仍按正常结构（elements / appState / files）初始化 —— 直接给
 * `{ elements: [] }` 会让页面在客户端初始化阶段抛异常。
 *
 * Playwright 的 route 后注册先匹配，所以这条覆盖 mockApi 的同路径 GET。
 */
async function mockEmptyCanvas(page: Page): Promise<void> {
  await page.route(`**/api/canvases/${IDS.canvas}`, async (route) => {
    if (route.request().method() !== "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: 2 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        canvas: {
          id: IDS.canvas,
          name: "E2E Empty Canvas",
          projectId: IDS.project,
          content: {
            elements: [
              {
                id: "e2e-image-1",
                type: "image",
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                angle: 0,
                strokeColor: "transparent",
                backgroundColor: "transparent",
                fillStyle: "solid",
                strokeWidth: 1,
                strokeStyle: "solid",
                roughness: 0,
                opacity: 100,
                groupIds: [],
                frameId: null,
                roundness: null,
                seed: 1,
                version: 2,
                versionNonce: 2,
                isDeleted: true,
                boundElements: null,
                updated: 2,
                link: null,
                locked: false,
                status: "saved",
                fileId: "e2e-file-1",
                scale: [1, 1],
                crop: null,
                customData: { title: CANVAS_IMAGE_TITLE },
              },
            ],
            appState: {},
            files: {
              "e2e-file-1": {
                id: "e2e-file-1",
                mimeType: "image/png",
                dataURL: `data:image/png;base64,${PNG_1X1_BASE64}`,
                created: 1,
                assetId: IDS.canvasAsset,
              },
            },
          },
          version: 1,
        },
      }),
    });
  });
}

/**
 * 打开 `@` 引用列表并等到三组数据都到齐（条目顺序靠它稳定）。
 *
 * 「画布对象」组的数据来自 Excalidraw 场景，冷启动偶尔十几秒才到；列表一旦在数据
 * 到达前渲染，不会自己补齐，所以这里带一次重开：Esc 关掉 → 把这个 `@` 真的删掉 →
 * 重新输入 `@`（chat-input 会把「Esc 时还留着的 @」记成 dismissed，同一个 @ 不会再
 * 弹面板，必须清掉再输）。
 */
async function openMentionPicker(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type("@");
    try {
      await expect(
        page.getByTestId("agent-mention-group").filter({ hasText: "画布对象" }),
      ).toHaveCount(1, { timeout: 20_000 });
      await expect(
        page.getByTestId("agent-mention-group").filter({ hasText: "我的素材" }),
      ).toHaveCount(1, { timeout: 10_000 });
      await expect(
        page.getByTestId("agent-mention-group").filter({ hasText: "模型" }),
      ).toHaveCount(1, { timeout: 10_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await page.keyboard.press("Escape");
      await input(page).click();
      await page.keyboard.press("End");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
    }
  }
}

test("SC-01 Escape 关闭技能选择列表，已输入的 / 文本保留", async ({ page }) => {
  await openCanvas(page);
  await input(page).click();
  await page.keyboard.type("/");
  await expect(page.getByTestId("agent-mention-group").first()).toBeVisible({
    timeout: PICKER_TIMEOUT,
  });
  for (const name of SKILL_NAMES) {
    await expect(
      page.getByTestId("canvas-image-picker-item").filter({ hasText: name }),
    ).toBeVisible();
  }

  await page.keyboard.press("Escape");

  await expect(page.getByTestId("agent-mention-group")).toHaveCount(0);
  await expect(input(page)).toContainText("/");
});

test("SC-02 ArrowDown 把选中项下移一格，Enter 插入的是第二项而不是第一项", async ({ page }) => {
  await openCanvas(page);
  await openMentionPicker(page);

  // 条目顺序由 fixtures 的三组 mock 数据决定：画布对象（CANVAS_IMAGE_TITLE）→
  // 我的素材（BRAND_ASSET_NAME）→ 模型（MODEL_NAME）。
  // 高亮默认停在第 0 项，ArrowDown 之后 Enter 应该插入第 1 项。
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("agent-mention-group")).toHaveCount(0);
  const pill = page.getByTestId("chat-input-mention-remove");
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText(BRAND_ASSET_NAME);
  await expect(pill).not.toContainText(CANVAS_IMAGE_TITLE);
});

test("SC-03 ArrowUp 在第一项上回卷到最后一项，Enter 插入最后一项", async ({ page }) => {
  await openCanvas(page);
  await openMentionPicker(page);

  // 高亮在第 0 项时按 ArrowUp 应回卷到列表最后一项，也就是模型组的 MODEL_NAME。
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("agent-mention-group")).toHaveCount(0);
  const pill = page.getByTestId("chat-input-mention-remove");
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText(MODEL_NAME);
  await expect(pill).not.toContainText(CANVAS_IMAGE_TITLE);
});

test.fixme("SC-04 Backspace 删除光标前的引用胶囊", async ({ page }) => {
  // 原因：删除胶囊要求光标**紧贴胶囊右缘**（chat-composer.tsx:270 只处理紧邻的情况）。
  // 纯键盘 + testid 约束下拿不到那个光标位置：点回输入框再按 End，实测落在文本行尾，
  // Backspace 没有删除胶囊 —— 实测报错原文：
  //   expect(locator).toHaveCount(expected) failed
  //   Locator: getByTestId('chat-input-mention-remove')  Expected: 0  Received: 1
  // 精确定位光标需要 DOM Range / evaluate 直接摆选区，README §2 禁止用 evaluate 绕过
  // 真实输入路径，所以这条先不硬造。
  await openCanvas(page);
  await openMentionPicker(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const pill = page.getByTestId("chat-input-mention-remove");
  await expect(pill).toHaveCount(1);

  await input(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");

  await expect(pill).toHaveCount(0);
});

test("SC-05 ArrowLeft / ArrowRight 在分隔条上以 20px 步长改变对话面板宽度", async ({ page }) => {
  await openCanvas(page);

  const handle = page.getByRole("separator", { name: "Resize chat panel" });
  await expect(handle).toBeVisible();
  const before = Number(await handle.getAttribute("aria-valuenow"));
  expect(Number.isFinite(before)).toBe(true);

  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before + 20));

  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(before));
});

test.fixme("SC-06 C 在空白画布上打开对话面板", async ({ page }) => {
  // 原因：C 只在画布「没有可见元素」时才挂 keydown 监听（canvas-empty-hint.tsx:42），
  // 而 fixtures.ts 的默认 mock 画布固定带 1 张图，必须先造出空场景。两条路都试过：
  //   A) canvas content.elements = []                    → 页面客户端初始化直接抛异常
  //   B) 原样返回那张图、只把 isDeleted 置 true（当前 mockEmptyCanvas）
  //                                                       → 同样抛异常
  // 两次实测拿到的都只是 Next.js 错误页：
  //   "Application error: a client-side exception has occurred while loading 127.0.0.1"
  // 根因不在本 spec 能改的范围（不许改 fixtures / 组件以外的画布初始化逻辑），
  // 所以纯 mock + 禁坐标点击的约束下造不出可用的空画布，C 暂时无法断言。
  await page.setViewportSize({ width: 900, height: 800 });
  await seedSession(page);
  await mockApi(page);
  await mockEmptyCanvas(page);
  await page.goto(CANVAS_URL);
  await expect(page.getByText(EMPTY_CANVAS_HINT)).toBeVisible({ timeout: CANVAS_TIMEOUT });
  await page.keyboard.press("c");
});

test("SC-07 Enter 在输入框发送消息", async ({ page }) => {
  await openCanvas(page);
  const text = "E2E 快捷键 Enter 发送";

  await input(page).click();
  await page.keyboard.type(text);
  await expect(input(page)).toContainText(text);

  await page.keyboard.press("Enter");

  // 输入框被清空 + 消息出现在对话区（本地乐观插入，chat-sidebar.tsx:429），
  // 同时会话标题也会被首条消息替换（chat-session-selector-trigger）。
  await expect(input(page)).not.toContainText(text, { timeout: PICKER_TIMEOUT });
  await expect(page.getByTestId("chat-session-selector-trigger")).toContainText(text, {
    timeout: PICKER_TIMEOUT,
  });
  await expect(page.getByText(text).last()).toBeVisible({ timeout: PICKER_TIMEOUT });
});

test.fixme("SC-08 Ctrl+Z / Ctrl+Shift+Z 撤销 / 重做", async ({ page }) => {
  await openCanvas(page);
  // 原因：撤销/重做由 Excalidraw 自己的历史栈处理（canvas-logo-menu.tsx:44-58 只是
  // 往 Excalidraw 里补发一个合成 keydown）。要造出「可撤销的一步」必须在画布上
  // 真实拖拽/绘制，而 README §2 禁止坐标点击与坐标拖拽；mock 场景加载的就是
  // fixtures.ts 里那张固定的图片元素，历史栈为空，按下 Ctrl+Z 没有任何可见变化。
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
});

test.fixme("SC-09 图片灯箱 + / - / r / Escape", async ({ page }) => {
  await openCanvas(page);
  // 原因：灯箱（chat/image-lightbox.tsx:118-121）只能从「历史消息里的图片」打开，
  // 而 fixtures.ts 的 /messages 固定返回空数组，本 spec 不允许改 fixtures 之外的
  // mock 数据来源，也无法点开一个不存在的缩略图。
});

test.fixme("SC-10 Tab 打开单图快速编辑面板（面板内 Escape 关闭）", async ({ page }) => {
  await openCanvas(page);
  // 原因：Tab 只在「画布上恰好选中 1 张图」时生效（image-toolbar-layer.tsx:677-696）。
  // 选中画布元素需要点中元素本体，README §2 禁坐标点击；Excalidraw 的框选同样要
  // 落点坐标。本 spec 无法在纯键盘 + testid 约束下造出该选中状态。
});

test.fixme("SC-11 面板类 Escape 与生成面板 Enter", async ({ page }) => {
  await openCanvas(page);
  // 原因：layers / files / 生成面板 / 权益弹层 / 模型下拉 / 工具块面板 / 翻转旋转条
  // 的 Escape 都需要先「打开」对应面板，而它们的打开入口依赖选中画布元素或一次
  // 真实生成任务（mock 的 /api/** 一律返回占位 JSON，任务不会完成）。纯 mock 环境
  // 下这些面板不可达，因此无法产生可观察的「Escape 关闭」结果。
});
