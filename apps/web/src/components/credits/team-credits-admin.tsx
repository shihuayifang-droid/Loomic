// @credits-system — AD-01 / BL-12 / BL-01: the admin panel that shows every
// member's credit numbers and lets an owner change caps, adjust credits and
// apply cap templates.
"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import type { CreditCapTemplate, MemberCreditSummary } from "@loomic/shared";

import {
  adjustMemberTopup,
  applyCapTemplate,
  createCapTemplate,
  fetchCapTemplates,
  fetchMemberCredits,
  setMemberCap,
  setMemberGenerationPaused,
} from "@/lib/admin-credits-api";
import { useAuth } from "@/lib/auth-context";

// ── Types ────────────────────────────────────────────────────

export type TeamCreditsMemberName = {
  displayName: string | null;
  email: string;
};

export type TeamCreditsAdminProps = {
  /**
   * AD-01: the names/e-mails come from the existing member list endpoint, so the
   * credits panel asks for them instead of fetching the same rows twice. A
   * member missing from the map falls back to its `userId`.
   */
  memberNames?: Record<string, TeamCreditsMemberName>;
};

// ── Helpers ──────────────────────────────────────────────────

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "请求失败";
}

/** A whole, non-negative number typed by hand — anything else cannot be a cap. */
function parseCapInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A whole, non-zero delta — the server refuses 0 and fractions anyway. */
function parseDeltaInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (parsed === 0) return null;
  return parsed;
}

// ── Main component ───────────────────────────────────────────

export function TeamCreditsAdmin(props: TeamCreditsAdminProps) {
  const { session } = useAuth();
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;

  const [members, setMembers] = useState<MemberCreditSummary[]>([]);
  const [templates, setTemplates] = useState<CreditCapTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // Per-row cap editing
  const [capEditingFor, setCapEditingFor] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState("");
  const [capError, setCapError] = useState<string | null>(null);

  // Per-row adjustment form
  const [adjustFor, setAdjustFor] = useState<string | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);

  // BL-01 selection + template creation
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [templateName, setTemplateName] = useState("");
  const [templateCap, setTemplateCap] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  // AD-01 / BL-21: pause / resume one member's generation
  const [pauseFor, setPauseFor] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState("");
  const [pauseErrorFor, setPauseErrorFor] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);

  const reloadMembers = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    const list = await fetchMemberCredits(token);
    setMembers(Array.isArray(list) ? list : []);
  }, []);

  const load = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [memberList, templateList] = await Promise.all([
        fetchMemberCredits(token),
        fetchCapTemplates(token),
      ]);
      setMembers(Array.isArray(memberList) ? memberList : []);
      setTemplates(Array.isArray(templateList) ? templateList : []);
    } catch {
      // BL-01 / AD-01: an `ApiAuthError` lands here too — the panel cannot show
      // anything useful without the two lists, so both read as 加载失败.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── AD-01 / BL-01: one member's monthly personal cap ──────

  const handleSaveCap = async (userId: string) => {
    const token = accessTokenRef.current;
    const cap = parseCapInput(capDraft);
    if (!token || cap === null) return;
    setCapError(null);
    try {
      const saved = await setMemberCap(token, userId, cap);
      setMembers((prev) =>
        prev.map((member) =>
          member.userId === userId ? { ...member, personalCap: saved } : member,
        ),
      );
      setCapEditingFor(null);
      setCapDraft("");
    } catch (error) {
      setCapEditingFor(userId);
      setCapError(messageOf(error));
    }
  };

  // ── BL-12: add / subtract credits with a mandatory reason ─

  const deltaValue = parseDeltaInput(adjustDelta);
  const adjustSubmittable =
    deltaValue !== null && adjustReason.trim().length > 0 && !adjusting;

  const handleAdjustSubmit = async (userId: string) => {
    const token = accessTokenRef.current;
    if (!token || deltaValue === null || adjustReason.trim().length === 0) return;
    setAdjusting(true);
    setAdjustError(null);
    try {
      await adjustMemberTopup(token, userId, {
        delta: deltaValue,
        reason: adjustReason.trim(),
      });
      setAdjustFor(null);
      setAdjustDelta("");
      setAdjustReason("");
      await reloadMembers();
    } catch (error) {
      setAdjustError(messageOf(error));
    } finally {
      setAdjusting(false);
    }
  };

  // ── AD-01 / BL-21: pause / resume a member's generation ──

  const handlePauseSubmit = async (userId: string) => {
    const token = accessTokenRef.current;
    const reason = pauseReason.trim();
    if (!token || reason.length === 0 || pausing) return;
    setPausing(true);
    setPauseError(null);
    setPauseErrorFor(null);
    try {
      await setMemberGenerationPaused(token, userId, { paused: true, reason });
      setPauseFor(null);
      setPauseReason("");
      await reloadMembers();
    } catch (error) {
      // The server's own words, e.g. 暂停需要填写原因.
      setPauseErrorFor(userId);
      setPauseError(messageOf(error));
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async (userId: string) => {
    const token = accessTokenRef.current;
    if (!token || pausing) return;
    setPausing(true);
    setPauseError(null);
    setPauseErrorFor(null);
    try {
      await setMemberGenerationPaused(token, userId, { paused: false });
      setPauseFor(null);
      setPauseReason("");
      await reloadMembers();
    } catch (error) {
      setPauseErrorFor(userId);
      setPauseError(messageOf(error));
    } finally {
      setPausing(false);
    }
  };

  // ── BL-01: cap templates ──────────────────────────────────

  const templateCapValue = parseCapInput(templateCap);
  const canCreateTemplate =
    templateName.trim().length > 0 && templateCapValue !== null;

  const handleCreateTemplate = async () => {
    const token = accessTokenRef.current;
    if (!token || templateCapValue === null || templateName.trim().length === 0) return;
    setTemplateError(null);
    try {
      const created = await createCapTemplate(token, {
        name: templateName.trim(),
        cap: templateCapValue,
      });
      setTemplates((prev) => [...prev, created]);
      setTemplateName("");
      setTemplateCap("");
    } catch (error) {
      // The server's own words, e.g. 已有同名模板 on a 409.
      setTemplateError(messageOf(error));
    }
  };

  const handleApplyTemplate = async (templateId: string) => {
    const token = accessTokenRef.current;
    if (!token || selectedIds.size === 0) return;
    setTemplateError(null);
    try {
      const applied = await applyCapTemplate(token, templateId, [...selectedIds]);
      setAppliedCount(applied);
      await reloadMembers();
    } catch (error) {
      setTemplateError(messageOf(error));
    }
  };

  const toggleSelected = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────

  if (loading) {
    return <p className="py-8 text-sm text-muted-foreground">加载中…</p>;
  }

  if (loadFailed) {
    return (
      <div className="flex flex-col items-start gap-3 py-8">
        <p className="text-sm text-destructive">加载失败</p>
        <button
          data-testid="credits-admin-retry"
          type="button"
          onClick={() => void load()}
          className="rounded-lg border px-4 py-2 text-sm transition-colors hover:bg-secondary"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">团队成员额度</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          查看每个成员的本月个人上限、团队池用量、充值余额与今日赠送剩余。
        </p>
      </div>

      {/* AD-01: the member table */}
      <div className="overflow-hidden rounded-lg border">
        <table data-testid="credits-admin-table" className="w-full text-sm">
          <thead>
            <tr className="border-b bg-secondary text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-2.5">
                <span className="sr-only">选择</span>
              </th>
              <th className="px-4 py-2.5">成员</th>
              <th className="px-4 py-2.5 text-right">本月个人上限</th>
              <th className="px-4 py-2.5 text-right">本月已用（团队池）</th>
              <th className="px-4 py-2.5 text-right">充值余额</th>
              <th className="px-4 py-2.5 text-right">今日赠送剩余</th>
              <th className="px-4 py-2.5">操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const named = props.memberNames?.[member.userId];
              const isEditingCap = capEditingFor === member.userId;
              const capDraftValue = parseCapInput(capDraft);
              const isAdjusting = adjustFor === member.userId;
              // AD-01 / BL-21: the schema writes this key only when it is true.
              const isPaused = member.generationPaused === true;
              const isPausing = pauseFor === member.userId;
              return (
                <Fragment key={member.userId}>
                  <tr
                    data-testid={`credits-admin-row-${member.userId}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-3 py-2.5 align-top">
                      <input
                        data-testid={`credits-admin-select-${member.userId}`}
                        type="checkbox"
                        checked={selectedIds.has(member.userId)}
                        onChange={() => toggleSelected(member.userId)}
                        aria-label={`选择成员 ${named?.displayName ?? named?.email ?? member.userId}`}
                      />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex flex-col gap-1">
                        {named ? (
                          <div className="flex flex-col">
                            <span className="font-medium text-foreground">
                              {named.displayName ?? named.email}
                            </span>
                            {named.displayName ? (
                              <span className="text-xs text-muted-foreground">
                                {named.email}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="font-medium text-foreground">
                            {member.userId}
                          </span>
                        )}
                        {isPaused ? (
                          <span
                            data-testid={`credits-admin-paused-${member.userId}`}
                            className="w-fit rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                          >
                            已暂停生成
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(member.personalCap)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(member.teamUsed)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(member.topup)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatNumber(member.dailyRemaining)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {isEditingCap ? (
                          <>
                            <input
                              data-testid={`credits-admin-cap-input-${member.userId}`}
                              type="number"
                              min={0}
                              step={1}
                              value={capDraft}
                              onChange={(event) => setCapDraft(event.target.value)}
                              aria-label={`本月个人上限（${named?.displayName ?? named?.email ?? member.userId}）`}
                              className="w-28 rounded-md border px-2 py-1 text-sm tabular-nums"
                            />
                            <button
                              data-testid={`credits-admin-cap-save-${member.userId}`}
                              type="button"
                              onClick={() => void handleSaveCap(member.userId)}
                              disabled={capDraftValue === null}
                              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                            >
                              保存
                            </button>
                          </>
                        ) : (
                          <button
                            data-testid={`credits-admin-cap-edit-${member.userId}`}
                            type="button"
                            onClick={() => {
                              setCapEditingFor(member.userId);
                              setCapDraft(String(member.personalCap));
                              setCapError(null);
                            }}
                            className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
                          >
                            改上限
                          </button>
                        )}
                        <button
                          data-testid={`credits-admin-adjust-open-${member.userId}`}
                          type="button"
                          onClick={() => {
                            setAdjustFor(isAdjusting ? null : member.userId);
                            setAdjustDelta("");
                            setAdjustReason("");
                            setAdjustError(null);
                          }}
                          className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
                        >
                          调积分
                        </button>
                        {isPaused ? (
                          <button
                            data-testid={`credits-admin-resume-${member.userId}`}
                            type="button"
                            onClick={() => void handleResume(member.userId)}
                            disabled={pausing}
                            aria-label={`恢复 ${named?.displayName ?? named?.email ?? member.userId} 的生成`}
                            className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                          >
                            恢复生成
                          </button>
                        ) : isPausing ? (
                          <>
                            <input
                              data-testid={`credits-admin-pause-reason-${member.userId}`}
                              type="text"
                              value={pauseReason}
                              onChange={(event) => setPauseReason(event.target.value)}
                              aria-label={`暂停原因（${named?.displayName ?? named?.email ?? member.userId}）`}
                              className="w-56 rounded-md border px-2 py-1 text-sm"
                            />
                            <button
                              data-testid={`credits-admin-pause-submit-${member.userId}`}
                              type="button"
                              onClick={() => void handlePauseSubmit(member.userId)}
                              disabled={pauseReason.trim().length === 0 || pausing}
                              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                            >
                              确认暂停
                            </button>
                          </>
                        ) : (
                          <button
                            data-testid={`credits-admin-pause-open-${member.userId}`}
                            type="button"
                            onClick={() => {
                              setPauseFor(member.userId);
                              setPauseReason("");
                              setPauseError(null);
                              setPauseErrorFor(null);
                            }}
                            className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
                          >
                            暂停生成
                          </button>
                        )}
                      </div>
                      {pauseErrorFor === member.userId && pauseError ? (
                        <p
                          data-testid={`credits-admin-pause-error-${member.userId}`}
                          className="mt-1 text-xs text-destructive"
                        >
                          {pauseError}
                        </p>
                      ) : null}
                      {isEditingCap && capError ? (
                        <p
                          data-testid={`credits-admin-cap-error-${member.userId}`}
                          className="mt-1 text-xs text-destructive"
                        >
                          {capError}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                  {isAdjusting ? (
                    <tr className="border-b bg-secondary/40 last:border-b-0">
                      <td className="px-3 py-3" colSpan={7}>
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                              数额（可负）
                              <input
                                data-testid={`credits-admin-adjust-delta-${member.userId}`}
                                type="number"
                                step={1}
                                value={adjustDelta}
                                onChange={(event) => setAdjustDelta(event.target.value)}
                                className="w-28 rounded-md border px-2 py-1 text-sm tabular-nums"
                              />
                            </label>
                            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                              原因（必填）
                              <input
                                data-testid={`credits-admin-adjust-reason-${member.userId}`}
                                type="text"
                                value={adjustReason}
                                onChange={(event) => setAdjustReason(event.target.value)}
                                className="w-56 rounded-md border px-2 py-1 text-sm"
                              />
                            </label>
                            <button
                              data-testid={`credits-admin-adjust-submit-${member.userId}`}
                              type="button"
                              onClick={() => void handleAdjustSubmit(member.userId)}
                              disabled={!adjustSubmittable}
                              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                            >
                              确定
                            </button>
                          </div>
                          {adjustError ? (
                            <p
                              data-testid={`credits-admin-adjust-error-${member.userId}`}
                              className="text-xs text-destructive"
                            >
                              {adjustError}
                            </p>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* BL-01: cap templates */}
      <div data-testid="credits-admin-templates" className="space-y-3 rounded-lg border p-4">
        <h3 className="text-sm font-semibold">额度模板</h3>
        <ul className="space-y-1 text-sm">
          {templates.map((template) => (
            <li
              key={template.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="tabular-nums">
                {template.name} · {formatNumber(template.cap)}
              </span>
              <button
                data-testid={`credits-admin-template-apply-${template.id}`}
                type="button"
                onClick={() => void handleApplyTemplate(template.id)}
                disabled={selectedIds.size === 0}
                aria-label={`套用模板 ${template.name} 到所选成员`}
                className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
              >
                套用到所选成员
              </button>
            </li>
          ))}
          {templates.length === 0 ? (
            <li className="text-sm text-muted-foreground">还没有模板。</li>
          ) : null}
        </ul>

        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            模板名称
            <input
              data-testid="credits-admin-template-name"
              type="text"
              value={templateName}
              onChange={(event) => setTemplateName(event.target.value)}
              className="w-48 rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            上限
            <input
              data-testid="credits-admin-template-cap"
              type="number"
              min={0}
              step={1}
              value={templateCap}
              onChange={(event) => setTemplateCap(event.target.value)}
              className="w-28 rounded-md border px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <button
            data-testid="credits-admin-template-create"
            type="button"
            onClick={() => void handleCreateTemplate()}
            disabled={!canCreateTemplate}
            className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
          >
            新建模板
          </button>
        </div>

        {templateError ? (
          <p data-testid="credits-admin-template-error" className="text-xs text-destructive">
            {templateError}
          </p>
        ) : null}

        {appliedCount !== null ? (
          <p data-testid="credits-admin-template-applied" className="text-xs text-muted-foreground">
            {appliedCount === 0
              ? "已套用 0 人（单独改过上限的成员不会被模板覆盖）"
              : `已套用 ${appliedCount} 人`}
          </p>
        ) : null}
      </div>
    </div>
  );
}
