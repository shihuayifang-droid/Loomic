import { tool } from "langchain";
import { z } from "zod";

import type {
  BrandKitAssetRow,
  BrandKitReadRepository,
  KitDetailRow,
} from "../../db/brand-kit-read-repository.js";
import { readSubject } from "./persist-sandbox-file.js";
import type { ObjectStore } from "../../features/storage/object-store.js";

const brandKitSchema = z.object({});

/**
 * `get_brand_kit` (workorder 21AC).
 *
 * Both table reads move to `BrandKitReadRepository` (workorder 21Z's module, the
 * only place a brand kit row is READ): the kit row for the project's
 * `brand_kit_id`, and that kit's asset rows. What does NOT move is the storage
 * signing below — the signed URLs of the logo/image assets still come from the
 * caller's own client, exactly as before (that belongs to workorder 22A).
 *
 * The actor is the JWT's `sub`, read with the SAME helper `persist_sandbox_file`
 * uses. It is deliberately not `configurable.user_id`: that field can disagree
 * with the token, and the token is what authorises the call.
 *
 * The owner predicate is load-bearing (T-55). `brand_kit_id` reaches this tool
 * from the canvas → project link, and an administrator can read EVERY project of
 * their workspace, so a kit id that belongs to somebody else is reachable input.
 * `findOwnKit`/`listOwnKitAssets` key on `user_id = actor` (the translated
 * `brand_kits_user_policy`), so a foreign kit answers nothing here — which is
 * also exactly what the removed user-scoped read returned once RLS refused it.
 *
 * Every failure degrades to what the old read returned instead of throwing into
 * LangChain — an exception here would abort the model's tool call, which is a
 * behaviour change this workorder does not own:
 *
 *   kit read failed / no kit / no usable subject → `{error:"Brand kit not found"}`
 *   asset read failed                            → the kit answers with no assets
 *   no access token at all                       → `{error:"No access token available"}`
 */
export function createBrandKitTool(
  deps: {
    createUserClient: (accessToken: string) => any;
    /**
     * 45AH / T-133 (2nd slice): Storage arrives as a FACTORY keyed on the
     * user-scoped client, exactly as `createBrandKitService` takes it. A shared
     * `ObjectStore` would sign with the identity its own client carries, and
     * this tool must sign as the CALLER (that is what RLS on Storage enforced
     * before the `ObjectStore` seam existed). This module therefore no longer
     * imports a backend at all — it only names the seam's type.
     */
    createObjectStore: (client: any) => ObjectStore;
    /** 工单21AC: the kit and its assets are reads of this repository. */
    brandKitReadRepository: BrandKitReadRepository;
  },
  brandKitId: string,
) {
  return tool(
    async (_input, config) => {
      const accessToken = (config as any)?.configurable?.access_token;
      if (!accessToken) {
        return JSON.stringify({ error: "No access token available" });
      }

      // The client is only needed for storage signing, and it is built here rather
      // than lazily so a broken factory fails at the same point it used to.
      const client = deps.createUserClient(accessToken);

      const actorId = readSubject(accessToken);
      if (!actorId) {
        // A token whose subject cannot be read is the same "not yours" the RLS
        // read answered for a token it could not authenticate: one answer, and it
        // is the one the model already knows how to handle.
        return JSON.stringify({ error: "Brand kit not found" });
      }

      // Fetch kit — owner-keyed, so a kit id belonging to somebody else answers
      // nothing. Every failure is the same answer the removed read gave for "no
      // row" and for "read error", because the old code did not distinguish them.
      let kit: KitDetailRow | null = null;
      try {
        kit = await deps.brandKitReadRepository.findOwnKit({
          actorId,
          kitId: brandKitId,
        });
      } catch {
        return JSON.stringify({ error: "Brand kit not found" });
      }

      if (!kit) {
        return JSON.stringify({ error: "Brand kit not found" });
      }

      // Fetch assets — a failed read used to leave `assets` null and the tool
      // published an empty asset list, so this stays that shape rather than
      // failing the whole call.
      let assets: BrandKitAssetRow[] = [];
      try {
        assets = await deps.brandKitReadRepository.listOwnKitAssets({
          actorId,
          kitId: brandKitId,
        });
      } catch {
        assets = [];
      }

      // The tool's published projection is these six columns, and only these; the
      // repository answers a ten-column row because the HTTP detail path needs all
      // of it.
      const safeAssets = assets.map((asset) => ({
        asset_type: asset.asset_type,
        display_name: asset.display_name,
        role: asset.role,
        text_content: asset.text_content,
        file_url: asset.file_url,
        metadata: asset.metadata,
      }));

      // Resolve signed URLs for file-based assets (logo/image)
      const fileAssets = safeAssets.filter((a) => a.file_url);
      if (fileAssets.length > 0) {
        const paths = fileAssets.map((a) => a.file_url as string);
        // OP-05 / 43J: the signature batch goes through the `ObjectStore` seam, so
        // this tool names no storage client method of its own — and 45AH: the store
        // is built from the CALLER's client, not from a shared one.
        const signed = await deps
          .createObjectStore(client)
          .signedReadUrls("brand-kit-assets", paths, { ttlSeconds: 3600 });

        for (const asset of fileAssets) {
          const url = signed.get(asset.file_url as string);
          if (url) asset.file_url = url;
        }
      }

      const result = {
        kit_name: kit.name,
        design_guidance: kit.guidance_text ?? "",
        colors: safeAssets
          .filter((a) => a.asset_type === "color")
          .map((a) => ({
            name: a.display_name,
            hex: a.text_content,
            role: a.role,
          })),
        fonts: safeAssets
          .filter((a) => a.asset_type === "font")
          .map((a) => ({
            name: a.display_name,
            family: a.text_content,
            weight: (a.metadata as any)?.weight ?? "400",
            role: a.role,
          })),
        logos: safeAssets
          .filter((a) => a.asset_type === "logo")
          .map((a) => ({
            name: a.display_name,
            url: a.file_url,
            role: a.role,
          })),
        images: safeAssets
          .filter((a) => a.asset_type === "image")
          .map((a) => ({
            name: a.display_name,
            url: a.file_url,
          })),
      };

      return JSON.stringify(result, null, 2);
    },
    {
      name: "get_brand_kit",
      description:
        "查询当前项目绑定的品牌套件信息，包含设计指南、颜色、字体、Logo等品牌资产。当用户提到品牌、风格、设计规范时使用此工具。",
      schema: brandKitSchema,
    },
  );
}
