// @vitest-environment jsdom
//
// 工单 34P · AS-06「参考」面板组件（T3，7 例）。
//
// 两个替身，理由：
// 1. `@/lib/server-api` 换掉 —— 本单验的是「组件在什么时候用哪些参数去取数」，
//    真实请求的 URL 拼装在 `upload-precheck.test.ts` 里用真身 + mockFetch 钉住（T4）。
// 2. `@/components/toast` 换成可断言的 spy —— 要验的是「服务端的中文原因原样弹出来」，
//    不是 toast 组件自己的动画。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const apiMock = vi.hoisted(() => ({
  fetchProjectUploads: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@/lib/server-api", () => ({
  fetchProjectUploads: apiMock.fetchProjectUploads,
  uploadFile: apiMock.uploadFile,
}));

const toastMock = vi.hoisted(() => ({
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/components/toast", () => ({ useToast: () => toastMock }));

import { ReferencePanel, toImageArtifact } from "../src/components/canvas/reference-panel";

const firstItem = {
  id: "asset-1",
  name: "草稿-第一张.png",
  mimeType: "image/png",
  byteSize: 1024,
  createdAt: "2026-10-13T00:00:00.000Z",
  url: "https://example.invalid/signed/one",
};

const secondItem = {
  id: "asset-2",
  name: "分镜.pdf",
  mimeType: "application/pdf",
  byteSize: 4096,
  createdAt: "2026-10-12T00:00:00.000Z",
  url: null,
};

/** 最后一次取数调用的第三个参数（组件只在有值时才加字段）。 */
function lastFetchOptions(): unknown {
  const calls = apiMock.fetchProjectUploads.mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall === undefined ? undefined : lastCall[2];
}

function renderPanel() {
  render(<ReferencePanel accessToken="tok" projectId="project-1" />);
}

describe("ReferencePanel (AS-06)", () => {
  beforeEach(() => {
    apiMock.fetchProjectUploads.mockReset();
    apiMock.uploadFile.mockReset();
    toastMock.toast.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    apiMock.fetchProjectUploads.mockResolvedValue({ uploads: [firstItem, secondItem] });
  });

  afterEach(() => {
    cleanup();
  });

  it("AS-06: the list loads newest first by default", async () => {
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId("ref-item")).toHaveLength(2));

    expect(apiMock.fetchProjectUploads).toHaveBeenCalledWith("tok", "project-1", {
      order: "newest",
    });
    expect(screen.getAllByTestId("ref-item")[0]).toHaveTextContent("草稿-第一张.png");
  });

  it("AS-06: choosing 旧→新 asks again with order=oldest", async () => {
    renderPanel();
    await waitFor(() => expect(apiMock.fetchProjectUploads).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("ref-sort"), { target: { value: "oldest" } });

    await waitFor(() => expect(lastFetchOptions()).toEqual({ order: "oldest" }));
  });

  it("AS-06: the PDF filter asks with type=pdf", async () => {
    renderPanel();
    await waitFor(() => expect(apiMock.fetchProjectUploads).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("ref-filter"), { target: { value: "pdf" } });

    await waitFor(() =>
      expect(lastFetchOptions()).toEqual({ order: "newest", type: "pdf" }),
    );
  });

  it("AS-06: an empty list shows 还没有参考图，拖入或点击上传", async () => {
    apiMock.fetchProjectUploads.mockResolvedValue({ uploads: [] });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId("ref-empty")).toHaveTextContent("还没有参考图，拖入或点击上传"),
    );
    expect(screen.queryAllByTestId("ref-item")).toHaveLength(0);
  });

  it("AS-06: uploading a file refreshes the list", async () => {
    apiMock.uploadFile.mockResolvedValue({ asset: { id: "asset-3" }, url: "u" });
    renderPanel();
    await waitFor(() => expect(apiMock.fetchProjectUploads).toHaveBeenCalledTimes(1));

    const file = new File(["png-bytes"], "ref.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("ref-upload-input"), { target: { files: [file] } });

    await waitFor(() => expect(apiMock.uploadFile).toHaveBeenCalledWith("tok", file, "project-1"));
    await waitFor(() => expect(apiMock.fetchProjectUploads).toHaveBeenCalledTimes(2));
  });

  it("AS-06: a refused upload shows the server-side reason", async () => {
    apiMock.uploadFile.mockRejectedValue(new Error("图片最大 20MB"));
    renderPanel();
    await waitFor(() => expect(apiMock.fetchProjectUploads).toHaveBeenCalledTimes(1));

    const file = new File(["png-bytes"], "big.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("ref-upload-input"), { target: { files: [file] } });

    await waitFor(() => expect(toastMock.toast).toHaveBeenCalledWith("图片最大 20MB"));
  });

  it("AS-06: dragging an item carries its asset id", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("ref-item")).toHaveLength(2));

    const dataTransfer = { setData: vi.fn() };
    const firstRow = screen.getAllByTestId("ref-item")[0];
    expect(firstRow).toBeDefined();
    fireEvent.dragStart(firstRow as HTMLElement, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    const [mime, payload] = dataTransfer.setData.mock.calls[0] as [string, string];
    expect(mime).toBe("application/x-hahart-asset");
    expect(JSON.parse(payload)).toMatchObject({
      assetId: "asset-1",
      mimeType: "image/png",
      name: "草稿-第一张.png",
    });
  });

  // ── 34Q：点击插入画布 + T-92（mimeType 可空） ──

  it("AS-06: 插入画布 hands the image to onInsert as an artifact", async () => {
    const onInsert = vi.fn();
    render(
      <ReferencePanel accessToken="tok" projectId="project-1" onInsert={onInsert} />,
    );
    await waitFor(() => expect(screen.getAllByTestId("ref-item")).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("ref-item-insert")[0] as HTMLElement);

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert).toHaveBeenCalledWith({
      type: "image",
      title: "草稿-第一张.png",
      url: "https://example.invalid/signed/one",
      assetId: "asset-1",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
  });

  it("AS-06: a PDF item has no 插入画布 button", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId("ref-item")).toHaveLength(2));

    const rows = screen.getAllByTestId("ref-item");
    expect(within(rows[0] as HTMLElement).getAllByTestId("ref-item-insert")).toHaveLength(1);
    expect(within(rows[1] as HTMLElement).queryAllByTestId("ref-item-insert")).toHaveLength(0);
  });

  it("AS-06: toImageArtifact refuses an item without a url", () => {
    expect(toImageArtifact(secondItem)).toBeNull();
  });

  it("AS-06: an item without a mime type is listed as 文件", async () => {
    apiMock.fetchProjectUploads.mockResolvedValue({
      uploads: [
        {
          id: "asset-9",
          name: "unknown-blob",
          mimeType: null,
          byteSize: null,
          createdAt: "2026-10-11T00:00:00.000Z",
          url: null,
        },
      ],
    });
    renderPanel();

    await waitFor(() => expect(screen.getAllByTestId("ref-item")).toHaveLength(1));
    expect(screen.getAllByTestId("ref-item")[0]).toHaveTextContent("文件");
    expect(screen.getAllByTestId("ref-item")[0]).toHaveTextContent("unknown-blob");
  });
});
