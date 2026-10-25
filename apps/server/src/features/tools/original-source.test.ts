// ED-00j: what a tool is allowed to be given, and what it is refused.
//
// These cases pin the contract of the resolver: the artifact comes from an id
// through the read ACL, the signature carries no transform, and each way of
// failing has its own code. The last two matter as much as the first two — a
// tool that cannot tell "no such artifact" from "the database is down" will
// report the wrong thing to a person.
//
// T-133 slice 9: the resolver signs through an injected `ObjectStore` now, so
// the double is the shared in-memory store from `test-support` rather than a
// hand-rolled Supabase-shaped client. The behaviour assertions are unchanged;
// what the double records lets each case also pin WHICH object was signed and
// with which TTL — the part a bare "a URL came back" never checked.
import { describe, expect, it } from "vitest";

import type { AssetReadRow, AssetReadRepository } from "../../db/asset-read-repository.js";
import { createFakeObjectStore } from "../../test-support/fake-object-store.js";
import type { FakeObjectStore } from "../../test-support/fake-object-store.js";
import { ObjectStoreError } from "../storage/object-store.js";
import { PROJECT_ASSET_URL_TTL_SECONDS } from "../storage/project-asset-urls.js";
import { OriginalSourceError, resolveOriginalSource } from "./original-source.js";

type SignedCall = {
  bucket: string;
  key: string;
  ttlSeconds: number;
  transform?: unknown;
  download?: unknown;
};

const ROW: AssetReadRow = {
  id: "artifact-1",
  bucket: "project-assets",
  object_path: "ws/p/original.png",
  mime_type: "image/png",
  byte_size: 4096,
  workspace_id: "ws-1",
  project_id: "p-1",
  created_at: "2026-01-01T00:00:00.000Z",
};

/** Every signature the store was asked for, flattened for assertions. */
function signedCalls(store: FakeObjectStore): SignedCall[] {
  const calls: SignedCall[] = [];
  for (const call of store.calls) {
    if (call.method !== "signedReadUrl") continue;
    calls.push({
      bucket: call.ref.bucket,
      key: call.ref.key,
      ...call.options,
    });
  }
  return calls;
}

/**
 * A store whose backend refuses every signature, reported the way the real seam
 * reports a refusal (an `ObjectStoreError`, not a bare string).
 */
function makeRefusingStore(): FakeObjectStore {
  const store = createFakeObjectStore();
  store.signedReadUrl = async () => {
    throw new ObjectStoreError("backend_failed", "denied");
  };
  return store;
}

function makeRepository(
  behavior:
    | { row: AssetReadRow | null }
    | { throws: Error },
) {
  const seen: Array<{ actorId: string; assetId: string }> = [];

  const repository = {
    async findReadableAsset(input: { actorId: string; assetId: string }) {
      seen.push(input);
      if ("throws" in behavior) throw behavior.throws;
      return behavior.row;
    },
  } as unknown as Pick<AssetReadRepository, "findReadableAsset">;

  return { repository, seen };
}

describe("resolveOriginalSource", () => {
  it("ED-00j: the original is signed without any transform", async () => {
    const store = createFakeObjectStore();
    const { repository, seen } = makeRepository({ row: ROW });

    const source = await resolveOriginalSource(
      { assetReadRepository: repository, objectStore: store },
      { actorId: "actor-1", artifactId: ROW.id },
    );

    const calls = signedCalls(store);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bucket).toBe(ROW.bucket);
    expect(calls[0]?.key).toBe(ROW.object_path);
    expect(calls[0]?.ttlSeconds).toBe(PROJECT_ASSET_URL_TTL_SECONDS);
    expect(calls[0]?.transform).toBeUndefined();
    expect(calls[0]?.download).toBeUndefined();
    expect(source.url).toBe(
      `fake://${ROW.bucket}/${ROW.object_path}?ttl=${PROJECT_ASSET_URL_TTL_SECONDS}`,
    );
    expect(source.bucket).toBe(ROW.bucket);
    expect(source.objectPath).toBe(ROW.object_path);
    expect(source.mimeType).toBe(ROW.mime_type);
    expect(source.byteSize).toBe(ROW.byte_size);
    expect(seen).toEqual([{ actorId: "actor-1", assetId: ROW.id }]);
  });

  it("ED-00j: the signed url carries no resize parameters", async () => {
    const store = createFakeObjectStore();
    const { repository } = makeRepository({ row: ROW });

    const source = await resolveOriginalSource(
      { assetReadRepository: repository, objectStore: store },
      { actorId: "actor-1", artifactId: ROW.id },
    );

    expect(source.url).not.toContain("width=");
    expect(source.url).not.toContain("height=");
    expect(source.url).not.toContain("resize");
    expect(source.url).not.toContain("render/image");
    expect(signedCalls(store)[0]?.transform).toBeUndefined();
    expect(signedCalls(store)[0]?.download).toBeUndefined();
  });

  it("ED-00j: an unreadable artifact is not_found and nothing is signed", async () => {
    const store = createFakeObjectStore();
    const { repository } = makeRepository({ row: null });

    await expect(
      resolveOriginalSource(
        { assetReadRepository: repository, objectStore: store },
        { actorId: "actor-1", artifactId: "artifact-unknown" },
      ),
    ).rejects.toMatchObject({ name: "OriginalSourceError", code: "not_found" });

    expect(signedCalls(store)).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("ED-00j: a failing lookup is lookup_failed", async () => {
    const store = createFakeObjectStore();
    const { repository } = makeRepository({ throws: new Error("connection reset") });

    const failure = await resolveOriginalSource(
      { assetReadRepository: repository, objectStore: store },
      { actorId: "actor-1", artifactId: ROW.id },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OriginalSourceError);
    expect((failure as OriginalSourceError).code).toBe("lookup_failed");
    expect(signedCalls(store)).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("ED-00j: a refused signature is sign_failed and the message has no url", async () => {
    const store = makeRefusingStore();
    const { repository } = makeRepository({ row: ROW });

    const failure = await resolveOriginalSource(
      { assetReadRepository: repository, objectStore: store },
      { actorId: "actor-1", artifactId: ROW.id },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OriginalSourceError);
    expect((failure as OriginalSourceError).code).toBe("sign_failed");
    expect((failure as OriginalSourceError).message).not.toContain("http");
    expect((failure as OriginalSourceError).message).not.toContain(ROW.object_path);
  });
});
