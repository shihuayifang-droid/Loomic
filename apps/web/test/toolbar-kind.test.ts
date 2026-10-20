import { describe, expect, it } from "vitest";

import {
  type SelectionItemKind,
  type ToolbarKind,
  elementKind,
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

// ---------------------------------------------------------------------------
// 工单 30Q §3 裁决 2：Excalidraw 元素 → kind
// ---------------------------------------------------------------------------

describe("elementKind：裁决 2 的表格逐行（工单 30Q）", () => {
  it("`customData.generating === true` → placeholder_generating（优先级最高）", () => {
    expect(elementKind({ type: "rectangle", customData: { generating: true } })).toBe(
      "placeholder_generating",
    );
    // 生成中的占位常常就是一个 image 元素：先判 generating 才不会把它当可编辑的图片
    expect(elementKind({ type: "image", customData: { generating: true } })).toBe(
      "placeholder_generating",
    );
  });

  it("`generating` 不是布尔 true 时不算占位（`=== true` 才认）", () => {
    expect(elementKind({ type: "image", customData: { generating: "true" } })).toBe("image");
    expect(elementKind({ type: "image", customData: { generating: 1 } })).toBe("image");
    expect(elementKind({ type: "image", customData: { generating: false } })).toBe("image");
    expect(elementKind({ type: "image", customData: {} })).toBe("image");
    expect(elementKind({ type: "image", customData: null })).toBe("image");
    expect(elementKind({ type: "image" })).toBe("image");
  });

  it("`image` → image", () => {
    expect(elementKind({ type: "image" })).toBe("image");
  });

  it("`text` → text", () => {
    expect(elementKind({ type: "text" })).toBe("text");
  });

  it("`rectangle` / `ellipse` / `diamond` → shape", () => {
    expect(elementKind({ type: "rectangle" })).toBe("shape");
    expect(elementKind({ type: "ellipse" })).toBe("shape");
    expect(elementKind({ type: "diamond" })).toBe("shape");
  });

  it("`line` / `arrow` → line", () => {
    expect(elementKind({ type: "line" })).toBe("line");
    expect(elementKind({ type: "arrow" })).toBe("line");
  });

  it("`freedraw` → freedraw", () => {
    expect(elementKind({ type: "freedraw" })).toBe("freedraw");
  });

  it("`frame` / `magicframe` → frame", () => {
    expect(elementKind({ type: "frame" })).toBe("frame");
    expect(elementKind({ type: "magicframe" })).toBe("frame");
  });

  it("其余一律 null：`embeddable`（视频留给接视频那张单）", () => {
    expect(elementKind({ type: "embeddable" })).toBeNull();
  });

  it("其余一律 null：未知 / 缺失 type，以及 `selection` / `iframe` 这类非画布元素", () => {
    expect(elementKind({})).toBeNull();
    expect(elementKind({ type: undefined })).toBeNull();
    expect(elementKind({ type: "selection" })).toBeNull();
    expect(elementKind({ type: "iframe" })).toBeNull();
    expect(elementKind({ type: "IMAGE" })).toBeNull();
  });

  it("本单不映射的两格：placeholder_failed 与 vector 都拿不到（见 T-78）", () => {
    // 没有任何输入会产出这两个 kind —— 它们是留给后续单子的位置，不是这个函数的返回值。
    const inputs: Array<{ type?: string; customData?: { generating?: unknown } }> = [
      { type: "image" },
      { type: "image", customData: { generating: false } },
      { type: "embeddable" },
      { type: "frame" },
      {},
    ];
    const kinds = inputs.map((input) => elementKind(input));
    expect(kinds).not.toContain("placeholder_failed");
    expect(kinds).not.toContain("vector");
  });
});

// ---------------------------------------------------------------------------
// 工单 35A：补齐 T-78 的两格（失败占位 / 视频）
// ---------------------------------------------------------------------------

describe("elementKind：工单 35A 补的两格（失败占位 / 视频）", () => {
  it("ED-00e: a failed slot is placeholder_failed", () => {
    // 失败占位由服务端 markGenerationSlotFailed 打上 failed: true，generating 同时被置为 false
    expect(
      elementKind({ type: "embeddable", customData: { failed: true, generating: false } }),
    ).toBe("placeholder_failed");
    // 即使脏数据里两个标记同时为 true，失败也要排在生成中之前
    expect(
      elementKind({ type: "image", customData: { failed: true, generating: true } }),
    ).toBe("placeholder_failed");
  });

  it("ED-00e: a canvas video is video", () => {
    // 画布视频是 type: "embeddable" + customData.isVideo === true（lib/canvas-elements.ts）
    expect(elementKind({ type: "embeddable", customData: { isVideo: true } })).toBe("video");
    // 不依赖 type：换成别的 type 也认 isVideo
    expect(elementKind({ type: "rectangle", customData: { isVideo: true } })).toBe("video");
    // 生成中的视频占位仍归 placeholder_generating（顺序：generating 在 isVideo 之前）
    expect(
      elementKind({ type: "embeddable", customData: { isVideo: true, generating: true } }),
    ).toBe("placeholder_generating");
  });

  it('ED-00e: failed:"true" as a string is not recognised', () => {
    // 只在 === true 时认，字符串 "true" 不算（此时 embeddable 没有 isVideo，落到 null）
    expect(elementKind({ type: "embeddable", customData: { failed: "true" } })).toBeNull();
    // 同一口径适用于 isVideo
    expect(elementKind({ type: "embeddable", customData: { isVideo: "true" } })).toBeNull();
  });

  it("ED-00e: a single failed slot resolves to the retry/delete toolbar", () => {
    const failedSlot = elementKind({
      type: "embeddable",
      customData: { failed: true, generating: false },
    });
    expect(resolveToolbar([{ kind: failedSlot! }])).toBe("placeholder_failed");
    expect(TOOLBAR_ITEMS[resolveToolbar([{ kind: failedSlot! }])]).toEqual(["retry", "delete"]);
  });

  it("ED-00e: two images and a video resolve to download_all", () => {
    const image = elementKind({ type: "image" });
    const video = elementKind({ type: "embeddable", customData: { isVideo: true } });
    expect(video).toBe("video");
    const toolbar = resolveToolbar([{ kind: image! }, { kind: image! }, { kind: video! }]);
    expect(toolbar).toBe("download_all");
    expect(TOOLBAR_ITEMS[toolbar]).toEqual(["download_all"]);
  });
});
