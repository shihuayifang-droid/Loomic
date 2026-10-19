import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetCompletionTitleForTests,
  useCompletionTitle,
  type CompletionTitleControls,
} from "../src/hooks/use-completion-title";

/**
 * CV-10 完成提醒的接线（工单 30H T3）
 *
 * `document.visibilityState` 与 `document.title` 都换成可控的假实现：
 * - `visibilityVariable` 模拟「用户切走 / 切回」的**状态**；
 * - `titleWrites` 记录每一次**写入**，这样「前台一个字节都不改」能被钉住
 *   （只看 `document.title` 的终值无法区分「没改」和「改了又改回来」）。
 *
 * 本仓 vitest 没开 globals，RTL 不会自动 cleanup；而且这个 hook 是**模块级单例**，
 * 所以每例之间必须 `cleanup()` + `resetCompletionTitleForTests()`。
 */

const ORIGINAL_TITLE = "我的项目 · HaHart";

let visibility: DocumentVisibilityState = "visible";
let titleValue = ORIGINAL_TITLE;
let titleWrites: string[] = [];

function installDocumentMocks(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.defineProperty(document, "title", {
    configurable: true,
    get: () => titleValue,
    set: (next: string) => {
      titleValue = next;
      titleWrites.push(next);
    },
  });
}

function removeDocumentMocks(): void {
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(document, "title");
}

/** 模拟用户切走 / 切回：先改状态，再派发 `visibilitychange`。 */
function switchTo(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function renderControls(): CompletionTitleControls {
  return renderHook(() => useCompletionTitle()).result.current;
}

beforeEach(() => {
  visibility = "visible";
  titleValue = ORIGINAL_TITLE;
  titleWrites = [];
  resetCompletionTitleForTests();
  installDocumentMocks();
});

afterEach(() => {
  cleanup();
  resetCompletionTitleForTests();
  removeDocumentMocks();
});

describe("useCompletionTitle（CV-10 验收 1、2、3）", () => {
  it("验收1：隐藏时结束一轮会改标题，切回前台立即复原", () => {
    const controls = renderControls();
    visibility = "hidden";

    act(() => {
      controls.begin("job-1");
    });
    act(() => {
      controls.end("job-1", true);
    });
    expect(titleValue).toBe("✅ 创作完成");

    switchTo("visible");
    expect(titleValue).toBe(ORIGINAL_TITLE);
  });

  it("验收2：页面在前台时结束一轮，标题一次都没被写过", () => {
    const controls = renderControls();

    act(() => {
      controls.begin("job-1");
    });
    act(() => {
      controls.end("job-1", true);
    });

    expect(titleValue).toBe(ORIGINAL_TITLE);
    expect(titleWrites).toEqual([]);
  });

  it("复原之后再派发 visibilitychange，标题不会再变（监听已摘掉）", () => {
    const controls = renderControls();
    visibility = "hidden";
    act(() => {
      controls.begin("job-1");
    });
    act(() => {
      controls.end("job-1", true);
    });

    switchTo("visible");
    // 复原本身也是一次写入，所以序列里第二项是那一次的还原值。
    expect(titleWrites).toEqual(["✅ 创作完成", ORIGINAL_TITLE]);
    expect(titleValue).toBe(ORIGINAL_TITLE);

    switchTo("hidden");
    switchTo("visible");
    expect(titleWrites).toEqual(["✅ 创作完成", ORIGINAL_TITLE]);
    expect(titleValue).toBe(ORIGINAL_TITLE);
  });

  it("两个组件共用同一轮（模块级单例）：最后一个 end 才触发", () => {
    const hostA = renderControls();
    const hostB = renderControls();
    visibility = "hidden";

    act(() => {
      hostA.begin("job-1");
      hostB.begin("job-2");
    });
    act(() => {
      hostA.end("job-1", true);
    });
    expect(titleWrites).toEqual([]);

    act(() => {
      hostB.end("job-2", false);
    });
    expect(titleValue).toBe("⚠️ 1 项完成，1 项失败");
  });

  it("验收3：3 个任务里 1 个失败，隐藏状态下只改一次标题", () => {
    const controls = renderControls();
    visibility = "hidden";

    act(() => {
      for (const id of ["job-1", "job-2", "job-3"]) controls.begin(id);
    });
    act(() => {
      controls.end("job-1", true);
      controls.end("job-2", true);
    });
    expect(titleWrites).toEqual([]);

    act(() => {
      controls.end("job-3", false);
    });
    expect(titleWrites).toEqual(["⚠️ 2 项完成，1 项失败"]);
    expect(titleValue).toBe("⚠️ 2 项完成，1 项失败");
  });

  it("全部失败的一轮显示「❌ 生成失败」", () => {
    const controls = renderControls();
    visibility = "hidden";

    act(() => {
      controls.begin("job-1");
      controls.begin("job-2");
    });
    act(() => {
      controls.end("job-1", false);
      controls.end("job-2", false);
    });

    expect(titleValue).toBe("❌ 生成失败");
  });

  it("end 一个没 begin 过的 id：不改标题，也不让本轮提前结束", () => {
    const controls = renderControls();
    visibility = "hidden";

    act(() => {
      controls.end("ghost", false);
    });
    expect(titleWrites).toEqual([]);

    act(() => {
      controls.begin("job-1");
    });
    act(() => {
      controls.end("ghost", false);
    });
    expect(titleWrites).toEqual([]);

    act(() => {
      controls.end("job-1", true);
    });
    expect(titleValue).toBe("✅ 创作完成");
  });

  it("第二轮在仍然隐藏时结束：标题换成新计数，复原目标仍是最初那个标题", () => {
    const controls = renderControls();
    visibility = "hidden";

    act(() => {
      controls.begin("job-1");
      controls.end("job-1", true);
    });
    expect(titleValue).toBe("✅ 创作完成");

    act(() => {
      controls.begin("job-2");
      controls.end("job-2", false);
    });
    expect(titleValue).toBe("❌ 生成失败");

    switchTo("visible");
    expect(titleValue).toBe(ORIGINAL_TITLE);
  });

  it("复原之后开始的新一轮，再次隐藏时又会改标题", () => {
    const controls = renderControls();
    visibility = "hidden";
    act(() => {
      controls.begin("job-1");
      controls.end("job-1", true);
    });
    switchTo("visible");

    visibility = "hidden";
    act(() => {
      controls.begin("job-2");
      controls.end("job-2", false);
    });

    expect(titleValue).toBe("❌ 生成失败");
    // 三段写入：第一轮结果 → 切回前台复原 → 第二轮结果。
    expect(titleWrites).toEqual(["✅ 创作完成", ORIGINAL_TITLE, "❌ 生成失败"]);
  });
});
