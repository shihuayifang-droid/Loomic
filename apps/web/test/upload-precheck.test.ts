// @vitest-environment jsdom
//
// AS-02: the constraint check happens BEFORE the request. The acceptance
// criterion is "a 16MB MP3 is refused and the network panel shows no upload
// request" — so these cases assert on the mock fetch's call count, not only on
// the error. A precheck that ran after `fetch` would show the same message and
// still have spent the user's bandwidth (and earned a 413 from the server).
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiApplicationError, uploadFile } from "../src/lib/server-api";

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
