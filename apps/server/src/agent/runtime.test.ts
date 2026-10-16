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

import type {
  CanvasProjectLinkRow,
  CanvasReadRepository,
} from "../db/canvas-read-repository.js";
import type { UserSupabaseClient } from "../supabase/user.js";
import {
  readCanvasProjectLinkForRun,
  readCanvasSummaryForRun,
  resolveAttachmentContent,
  resolveCanvasProjectId,
} from "./runtime.js";

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
