// @credits-system — AD-08 §3: the admin panel that adds a member by e-mail,
// switches a role between member / admin and removes a member. Removing hands
// that member's projects to the admin who did it, so the panel reports the
// counts the server sends back.
"use client";

import { useCallback, useEffect, useState } from "react";

import type { TeamMember } from "@loomic/shared";

import {
  addTeamMember,
  fetchTeamMembers,
  removeTeamMember,
  setTeamMemberRole,
} from "@/lib/admin-credits-api";
import { errorCodeOf, lookupError } from "@/lib/error-catalog";

export type TeamMemberAdminProps = {
  /** The admin's own access token; every route behind this panel refuses a non-admin. */
  accessToken: string;
  /**
   * AD-08: no one may demote or remove themselves, and the owner keeps its role,
   * so those two rows render read-only. A provider that has no `user` yet leaves
   * this undefined, which simply hides no row.
   */
  currentUserId?: string | null;
};

/** The only two roles that travel on the wire. */
type AssignableRole = "member" | "admin";

const ROLE_LABELS: Record<TeamMember["role"], string> = {
  owner: "拥有者",
  admin: "管理员",
  member: "成员",
};

function messageOf(error: unknown): string {
  return lookupError(errorCodeOf(error)).message;
}

function assignableRoleOf(role: TeamMember["role"]): AssignableRole {
  return role === "admin" ? "admin" : "member";
}

/** The wire value is an ISO timestamp; the table only needs the calendar day. */
function joinedDayOf(joinedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(joinedAt) ? joinedAt.slice(0, 10) : joinedAt;
}

export function TeamMemberAdmin({
  accessToken,
  currentUserId,
}: TeamMemberAdminProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  // AD-08 §2: join by e-mail, `member` unless the admin picks otherwise.
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<AssignableRole>("member");
  const [adding, setAdding] = useState(false);

  // AD-08 §3: removing asks once before it calls the server.
  const [removingFor, setRemovingFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // One error line and one notice line for the whole panel.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const list = await fetchTeamMembers(accessToken);
      setMembers(Array.isArray(list) ? list : []);
    } catch (err) {
      setLoadFailed(true);
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── AD-08 §2: join by e-mail ──────────────────────────────

  const addTarget = addEmail.trim();
  const canAdd = addTarget.length > 0 && !adding;

  const handleAdd = async () => {
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const result = await addTeamMember(accessToken, {
        email: addTarget,
        role: addRole,
      });
      if (result.added) {
        setAddEmail("");
      } else {
        // A 200 that did not add anybody: the address is already in the team.
        setNotice("该成员已在团队中");
      }
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setAdding(false);
    }
  };

  // ── AD-08 §3: change one member's role ────────────────────

  const handleRoleChange = async (
    member: TeamMember,
    nextRole: AssignableRole,
  ) => {
    const previousRole = member.role;
    setError(null);
    setNotice(null);
    // Optimistic: the select already shows the new role, so put it in the row.
    setMembers((prev) =>
      prev.map((row) =>
        row.userId === member.userId ? { ...row, role: nextRole } : row,
      ),
    );
    try {
      await setTeamMemberRole(accessToken, member.userId, nextRole);
    } catch (err) {
      // Roll the row back: the server refused, so the old role still holds.
      setMembers((prev) =>
        prev.map((row) =>
          row.userId === member.userId
            ? { ...row, role: previousRole }
            : row,
        ),
      );
      setError(messageOf(err));
    }
  };

  // ── AD-08 §3: remove one member ───────────────────────────

  const handleRemoveConfirm = async (member: TeamMember) => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await removeTeamMember(accessToken, member.userId);
      setMembers((prev) => prev.filter((row) => row.userId !== member.userId));
      setRemovingFor(null);
      setNotice(
        `已移出，转移项目 ${result.transferred.projects} 个、素材 ${result.transferred.assets} 个`,
      );
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRemoving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────

  return (
    <div data-testid="credits-member-admin" className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">成员管理</h3>
      <p className="text-xs text-muted-foreground">
        按邮箱把人加进团队，改角色（管理员 / 成员），或把成员移出；移出后其项目转给你
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          成员邮箱
          <input
            data-testid="credits-member-add-email"
            type="email"
            value={addEmail}
            onChange={(event) => setAddEmail(event.target.value)}
            placeholder="member@example.com"
            className="w-64 rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          角色
          <select
            data-testid="credits-member-add-role"
            value={addRole}
            onChange={(event) =>
              setAddRole(event.target.value === "admin" ? "admin" : "member")
            }
            className="rounded-md border px-2 py-1 text-sm"
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button
          data-testid="credits-member-add-submit"
          type="button"
          onClick={() => void handleAdd()}
          disabled={!canAdd}
          className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
        >
          {adding ? "加入中..." : "加入"}
        </button>
      </div>

      {error ? (
        <p data-testid="credits-member-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p data-testid="credits-member-notice" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}

      {!loading && loadFailed ? (
        <p className="text-sm text-destructive">成员列表加载失败</p>
      ) : null}

      {!loading && !loadFailed ? (
        <div className="overflow-hidden rounded-lg border">
          <table data-testid="credits-member-table" className="w-full text-sm">
            <thead>
              <tr className="border-b bg-secondary text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">成员</th>
                <th className="px-4 py-2.5">角色</th>
                <th className="px-4 py-2.5">加入时间</th>
                <th className="px-4 py-2.5">操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const isSelf = currentUserId === member.userId;
                // The owner's role is fixed and nobody edits their own row.
                const readOnly = member.role === "owner" || isSelf;
                const isConfirming = removingFor === member.userId;
                return (
                  <tr
                    key={member.userId}
                    data-testid={`credits-member-row-${member.userId}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {member.displayName ?? member.email}
                        </span>
                        {member.displayName ? (
                          <span className="text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      {readOnly ? (
                        <span
                          data-testid={`credits-member-role-readonly-${member.userId}`}
                          className="text-sm"
                        >
                          {ROLE_LABELS[member.role]}
                        </span>
                      ) : (
                        <select
                          data-testid={`credits-member-role-${member.userId}`}
                          value={assignableRoleOf(member.role)}
                          onChange={(event) =>
                            void handleRoleChange(
                              member,
                              event.target.value === "admin" ? "admin" : "member",
                            )
                          }
                          aria-label={`角色（${member.displayName ?? member.email}）`}
                          className="rounded-md border px-2 py-1 text-sm"
                        >
                          <option value="member">成员</option>
                          <option value="admin">管理员</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top tabular-nums">
                      {joinedDayOf(member.joinedAt)}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      {readOnly ? null : isConfirming ? (
                        <div
                          data-testid={`credits-member-remove-confirm-${member.userId}`}
                          className="flex flex-col gap-2 rounded-md border border-dashed p-2"
                        >
                          <p className="text-xs text-destructive">
                            移出后该成员无法再使用，其项目将转给你。确认移出？
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              data-testid={`credits-member-remove-ok-${member.userId}`}
                              type="button"
                              onClick={() => void handleRemoveConfirm(member)}
                              disabled={removing}
                              className="rounded-md border px-3 py-1 text-xs text-destructive transition-colors hover:bg-secondary disabled:opacity-50"
                            >
                              确认移出
                            </button>
                            <button
                              data-testid={`credits-member-remove-cancel-${member.userId}`}
                              type="button"
                              onClick={() => setRemovingFor(null)}
                              className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          data-testid={`credits-member-remove-${member.userId}`}
                          type="button"
                          onClick={() => {
                            setRemovingFor(member.userId);
                            setError(null);
                            setNotice(null);
                          }}
                          className="rounded-md border px-3 py-1 text-xs transition-colors hover:bg-secondary"
                        >
                          移出
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-sm text-muted-foreground" colSpan={4}>
                    团队还没有成员。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
