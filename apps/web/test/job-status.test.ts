import { backgroundJobStatusSchema } from "@loomic/shared";
import { describe, expect, it } from "vitest";

import {
  LEGACY_JOB_STATUS,
  TERMINAL_JOB_STATUSES,
  formatRetryLabel,
  isTerminalJobStatus,
  normalizeJobStatus,
} from "../src/lib/job-status";

/** 服务端枚举的全集：GN-30 的六个对外状态 + legacy 的 dead_letter */
const ALL_STATUSES: readonly string[] = backgroundJobStatusSchema.options;
const TERMINAL: readonly string[] = TERMINAL_JOB_STATUSES;

describe("TERMINAL_JOB_STATUSES", () => {
  it("恰好 3 个元素：succeeded / failed / canceled（retrying 不在里面）", () => {
    expect(TERMINAL_JOB_STATUSES).toHaveLength(3);
    expect(TERMINAL_JOB_STATUSES).toEqual(["succeeded", "failed", "canceled"]);
    expect(TERMINAL).not.toContain("retrying");
    expect(TERMINAL).not.toContain("dead_letter");
  });

  it("GN-30 契约：backgroundJobStatusSchema 的每个值都能归类为 终态 / 非终态 / legacy，没有漏项", () => {
    const terminal = ALL_STATUSES.filter((s) => TERMINAL.includes(s));
    // 显式标 string[]：否则 filter 会把类型窄化成 "dead_letter"[]，下面 includes 用不了
    const legacy: string[] = ALL_STATUSES.filter((s) => s === LEGACY_JOB_STATUS);
    const nonTerminal = ALL_STATUSES.filter(
      (s) => !TERMINAL.includes(s) && s !== LEGACY_JOB_STATUS,
    );

    // 三类各自的内容是钉死的：枚举里多一个值而这里没归类，下面就会红
    expect(terminal).toEqual(["succeeded", "failed", "canceled"]);
    expect(legacy).toEqual(["dead_letter"]);
    expect(nonTerminal).toEqual(["queued", "running", "retrying"]);

    // 没有漏项：三类相加正好等于枚举全集，且每个值只落进一类
    expect(terminal.length + legacy.length + nonTerminal.length).toBe(
      ALL_STATUSES.length,
    );
    for (const status of ALL_STATUSES) {
      const buckets = [
        terminal.includes(status),
        legacy.includes(status),
        nonTerminal.includes(status),
      ].filter(Boolean);
      expect(buckets, `状态 ${status} 的归类不唯一`).toHaveLength(1);
    }
  });
});

describe("normalizeJobStatus", () => {
  it("legacy 的 dead_letter 归一成 failed", () => {
    expect(normalizeJobStatus("dead_letter")).toBe("failed");
  });

  it("其余状态原样返回（含 retrying，不能被归一掉）", () => {
    for (const status of ["queued", "running", "retrying", "succeeded", "failed", "canceled"]) {
      expect(normalizeJobStatus(status)).toBe(status);
    }
  });
});

describe("isTerminalJobStatus", () => {
  it("终态三个返回 true", () => {
    for (const status of TERMINAL_JOB_STATUSES) {
      expect(isTerminalJobStatus(status)).toBe(true);
    }
  });

  it("queued / running / retrying 都是非终态（retrying 不停止等待）", () => {
    for (const status of ["queued", "running", "retrying"]) {
      expect(isTerminalJobStatus(status)).toBe(false);
    }
  });

  it("legacy 的 dead_letter 归一后算终态，不会让等待方一直转", () => {
    expect(isTerminalJobStatus("dead_letter")).toBe(true);
    expect(normalizeJobStatus("dead_letter")).toBe("failed");
  });
});

describe("formatRetryLabel", () => {
  it("两次尝试、上限三次 → 「重试中（2/3）」", () => {
    expect(formatRetryLabel(2, 3)).toBe("重试中（2/3）");
  });

  it("缺 maxAttempts 时只说「重试中」，不编造分母", () => {
    expect(formatRetryLabel(2, undefined)).toBe("重试中");
    expect(formatRetryLabel(2, null)).toBe("重试中");
    expect(formatRetryLabel(undefined, 3)).toBe("重试中");
  });
});
