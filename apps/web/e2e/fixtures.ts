import type { Page, Route } from "@playwright/test";

// All values are placeholders. No real account, token or key appears here.
export const IDS = {
  user: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  teamWorkspace: "00000000-0000-4000-8000-000000000003",
  project: "00000000-0000-4000-8000-000000000004",
  canvas: "00000000-0000-4000-8000-000000000005",
  brandKit: "00000000-0000-4000-8000-000000000006",
  session: "00000000-0000-4000-8000-000000000007",
  asset: "00000000-0000-4000-8000-000000000008",
  canvasAsset: "00000000-0000-4000-8000-000000000009",
} as const;

export const SKILL_NAMES = ["品牌海报", "电商主图"] as const;
export const MODEL_NAME = "E2E 图片模型";
export const BRAND_ASSET_NAME = "E2E 品牌素材";
export const CANVAS_IMAGE_TITLE = "E2E 画布图";

export const CANVAS_URL = `/canvas?id=${IDS.canvas}`;

/** 1x1 transparent PNG. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_BASE64}`;

/** Writes a fake self-auth session before any page script runs. */
export async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ id }) => {
      const now = Math.floor(Date.now() / 1000);
      localStorage.setItem(
        "hahart.auth.session",
        JSON.stringify({
          access_token: "e2e-placeholder-token",
          expires_at: now + 3600,
          refresh_token: "e2e-placeholder-refresh",
          refresh_expires_at: now + 86400,
          user: {
            id,
            email: "e2e@example.invalid",
            user_metadata: { full_name: "E2E" },
            must_change_password: false,
          },
        }),
      );
    },
    { id: IDS.user },
  );
}

const NOW = "2026-01-01T00:00:00.000Z";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function workspace(id: string, type: string) {
  return { id, name: "E2E Workspace", type, ownerUserId: IDS.user };
}

/**
 * The canvas the mock serves: one image element so "canvas objects" has content.
 * The file is INLINE (dataURL + assetId, no storageUrl): storage-backed files are fetched
 * and re-added to Excalidraw without their assetId, so they never reach the @ picker.
 */
function canvasContent() {
  return {
    elements: [
      {
        id: "e2e-image-1",
        type: "image",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        status: "saved",
        fileId: "e2e-file-1",
        scale: [1, 1],
        crop: null,
        customData: { title: CANVAS_IMAGE_TITLE },
      },
    ],
    appState: {},
    files: {
      "e2e-file-1": {
        id: "e2e-file-1",
        mimeType: "image/png",
        dataURL: PNG_DATA_URL,
        created: 1,
        assetId: IDS.canvasAsset,
      },
    },
  };
}

export type ApiLog = { method: string; path: string }[];

/**
 * Intercepts every /api/** request with the smallest JSON the page needs.
 * Returns the request log so a test can assert what was (not) called.
 */
export async function mockApi(page: Page): Promise<ApiLog> {
  const log: ApiLog = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    log.push({ method, path });

    if (path === "/api/viewer") {
      return json(route, {
        profile: {
          id: IDS.user,
          email: "e2e@example.invalid",
          displayName: "E2E",
        },
        workspace: workspace(IDS.workspace, "personal"),
        membership: {
          workspaceId: IDS.workspace,
          userId: IDS.user,
          role: "owner",
        },
        teamWorkspace: workspace(IDS.teamWorkspace, "team"),
        teamMembership: {
          workspaceId: IDS.teamWorkspace,
          userId: IDS.user,
          role: "owner",
        },
      });
    }
    if (path === `/api/canvases/${IDS.canvas}`) {
      if (method === "GET") {
        return json(route, {
          canvas: {
            id: IDS.canvas,
            name: "E2E Canvas",
            projectId: IDS.project,
            content: canvasContent(),
            version: 1,
          },
        });
      }
      return json(route, { version: 2 });
    }
    if (path === `/api/projects/${IDS.project}`) {
      return json(route, {
        project: {
          id: IDS.project,
          name: "E2E Project",
          slug: "e2e-project",
          description: null,
          brand_kit_id: IDS.brandKit,
        },
      });
    }
    if (path === "/api/brand-kits") {
      return json(route, { brandKits: [] });
    }
    if (path === `/api/brand-kits/${IDS.brandKit}`) {
      return json(route, {
        id: IDS.brandKit,
        name: "E2E Kit",
        is_default: true,
        guidance_text: null,
        cover_url: null,
        created_at: NOW,
        updated_at: NOW,
        assets: [
          {
            id: IDS.asset,
            asset_type: "color",
            display_name: BRAND_ASSET_NAME,
            role: null,
            sort_order: 0,
            text_content: "#112233",
            file_url: null,
            metadata: {},
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      });
    }
    if (path === "/api/credits") {
      return json(route, {
        balance: 100,
        plan: "free",
        dailyClaimed: true,
        limits: { maxConcurrentJobs: 1, maxResolution: "1080p", monthlyCredits: 0, dailyCredits: 0 },
      });
    }
    if (path.endsWith("/recoverable")) {
      return json(route, { artifacts: [] });
    }
    if (path === "/api/workspaces/skills" || path === "/api/skills") {
      const skills = SKILL_NAMES.map((name, i) => ({
        id: `skill-${i + 1}`,
        name,
        slug: `e2e-skill-${i + 1}`,
        description: `${name} 描述`,
        author: "e2e",
        version: "1.0.0",
        category: "design",
        iconName: null,
        source: "builtin",
        isFeatured: false,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
        installed: true,
        enabled: true,
      }));
      return json(route, { skills });
    }
    if (path === "/api/image-models") {
      return json(route, {
        models: [
          {
            id: "e2e-image-model",
            displayName: MODEL_NAME,
            description: "e2e model",
            provider: "e2e",
            accessible: true,
          },
        ],
      });
    }
    if (path === "/api/video-models" || path === "/api/models") {
      return json(route, { models: [] });
    }
    if (path === "/api/uploads" && method === "POST") {
      return json(
        route,
        {
          asset: {
            id: IDS.asset,
            bucket: "uploads",
            objectPath: "e2e/e2e.png",
            mimeType: "image/png",
            byteSize: 68,
            workspaceId: IDS.workspace,
            projectId: IDS.project,
            createdAt: NOW,
          },
          url: PNG_DATA_URL,
        },
        201,
      );
    }
    if (path === `/api/canvases/${IDS.canvas}/sessions`) {
      return method === "GET"
        ? json(route, { sessions: [] })
        : json(
            route,
            { session: { id: IDS.session, title: "E2E", createdAt: NOW, updatedAt: NOW } },
            201,
          );
    }
    if (/\/messages$/.test(path)) {
      return method === "GET" ? json(route, { messages: [] }) : json(route, {});
    }
    if (method === "GET") {
      // Unknown reads: an object that is also harmless when read as a list.
      return json(route, {});
    }
    return json(route, {});
  });
  return log;
}
