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
//
// 工单21S: the row those bytes come from is no longer read through the caller's
// PostgREST client — it comes from `AssetReadRepository.findReadableAsset`, asked
// with the run's own actor id. The signing client in these tests therefore keeps
// ONLY its storage surface: a table read through it throws, and the number of
// times one was attempted is asserted to be zero. The read itself is a fake
// repository that records every ask, so "which actor asked for which asset" and
// "was the read attempted at all" are measured rather than assumed.
//
// 工单21AC: the same "measure the wiring, do not assume it" rule now covers the
// three repositories the Agent side needs — the canvas read, the asset-row
// compensation delete and the owner-keyed brand kit read. They are REQUIRED
// properties of `createLoomicDeepAgent`'s options and of `createMainAgentTools`'
// deps, so a missing one is a compile error; the cases at the end of this file go
// one step further and check the OBJECTS actually reach the tool factory, and that
// the tool built from them answers from the repository instead of a table read.
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A pass-through spy on the tool factory: the real `createMainAgentTools` still
 * runs (so the tools below are the tools a run would get), and every call is
 * recorded so the arguments are observable. `vi.mock` is hoisted, hence
 * `vi.hoisted` for the spy itself.
 */
const mainAgentToolsSpy = vi.hoisted(() => vi.fn());

vi.mock("./tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/index.js")>();
  return {
    ...actual,
    createMainAgentTools: (
      ...args: Parameters<typeof actual.createMainAgentTools>
    ) => {
      mainAgentToolsSpy(...args);
      return actual.createMainAgentTools(...args);
    },
  };
});


import type { ImageAttachment } from "@loomic/shared";

import type {
  AssetReadRepository,
  AssetReadRow,
} from "../db/asset-read-repository.js";
import type { AssetWriteRepository } from "../db/asset-write-repository.js";
import type {
  BrandKitAssetRow,
  BrandKitReadRepository,
  KitDetailRow,
} from "../db/brand-kit-read-repository.js";
import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../db/canvas-read-repository.js";
import type { ServerEnv } from "../config/env.js";
import type { UserSupabaseClient } from "../supabase/user.js";
import { createLoomicDeepAgent } from "./deep-agent.js";
import {
  eventAfterPersistFailure,
  readCanvasProjectLinkForRun,
  readCanvasSummaryForRun,
  resolveAttachmentContent,
  resolveCanvasProjectId,
} from "./runtime.js";
import { createMainAgentTools } from "./tools/index.js";

const BUCKET = "project-assets";
const OBJECT_PATH = "ws-team/p/a.png";
const ACTOR = "user-1";
const EXPIRED = "https://proj.test/storage/v1/object/sign/p.svg?token=expired-old";
const FORGED = "https://evil.test/exfiltrate.png";
const PNG = Buffer.from("the-real-bytes", "utf-8");

/** A driver error as PostgreSQL would raise it: it names the statement. */
const ASSET_DRIVER_ERROR = new Error(
  'select a.bucket, a.object_path from public.asset_objects a where a.id = $2::uuid — invalid input syntax for type uuid: "asset-1"',
);

/**
 * A SIGNING client, and only that: it mints a storage signature and nothing else.
 *
 * The row read now belongs to the asset repository (工单21S), so a table read
 * through this object THROWS and is counted. That is what turns "the row no
 * longer comes from here" into a measurement: a runtime that reached for a table
 * again would fail the case on the throw instead of passing on a stub that still
 * answered.
 */
function makeClient(options: { signError?: { message: string } | null } = {}) {
  const signCalls: string[] = [];
  let signSeq = 0;
  let tableReads = 0;

  const client = {
    from: (table: string) => {
      tableReads += 1;
      throw new Error(`unexpected table read in runtime test: ${table}`);
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
    /** How many table reads this client was asked for — must stay zero. */
    tableReads: () => tableReads,
  };
}

/** One asset row as the repository returns it: eight columns, three of them read. */
function assetRow(overrides: Partial<AssetReadRow> = {}): AssetReadRow {
  return {
    id: "asset-1",
    bucket: BUCKET,
    object_path: OBJECT_PATH,
    mime_type: "image/png",
    byte_size: null,
    workspace_id: "workspace-1",
    project_id: null,
    created_at: "2026-10-16T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A fake `AssetReadRepository` that records the RAW ask, so both "which actor
 * asked for which asset" and the exact shape of the input object are observable.
 *
 * `readable` maps an assetId to the row THIS caller may read. An id that is not
 * in the map answers `null` — which is how the real statement reports both
 * "there is no such asset" and "there is one but it is not yours": one answer,
 * never an error, and never a distinguishable one.
 */
function assetRepository(
  options: { readable?: Record<string, AssetReadRow>; error?: Error } = {},
) {
  const readable = options.readable ?? {};
  const calls: Array<Record<string, unknown>> = [];

  const repository: AssetReadRepository = {
    async findReadableAsset(input) {
      calls.push({ ...input });
      if (options.error) throw options.error;
      return readable[input.assetId] ?? null;
    },
  };

  return { repository, calls };
}

/**
 * A fetch stub that serves the given bytes per object path and records every URL.
 * The content type is a parameter because the mime fallback chain has to be told
 * apart from the row's own `mime_type`, and a stub that always answered
 * `image/png` could not do that.
 */
function makeFetch(
  bytesByPath: Record<string, Buffer>,
  contentType = "image/png",
) {
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
      headers: {
        get: (name: string) => (name === "content-type" ? contentType : null),
      },
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
function attachmentWithUrlSpy(
  url: string,
  assetId = "asset-1",
): {
  attachment: ImageAttachment;
  reads: () => number;
} {
  let reads = 0;
  const attachment = {
    assetId,
    mimeType: "image/png",
    get url() {
      reads += 1;
      return url;
    },
  } as ImageAttachment;

  return { attachment, reads: () => reads };
}

/**
 * An attachment that carries no usable request-side mime, so the fallback chain
 * runs on the row and the response alone. The wire schema requires a `mimeType`,
 * but the runtime's chain exists precisely because a value can be absent here —
 * the cast states that this case contributes none instead of pretending the
 * contract allows it.
 */
function attachmentWithoutMime(assetId = "asset-1"): ImageAttachment {
  return { assetId } as ImageAttachment;
}

// ---------------------------------------------------------------------------
// Workorder 20C: the automatic canvas summary is a pure read, so it goes through
// the canvas repository with the run's own actor id. It must never be able to
// fail an Agent run.
// ---------------------------------------------------------------------------

const RUN_ACTOR = "user-1";
const RUN_CANVAS = "canvas-1";
const RUN_PROJECT = "project-1";
const RUN_WORKSPACE = "workspace-1";
const RUN_BRAND_KIT = "brand-kit-1";

/** A driver error as PostgreSQL would raise it: it names the statement. */
const DRIVER_ERROR = new Error(
  'select c.project_id, p.workspace_id from public.canvases c where c.id = $2::uuid — invalid input syntax for type uuid: "canvas-1"',
);

const RUN_LINK: CanvasProjectLinkRow = {
  project_id: RUN_PROJECT,
  workspace_id: RUN_WORKSPACE,
  brand_kit_id: RUN_BRAND_KIT,
};

const CANVAS_ELEMENT = {
  id: "el-1",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  isDeleted: false,
};

/** A repository that records what it was asked and answers `content`. */
function canvasRepository(options: {
  content?: unknown;
  error?: Error;
  found?: boolean;
  link?: CanvasProjectLinkRow | null;
  linkError?: Error;
}) {
  const calls: Array<{ actorId: string; canvasId: string }> = [];
  const linkCalls: Array<{ actorId: string; canvasId: string }> = [];

  const repository: CanvasReadRepository = {
    async findReadableCanvasContent(input) {
      calls.push({ actorId: input.actorId, canvasId: input.canvasId });
      if (options.error) throw options.error;
      return options.found === false ? null : { content: options.content as never };
    },
    async findReadableCanvasProjectLink(input) {
      linkCalls.push({ actorId: input.actorId, canvasId: input.canvasId });
      if (options.linkError) throw options.linkError;
      return options.link ?? null;
    },
    async listReadableSucceededImageJobs() {
      return [];
    },
    async listReadableCanvasAssets() {
      return [];
    },
  };

  return { repository, calls, linkCalls };
}

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
    const h = makeClient();
    const a = assetRepository({ readable: { "asset-1": assetRow() } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const { attachment, reads } = attachmentWithUrlSpy(EXPIRED);
    const resolved = await resolveAttachmentContent(
      { repository: a.repository, actorId: ACTOR, signingClient: h.client },
      [attachment],
    );

    // The row came from the repository, asked for the RUN's actor — and not from
    // the signing client, which was never asked for a table.
    expect(a.calls).toEqual([{ actorId: ACTOR, assetId: "asset-1" }]);
    expect(h.tableReads()).toBe(0);

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
    const h = makeClient();
    const a = assetRepository({ readable: { "asset-1": assetRow() } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const { attachment, reads } = attachmentWithUrlSpy(FORGED);
    const resolved = await resolveAttachmentContent(
      { repository: a.repository, actorId: ACTOR, signingClient: h.client },
      [attachment],
    );

    // Exactly one outbound request, to the address the SERVER signed. A forged
    // url in the request body is not an input to this function at all.
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain("token=sig-1");
    expect(f.calls.some((url) => url.includes("evil.test"))).toBe(false);
    expect(reads()).toBe(0);
    expect(resolved.imageBlocks).toHaveLength(1);
    // The authority for what may be read is the repository, and it was asked
    // with the run's actor — never through the signing client.
    expect(a.calls).toEqual([{ actorId: ACTOR, assetId: "asset-1" }]);
    expect(h.tableReads()).toBe(0);
  });

  it("case 3: an absent assetId and an invisible one fail IDENTICALLY, with no fetch", async () => {
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    // The repository answers `null` for both: "there is none" and "there is one
    // but it is not yours" are one answer in the statement, never an error.
    const absent = assetRepository({ readable: {} });
    const invisible = assetRepository({ readable: { "asset-1": assetRow() } });
    const h = makeClient();

    const absentError = await refusal(
      resolveAttachmentContent(
        { repository: absent.repository, actorId: ACTOR, signingClient: h.client },
        [{ assetId: "asset-missing", mimeType: "image/png" }],
      ),
    );

    // The read is the authority for who may see what — the runtime must not be
    // able to tell that apart from "no such asset", or the error message becomes
    // an existence oracle over other people's media.
    const invisibleError = await refusal(
      resolveAttachmentContent(
        {
          repository: invisible.repository,
          actorId: ACTOR,
          signingClient: h.client,
        },
        [{ assetId: "asset-not-mine", mimeType: "image/png" }],
      ),
    );

    expect(absentError.message).toContain("not available to this user");
    expect(invisibleError.message).toBe(absentError.message);

    // The read WAS asked in both cases: the refusal is its answer, not a lookup
    // that was skipped.
    expect(absent.calls).toEqual([
      { actorId: ACTOR, assetId: "asset-missing" },
    ]);
    expect(invisible.calls).toEqual([
      { actorId: ACTOR, assetId: "asset-not-mine" },
    ]);

    // Nothing was signed, nothing was fetched, no model input was built — and no
    // table was reached through the client.
    expect(h.signCalls).toHaveLength(0);
    expect(h.tableReads()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 4: a signing refusal stops the run and returns no URL of any kind", async () => {
    const h = makeClient({ signError: { message: "permission denied" } });
    const a = assetRepository({ readable: { "asset-1": assetRow() } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusal(
      resolveAttachmentContent(
        { repository: a.repository, actorId: ACTOR, signingClient: h.client },
        [{ assetId: "asset-1", mimeType: "image/png" }],
      ),
    );

    expect(error.message).toContain("could not be authorised for reading");
    // A signed URL is a bearer token: neither the message nor the log carries one.
    expect(error.message).not.toContain("http");
    expect(f.calls).toHaveLength(0);
    // The row WAS readable, so this refusal comes from the signing step and not
    // from the read — the two must not be confused when this is debugged.
    expect(a.calls).toEqual([{ actorId: ACTOR, assetId: "asset-1" }]);
    expect(h.tableReads()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Workorder 21S: the row behind an `assetId` is read by the asset repository and
// no longer by the caller's table client. Four different ways for that read to
// come up empty have to produce ONE sentence, and the cases below compare those
// messages to EACH OTHER rather than to a literal — an edit that made two of
// them distinguishable has to fail, not merely look different.
// ---------------------------------------------------------------------------

/** Resolve one attachment against a given read answer and hand back the refusal. */
async function refusalFor(
  input: {
    repository: AssetReadRepository | undefined;
    actorId: string | undefined;
    signingClient: UserSupabaseClient;
  },
  assetId = "asset-1",
): Promise<Error> {
  return refusal(
    resolveAttachmentContent(input, [{ assetId, mimeType: "image/png" }]),
  );
}

describe("resolveAttachmentContent reads the asset row through the repository (21S)", () => {
  it("case 1: a missing repository refuses with the same sentence and reaches nothing else", async () => {
    const h = makeClient();
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusalFor({
      repository: undefined,
      actorId: ACTOR,
      signingClient: h.client,
    });

    expect(error.message).toBe(
      "attachment 1 references an asset that is not available to this user",
    );
    expect(h.signCalls).toHaveLength(0);
    expect(h.tableReads()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 2: a missing actor id refuses the same way and never asks the repository", async () => {
    const h = makeClient();
    const a = assetRepository({ readable: { "asset-1": assetRow() } });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusalFor({
      repository: a.repository,
      actorId: undefined,
      signingClient: h.client,
    });

    expect(error.message).toBe(
      "attachment 1 references an asset that is not available to this user",
    );
    // An actor-less read would be a privileged read for nobody, so it is not
    // attempted at all — and the answer still does not say why.
    expect(a.calls).toHaveLength(0);
    expect(h.signCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 3: a throwing read refuses the same way and never echoes the driver text", async () => {
    const h = makeClient();
    const a = assetRepository({ error: ASSET_DRIVER_ERROR });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusalFor({
      repository: a.repository,
      actorId: ACTOR,
      signingClient: h.client,
    });

    expect(error.message).toBe(
      "attachment 1 references an asset that is not available to this user",
    );
    // The replaced read interpolated the driver's `{code, message}` pair, and a
    // driver error can carry the statement, a host or a credential.
    expect(error.message).not.toContain("asset_objects");
    expect(error.message).not.toContain("public.");
    expect(error.message).not.toContain("$2::uuid");
    expect(error.message).not.toContain("invalid input syntax");

    // The read WAS attempted, so the refusal is its answer rather than a skipped
    // lookup — a distinction whoever debugs this next needs.
    expect(a.calls).toHaveLength(1);
    expect(h.signCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 4: no repository, no actor, a thrown read and an unreadable row are ONE answer", async () => {
    const h = makeClient();
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const mine = assetRepository({ readable: { "asset-1": assetRow() } });
    const missing = assetRepository({ readable: {} });
    const throwing = assetRepository({ error: ASSET_DRIVER_ERROR });

    const signedClient = h.client;
    const messages = [
      (
        await refusalFor({
          repository: undefined,
          actorId: ACTOR,
          signingClient: signedClient,
        })
      ).message,
      (
        await refusalFor({
          repository: mine.repository,
          actorId: undefined,
          signingClient: signedClient,
        })
      ).message,
      (
        await refusalFor({
          repository: throwing.repository,
          actorId: ACTOR,
          signingClient: signedClient,
        })
      ).message,
      (
        await refusalFor({
          repository: missing.repository,
          actorId: ACTOR,
          signingClient: signedClient,
        })
      ).message,
      // `mine` holds a row this caller MAY read and is asked for a DIFFERENT id:
      // that is "there is one, but not yours" — the case the statement has to
      // report exactly like "there is none".
      (
        await refusalFor(
          {
            repository: mine.repository,
            actorId: ACTOR,
            signingClient: signedClient,
          },
          "asset-not-mine",
        )
      ).message,
    ];

    // One distinct message across five reasons, and it is the existing sentence.
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(
      "attachment 1 references an asset that is not available to this user",
    );
    expect(messages[0]).not.toContain("public.");
    expect(h.signCalls).toHaveLength(0);
    expect(h.tableReads()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });

  it("case 5: the repository is asked with EXACTLY the actor and the asset id", async () => {
    const h = makeClient();
    const a = assetRepository({
      readable: { "asset-9": assetRow({ id: "asset-9" }) },
    });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    // The attachment carries a forged url: if the read were widened by anything
    // the request carried, the recorded ask below would show it.
    const { attachment } = attachmentWithUrlSpy(FORGED, "asset-9");
    await resolveAttachmentContent(
      { repository: a.repository, actorId: ACTOR, signingClient: h.client },
      [attachment],
    );

    expect(a.calls[0]).toEqual({ actorId: ACTOR, assetId: "asset-9" });
    // Exactly two keys: no url, no token, no client is handed to the read.
    expect(Object.keys(a.calls[0]!).sort()).toEqual(["actorId", "assetId"]);
  });

  it("case 6: a null mime_type falls through to the response content-type", async () => {
    const h = makeClient();
    // The response says webp, so an answer of `image/png` could only have come
    // from somewhere else — that is what makes the fallback observable.
    const f = makeFetch({ [OBJECT_PATH]: PNG }, "image/webp");
    vi.stubGlobal("fetch", f.impl);

    const noRowMime = assetRepository({
      readable: { "asset-1": assetRow({ mime_type: null }) },
    });
    const fromHeader = await resolveAttachmentContent(
      {
        repository: noRowMime.repository,
        actorId: ACTOR,
        signingClient: h.client,
      },
      [attachmentWithoutMime()],
    );
    expect(fromHeader.downloaded[0]!.mimeType).toBe("image/webp");

    // The row's own mime wins over the response when the request carries none…
    const rowMime = assetRepository({
      readable: { "asset-1": assetRow({ mime_type: "image/png" }) },
    });
    const fromRow = await resolveAttachmentContent(
      { repository: rowMime.repository, actorId: ACTOR, signingClient: h.client },
      [attachmentWithoutMime()],
    );
    expect(fromRow.downloaded[0]!.mimeType).toBe("image/png");

    // …and the attachment's own mime wins over both.
    const fromAttachment = await resolveAttachmentContent(
      { repository: rowMime.repository, actorId: ACTOR, signingClient: h.client },
      [{ assetId: "asset-1", mimeType: "image/gif" }],
    );
    expect(fromAttachment.downloaded[0]!.mimeType).toBe("image/gif");
  });

  it("case 7: every attachment is read on its own, and the refusal names its position", async () => {
    const h = makeClient();
    const a = assetRepository({
      readable: { "asset-a": assetRow({ id: "asset-a" }) },
    });
    const f = makeFetch({ [OBJECT_PATH]: PNG });
    vi.stubGlobal("fetch", f.impl);

    const error = await refusal(
      resolveAttachmentContent(
        { repository: a.repository, actorId: ACTOR, signingClient: h.client },
        [
          { assetId: "asset-a", mimeType: "image/png" },
          { assetId: "asset-b", mimeType: "image/png" },
        ],
      ),
    );

    // The SECOND one is the unreadable one, and the message counts in the order
    // the attachments arrived — that index is what an operator debugs with.
    expect(error.message).toBe(
      "attachment 2 references an asset that is not available to this user",
    );
    expect(a.calls).toEqual([
      { actorId: ACTOR, assetId: "asset-a" },
      { actorId: ACTOR, assetId: "asset-b" },
    ]);
    // The first attachment was fully processed before the second was refused.
    expect(h.signCount()).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
});

describe("readCanvasSummaryForRun (20C)", () => {
  it("case 1: summarises a readable canvas and asks for it with the run's own actor and canvas", async () => {
    const h = canvasRepository({
      content: { elements: [CANVAS_ELEMENT], appState: {} },
    });

    const summary = await readCanvasSummaryForRun({
      repository: h.repository,
      actorId: RUN_ACTOR,
      canvasId: RUN_CANVAS,
    });

    expect(summary).toContain("Canvas: 1 elements");
    expect(summary).toContain("el-1");
    // The repository is the authority for who is asking; a summary built for
    // somebody else's canvas would be a leak with no error attached.
    expect(h.calls).toEqual([{ actorId: RUN_ACTOR, canvasId: RUN_CANVAS }]);
  });

  it("case 2: a repository error degrades to no summary instead of failing the run", async () => {
    const h = canvasRepository({
      error: new Error("canvas read failed (findReadableCanvasContent)"),
    });

    await expect(
      readCanvasSummaryForRun({
        repository: h.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it("case 3: an unreadable canvas and an empty canvas both produce no summary", async () => {
    const denied = canvasRepository({ found: false });
    await expect(
      readCanvasSummaryForRun({
        repository: denied.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();

    const noContent = canvasRepository({ content: null });
    await expect(
      readCanvasSummaryForRun({
        repository: noContent.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();

    // A canvas whose elements are all soft-deleted has nothing to summarise.
    const allDeleted = canvasRepository({
      content: { elements: [{ ...CANVAS_ELEMENT, isDeleted: true }], appState: {} },
    });
    await expect(
      readCanvasSummaryForRun({
        repository: allDeleted.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
  });

  it("case 4: without a repository, an actor or a canvas nothing is asked at all", async () => {
    const h = canvasRepository({ content: { elements: [CANVAS_ELEMENT] } });

    await expect(
      readCanvasSummaryForRun({
        repository: undefined,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      readCanvasSummaryForRun({
        repository: h.repository,
        actorId: undefined,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      readCanvasSummaryForRun({
        repository: h.repository,
        actorId: RUN_ACTOR,
        canvasId: undefined,
      }),
    ).resolves.toBeNull();

    // An actor-less read is not a read: it must never reach the database.
    expect(h.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Workorder 21R: the canvas → project link. Two consumers with OPPOSITE
// failure disciplines read the same repository method, and that difference is
// what these cases pin down:
//
//   - `readCanvasProjectLinkForRun` feeds the brand kit and the workspace
//     skills: it must NEVER reject, because neither is worth failing a run for.
//   - `resolveCanvasProjectId` is the gate before credits are charged: it must
//     FAIL CLOSED, because a job created without its project can never have its
//     output authorised.
// ---------------------------------------------------------------------------

describe("readCanvasProjectLinkForRun (21R)", () => {
  it("case 1: returns the link, asking with the run's own actor and canvas", async () => {
    const h = canvasRepository({ link: RUN_LINK });

    const link = await readCanvasProjectLinkForRun({
      repository: h.repository,
      actorId: RUN_ACTOR,
      canvasId: RUN_CANVAS,
    });

    expect(link).toEqual(RUN_LINK);
    // The repository is the authority for who is asking; a link resolved for
    // somebody else's canvas would leak a project with no error attached.
    expect(h.linkCalls).toEqual([
      { actorId: RUN_ACTOR, canvasId: RUN_CANVAS },
    ]);
  });

  it("case 2: a link without a brand kit is returned as-is, not rejected", async () => {
    const h = canvasRepository({ link: { ...RUN_LINK, brand_kit_id: null } });

    await expect(
      readCanvasProjectLinkForRun({
        repository: h.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toEqual({ ...RUN_LINK, brand_kit_id: null });
  });

  it("case 3: a repository error never rejects, and logs fixed text with no driver detail", async () => {
    const h = canvasRepository({ linkError: DRIVER_ERROR });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const link = await readCanvasProjectLinkForRun({
      repository: h.repository,
      actorId: RUN_ACTOR,
      canvasId: RUN_CANVAS,
    });

    expect(link).toBeNull();
    // The lookup WAS attempted — the null above is the degradation, not a
    // skipped read.
    expect(h.linkCalls).toHaveLength(1);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("canvas project link lookup failed");
    expect(logged).not.toContain("public.canvases");
    expect(logged).not.toContain("$2::uuid");
    expect(logged).not.toContain("invalid input syntax");
  });

  it("case 4: an unreadable canvas is a null link, not a failure", async () => {
    const h = canvasRepository({ link: null });

    await expect(
      readCanvasProjectLinkForRun({
        repository: h.repository,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    expect(h.linkCalls).toHaveLength(1);
  });

  it("case 5: without a repository, an actor or a canvas nothing is asked and nothing rejects", async () => {
    const h = canvasRepository({ link: RUN_LINK });

    await expect(
      readCanvasProjectLinkForRun({
        repository: undefined,
        actorId: RUN_ACTOR,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      readCanvasProjectLinkForRun({
        repository: h.repository,
        actorId: undefined,
        canvasId: RUN_CANVAS,
      }),
    ).resolves.toBeNull();
    await expect(
      readCanvasProjectLinkForRun({
        repository: h.repository,
        actorId: RUN_ACTOR,
        canvasId: undefined,
      }),
    ).resolves.toBeNull();

    // A link read with no actor would be a privileged read for nobody.
    expect(h.linkCalls).toHaveLength(0);
  });
});

describe("resolveCanvasProjectId (21R)", () => {
  it("case 1: answers the project id and asks with the actor it was given", async () => {
    const h = canvasRepository({ link: RUN_LINK });

    await expect(
      resolveCanvasProjectId(
        h.repository,
        RUN_ACTOR,
        RUN_CANVAS,
        "submitImageJob",
      ),
    ).resolves.toBe(RUN_PROJECT);
    expect(h.linkCalls).toEqual([
      { actorId: RUN_ACTOR, canvasId: RUN_CANVAS },
    ]);
  });

  it("case 2: a missing repository refuses the job with the fixed code, and logs no driver text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const error = await refusal(
      resolveCanvasProjectId(undefined, RUN_ACTOR, RUN_CANVAS, "submitImageJob"),
    );

    expect(error.message).toBe("Canvas project lookup failed (canvas_read_failed)");
    expect(error.message).not.toMatch(/postgres|public\.|select|repository is not/i);
    const logged = log.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[submitImageJob] canvas project lookup failed");
    expect(logged).not.toContain("Canvas project lookup failed");
  });

  it("case 3: a throwing repository is refused the same way — fail closed, never undefined", async () => {
    const h = canvasRepository({ linkError: DRIVER_ERROR });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const error = await refusal(
      resolveCanvasProjectId(h.repository, RUN_ACTOR, RUN_CANVAS, "submitVideoJob"),
    );

    // The whole point: a read that failed must not become a job with no project.
    expect(error.message).toBe("Canvas project lookup failed (canvas_read_failed)");
    // The driver's message used to be interpolated into this one.
    expect(error.message).not.toContain("public.canvases");
    expect(error.message).not.toContain("invalid input syntax");
    expect(error.message).not.toContain("$2::uuid");
    expect(h.linkCalls).toHaveLength(1);

    const logged = log.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[submitVideoJob] canvas project lookup failed");
    expect(logged).not.toContain("public.canvases");
    expect(logged).not.toContain("invalid input syntax");
  });

  it("case 4: an unreadable canvas refuses the job with the message that was already there, verbatim", async () => {
    const h = canvasRepository({ link: null });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const error = await refusal(
      resolveCanvasProjectId(h.repository, RUN_ACTOR, RUN_CANVAS, "submitImageJob"),
    );

    expect(error.message).toBe(
      "Canvas not found or not accessible — refusing to create a job without its project",
    );
    // "not found" and "not accessible" stay indistinguishable on purpose: the
    // message must not become an existence oracle over other people's canvases.
    expect(h.linkCalls).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// 工单21AC: the three repositories reach the agent's tools, and the tool they
// build reads through them instead of a table.
//
// This is the wiring proof for `app.ts → runtime → deep-agent → tools/index`:
// every one of those layers declares the repositories as REQUIRED, so a missing
// one is a compile error, and the cases below additionally check that the very
// objects a runtime is built with are the ones the tool factory receives and the
// tool calls. Nothing here is a mock of the seam being tested — the real
// `createMainAgentTools` runs and the real `get_brand_kit` tool is invoked.
// ---------------------------------------------------------------------------

const WIRING_KIT_ID = "00000000-0000-0000-0000-0000000000b1";

/** A structurally valid JWT whose `sub` is the acting user; only the payload is read. */
const WIRING_TOKEN = `header.${Buffer.from(
  JSON.stringify({ sub: ACTOR, email: "a@t" }),
).toString("base64url")}.signature`;

const WIRING_KIT: KitDetailRow = {
  id: WIRING_KIT_ID,
  name: "Acme Brand",
  is_default: true,
  guidance_text: null,
  cover_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

const WIRING_ASSETS: BrandKitAssetRow[] = [
  {
    id: "asset-color",
    asset_type: "color",
    display_name: "Brand red",
    role: "primary",
    sort_order: 0,
    text_content: "#D4A574",
    file_url: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
];

describe("工单21AC: the Agent-side repositories are wired to the tools", () => {
  afterEach(() => {
    mainAgentToolsSpy.mockClear();
  });

  it("case 1: `createLoomicDeepAgent` passes the SAME three repository objects to the tool factory", () => {
    const assetWriteRepository = {
      async deleteOwnAsset() {
        throw new Error("deleteOwnAsset is not used by this case");
      },
    } as unknown as AssetWriteRepository;
    const brandKitReadRepository = {
      async findOwnKit() {
        return null;
      },
    } as unknown as BrandKitReadRepository;
    const canvasReadRepository = {
      async findReadableCanvasProjectLink() {
        return null;
      },
    } as unknown as CanvasReadRepository;

    createLoomicDeepAgent({
      assetWriteRepository,
      brandKitReadRepository,
      canvasReadRepository,
      backendResult: { factory: (() => ({})) as never },
      // The filesystem backend mode is the one that needs no canvas id; the model
      // is named explicitly so no provider env var is consulted.
      env: {
        agentBackendMode: "filesystem",
        agentFilesRoot: "/tmp/loomic-runtime-wiring",
        skillsRoot: "/tmp/loomic-runtime-wiring-skills",
        agentModel: "deepseek-v4-flash",
      } as unknown as ServerEnv,
      model: "openai:gpt-4o-mini",
    });

    expect(mainAgentToolsSpy).toHaveBeenCalledTimes(1);
    const deps = mainAgentToolsSpy.mock.calls[0]?.[1] as Record<string, unknown>;

    // IDENTITY, not equality: the tool factory must receive the runtime's own
    // repositories, never a copy or a second construction of them.
    expect(deps["assetWriteRepository"]).toBe(assetWriteRepository);
    expect(deps["brandKitReadRepository"]).toBe(brandKitReadRepository);
    expect(deps["canvasReadRepository"]).toBe(canvasReadRepository);
  });

  it("case 2: the `get_brand_kit` tool built from those deps answers from the repository, and never reads a table", async () => {
    const kitAsks: Array<{ actorId: string; kitId: string }> = [];
    const assetAsks: Array<{ actorId: string; kitId: string }> = [];

    const brandKitReadRepository = {
      async listOwnKits(): Promise<never> {
        throw new Error("listOwnKits is not used by this tool");
      },
      async findOwnKit(input: {
        actorId: string;
        kitId: string;
      }): Promise<KitDetailRow | null> {
        kitAsks.push({ ...input });
        return WIRING_KIT;
      },
      async listOwnKitAssets(input: {
        actorId: string;
        kitId: string;
      }): Promise<BrandKitAssetRow[]> {
        assetAsks.push({ ...input });
        return WIRING_ASSETS;
      },
      async listOwnKitFileUrls(): Promise<never> {
        throw new Error("listOwnKitFileUrls is not used by this tool");
      },
      async readNextSortOrder(): Promise<never> {
        throw new Error("readNextSortOrder is not used by this tool");
      },
      async findOwnAsset(): Promise<never> {
        throw new Error("findOwnAsset is not used by this tool");
      },
    } as unknown as BrandKitReadRepository;

    let tableReads = 0;
    const signingClient = {
      from: (table: string) => {
        tableReads += 1;
        throw new Error(`unexpected table read in runtime wiring test: ${table}`);
      },
      storage: {
        from: () => ({
          createSignedUrls: async () => ({ data: [], error: null }),
        }),
      },
    };

    const tools = createMainAgentTools({} as never, {
      assetWriteRepository: {} as unknown as AssetWriteRepository,
      brandKitReadRepository,
      canvasReadRepository: {} as unknown as CanvasReadRepository,
      brandKitId: WIRING_KIT_ID,
      createUserClient: () => signingClient as unknown as UserSupabaseClient,
    });

    const kitTool = tools.find((entry) => entry.name === "get_brand_kit");
    expect(kitTool).toBeDefined();

    const published = JSON.parse(
      String(
        await kitTool!.invoke(
          {},
          { configurable: { access_token: WIRING_TOKEN } },
        ),
      ),
    );

    // The answer came from the injected repository, asked with the token's subject.
    expect(published.kit_name).toBe("Acme Brand");
    expect(published.colors).toEqual([
      { name: "Brand red", hex: "#D4A574", role: "primary" },
    ]);
    expect(kitAsks).toEqual([{ actorId: ACTOR, kitId: WIRING_KIT_ID }]);
    expect(assetAsks).toEqual([{ actorId: ACTOR, kitId: WIRING_KIT_ID }]);
    // And the client it signs URLs with was never asked for a table.
    expect(tableReads).toBe(0);
  });
});

/**
 * AG-35 §3: the run's terminal state must not be a lie about the artifacts.
 *
 * When `run.completed` arrives the image is already on the canvas, so a status
 * row that could not be written is a persistence problem, not a failed run. The
 * cases below drive the decision function directly, because the point of the
 * extraction is that this rule is a value, not a control-flow accident buried in
 * the streaming loop.
 */
describe("eventAfterPersistFailure (AG-35 §3)", () => {
  /** The error a transport retry gives up on: a driver error with a socket code. */
  const writeError = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });

  function silenceConsoleError() {
    return vi.spyOn(console, "error").mockImplementation(() => {});
  }

  it("AG-35: a completed run whose status write failed is still completed", () => {
    const spy = silenceConsoleError();
    try {
      const completed = {
        runId: "run-1",
        timestamp: "t0",
        type: "run.completed",
      } as const;

      const next = eventAfterPersistFailure("run-1", () => "t0", completed, writeError);

      // IDENTITY: the caller re-emits the very event it was about to emit, so no
      // field can drift and the run does not turn into a failure.
      expect(next).toBe(completed);
      expect(next.type).toBe("run.completed");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("AG-35: a failed run whose failure write failed is still a run.failed", () => {
    const spy = silenceConsoleError();
    try {
      const failed = {
        error: { code: "run_failed", message: "the run itself failed" },
        runId: "run-1",
        timestamp: "t0",
        type: "run.failed",
      } as const;

      const next = eventAfterPersistFailure("run-1", () => "t1", failed, writeError);

      expect(next.type).toBe("run.failed");
      if (next.type !== "run.failed") {
        throw new Error("unreachable: narrowed above");
      }
      expect(next.error.code).toBe("run_failed");
      expect(next.runId).toBe("run-1");
    } finally {
      spy.mockRestore();
    }
  });

  it("AG-35: any other event whose write failed becomes run.failed, as before", () => {
    const spy = silenceConsoleError();
    try {
      const delta = {
        delta: "a token",
        messageId: "message-1",
        runId: "run-1",
        timestamp: "t0",
        type: "message.delta",
      } as const;

      const next = eventAfterPersistFailure("run-1", () => "t2", delta, writeError);

      expect(next.type).toBe("run.failed");
      if (next.type !== "run.failed") {
        throw new Error("unreachable: narrowed above");
      }
      expect(next.error.code).toBe("run_failed");
      expect(next.runId).toBe("run-1");
      expect(next.timestamp).toBe("t2");
    } finally {
      spy.mockRestore();
    }
  });
});
