/**
 * X-40 一期：the client-side error catalogue — `code → category → user copy`.
 *
 * WHY ONE FILE
 * Before this, every caller that wanted to say something about a failure had to
 * know the code itself, and the ones that did not gave up and printed
 * 「生成失败，请重试。」 for everything. Adding a code to the server then produced
 * no new copy anywhere on the client. Here a code is one row, and the exact type
 * of `APP_ERROR_CATALOG` means adding a code to shared's enum makes `tsc` fail
 * here until the row exists — the catalogue cannot silently fall behind.
 *
 * THE FOUR CATEGORIES (X-40 §2, Kiro's ruling for this ticket):
 *   - `user_fixable` — the request asked for something it cannot have; the user
 *     can fix it by changing parameters, so the entry carries an `edit_params`
 *     action.
 *   - `quota` — the account has run out of the thing the request costs. BL-45
 *     owns the three-tier copy; this ticket only pins the category.
 *   - `policy` — an account-level restriction. There is nothing to retry and
 *     nothing to edit, so the action is `null`.
 *   - `service` — our side or the upstream is at fault; retrying later is the
 *     only move, so the entry carries `retry_later`.
 *
 * COPY RULES (from the ticket): short Chinese sentences, no jargon beyond
 * 「请重试」, and the wording lives here only — never inline at a call site, or
 * the next tweak will land in one of five places.
 *
 * ACTION LABELS (工单 30C): the two entry-point captions live in
 * `ERROR_ACTION_LABELS` below and nowhere else — a call site that writes
 * 「修改参数」 inline is how the catalogue and the buttons drift apart.
 *
 * STILL NOT IN THIS FILE: refund copy (「已退回 N 积分」) needs GN-35/BL-41.
 */
import type { ApplicationErrorCode } from "@loomic/shared";

import { JobFailed } from "./await-job";
import { ApiApplicationError } from "./server-api";

export type ErrorCategory = "user_fixable" | "service" | "quota" | "policy";

export type ErrorEntry = {
  category: ErrorCategory;
  message: string;
  action: "edit_params" | "retry_later" | "quota" | null;
};

/**
 * X-40 二期的入口按钮文案（工单 30C T2）。**只许从这里取**：调用处另写一份，
 * 下次改文案就会漏改按钮。`quota` / `policy` 没有可点的入口 —— 额度入口归
 * BL-45，账号级限制既不可重试也不可改参数，所以只有这两个键。
 */
export const ERROR_ACTION_LABELS = {
  edit_params: "修改参数",
  retry_later: "稍后重试",
} as const;

/**
 * 条目的 `action` → 按钮文案；没有对应入口时返回 `null`（只显示文案）。
 * 有文案也不代表一定有按钮：调用方没给回调时同样不显示（见 handler）。
 */
export function actionLabelOf(entry: ErrorEntry): string | null {
  if (entry.action === "edit_params") return ERROR_ACTION_LABELS.edit_params;
  if (entry.action === "retry_later") return ERROR_ACTION_LABELS.retry_later;
  return null;
}

// --- Entry builders (keeps the table one line per code) ---------------------

const service = (message: string): ErrorEntry => ({
  category: "service",
  message,
  action: "retry_later",
});

const fixable = (message: string): ErrorEntry => ({
  category: "user_fixable",
  message,
  action: "edit_params",
});

const quota = (message: string): ErrorEntry => ({
  category: "quota",
  message,
  action: "quota",
});

const policy = (message: string): ErrorEntry => ({
  category: "policy",
  message,
  action: null,
});

// --- Codes inside shared's applicationErrorCodeSchema -----------------------

/**
 * Exhaustive over `ApplicationErrorCode` on purpose: a code added to shared
 * without a row here is a compile error, not a generic toast at runtime.
 */
export const APP_ERROR_CATALOG: Record<ApplicationErrorCode, ErrorEntry> = {
  // quota
  // BL-45: the three refusal sentences are the spec's wording, verbatim. `N`
  // (the cap) is not repeated here — the server sends the full sentence in
  // `billing.error.message`, and `lib/billing-error-route.ts` prefers it for the
  // cap variant. "请稍后再试" was misleading for both cap codes: waiting does not
  // refill a personal cap or a team pool.
  insufficient_credits: quota("积分不足"),
  concurrency_limit: quota("同时进行中的任务已满，请等前面的完成后再试。"),
  personal_cap_reached: quota("本月额度已用完，可联系管理员调整"),
  team_pool_exhausted: quota("团队本月额度已用完"),
  adjust_exceeds_topup: quota("超出可减额度。"),

  // user_fixable — the user can change something and try again
  invalid_request: fixable("请求内容有误，请修改参数后重试。"),
  project_slug_taken: fixable("这个项目名已被占用，请换一个。"),
  resolution_not_allowed: fixable("当前模型不支持这个分辨率，请修改参数后重试。"),
  model_not_accessible: fixable("当前套餐不能使用这个模型，请更换模型。"),
  // Workorder 31B: the code lives in shared's enum now (the price table has no
  // row for the model), so it is an exhaustive-catalogue entry, not an EXTRA one.
  model_not_available: fixable("这个模型暂不可用，请更换模型。"),
  feature_disabled: fixable("这个功能暂未开放。"),
  model_not_allowed: fixable("当前不能使用这个模型，请更换模型。"),
  quote_mismatch: fixable("价格已经变化，请重新确认后再试。"),
  tool_disabled: fixable("这个工具暂不可用，请取消勾选后重试。"),

  // MD-03 / workorder 40B: the six models whose reference-image cap is
  // unverified declare `"unbounded"`, so nothing is blocked on the client and the
  // upstream's refusal is the only moment the cap shows. It is the user's
  // request that has to change, not a service problem: edit the images and retry.
  reference_image_limit: fixable("该模型参考图数量超限，请减少参考图后重试。"),

  // policy — account-level, so there is nothing to retry
  account_suspended: policy("账号已被暂停，无法继续生成。"),

  // service — everything else: our side or upstream, retry later
  application_error: service("服务出现异常，请稍后重试。"),
  bootstrap_failed: service("页面初始化失败，请刷新后重试。"),
  brand_kit_not_found: service("品牌资料不存在或已被删除。"),
  brand_kit_create_failed: service("品牌资料创建失败，请稍后重试。"),
  brand_kit_update_failed: service("品牌资料更新失败，请稍后重试。"),
  brand_kit_delete_failed: service("品牌资料删除失败，请稍后重试。"),
  brand_kit_query_failed: service("品牌资料读取失败，请稍后重试。"),
  brand_kit_asset_not_found: service("品牌素材不存在或已被删除。"),
  brand_kit_asset_create_failed: service("品牌素材保存失败，请稍后重试。"),
  canvas_not_found: service("画布不存在或已被删除。"),
  canvas_save_failed: service("画布保存失败，请稍后重试。"),
  chat_error: service("对话暂时不可用，请稍后重试。"),
  profile_update_failed: service("个人资料更新失败，请稍后重试。"),
  project_query_failed: service("项目列表读取失败，请稍后重试。"),
  project_create_failed: service("项目创建失败，请稍后重试。"),
  project_delete_failed: service("项目删除失败，请稍后重试。"),
  project_not_found: service("项目不存在或已被删除。"),
  project_update_failed: service("项目更新失败，请稍后重试。"),
  session_not_found: service("会话不存在或已被删除。"),
  settings_not_found: service("设置还没有生成，请刷新后重试。"),
  settings_read_failed: service("设置读取失败，请稍后重试。"),
  settings_update_failed: service("设置更新失败，请稍后重试。"),
  upload_failed: service("文件上传失败，请稍后重试。"),
  asset_not_found: service("素材不存在或已被删除。"),
  job_not_found: service("任务不存在或已被删除。"),
  job_create_failed: service("任务提交失败，请稍后重试。"),
  job_query_failed: service("任务状态读取失败，请稍后重试。"),
  job_cancel_failed: service("取消任务失败，请稍后重试。"),
  skill_not_found: service("技能不存在或已被删除。"),
  skill_create_failed: service("技能创建失败，请稍后重试。"),
  skill_update_failed: service("技能更新失败，请稍后重试。"),
  skill_delete_failed: service("技能删除失败，请稍后重试。"),
  skill_query_failed: service("技能读取失败，请稍后重试。"),
  skill_install_failed: service("技能安装失败，请稍后重试。"),
  skill_uninstall_failed: service("技能卸载失败，请稍后重试。"),
  skill_toggle_failed: service("技能开关失败，请稍后重试。"),
  skill_import_failed: service("技能导入失败，请稍后重试。"),
  skill_file_query_failed: service("技能文件读取失败，请稍后重试。"),
  marketplace_search_failed: service("模板市场搜索失败，请稍后重试。"),
  marketplace_detail_failed: service("模板详情读取失败，请稍后重试。"),
  marketplace_install_failed: service("模板安装失败，请稍后重试。"),
  provider_not_configured: service("生成服务还没有配置，请稍后重试。"),
  service_unavailable: service("服务暂时不可用，请稍后重试。"),
  credit_query_failed: service("积分读取失败，请稍后重试。"),
  credit_claim_failed: service("积分发放失败，请稍后重试。"),
  credit_deduct_failed: service("积分扣除失败，请稍后重试。"),
  credit_refund_failed: service("积分退回失败，请稍后重试。"),
  credit_plan_update_failed: service("积分方案更新失败，请稍后重试。"),
  variant_not_found: service("这个版本不存在或已被删除。"),
  checkout_failed: service("支付发起失败，请稍后重试。"),
  payment_not_configured: service("支付服务还没有配置，请稍后重试。"),
  subscription_not_found: service("没有找到当前工作区的订阅。"),
  subscription_update_failed: service("订阅更新失败，请稍后重试。"),
  webhook_processing_failed: service("支付回调处理失败，请稍后重试。"),
  generation_failed: service("生成没有完成，请重试。"),
  not_team_member: service("当前账号不在团队里，请确认后再试。"),
  forbidden: service("没有权限执行这个操作。"),
  user_not_found: service("找不到这个成员，请确认邮箱后再试。"),
  timeout: service("生成超时，请重试。"),
  upstream_busy: service("模型服务繁忙，请稍后重试。"),
  canvas_unavailable: service("画布暂时不可用，请稍后重试。"),
};

// --- Codes outside shared's enum -------------------------------------------

/**
 * Now empty: every code the catalogue knows lives in shared's
 * `applicationErrorCodeSchema`, so `APP_ERROR_CATALOG` is the only home.
 * If the frontend ever needs a code before shared's enum grows it, it goes
 * here temporarily — and moves into `APP_ERROR_CATALOG` once the enum catches up.
 */
export const EXTRA_ERROR_CATALOG: Record<string, ErrorEntry> = {};

/** Unknown codes are our fault, not the user's: service + retry later. */
const UNKNOWN_ERROR_ENTRY: ErrorEntry = service("生成失败，请稍后重试。");

/**
 * Looks up a code, falling back to `service` for anything unrecognised —
 * including `undefined`, which is what a thrown non-API error gives us.
 */
export function lookupError(code: string | undefined): ErrorEntry {
  if (!code) return UNKNOWN_ERROR_ENTRY;

  const appEntry = (APP_ERROR_CATALOG as Record<string, ErrorEntry | undefined>)[
    code
  ];
  if (appEntry) return appEntry;

  const extraEntry = EXTRA_ERROR_CATALOG[code];
  if (extraEntry) return extraEntry;

  return UNKNOWN_ERROR_ENTRY;
}

/**
 * The code behind a thrown value, for callers that only have `catch (err)`.
 * `JobFailed` carries the job's `error_code`; before this it was dropped and
 * `timeout` / `upstream_busy` both came out as the generic line.
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (error instanceof ApiApplicationError) return error.code;
  if (error instanceof JobFailed) return error.code || undefined;
  return undefined;
}
