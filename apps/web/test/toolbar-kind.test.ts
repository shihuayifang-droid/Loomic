import { describe, expect, it } from "vitest";

import {
  type SelectionItemKind,
  type ToolbarKind,
  TOOLBAR_ITEMS,
  resolveToolbar,
} from "../src/lib/toolbar-kind";

/**
 * ED-00e · 选中内容 → 工具条形态。
 *
 * 规格表 9 行每行至少 1 例（工单 30E §4），另加 Kiro 裁定的三条重叠规则各 1 例、
 * 空选择 1 例，以及一条 `it.each` 覆盖 `SelectionItemKind` 的全部单选情况
 * —— 后者用来证明「每种 kind 都有归属，没有遗漏」。
 */

/** 单选一个对象。 */
function one(kind: SelectionItemKind): Array<{ kind: SelectionItemKind }> {
  return [{ kind }];
}

/** 多选若干个对象。 */
function many(...kinds: SelectionItemKind[]): Array<{ kind: SelectionItemKind }> {
  return kinds.map((kind) => ({ kind }));
}

/**
 * 全部 `SelectionItemKind` 取值。与下面的 `SINGLE_KIND_EXPECTED` 配合：
 * `SelectionItemKind` 新增一个 kind 时，`Record<SelectionItemKind, …>` 缺 key 会**编译报错**，
 * 所以「忘了归类」不可能悄悄溜过去；这条列表只用来做运行期的集合比对（防重复 / 漏写）。
 */
const ALL_SELECTION_KINDS: readonly SelectionItemKind[] = [
  "image",
  "video",
  "text",
  "shape",
  "line",
  "freedraw",
  "frame",
  "placeholder_generating",
  "placeholder_failed",
  "vector",
];

/** 单选时每个 kind 该归哪种形态（ED-00e 第 1、4~9 行）。 */
const SINGLE_KIND_EXPECTED: Record<SelectionItemKind, ToolbarKind> = {
  image: "image",
  video: "video_panel",
  text: "style",
  shape: "style",
  line: "style",
  freedraw: "style",
  frame: "frame",
  placeholder_generating: "placeholder_generating",
  placeholder_failed: "placeholder_failed",
  vector: "vector",
};

/** 全部 `ToolbarKind` 取值，用来证明 `TOOLBAR_ITEMS` 没有漏配形态。 */
const ALL_TOOLBAR_KINDS: readonly ToolbarKind[] = [
  "none",
  "image",
  "video_panel",
  "style",
  "frame",
  "placeholder_generating",
  "placeholder_failed",
  "vector",
  "download_all",
  "common",
];

describe("resolveToolbar：ED-00e 规格表逐行", () => {
  it("空选择 → none（没有选中任何对象时不显示工具条）", () => {
    expect(resolveToolbar([])).toBe("none");
  });

  it("第 1 行 单张图片 → image；TOOLBAR_ITEMS.image 是通配占位，不硬编码工具列表", () => {
    expect(resolveToolbar(one("image"))).toBe("image");
    // 完整图片工具条由 ED-00k 的 /api/tools 下发（30F 做），本单不许硬编码，所以只有 ["*"]
    expect(TOOLBAR_ITEMS.image).toEqual(["*"]);
  });

  it("第 3 行 视频 → video_panel（走现有视频面板，不弹图片工具条）", () => {
    expect(resolveToolbar(one("video"))).toBe("video_panel");
    // 形态是「图片工具条这一侧不渲染任何项」，下载 / 删除由视频面板自己提供
    expect(TOOLBAR_ITEMS.video_panel).toEqual([]);
  });

  it("第 5 行 文字 → style", () => {
    expect(resolveToolbar(one("text"))).toBe("style");
  });

  it("第 5 行 形状 → style", () => {
    expect(resolveToolbar(one("shape"))).toBe("style");
  });

  it("第 5 行 线条 → style", () => {
    expect(resolveToolbar(one("line"))).toBe("style");
  });

  it("第 5 行 画笔 → style", () => {
    expect(resolveToolbar(one("freedraw"))).toBe("style");
  });

  it("第 6 行 画板 → frame（不弹图片工具条）", () => {
    expect(resolveToolbar(one("frame"))).toBe("frame");
    expect(TOOLBAR_ITEMS.frame).toEqual([]);
  });

  it("第 7 行 生成中的占位 → placeholder_generating，只有「取消」", () => {
    expect(resolveToolbar(one("placeholder_generating"))).toBe("placeholder_generating");
    expect(TOOLBAR_ITEMS.placeholder_generating).toEqual(["cancel"]);
  });

  it("第 8 行 失败的占位 → placeholder_failed，「重试」「删除」", () => {
    expect(resolveToolbar(one("placeholder_failed"))).toBe("placeholder_failed");
    expect(TOOLBAR_ITEMS.placeholder_failed).toEqual(["retry", "delete"]);
  });

  it("第 9 行 矢量对象 → vector，只有「下载」「翻转与旋转」", () => {
    expect(resolveToolbar(one("vector"))).toBe("vector");
    expect(TOOLBAR_ITEMS.vector).toEqual(["download", "flip_rotate"]);
  });
});

describe("resolveToolbar：重叠规则（Kiro 对 ED-00e 表内冲突的裁定）", () => {
  it("全是形状 / 文字 → style（两个形状、形状+文字、三个形状都算）", () => {
    expect(resolveToolbar(many("shape", "text"))).toBe("style");
    expect(resolveToolbar(many("shape", "shape"))).toBe("style");
    expect(resolveToolbar(many("shape", "shape", "text"))).toBe("style");
  });

  it("混选图片 + 形状 → common，只显示通用项：不透明度、删除", () => {
    expect(resolveToolbar(many("image", "shape"))).toBe("common");
    expect(TOOLBAR_ITEMS.common).toEqual(["opacity", "delete"]);
  });

  it("混选图片 + 文字 → common（「形状/文字」是同一组）", () => {
    expect(resolveToolbar(many("image", "text"))).toBe("common");
    expect(resolveToolbar(many("text", "image", "shape"))).toBe("common");
  });

  it("图片 + 视频 → download_all（视频不是形状/文字，不满足「恰好」）", () => {
    expect(resolveToolbar(many("image", "video"))).toBe("download_all");
    expect(TOOLBAR_ITEMS.download_all).toEqual(["download_all"]);
  });

  it("两张图片 → download_all", () => {
    expect(resolveToolbar(many("image", "image"))).toBe("download_all");
    expect(resolveToolbar(many("image", "image", "image"))).toBe("download_all");
  });

  it("图片 + 形状 + 第三种 kind → download_all（不是「恰好由图片和形状/文字组成」）", () => {
    expect(resolveToolbar(many("image", "shape", "video"))).toBe("download_all");
    expect(resolveToolbar(many("image", "shape", "frame"))).toBe("download_all");
  });

  it("规格未定义的一格：多选 线条 + 画笔 落到 download_all（「全是形状/文字」按字面只含 shape / text）", () => {
    // 线条与画笔只在**单选**那几行里归 style；多选时「全是形状/文字」按 Kiro 裁定的字面范围
    // 只含 shape 与 text，所以这一格落进第三条兜底「其余多选 → download_all」。
    expect(resolveToolbar(many("line", "freedraw"))).toBe("download_all");
    expect(resolveToolbar(many("line", "line"))).toBe("download_all");
  });
});

describe("resolveToolbar：每种 kind 都有归属，没有遗漏", () => {
  it.each(Object.entries(SINGLE_KIND_EXPECTED))(
    "单选 %s → %s，且不是 none",
    (kind, expected) => {
      const resolved = resolveToolbar(one(kind as SelectionItemKind));
      expect(resolved).toBe(expected);
      // 「有归属」= 不是 none（none 只属于空选择）
      expect(resolved).not.toBe("none");
    },
  );

  it("it.each 的表确实覆盖了全部 SelectionItemKind（集合相等，不多不漏）", () => {
    expect(Object.keys(SINGLE_KIND_EXPECTED).sort()).toEqual([...ALL_SELECTION_KINDS].sort());
    expect(ALL_SELECTION_KINDS).toHaveLength(10);
  });

  it("每一种单选形态都能在 TOOLBAR_ITEMS 里查到项（没有漏配的形态）", () => {
    for (const kind of ALL_SELECTION_KINDS) {
      const toolbar = resolveToolbar(one(kind));
      expect(TOOLBAR_ITEMS[toolbar], `${kind} 落到 ${toolbar}，但 TOOLBAR_ITEMS 里没有`).toBeDefined();
      expect(Array.isArray(TOOLBAR_ITEMS[toolbar])).toBe(true);
    }
  });
});

describe("TOOLBAR_ITEMS：形态与项一一对上", () => {
  it("覆盖全部 ToolbarKind，键集合相等", () => {
    expect(Object.keys(TOOLBAR_ITEMS).sort()).toEqual([...ALL_TOOLBAR_KINDS].sort());
  });

  it("none 一个项都没有；每个形态的项都是数组（不会返回 undefined）", () => {
    expect(TOOLBAR_ITEMS.none).toEqual([]);
    for (const kind of ALL_TOOLBAR_KINDS) {
      expect(TOOLBAR_ITEMS[kind]).toBeInstanceOf(Array);
    }
  });

  it("style 的项来自 ED-00o 的固定表（描边色 / 填充色 / 线宽 / 线型 / 不透明度 / 字号 / 字体 / 对齐 / 删除）", () => {
    expect(TOOLBAR_ITEMS.style).toEqual([
      "stroke",
      "fill",
      "stroke_width",
      "stroke_style",
      "opacity",
      "font_size",
      "font_family",
      "text_align",
      "delete",
    ]);
  });

  it("common 是 style 的子集关系说得通：通用项在两个形态里同义（不透明度、删除）", () => {
    expect(TOOLBAR_ITEMS.common.every((item) => TOOLBAR_ITEMS.style.includes(item))).toBe(true);
  });
});

describe("resolveToolbar：纯函数", () => {
  it("不改入参（传冻结数组也不报错）、顺序无关、重复 kind 不影响判定", () => {
    const frozen = Object.freeze([
      Object.freeze({ kind: "image" as SelectionItemKind }),
      Object.freeze({ kind: "shape" as SelectionItemKind }),
    ]);
    expect(() => resolveToolbar(frozen)).not.toThrow();
    expect(resolveToolbar(frozen)).toBe("common");

    // 顺序无关
    expect(resolveToolbar(many("shape", "image"))).toBe(resolveToolbar(many("image", "shape")));
    // 重复的 kind 不改变判定
    expect(resolveToolbar(many("image", "image", "shape"))).toBe("common");
    // 调完之后入参内容没变
    expect(frozen.map((item) => item.kind)).toEqual(["image", "shape"]);
  });
});
