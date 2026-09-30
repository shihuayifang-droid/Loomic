import { describe, expect, it } from "vitest";

import {
  SafeFetchError,
  safeFetch,
  type SafeFetchErrorCode,
} from "./safe-fetch.js";

type RecordedCall = { url: string; init: RequestInit | undefined };

/** A fake `fetch` driven by a queue of response factories, recording every call. */
function makeFetchStub(factories: Array<() => Response | Promise<Response>>) {
  const calls: RecordedCall[] = [];

  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const factory = factories.shift();
    if (!factory) throw new Error(`unexpected fetch call to ${String(input)}`);
    return factory();
  }) as typeof fetch;

  return { impl, calls };
}

/** Streams `totalBytes` in `chunkBytes` pieces; `onPull` observes body reads. */
function byteStream(totalBytes: number, chunkBytes: number, onPull?: () => void) {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();

      if (sent >= totalBytes) {
        controller.close();
        return;
      }

      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<SafeFetchErrorCode> {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(SafeFetchError);
  return (error as SafeFetchError).code;
}

describe("safeFetch", () => {
  it("case 1: an allowed host is fetched with redirect manual and a signal", async () => {
    const { impl, calls } = makeFetchStub([
      () => new Response("hello", { status: 200 }),
    ]);

    const response = await safeFetch(
      "https://registry.npmjs.org/x",
      undefined,
      { fetchImpl: impl },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(calls.length).toBe(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("case 2: plain http is refused without a request", async () => {
    const { impl, calls } = makeFetchStub([]);

    const code = await codeOf(() =>
      safeFetch("http://registry.npmjs.org/x", undefined, { fetchImpl: impl }),
    );

    expect(["bad_url", "host_not_allowed"]).toContain(code);
    expect(calls.length).toBe(0);
  });

  it("case 3: loopback, unknown and suffix-spoofed hosts are refused", async () => {
    const { impl, calls } = makeFetchStub([]);

    for (const url of [
      "https://127.0.0.1:8080/x.tgz",
      "https://evil.example/x.tgz",
      "https://registry.npmjs.org.evil.example/",
    ]) {
      const code = await codeOf(() => safeFetch(url, undefined, { fetchImpl: impl }));
      expect(code, url).toBe("host_not_allowed");
    }

    expect(calls.length).toBe(0);
  });

  it("case 4: credentials and non-default ports are refused", async () => {
    const { impl, calls } = makeFetchStub([]);

    for (const url of [
      "https://user:pw@registry.npmjs.org/",
      "https://registry.npmjs.org:8443/",
    ]) {
      const code = await codeOf(() => safeFetch(url, undefined, { fetchImpl: impl }));
      expect(code, url).toBe("bad_url");
    }

    expect(calls.length).toBe(0);
  });

  it("case 5: a redirect to another allowed host is followed", async () => {
    const { impl, calls } = makeFetchStub([
      () => new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/y" } }),
      () => new Response("final", { status: 200 }),
    ]);

    const response = await safeFetch(
      "https://registry.npmjs.org/x",
      undefined,
      { fetchImpl: impl },
    );

    expect(await response.text()).toBe("final");
    expect(calls.length).toBe(2);
    expect(calls[1]?.url).toBe("https://registry.npmjs.org/y");
  });

  it("case 6: a redirect to a disallowed host is refused before the second request", async () => {
    const { impl, calls } = makeFetchStub([
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    ]);

    const code = await codeOf(() =>
      safeFetch("https://registry.npmjs.org/x", undefined, { fetchImpl: impl }),
    );

    expect(code).toBe("host_not_allowed");
    expect(calls.length).toBe(1);
  });

  it("case 7: too many redirects", async () => {
    const { impl, calls } = makeFetchStub([
      () => new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/r1" } }),
      () => new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/r2" } }),
      () => new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/r3" } }),
      () => new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/r4" } }),
    ]);

    const code = await codeOf(() =>
      safeFetch("https://registry.npmjs.org/x", undefined, { fetchImpl: impl }),
    );

    expect(code).toBe("too_many_redirects");
    expect(calls.length).toBe(4);
  });

  it("case 8: an oversized content-length is refused without reading the body", async () => {
    let pulls = 0;
    const stream = byteStream(20 * 1024 * 1024, 1024 * 1024, () => {
      pulls += 1;
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-length": String(20 * 1024 * 1024) },
    });
    // The Response/stream plumbing itself may wrap (and pull) once; what this
    // case is about is that safeFetch adds no reads of its own.
    const pullsBeforeSafeFetch = pulls;

    const { impl } = makeFetchStub([() => response]);

    const code = await codeOf(() =>
      safeFetch("https://registry.npmjs.org/x", undefined, { fetchImpl: impl }),
    );

    expect(code).toBe("too_large");
    // One pull is undici's own prefetch when a streamed Response settles; what
    // this case proves is that safeFetch never drains the 20 MB (a real body
    // read would pull ~20 chunks) and leaves the body untouched.
    expect(pulls).toBeLessThanOrEqual(1);
    expect(response.bodyUsed).toBe(false);
  });

  it("case 9: a chunked body without content-length is counted while it streams", async () => {
    const { impl } = makeFetchStub([
      () => new Response(byteStream(11 * 1024 * 1024, 1024 * 1024), { status: 200 }),
    ]);

    const code = await codeOf(() =>
      safeFetch("https://registry.npmjs.org/x", undefined, { fetchImpl: impl }),
    );

    expect(code).toBe("too_large");
  });

  it("case 10: the overall deadline aborts a request that never answers", async () => {
    const impl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;

    const started = Date.now();
    const code = await codeOf(() =>
      safeFetch("https://registry.npmjs.org/x", undefined, {
        fetchImpl: impl,
        timeoutMs: 50,
      }),
    );

    expect(code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
