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
  cancelJob,
  downloadAssetsZip,
  fetchPriceQuote,
  fetchProjectUploads,
  getAssetDownloadUrl,
  submitImageJob,
  uploadFile,
  uploadToolOutput,
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

// 工单 34W：`POST /api/uploads/zip` 回的是 zip 流，包名与跳过数都在响应头上 —— 替身证明不了
// 头部怎么解析，所以这里走真身 + 一个能读头部的假响应。
describe("ED-05: zip download (34W)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("ED-05: downloadAssetsZip posts the ids and reads the file name and skip count", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({
        "content-disposition":
          "attachment; filename*=UTF-8''%E7%94%BB%E5%B8%83_20261021-0005.zip",
        "x-skipped-count": "2",
      }),
      blob: async () => new Blob(["x"]),
    });

    const result = await downloadAssetsZip("tok", {
      assetIds: ["a1", "a2"],
      projectName: "画布",
    });

    expect(result.fileName).toBe("画布_20261021-0005.zip");
    expect(result.skipped).toBe(2);

    const [url, init] = mockFetch.mock.calls[0] as [string, { method?: string; body?: unknown }];
    expect(url.endsWith("/api/uploads/zip")).toBe(true);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("assetIds");
  });
});

// 工单35K · ED-00f：菜单标价的来源是 `POST /api/pricing/quote`（GN-01）。
// 替身只能证明「请求长什么样」，所以这里钉 URL、方法与请求体形状。
describe("ED-00f: price quote (35K)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], balance: {} }),
    });
  });

  it("ED-00f: fetchPriceQuote posts the items to /api/pricing/quote", async () => {
    const body = { items: [{ kind: "tool" as const, tool_id: "vectorize" }] };

    await fetchPriceQuote("tok", body);

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; body?: unknown; headers?: Record<string, string> },
    ];
    expect(url.endsWith("/api/pricing/quote")).toBe(true);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("items");
    expect(String(init.body)).toContain("vectorize");
    expect(init.headers?.Authorization).toBe("Bearer tok");
  });
});

// 工单35R · ED-00i：像素类工具（调整 / 裁剪）的产物走独立的工具产物上传端点 ——
// 来源与父产物是这次请求的全部意义（出处链 + 花费 0 靠它们在服务端落地），
// 所以这里钉字段取值本身，不只是「发了个请求」。
describe("ED-00i: tool output upload (35R)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("ED-00i: uploadToolOutput posts the file with its tool source and parent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ asset: { id: "a-child" }, url: "u" }),
    });

    const file = new File(["bytes"], "cropped.png", { type: "image/png" });
    const result = await uploadToolOutput("tok", {
      file,
      source: "tool:crop",
      parentArtifactId: "p-1",
    });

    expect(result).toMatchObject({ asset: { id: "a-child" }, url: "u" });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; body?: unknown; headers?: Record<string, string> },
    ];
    expect(url.endsWith("/api/uploads/tool-output")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer tok");

    const body = init.body as FormData;
    expect(body.get("source")).toBe("tool:crop");
    expect(body.get("parentArtifactId")).toBe("p-1");
    expect(body.get("file")).toBeInstanceOf(File);
  });

  it("ED-00i: an oversized tool output is refused before any request", async () => {
    const file = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 21 * 1024 * 1024 });

    const error = await uploadToolOutput("tok", {
      file,
      source: "tool:adjust",
      parentArtifactId: "p-1",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiApplicationError);
    expect((error as ApiApplicationError).code).toBe("upload_failed");
    expect((error as ApiApplicationError).message).toBe("图片最大 20MB");
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });
});

// 替身钉 URL、方法与请求体（quality 只在模型有档位时才带上，见 image-quality-options）。
// 工单35P · GN-37：图像生成器改走任务链路 —— 提交这一步回到 202，不再是「等图生成完」。
// 替身钉 URL、方法与请求体（quality 只在模型有档位时才带上，见 image-quality-options）。
describe("GN-37: image generation submits a job (35P)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ jobId: "job-1", status: "queued", prompt: "a cat" }),
    });
  });

  it("GN-37: submitImageJob posts prompt and quality to /api/agent/generate-image-job", async () => {
    const result = await submitImageJob("tok", "a cat", {
      model: "openai/gpt-image-1",
      aspectRatio: "1:1",
      quality: "2K",
    });

    expect(result).toMatchObject({ jobId: "job-1", status: "queued" });

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; body?: unknown },
    ];
    expect(url.endsWith("/api/agent/generate-image-job")).toBe(true);
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("a cat");
    expect(String(init.body)).toContain("quality");
  });
});

// 工单36F · CV-02 / GN-32：占位上的「取消」打到 `POST /api/jobs/:jobId/cancel`。
// 替身只钉 URL、方法与鉴权头（退积分规则在服务端）。
describe("CV-02: cancel job (36F)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ job: { id: "job-1", status: "canceled" } }),
    });
  });

  it("CV-02: cancelJob posts to /api/jobs/job-1/cancel", async () => {
    await cancelJob("tok", "job-1");

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string> },
    ];
    expect(url.endsWith("/api/jobs/job-1/cancel")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer tok");
  });
});
