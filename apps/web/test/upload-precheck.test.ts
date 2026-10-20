// @vitest-environment jsdom
//
// AS-02: the constraint check happens BEFORE the request. The acceptance
// criterion is "a 16MB MP3 is refused and the network panel shows no upload
// request" — so these cases assert on the mock fetch's call count, not only on
// the error. A precheck that ran after `fetch` would show the same message and
// still have spent the user's bandwidth (and earned a 413 from the server).
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiApplicationError,
  fetchProjectUploads,
  getAssetDownloadUrl,
  uploadFile,
} from "../src/lib/server-api";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("uploadFile refuses locally from the shared constraint table (AS-02)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("AS-02: a 16MB MP3 is refused with 音频最大 15MB and no request is sent", async () => {
    const file = new File(["x"], "big.mp3", { type: "audio/mpeg" });
    Object.defineProperty(file, "size", { value: 16 * 1024 * 1024 });

    await expect(uploadFile("tok", file)).rejects.toBeInstanceOf(ApiApplicationError);

    // The same call again, caught, so the code and message can be asserted
    // without relying on the rejection matcher's shape.
    const error = await uploadFile("tok", file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiApplicationError);
    expect((error as ApiApplicationError).code).toBe("upload_failed");
    expect((error as ApiApplicationError).message).toBe("音频最大 15MB");
    expect((error as ApiApplicationError).status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("AS-02: an unsupported type is refused with 不支持的文件类型 and no request is sent", async () => {
    const file = new File(["x"], "archive.zip", { type: "application/zip" });

    const error = await uploadFile("tok", file).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiApplicationError);
    expect((error as ApiApplicationError).code).toBe("upload_failed");
    expect((error as ApiApplicationError).message).toBe("不支持的文件类型");
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it("AS-02: a small PNG goes to the server", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asset: { id: "a" }, url: "u" }),
    });

    const file = new File(["bytes"], "small.png", { type: "image/png" });
    const result = await uploadFile("tok", file);

    expect(result).toMatchObject({ asset: { id: "a" }, url: "u" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url.endsWith("/api/uploads")).toBe(true);
  });
});

// T-91 + 工单 34P T4：URL 拼装用真身钉住 —— 替身只能证明「组件用了哪些参数」，
// 钉不住真正发出去的请求长什么样（ED-05 的 `?download=1` 之前就是这样漏掉的）。
describe("server-api URL shapes (ED-05 / AS-06)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://example.invalid/signed", uploads: [] }),
    });
  });

  it("ED-05: getAssetDownloadUrl asks for the download signature", async () => {
    await getAssetDownloadUrl("tok", "asset-9");

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url.endsWith("/api/uploads/asset-9/url?download=1")).toBe(true);
  });

  it("AS-06: fetchProjectUploads puts order and type on the query", async () => {
    await fetchProjectUploads("tok", "p-1", { order: "oldest", type: "pdf" });

    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url.endsWith("/api/projects/p-1/uploads?order=oldest&type=pdf")).toBe(true);
  });
});
