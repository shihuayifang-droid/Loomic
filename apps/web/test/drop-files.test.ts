import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { acceptedDropFiles, dragHasFiles } from "../src/lib/drop-files";

/**
 * AG-02：整个 Agent 面板是拖放区（工单 37D T3）。
 *
 * 面板组件依赖太多（WS / 会话 / 上传 hook），不在本单渲染；遮罩文案与 testid
 * 用源码断言，行为用 `drop-files.ts` 的两个纯函数断言。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_PATH = path.join(HERE, "..", "src", "components", "chat-sidebar.tsx");

function fakeFile(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("drop-files（AG-02 拖放区）", () => {
  it("AG-02: only images are accepted from a drop", () => {
    const png = fakeFile("a.png", "image/png");
    const pdf = fakeFile("b.pdf", "application/pdf");
    const jpeg = fakeFile("c.jpg", "image/jpeg");

    const accepted = acceptedDropFiles([png, pdf, jpeg]);

    expect(accepted.map((file) => file.name)).toEqual(["a.png", "c.jpg"]);
    expect(accepted[0]).toBe(png);
    expect(accepted[1]).toBe(jpeg);
  });

  it("AG-02: a drag of files is recognised", () => {
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });

  it("AG-02: dropping nothing usable accepts nothing", () => {
    expect(acceptedDropFiles([fakeFile("b.pdf", "application/pdf")])).toEqual([]);
  });

  it("AG-02: the overlay wording is exact", () => {
    const source = fs.readFileSync(SIDEBAR_PATH, "utf8");

    expect(source).toContain("松开添加到对话");
    expect(source).toContain("agent-drop-overlay");
  });
});
