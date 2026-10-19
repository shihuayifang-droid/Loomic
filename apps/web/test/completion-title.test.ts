import { describe, expect, it } from "vitest";

import {
  beginTask,
  completionTitle,
  endTask,
  type RoundState,
} from "../src/lib/completion-title";

/**
 * CV-10 完成提醒的纯逻辑（工单 30H T2）
 *
 * 这里钉的是「轮」的边界：`pending` 什么时候变空、计数什么时候累加、什么时候清零。
 * 标题文案取自 `CV-画布核心.md` L326，三个字面量逐字对齐（含 emoji 后面的空格）。
 */

function emptyRound(): RoundState {
  return { pending: new Set<string>(), succeeded: 0, failed: 0 };
}

/** 依次登记多个任务，返回新 state（不就地改）。 */
function beginAll(state: RoundState, ids: readonly string[]): RoundState {
  return ids.reduce((acc, id) => beginTask(acc, id), state);
}

describe("completionTitle（CV-10 第 2 条的三种文案）", () => {
  it("全部成功 → 「✅ 创作完成」", () => {
    expect(completionTitle(3, 0)).toBe("✅ 创作完成");
  });

  it("全部失败 → 「❌ 生成失败」", () => {
    expect(completionTitle(0, 2)).toBe("❌ 生成失败");
  });

  it("部分失败 → 「⚠️ N 项完成，M 项失败」", () => {
    expect(completionTitle(2, 1)).toBe("⚠️ 2 项完成，1 项失败");
    expect(completionTitle(1, 5)).toBe("⚠️ 1 项完成，5 项失败");
  });

  it("0 / 0 也全定义（一轮不会走到这里，这里只钉函数没有未定义分支）", () => {
    expect(completionTitle(0, 0)).toBe("✅ 创作完成");
  });
});

describe("beginTask / endTask（一轮的边界）", () => {
  it("验收3：3 个 begin、2 成功 1 失败，只有最后一次 end 让本轮结束", () => {
    let state = beginAll(emptyRound(), ["job-1", "job-2", "job-3"]);
    expect(state.pending.size).toBe(3);

    const first = endTask(state, "job-1", true);
    state = first.state;
    expect(first.finishedRound).toBe(false);

    const second = endTask(state, "job-2", true);
    state = second.state;
    expect(second.finishedRound).toBe(false);

    const third = endTask(state, "job-3", false);
    expect(third.finishedRound).toBe(true);
    // 本轮计数在 finishedRound 那一刻仍然可读 —— hook 正是拿它算标题。
    expect(completionTitle(third.state.succeeded, third.state.failed)).toBe("⚠️ 2 项完成，1 项失败");
  });

  it("未知 id 的 end 什么也不做：state 原样返回，finishedRound 为 false", () => {
    const state = beginTask(emptyRound(), "job-1");
    const result = endTask(state, "ghost", false);
    expect(result.finishedRound).toBe(false);
    expect(result.state).toBe(state);
    expect(result.state.pending.has("job-1")).toBe(true);
    expect(result.state.failed).toBe(0);
  });

  it("同一个 id 重复 end 只算一次（第二次 already 不在 pending 里）", () => {
    let state = beginAll(emptyRound(), ["job-1", "job-2"]);
    const first = endTask(state, "job-1", true);
    state = first.state;
    expect(state.succeeded).toBe(1);

    const again = endTask(state, "job-1", true);
    expect(again.finishedRound).toBe(false);
    expect(again.state.succeeded).toBe(1);
    expect(again.state.pending.size).toBe(1);
  });

  it("一轮结束后计数在下一轮 begin 时清零", () => {
    const finished = endTask(beginTask(emptyRound(), "job-1"), "job-1", true);
    expect(finished.finishedRound).toBe(true);
    expect(finished.state.succeeded).toBe(1);

    const next = beginTask(finished.state, "job-2");
    expect(next.succeeded).toBe(0);
    expect(next.failed).toBe(0);
    expect([...next.pending]).toEqual(["job-2"]);
  });

  it("同一轮里 begin 同一个 id 只占一个坑，计数不会被 begin 重置", () => {
    let state = beginAll(emptyRound(), ["job-1", "job-2"]);
    state = endTask(state, "job-1", false).state;
    expect(state.failed).toBe(1);

    const again = beginTask(state, "job-2");
    expect([...again.pending].sort()).toEqual(["job-2"]);
    expect(again.failed).toBe(1);
  });

  it("不改入参：endTask 之后调用方手里的 state 仍然是原样", () => {
    const state = beginAll(emptyRound(), ["job-1", "job-2"]);
    const before = [...state.pending];
    const result = endTask(state, "job-1", true);
    expect([...state.pending]).toEqual(before);
    expect(state.succeeded).toBe(0);
    expect([...result.state.pending]).toEqual(["job-2"]);
  });

  it("只有一个任务时：它成功/失败结束就是本轮结束", () => {
    const ok = endTask(beginTask(emptyRound(), "job-1"), "job-1", true);
    expect(ok.finishedRound).toBe(true);
    expect(completionTitle(ok.state.succeeded, ok.state.failed)).toBe("✅ 创作完成");

    const failed = endTask(beginTask(emptyRound(), "job-2"), "job-2", false);
    expect(failed.finishedRound).toBe(true);
    expect(completionTitle(failed.state.succeeded, failed.state.failed)).toBe("❌ 生成失败");
  });
});
