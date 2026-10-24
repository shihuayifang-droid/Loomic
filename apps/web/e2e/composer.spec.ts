import { expect, test, type Page } from "@playwright/test";

import {
  BRAND_ASSET_NAME,
  CANVAS_IMAGE_TITLE,
  CANVAS_URL,
  MODEL_NAME,
  PNG_1X1_BASE64,
  SKILL_NAMES,
  mockApi,
  seedSession,
  type ApiLog,
} from "./fixtures";

const INPUT_NAME = "输入消息";

async function openCanvas(page: Page): Promise<ApiLog> {
  await seedSession(page);
  const log = await mockApi(page);
  await page.goto(CANVAS_URL);
  await page.getByRole("textbox", { name: INPUT_NAME }).first().waitFor({ timeout: 45_000 });
  return log;
}

function input(page: Page) {
  return page.getByRole("textbox", { name: INPUT_NAME }).first();
}

test("AG-02 验收1-a: 输入 / 出现技能列表，过滤与 Esc", async ({ page }) => {
  await openCanvas(page);
  await input(page).click();
  await page.keyboard.type("/");

  const picker = page.getByTestId("agent-mention-group");
  await expect(picker.first()).toBeVisible();
  for (const name of SKILL_NAMES) {
    await expect(page.getByTestId("canvas-image-picker-item").filter({ hasText: name })).toBeVisible();
  }

  await page.keyboard.type("品牌");
  await expect(page.getByTestId("canvas-image-picker-item")).toHaveCount(1);
  await expect(page.getByTestId("canvas-image-picker-item").first()).toContainText("品牌海报");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-mention-group")).toHaveCount(0);
  await expect(input(page)).toContainText("/品牌");
});

test("AG-02 验收1-b: 输入 @ 出现分组，选中后插入胶囊", async ({ page }) => {
  await openCanvas(page);
  await input(page).click();
  await page.keyboard.type("@");

  // 组件实际渲染的 @ 分组是 画布对象 / 我的素材 / 模型（技能只走 `/`；
  // 「本轮已上传文件」这一组在 canvas-image-picker.tsx 里不存在，见回传「阻塞/偏差」）。
  await expect(page.getByTestId("agent-mention-group").first()).toBeVisible();
  const groups = page.getByTestId("agent-mention-group");
  await expect(groups.filter({ hasText: "画布对象" })).toHaveCount(1);
  await expect(groups.filter({ hasText: "我的素材" })).toHaveCount(1);
  await expect(groups.filter({ hasText: "模型" })).toHaveCount(1);
  await expect(groups.filter({ hasText: CANVAS_IMAGE_TITLE })).toHaveCount(1);
  await expect(groups.filter({ hasText: BRAND_ASSET_NAME })).toHaveCount(1);
  await expect(groups.filter({ hasText: MODEL_NAME })).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-mention-group")).toHaveCount(0);
  // 输入框里选中的引用渲染为 chat-input-mention-remove 胶囊（[data-kind] 只在已发送消息的 MentionPill 上）。
  await expect(page.getByTestId("chat-input-mention-remove")).toHaveCount(1);
  await expect(page.getByTestId("chat-input-mention-remove")).toContainText(BRAND_ASSET_NAME);
});

test("AG-02 验收2: 拖 PNG 到对话区出现附件，画布对象数不变", async ({ page }) => {
  const log = await openCanvas(page);

  // 拖放前先数画布对象：@ 列表里「画布对象」组的条目数。
  await input(page).click();
  await page.keyboard.type("@");
  const canvasItems = page
    .getByTestId("agent-mention-group")
    .filter({ hasText: "画布对象" })
    .getByTestId("canvas-image-picker-item");
  await expect(canvasItems).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");

  const savesBefore = log.filter((e) => e.method === "PUT" && e.path.startsWith("/api/canvases/")).length;
  const uploadsBefore = log.filter((e) => e.method === "POST" && e.path === "/api/uploads").length;

  const dataTransfer = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "e2e.png", { type: "image/png" }));
    return dt;
  }, PNG_1X1_BASE64);

  // 拖放区是 Agent 面板根节点（输入框的祖先）。
  const zone = page.locator("div.flex.h-full.shrink-0").filter({ has: input(page) }).first();
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await expect(page.getByTestId("agent-drop-overlay")).toBeVisible();
  await expect(page.getByTestId("agent-drop-overlay")).toContainText("松开添加到对话");

  await zone.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByTestId("agent-drop-overlay")).toHaveCount(0);

  // 上传被触发，输入框上方出现附件缩略图（该组件没有 [data-kind="file"]，
  // 附件由 ImageAttachmentBar 渲染：img[alt="Attachment"] + attachment-remove 按钮）。
  await expect(page.getByTestId("attachment-remove")).toHaveCount(1);
  await expect(page.locator('img[alt="Attachment"]')).toHaveCount(1);
  await expect
    .poll(() => log.filter((e) => e.method === "POST" && e.path === "/api/uploads").length)
    .toBe(uploadsBefore + 1);

  // 画布对象数不变：@ 列表里的画布对象仍是 1 个，且没有任何画布保存请求。
  await input(page).click();
  await page.keyboard.type("@");
  await expect(canvasItems).toHaveCount(1);
  await page.keyboard.press("Escape");
  expect(log.filter((e) => e.method === "PUT" && e.path.startsWith("/api/canvases/")).length).toBe(savesBefore);
});
