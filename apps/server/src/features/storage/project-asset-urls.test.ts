// X-52: the signing service is the only source of a project asset URL, and it
// NEVER falls back to a public one. These cases pin the two halves of that:
// what it signs, and what it refuses to do when signing fails.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_ASSET_BUCKET,
  PROJECT_ASSET_URL_TTL_SECONDS,
  ProjectAssetUrlError,
  signProjectAssetUrl,
  signProjectAssetUrls,
  storageRenderTransformEnabled,
  withWebpFormat,
  type ProjectAssetSigningClient,
} from "./project-asset-urls.js";

type Call = {
  bucket: string;
  path: string;
  expiresIn: number;
  options: { transform?: unknown; download?: unknown } | undefined;
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
            callOptions?: { transform?: unknown; download?: unknown },
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

  // X-52 stage 1C (工单18 T2): a mapped historical screenshot carries
  // `asset_objects.bucket = 'canvases'`, and the read path must sign in THAT bucket.
  // There is deliberately no second signing service and no bucket allowlist here:
  // whatever bucket the metadata row names is handed to the SDK verbatim. This case
  // pins the "verbatim" half; case 3 already pins the "no public fallback" half.
  it("case 7: a canvases bucket override reaches the signing SDK unchanged", async () => {
    const stub = makeClient({});

    const url = await signProjectAssetUrl(stub.client, "canvases/team/p/legacy.png", {
      bucket: "canvases",
    });

    expect(stub.calls).toEqual([
      {
        bucket: "canvases",
        path: "canvases/team/p/legacy.png",
        expiresIn: PROJECT_ASSET_URL_TTL_SECONDS,
        options: undefined,
      },
    ]);
    expect(url).toContain("/canvases/canvases/team/p/legacy.png?token=sig");
  });

  // ED-05: the object key is ASCII-mangled, so the name a person gave the file has
  // to travel beside it. `download` is how the storage service is told to answer the
  // signature with `Content-Disposition: attachment; filename*=UTF-8''…`.
  it("ED-05: a download name reaches the signing SDK as download", async () => {
    const stub = makeClient({});

    await signProjectAssetUrl(stub.client, "ws/p/a.png", {
      download: "角色-小橘.png",
    });

    expect(stub.calls[0]?.options).toEqual({ download: "角色-小橘.png" });
  });

  it("ED-05: no transform and no download still passes nothing", async () => {
    const stub = makeClient({});

    await signProjectAssetUrl(stub.client, "ws/p/a.png");

    expect(stub.calls[0]?.options).toBeUndefined();
  });
});

// GN-14: list cards and canvas tiles show a storage-side projection, never the
// stored original. The two pieces that make that possible — pinning `format=webp`
// on a signed URL and reading the renderer switch — used to be private to
// canvas-service; they now live here so the list path can use them too.
describe("GN-14 storage-side display projection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GN-14: withWebpFormat sets format=webp on a signed URL and keeps the token", () => {
    const signed =
      "https://proj.test/storage/v1/object/sign/project-assets/ws/p/a.png?token=sig";

    const url = withWebpFormat(signed);

    expect(url).toContain("token=sig");
    expect(url).toContain("format=webp");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("format")).toBe("webp");
    expect(parsed.searchParams.get("token")).toBe("sig");
  });

  it("GN-14: an unparsable URL is returned untouched", () => {
    expect(withWebpFormat("not a url at all")).toBe("not a url at all");
  });

  it("GN-14: the renderer switch reads LOOMIC_CANVAS_DISPLAY_TRANSFORM", () => {
    vi.stubEnv("LOOMIC_CANVAS_DISPLAY_TRANSFORM", "0");
    expect(storageRenderTransformEnabled()).toBe(false);

    vi.stubEnv("LOOMIC_CANVAS_DISPLAY_TRANSFORM", "off");
    expect(storageRenderTransformEnabled()).toBe(false);

    vi.unstubAllEnvs();
    expect(storageRenderTransformEnabled()).toBe(true);
  });
});

// OP-05 / 43C: the ONE signing exit now goes through the ObjectStore seam
// (`createSupabaseObjectStore(...).signedReadUrl(...)`) instead of reaching the
// storage SDK itself. Routing it through the seam is only worth anything if a
// caller cannot tell: this case pins the wire shape the backend receives — the
// bucket lookup count, and `(path, ttl, options)` down to the absent third
// argument — plus the failure wording, so a future backend swap still has to
// answer with exactly what the SDK answered before.
describe("OP-05 signing through the ObjectStore", () => {
  type Wire = {
    bucket: string;
    path: string;
    expiresIn: number;
    options: { transform?: unknown; download?: unknown } | undefined;
  };

  function makeRecordingClient(error: { message: string } | null = null) {
    const buckets: string[] = [];
    const wire: Wire[] = [];

    const client = {
      storage: {
        from(bucket: string) {
          buckets.push(bucket);
          return {
            createSignedUrl: async (
              path: string,
              expiresIn: number,
              options?: { transform?: unknown; download?: unknown },
            ) => {
              wire.push({ bucket, path, expiresIn, options });
              if (error) return { data: null, error };
              return {
                data: {
                  signedUrl: `https://proj.test/storage/v1/object/sign/${bucket}/${path}?token=sig`,
                },
                error: null,
              };
            },
          };
        },
      },
    };

    return {
      client: client as unknown as ProjectAssetSigningClient,
      buckets,
      wire,
    };
  }

  it("OP-05: signing goes through the ObjectStore", async () => {
    const plain = makeRecordingClient();

    const url = await signProjectAssetUrl(plain.client, "ws/p/a.png");

    // The bucket was looked up exactly once, and it is the default one.
    expect(plain.buckets).toEqual([PROJECT_ASSET_BUCKET]);
    // A plain signature still reaches the backend with no third argument at all.
    expect(plain.wire).toEqual([
      {
        bucket: PROJECT_ASSET_BUCKET,
        path: "ws/p/a.png",
        expiresIn: PROJECT_ASSET_URL_TTL_SECONDS,
        options: undefined,
      },
    ]);
    expect(url).toContain("token=sig");

    // Transform / download are passed when present, and only then.
    const withOptions = makeRecordingClient();
    await signProjectAssetUrl(withOptions.client, "ws/p/a.png", {
      transform: { width: 512, height: 512, resize: "contain" },
      download: "角色-小橘.png",
    });

    expect(withOptions.wire).toEqual([
      {
        bucket: PROJECT_ASSET_BUCKET,
        path: "ws/p/a.png",
        expiresIn: PROJECT_ASSET_URL_TTL_SECONDS,
        options: {
          transform: { width: 512, height: 512, resize: "contain" },
          download: "角色-小橘.png",
        },
      },
    ]);

    // A refusal keeps the exact message the callers and the logs already knew.
    const refusing = makeRecordingClient({ message: "boom" });
    const thrown = await signProjectAssetUrl(refusing.client, "ws/p/a.png")
      .then(() => null)
      .catch((error: unknown) => error as ProjectAssetUrlError);

    expect(thrown).toBeInstanceOf(ProjectAssetUrlError);
    expect(thrown?.message).toBe("Could not sign the stored object (boom).");
  });
});
