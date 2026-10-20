import { describe, expect, it } from "vitest";

import {
  planZipDownload,
  ZIP_MAX_BYTES,
  ZIP_MAX_ITEMS,
  type ZipDownloadItem,
  type ZipDownloadPlan,
} from "./zip-download-plan.js";

/**
 * 工单34F · T2 —— `planZipDownload` 的单元用例（纯函数，不连数据库、不碰存储）。
 *
 * 钉的是 ED-05 里「不用真的打一个 zip 就能判定」的那些规则：谁能进包、进多少、
 * 包内重名怎么变、压缩包叫什么。真的取字节 / 写 zip 流不在这一层。
 */

/** 生成文件名用的固定时间点：UTC 16:05 = 上海次日 00:05。 */
const AT = new Date("2026-10-20T16:05:00Z");

function ready(id: string, name: string, byteSize: number | null = null): ZipDownloadItem {
  return { id, name, byteSize, status: "ready" };
}

function notReady(
  id: string,
  name: string,
  status: "generating" | "failed",
): ZipDownloadItem {
  return { id, name, byteSize: null, status };
}

/** 断言是 ok 计划并返回它（失败时把原因带进报错，方便看是哪条规则先拒的）。 */
function expectOk(plan: ZipDownloadPlan): Extract<ZipDownloadPlan, { ok: true }> {
  if (!plan.ok) {
    throw new Error(`expected an ok plan, got rejection: ${plan.reason} (${plan.message})`);
  }
  return plan;
}

/** 断言是拒绝计划并返回它。 */
function expectRejected(plan: ZipDownloadPlan): Extract<ZipDownloadPlan, { ok: false }> {
  if (plan.ok) {
    throw new Error(`expected a rejection, got ok plan: ${plan.fileName}`);
  }
  return plan;
}

describe("planZipDownload", () => {
  it("ED-05: three ready images make a plan with their names", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "a.png"), ready("p2", "b.png"), ready("p3", "c.png")],
      }),
    );

    expect(plan.entries).toEqual([
      { id: "p1", entryName: "a.png" },
      { id: "p2", entryName: "b.png" },
      { id: "p3", entryName: "c.png" },
    ]);
    expect(plan.skipped).toBe(0);
    expect(plan.skippedMessage).toBeNull();
  });

  it("ED-05: duplicate names get (2), (3) before the extension", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [
          ready("p1", "a.png"),
          ready("p2", "a.png"),
          ready("p3", "a.png"),
          ready("p4", "a"),
          ready("p5", "a"),
        ],
      }),
    );

    expect(plan.entries.map((entry) => entry.entryName)).toEqual([
      "a.png",
      "a (2).png",
      "a (3).png",
      "a",
      "a (2)",
    ]);
  });

  it("ED-05: duplicate names without an extension get (2) too", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "README"), ready("p2", "README")],
      }),
    );

    expect(plan.entries.map((entry) => entry.entryName)).toEqual(["README", "README (2)"]);
  });

  it("ED-05: a name that already looks suffixed still gets the next free number", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "a.png"), ready("p2", "a (2).png"), ready("p3", "a.png")],
      }),
    );

    expect(plan.entries.map((entry) => entry.entryName)).toEqual([
      "a.png",
      "a (2).png",
      "a (3).png",
    ]);
  });

  it("ED-05: generating and failed items are skipped and counted", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [
          ready("p1", "a.png"),
          notReady("p2", "b.png", "generating"),
          ready("p3", "c.png"),
          notReady("p4", "d.png", "failed"),
        ],
      }),
    );

    expect(plan.entries).toEqual([
      { id: "p1", entryName: "a.png" },
      { id: "p3", entryName: "c.png" },
    ]);
    expect(plan.skipped).toBe(2);
    expect(plan.skippedMessage).toBe("已跳过 2 个未完成对象");
  });

  it("ED-05: the limits are the spec's 50 items and 500MB", () => {
    expect(ZIP_MAX_ITEMS).toBe(50);
    expect(ZIP_MAX_BYTES).toBe(500 * 1024 * 1024);
  });

  it("ED-05: 51 ready items is too many", () => {
    const items = Array.from({ length: 51 }, (_unused, index) =>
      ready(`p${index}`, `a-${index}.png`, 1),
    );

    const plan = expectRejected(planZipDownload({ projectName: "角色设定", now: AT, items }));

    expect(plan.reason).toBe("too_many");
    expect(plan.message).toBe("选中过多，请分批下载");
  });

  it("ED-05: exactly 50 is allowed", () => {
    const items = Array.from({ length: 50 }, (_unused, index) =>
      ready(`p${index}`, `a-${index}.png`, 1),
    );

    const plan = expectOk(planZipDownload({ projectName: "角色设定", now: AT, items }));

    expect(plan.entries).toHaveLength(50);
    expect(plan.skipped).toBe(0);
  });

  it("ED-05: over 500MB in total is too large", () => {
    const plan = expectRejected(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "big.png", 500 * 1024 * 1024 + 1)],
      }),
    );

    expect(plan.reason).toBe("too_large");
    expect(plan.message).toBe("选中过多，请分批下载");
  });

  it("ED-05: exactly 500MB is allowed", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "big.png", 500 * 1024 * 1024)],
      }),
    );

    expect(plan.entries).toEqual([{ id: "p1", entryName: "big.png" }]);
    expect(plan.skipped).toBe(0);
  });

  it("ED-05: nothing ready is refused", () => {
    const plan = expectRejected(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [
          notReady("p1", "a.png", "generating"),
          notReady("p2", "b.png", "failed"),
        ],
      }),
    );

    expect(plan.reason).toBe("nothing_to_download");
    expect(plan.message).toBe("没有可下载的对象");
  });

  it("ED-05: an empty selection is refused", () => {
    const plan = expectRejected(planZipDownload({ projectName: "角色设定", now: AT, items: [] }));

    expect(plan.reason).toBe("nothing_to_download");
  });

  it("ED-05: unknown byte size counts as zero", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: AT,
        items: [ready("p1", "a.png"), ready("p2", "b.png")],
      }),
    );

    expect(plan.entries).toHaveLength(2);
    expect(plan.skipped).toBe(0);
  });

  it("ED-05: the zip is named project_YYYYMMDD-HHmm in Shanghai time", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "角色设定",
        now: new Date("2026-10-20T16:05:00Z"),
        items: [ready("p1", "a.png")],
      }),
    );

    expect(plan.fileName).toBe("角色设定_20261021-0005.zip");
  });

  it("ED-05: unsafe characters in the project name are replaced", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "a/b:c*",
        now: AT,
        items: [ready("p1", "a.png")],
      }),
    );

    expect(plan.fileName.startsWith("a_b_c__")).toBe(true);
  });

  it("ED-05: a project name that sanitizes to nothing falls back to project", () => {
    const plan = expectOk(
      planZipDownload({
        projectName: "   ",
        now: AT,
        items: [ready("p1", "a.png")],
      }),
    );

    expect(plan.fileName.startsWith("project_")).toBe(true);
  });
});
