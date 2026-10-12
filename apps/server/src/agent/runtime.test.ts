// X-52 (工单14 fixup T1): the attachment's `assetId` is the ONLY authority for
// what the model is shown.
//
// The failure this pins down was a security check that rejected the legitimate
// case. `resolveAttachmentContent` used to demand that the client's URL equal the
// signature it had just minted. But a signature ROTATES: a different token, a
// different expiry, or a preview restored from sessionStorage all produce a
// different string for an asset the caller is fully entitled to read. Byte
// equality therefore rejected exactly the case it was written to tolerate, and
// the browser hook's own case 5 ("a session-storage preview may be stale") said
// so out loud while the runtime contradicted it.
//
// So the tests below do not just check that a mismatched URL is accepted — they
// check that the client's URL is never READ at all, using a getter that counts
// its own accesses. A field that is consulted "only for comparison" is still a
// field an attacker gets to choose; counting reads is the only way to tell the
// two apart from the outside.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageAttachment } from "@loomic/shared";

import type { UserSupabaseClient } from "../supabase/user.js";
import { resolveAttachmentContent } from "./runtime.js";

const BUCKET = "project-assets";
const OBJECT_PATH = "ws-team/p/a.png";
const EXPIRED = "https://proj.test/storage/v1/object/sign/p.svg?token=expired-old";
const FORGED = "https://evil.test/exfiltrate.png";
const PNG = Buffer.from("the-real-bytes", "utf-8");

type AssetRow = { bucket: string; object_path: string; mime_type: string | null };

/**
 * A user client whose `asset_objects` read answers like RLS does: a row the
 * caller may not see is simply ABSENT, never an error.
 */
function makeClient(options: {
  assets?: Record<string, AssetRow>;
  signError?: { message: string } | null;
}) {
  const assets = options.assets ?? {};
  const signCalls: string[] = [];
  let signSeq = 0;

  const chain = {
    select: () => chain,
    eq: (_column: string, id: string) => ({
      maybeSingle: async () => {
        const row = assets[id];
        return row ? { data: row, error: null } : { data: null, error: null };
      },
    }),
  };

  const client = {
    from: (table: string) => {
      if (table !== "asset_objects") {
        throw new Error(`unexpected table in runtime test: ${table}`);
      }
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          signCalls.push(path);
          if (options.signError) {
            return { data: null, error: options.signError };
          }
          signSeq += 1;
          return {
            data: {
              signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig-${signSeq}`,
            },
            error: null,
          };
        },
      }),
    },
  };

  return {
    client: client as unknown as UserSupabaseClient,
    signCalls,
    /** How many signatures were minted — rotation made visible. */
    signCount: () => signSeq,
  };
}

/** A fetch stub that serves the given bytes per object path and records every URL. */
function makeFetch(bytesByPath: Record<string, Buffer>) {
  const calls: string[] = [];

  const impl = async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const path = Object.keys(bytesByPath).find((candidate) => url.includes(candidate));

    if (!path) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }

    const bytes = bytesByPath[path]!;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    };
  };

  return { impl, calls };
}

/**
 * An attachment whose `url` counts its own reads, so "the runtime ignores it"
 * is measured rather than asserted. `url` is optional in the contract, which is
 * what makes leaving it off (and never touching it) a legal shape.
 */
function attachmentWithUrlSpy(url: string): {
  attachment: ImageAttachment;
  reads: () => number;
} {
  let reads = 0;
  const attachment = {
    assetId: "asset-1",
    mimeType: "image/png",
    get url() {
      reads += 1;
      return url;
    },
  } as ImageAttachment;

  return { attachment, reads: () => reads };
}

const VISIBLE: AssetRow = {
  bucket: BUCKET,
  object_path: OBJECT_PATH,
  mime_type: "image/png",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Await a call that MUST reject, and hand the error back as the value under
 * test. Written this way rather than with `.catch()` so a call that unexpectedly
 * resolves fails the case instead of quietly returning its result.
 */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to be refused, but it resolved");
}

describe("resolveAttachmentContent treats assetId as the authority (T1)", () => {
  it("case 1: an expired/rotated preview URL still succeeds, and the model gets the NEW signature's bytes", async () => {
    const h = makeClient({ assets: { "asset-1": VISIBLE } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const { attachment, reads } = attachmentWithUrlSpy(EXPIRED);
    const resolved = await resolveAttachmentContent(h.client, [attachment]);

    // The preview is a DIFFERENT string from what this read minted — that is the
    // rotation, and it must not be a refusal.
    expect(h.signCount()).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).not.toBe(EXPIRED);
    expect(f.calls[0]).toContain("token=sig-1");

    // The point of the ticket: the stale URL was not even looked at.
    expect(reads()).toBe(0);

    const base64 = PNG.toString("base64");
    expect(resolved.downloaded).toEqual([
      { assetId: "asset-1", mimeType: "image/png", base64 },
    ]);
    expect(resolved.imageBlocks).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
    ]);
  });

  it("case 2: a forged external URL still succeeds — and is NEVER fetched", async () => {
    const h = makeClient({ assets: { "asset-1": VISIBLE } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const { attachment, reads } = attachmentWithUrlSpy(FORGED);
    const resolved = await resolveAttachmentContent(h.client, [attachment]);

    // Exactly one outbound request, to the address the SERVER signed. A forged
    // url in the request body is not an input to this function at all.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain("token=sig-1");
    expect(f.calls.some((url) => url.includes("evil.test"))).toBe(false);
    expect(reads()).toBe(0);
    expect(resolved.imageBlocks).toHaveLength(1);
  });

  it("case 3: an absent assetId and an invisible one fail IDENTICALLY, with no fetch", async () => {
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const absent = makeClient({ assets: {} });
    const invisible = makeClient({ assets: { "asset-1": VISIBLE } });

    const absentError = await refusal(
      resolveAttachmentContent(absent.client, [
        { assetId: "asset-missing", mimeType: "image/png" },
      ]),
    );

    // RLS answers "no row" for someone else's asset — the runtime must not be
    // able to tell that apart from "no such asset", or the error message becomes
    // an existence oracle over other people's media.
    const invisibleError = await refusal(
      resolveAttachmentContent(invisible.client, [
        { assetId: "asset-not-mine", mimeType: "image/png" },
      ]),
    );

    expect(absentError.message).toContain("not available to this user");
    expect(invisibleError.message).toBe(absentError.message);

    // Nothing was signed, nothing was fetched, no model input was built.
    expect(absent.signCalls).toHaveLength(0);
    expect(invisible.signCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 4: a signing refusal stops the run and returns no URL of any kind", async () => {
    const h = makeClient({
      assets: { "asset-1": VISIBLE },
      signError: { message: "permission denied" },
    });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusal(
      resolveAttachmentContent(h.client, [
        { assetId: "asset-1", mimeType: "image/png" },
      ]),
    );

    expect(error.message).toContain("could not be authorised for reading");
    // A signed URL is a bearer token: neither the message nor the log carries one.
    expect(error.message).not.toContain("http");
    expect(f.calls).toHaveLength(0);
  });
});
