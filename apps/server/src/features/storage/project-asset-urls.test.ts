// X-52: the signing service is the only source of a project asset URL, and it
// NEVER falls back to a public one. These cases pin the two halves of that:
// what it signs, and what it refuses to do when signing fails.
import { describe, expect, it } from "vitest";

import {
  PROJECT_ASSET_BUCKET,
  PROJECT_ASSET_URL_TTL_SECONDS,
  ProjectAssetUrlError,
  signProjectAssetUrl,
  signProjectAssetUrls,
  type ProjectAssetSigningClient,
} from "./project-asset-urls.js";

type Call = {
  bucket: string;
  path: string;
  expiresIn: number;
  options: { transform?: unknown } | undefined;
};

function makeClient(options: {
  signedUrl?: string;
  error?: { message: string } | null;
  failing?: ReadonlySet<string>;
}) {
  const calls: Call[] = [];

  const client = {
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (
            path: string,
            expiresIn: number,
            callOptions?: { transform?: unknown },
          ) => {
            calls.push({ bucket, path, expiresIn, options: callOptions });
            if (options.error) return { data: null, error: options.error };
            if (options.failing?.has(path)) {
              return { data: null, error: { message: "Object not found" } };
            }
            return {
              data: {
                signedUrl: `${options.signedUrl ?? "https://proj.test/storage/v1/object/sign"}/${bucket}/${path}?token=sig`,
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

describe("project asset signed URLs", () => {
  it("case 1: signs the object with the default bucket and TTL", async () => {
    const stub = makeClient({});

    const url = await signProjectAssetUrl(stub.client, "ws/p/a.png");

    expect(url).toContain("token=sig");
    expect(stub.calls).toEqual([
      {
        bucket: PROJECT_ASSET_BUCKET,
        path: "ws/p/a.png",
        expiresIn: PROJECT_ASSET_URL_TTL_SECONDS,
        options: undefined,
      },
    ]);
    expect(PROJECT_ASSET_URL_TTL_SECONDS).toBe(3600);
  });

  it("case 2: passes the display transform through as a signed transform", async () => {
    const stub = makeClient({});

    await signProjectAssetUrl(stub.client, "ws/p/a.png", {
      transform: { width: 1024, height: 1024, resize: "contain" },
    });

    expect(stub.calls[0]?.options).toEqual({
      transform: { width: 1024, height: 1024, resize: "contain" },
    });
  });

  it("case 3: a signing failure throws and never yields a public URL", async () => {
    const stub = makeClient({ error: { message: "permission denied" } });

    const error = await signProjectAssetUrl(stub.client, "ws/p/secret.png")
      .then(() => null)
      .catch((thrown: unknown) => thrown as ProjectAssetUrlError);

    expect(error).toBeInstanceOf(ProjectAssetUrlError);
    expect(error?.code).toBe("sign_failed");
    // The message must not leak the path or a URL: it lands in logs.
    expect(error?.message).not.toContain("secret.png");
    expect(error?.message).not.toContain("http");
    expect(error?.message).toContain("permission denied");
  });

  it("case 4: a batch signs every signable path and reports the rest by omission", async () => {
    const stub = makeClient({ failing: new Set(["ws/p/gone.png"]) });

    const signed = await signProjectAssetUrls(stub.client, [
      "ws/p/a.png",
      "ws/p/gone.png",
      "ws/p/b.png",
      "ws/p/a.png",
    ]);

    expect([...signed.keys()].sort()).toEqual(["ws/p/a.png", "ws/p/b.png"]);
    // Duplicates are signed once.
    expect(stub.calls.filter((call) => call.path === "ws/p/a.png")).toHaveLength(1);
  });

  it("case 5: an empty batch signs nothing at all", async () => {
    const stub = makeClient({});

    const signed = await signProjectAssetUrls(stub.client, []);

    expect(signed.size).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("case 6: the bucket and TTL can be overridden by the caller", async () => {
    const stub = makeClient({});

    await signProjectAssetUrl(stub.client, "team/p/thumb.png", {
      bucket: "project-assets",
      ttlSeconds: 60,
    });

    expect(stub.calls[0]?.expiresIn).toBe(60);
  });
});
