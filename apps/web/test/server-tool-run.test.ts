import { describe, expect, it, vi } from "vitest";

import {
  TOOL_NO_OUTPUT_MESSAGE,
  createServerToolRunner,
  type ServerToolRunBody,
} from "../src/lib/server-tool-run";

/**
 * 工单 40T / ED-07 / ED-00m · `createServerToolRunner`。
 *
 * 这里只测「一次点击 = 一个任务」这条防护，以及产物从哪来：
 * - 连点 3 次只发 1 个请求（同一个 `client_request_id`），3 个调用解析成同一个结果；
 * - 完成后再点 → 是新的请求（`newRequestId` 再来一次）；
 * - 任务成功但没有产物 asset → 抛错，不是「替换成空图」；
 * - 产物 assetId 就是服务端给的那个（GN-24：**前端不重新上传**），
 *   字节只从 `signed_url` 读出来给画布用。
 */

/** 一个可以由测试决定何时 resolve 的 Promise（用来模拟「请求还在途」）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const OUTPUT = {
  asset_id: "asset-out",
  signed_url: "https://storage.test/out.png",
  width: 1254,
  height: 1254,
  mime_type: "image/png",
};

describe("createServerToolRunner：ED-00m 直接执行类工具的运行器", () => {
  it("ED-00m: three clicks while running send one request", async () => {
    const runGate = deferred<{ jobId: string }>();
    const run = vi.fn((_toolId: string, _body: ServerToolRunBody) => runGate.promise);
    const wait = vi.fn(async () => ({ result: OUTPUT }));
    const loadAsDataUrl = vi.fn(async () => "data:image/png;base64,OUT");
    const newRequestId = vi.fn(() => "req-1");
    const runner = createServerToolRunner({ run, wait, loadAsDataUrl, newRequestId });

    const first = runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });
    const second = runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });
    const third = runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });

    runGate.resolve({ jobId: "job-1" });
    const results = await Promise.all([first, second, third]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(newRequestId).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith("job-1");
    // 三次点击是同一份结果，不是三份被覆盖的
    expect(results.map((result) => result.assetId)).toEqual([
      "asset-out",
      "asset-out",
      "asset-out",
    ]);
    // 发出的那一个请求带的就是源 asset 与那个去重 id
    expect(run.mock.calls[0]?.[0]).toBe("remove_background");
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      artifact_id: "asset-source",
      client_request_id: "req-1",
    });
  });

  it("after it finishes the next click runs again", async () => {
    const run = vi.fn(async () => ({ jobId: "job-1" }));
    const wait = vi.fn(async () => ({ result: OUTPUT }));
    const loadAsDataUrl = vi.fn(async () => "data:image/png;base64,OUT");
    let requests = 0;
    const newRequestId = vi.fn(() => {
      requests += 1;
      return `req-${requests}`;
    });
    const runner = createServerToolRunner({ run, wait, loadAsDataUrl, newRequestId });

    await runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });
    await runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(newRequestId).toHaveBeenCalledTimes(2);
    expect(newRequestId.mock.results.map((result) => result.value)).toEqual([
      "req-1",
      "req-2",
    ]);
  });

  it("a job without an output asset is an error", async () => {
    const run = vi.fn(async () => ({ jobId: "job-1" }));
    // 成功但没有 asset：服务端缺陷，不能当成「替换成一张空图」。
    const wait = vi.fn(async () => ({ result: { signed_url: "https://storage.test/out.png" } }));
    const loadAsDataUrl = vi.fn(async () => "data:image/png;base64,OUT");
    const runner = createServerToolRunner({
      run,
      wait,
      loadAsDataUrl,
      newRequestId: () => "req-1",
    });

    await expect(
      runner.runOnce("img-1:remove_background", "remove_background", {
        artifactId: "asset-source",
      }),
    ).rejects.toThrow(TOOL_NO_OUTPUT_MESSAGE);
    // 没有产物就不该去读字节
    expect(loadAsDataUrl).toHaveBeenCalledTimes(0);

    // 失败之后 key 也要释放，否则这张图再也点不动了
    await expect(
      runner.runOnce("img-1:remove_background", "remove_background", {
        artifactId: "asset-source",
      }),
    ).rejects.toThrow(TOOL_NO_OUTPUT_MESSAGE);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("the result carries the server asset, not a re-upload", async () => {
    const run = vi.fn(async () => ({ jobId: "job-1" }));
    const wait = vi.fn(async () => ({ result: OUTPUT }));
    const loadAsDataUrl = vi.fn(async () => "data:image/png;base64,OUT");
    const runner = createServerToolRunner({
      run,
      wait,
      loadAsDataUrl,
      newRequestId: () => "req-1",
    });

    const result = await runner.runOnce("img-1:remove_background", "remove_background", {
      artifactId: "asset-source",
    });

    // GN-24：assetId 就是服务端产物的 id，前端没有上传动作
    expect(result.assetId).toBe(OUTPUT.asset_id);
    // 字节只来自签名地址（给画布画图用）
    expect(loadAsDataUrl).toHaveBeenCalledWith(OUTPUT.signed_url);
    expect(result.dataUrl).toBe("data:image/png;base64,OUT");
    expect(result.width).toBe(OUTPUT.width);
    expect(result.height).toBe(OUTPUT.height);
    expect(result.mimeType).toBe(OUTPUT.mime_type);
  });
});
