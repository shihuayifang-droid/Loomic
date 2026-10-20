// ED-00j: what a tool is allowed to be given, and what it is refused.
//
// These cases pin the contract of the resolver: the artifact comes from an id
// through the read ACL, the signature carries no transform, and each way of
// failing has its own code. The last two matter as much as the first two — a
// tool that cannot tell "no such artifact" from "the database is down" will
// report the wrong thing to a person.
import { describe, expect, it } from "vitest";

import type { AssetReadRow, AssetReadRepository } from "../../db/asset-read-repository.js";
import type { ProjectAssetSigningClient } from "../storage/project-asset-urls.js";
import { OriginalSourceError, resolveOriginalSource } from "./original-source.js";

type Call = {
  bucket: string;
  path: string;
  expiresIn: number;
  options: { transform?: unknown; download?: unknown } | undefined;
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

function makeSigner(options: {
  signedUrl?: string;
  error?: { message: string } | null;
}) {
  const calls: Call[] = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (
            path: string,
            expiresIn: number,
            callOptions?: { transform?: unknown; download?: unknown },
          ) => {
            calls.push({ bucket, path, expiresIn, options: callOptions });
            if (options.error) return { data: null, error: options.error };
            return {
              data: {
                signedUrl:
                  options.signedUrl ??
                  `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
              },
              error: null,
            };
          },
        };
      },
    },
  };

  return { client: client as unknown as ProjectAssetSigningClient, calls };
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
    const signer = makeSigner({ signedUrl: "https://proj.test/signed/original.png?token=sig" });
    const { repository, seen } = makeRepository({ row: ROW });

    const source = await resolveOriginalSource(
      { assetReadRepository: repository, signingClient: signer.client },
      { actorId: "actor-1", artifactId: ROW.id },
    );

    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]?.options).toBeUndefined();
    expect(signer.calls[0]?.path).toBe(ROW.object_path);
    expect(source.url).toBe("https://proj.test/signed/original.png?token=sig");
    expect(source.bucket).toBe(ROW.bucket);
    expect(source.objectPath).toBe(ROW.object_path);
    expect(source.mimeType).toBe(ROW.mime_type);
    expect(source.byteSize).toBe(ROW.byte_size);
    expect(seen).toEqual([{ actorId: "actor-1", assetId: ROW.id }]);
  });

  it("ED-00j: the signed url carries no resize parameters", async () => {
    const signer = makeSigner({
      signedUrl: "https://x/storage/v1/object/sign/project-assets/a.png?token=t",
    });
    const { repository } = makeRepository({ row: ROW });

    const source = await resolveOriginalSource(
      { assetReadRepository: repository, signingClient: signer.client },
      { actorId: "actor-1", artifactId: ROW.id },
    );

    expect(source.url).not.toContain("width=");
    expect(source.url).not.toContain("height=");
    expect(source.url).not.toContain("resize");
    expect(source.url).not.toContain("render/image");
  });

  it("ED-00j: an unreadable artifact is not_found and nothing is signed", async () => {
    const signer = makeSigner({});
    const { repository } = makeRepository({ row: null });

    await expect(
      resolveOriginalSource(
        { assetReadRepository: repository, signingClient: signer.client },
        { actorId: "actor-1", artifactId: "artifact-unknown" },
      ),
    ).rejects.toMatchObject({ name: "OriginalSourceError", code: "not_found" });

    expect(signer.calls).toHaveLength(0);
  });

  it("ED-00j: a failing lookup is lookup_failed", async () => {
    const signer = makeSigner({});
    const { repository } = makeRepository({ throws: new Error("connection reset") });

    const failure = await resolveOriginalSource(
      { assetReadRepository: repository, signingClient: signer.client },
      { actorId: "actor-1", artifactId: ROW.id },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OriginalSourceError);
    expect((failure as OriginalSourceError).code).toBe("lookup_failed");
    expect(signer.calls).toHaveLength(0);
  });

  it("ED-00j: a refused signature is sign_failed and the message has no url", async () => {
    const signer = makeSigner({ error: { message: "denied" } });
    const { repository } = makeRepository({ row: ROW });

    const failure = await resolveOriginalSource(
      { assetReadRepository: repository, signingClient: signer.client },
      { actorId: "actor-1", artifactId: ROW.id },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OriginalSourceError);
    expect((failure as OriginalSourceError).code).toBe("sign_failed");
    expect((failure as OriginalSourceError).message).not.toContain("http");
    expect((failure as OriginalSourceError).message).not.toContain(ROW.object_path);
  });
});
