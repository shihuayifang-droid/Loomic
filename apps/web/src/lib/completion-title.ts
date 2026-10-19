/**
 * CV-10 完成提醒的纯逻辑（工单 30H T2）
 *
 * 一条「轮」= 从第一个 `begin` 到最后一个任务结束。一轮里同时有几个任务时，
 * 只在**最后一个**任务结束时返回 `finishedRound = true`，由调用方（hook）在那一刻
 * 改标题一次，而不是每个任务各闪一次（CV-10 第 3 条）。
 *
 * ## 两个刻意的设计
 *
 * 1. **纯函数、不改入参**：`pending` 每次都拷贝一份，调用方手里的 state 永远不动。
 *    hook 只有一个模块级变量，改错了没人兜得住，所以这里不做原地修改。
 * 2. **计数清零放在 `beginTask`、不放在 `endTask`**：`endTask` 返回那一刻，
 *    hook 正要拿本轮的 `succeeded` / `failed` 去算标题；如果在 `endTask` 里清零，
 *    这个信息就当场丢了（返回值里只有 `{ state, finishedRound }`，没有计数）。
 *    所以「结束后计数清零开始下一轮」落在**下一轮的第一个 begin**：
 *    `pending` 为空即表示上一轮已结束（或还没开始），此时把计数归零。
 *
 * 未知 id 的 `end` 什么也不做（`finishedRound = false`，state 原样返回），
 * 因此同一个 id 重复 `end` 天然只算一次 —— 第二次时它已经不在 `pending` 里了。
 */

export type RoundState = {
  /** 本轮还没结束的任务 id。 */
  pending: ReadonlySet<string>;
  succeeded: number;
  failed: number;
};

/** 登记一个任务到当前轮。`id` 重复时只占一个坑（Set 语义）。 */
export function beginTask(state: RoundState, id: string): RoundState {
  const pending = new Set(state.pending);
  pending.add(id);
  // pending 为空 = 上一轮已经结束（或还没开始）→ 从这里开新一轮，计数归零。
  const startingNewRound = state.pending.size === 0;
  return {
    pending,
    succeeded: startingNewRound ? 0 : state.succeeded,
    failed: startingNewRound ? 0 : state.failed,
  };
}

/**
 * 结束一个任务。
 *
 * - 未知 id（或已经 end 过的 id）：state 原样返回，`finishedRound = false`；
 * - 本次 end 让 `pending` 变空 → `finishedRound = true`，返回的 state 里**保留本轮计数**，
 *   供调用方算标题；下一轮的第一个 `beginTask` 才会把它们清零。
 */
export function endTask(
  state: RoundState,
  id: string,
  ok: boolean,
): { state: RoundState; finishedRound: boolean } {
  if (!state.pending.has(id)) {
    return { state, finishedRound: false };
  }
  const pending = new Set(state.pending);
  pending.delete(id);
  const next: RoundState = {
    pending,
    succeeded: state.succeeded + (ok ? 1 : 0),
    failed: state.failed + (ok ? 0 : 1),
  };
  return { state: next, finishedRound: pending.size === 0 };
}

/**
 * 本轮结果的标题文案（CV-10 第 2 条，取自 `CV-画布核心.md` L326）。
 *
 * - 全成功 → `✅ 创作完成`
 * - 全失败 → `❌ 生成失败`
 * - 部分失败 → `⚠️ 2 项完成，1 项失败`
 *
 * `0 / 0` 不会被一轮调用到（一轮至少有一次 end），按 `failed === 0` 归到「全部成功」，
 * 这样函数对任意非负输入都有定义，不需要调用方先判断。
 */
export function completionTitle(succeeded: number, failed: number): string {
  if (failed === 0) return "✅ 创作完成";
  if (succeeded === 0) return "❌ 生成失败";
  return `⚠️ ${succeeded} 项完成，${failed} 项失败`;
}
