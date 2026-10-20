// ED-00i: the browser posts the tool output it rendered itself. The route's whole
// job is the source check — a whitelisted `tool:*` reaches the service, anything
// else (including `user_upload`) is a 400 and reaches nothing. The stubs below are
// the ones upload-constraints-route.test.ts uses for the neighbouring route.
import { isToolOutputSource, type ViewerResponse } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { ViewerService } from "../features/bootstrap/ensure-user-foundation.js";
import type { ProjectService } from "../features/projects/project-service.js";
import type { TeamMembershipService } from "../features/team/team-membership.js";
import type { UploadService } from "../features/uploads/upload-service.js";
import type {
  AuthenticatedUser,
  RequestAuthenticator,
} from "../supabase/user.js";

const TEAM_ID = "11111111-1111-1111-1111-111111111111";
const PERSONAL_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "00000000-0000-0000-0000-00000000000a";
const MEMBER_TOKEN = "member-token";
const BOUNDARY = "----loomictooloutput";
const PARENT_ID = "33333333-3333-3333-3333-333333333333";

const MEMBER: AuthenticatedUser = {
  accessToken: MEMBER_TOKEN,
  email: "member@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

let toolOutputCalls: Array<{
  parentArtifactId: string;
  source: string;
  workspaceId: string;
}> = [];

const auth: RequestAuthenticator = {
  async authenticate(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    return token === MEMBER_TOKEN ? MEMBER : null;
  },
};

const membershipService: TeamMembershipService = {
  async get() {
    return {
      workspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        type: "team",
        ownerUserId: "owner-1",
      },
      role: "member",
    };
  },
  invalidate() {},
};

const viewerService: ViewerService = {
  async ensureViewer(user) {
    return {
      profile: {
        avatarUrl: null,
        displayName: "Member",
        email: user.email,
        id: user.id,
      },
      workspace: {
        id: PERSONAL_ID,
        name: "Personal",
        ownerUserId: user.id,
        type: "personal",
      },
      membership: { role: "owner", userId: user.id, workspaceId: PERSONAL_ID },
      teamWorkspace: {
        id: TEAM_ID,
        name: "HaHart 团队",
        ownerUserId: "owner-1",
        type: "team",
      },
      teamMembership: { role: "member", userId: user.id, workspaceId: TEAM_ID },
    } as unknown as ViewerResponse;
  },
};

const projectService = {
  async listProjects() {
    return [];
  },
  async createProject() {
    throw new Error("not used");
  },
  async getProject() {
    throw new Error("not used");
  },
  async updateProject() {},
  async archiveProject() {},
  async saveThumbnail() {
    throw new Error("not used");
  },
} as unknown as ProjectService;

const uploadService = {
  async uploadToolOutput(
    _user: AuthenticatedUser,
    input: {
      parentArtifactId: string;
      source: string;
      workspaceId: string;
      fileName: string;
      fileBuffer: Buffer;
      mimeType: string;
    },
  ) {
    toolOutputCalls.push({
      parentArtifactId: input.parentArtifactId,
      source: input.source,
      workspaceId: input.workspaceId,
    });
    return {
      asset: {
        id: "asset-1",
        bucket: "project-assets",
        objectPath: `${input.workspaceId}/${PARENT_ID}/123-adjusted.png`,
        mimeType: input.mimeType,
        byteSize: input.fileBuffer.length,
        workspaceId: input.workspaceId,
        projectId: null,
        createdAt: new Date().toISOString(),
      },
      url: "https://example.invalid/signed",
    };
  },
  async uploadFile() {
    throw new Error("not used");
  },
  async getAssetUrl() {
    return "https://example.invalid/signed";
  },
  async deleteAsset() {},
} as unknown as UploadService;

let app: FastifyInstance;

function buildTestApp() {
  return buildApp({
    auth,
    env: {},
    projectService,
    teamMembershipService: membershipService,
    uploadService,
    viewerService,
  });
}

/**
 * Text fields come BEFORE the file part: `request.file()` hands back the fields
 * parsed up to that point, exactly as the browser's FormData ordering does.
 */
function multipartBody(input: {
  fields: Record<string, string>;
  contentType: string;
  filename: string;
  content: Buffer;
}): Buffer {
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(input.fields)) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
    ),
  );
  parts.push(input.content);
  parts.push(Buffer.from(`\r\n--${BOUNDARY}--\r\n`));

  return Buffer.concat(parts);
}

function post(body: Buffer) {
  return app.inject({
    method: "POST",
    url: "/api/uploads/tool-output",
    headers: {
      authorization: `Bearer ${MEMBER_TOKEN}`,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: body,
  });
}

beforeEach(() => {
  toolOutputCalls = [];
  app = buildTestApp();
});

afterEach(async () => {
  await app.close();
});

describe("ED-00i tool outputs on POST /api/uploads/tool-output", () => {
  it("ED-00i: a whitelisted tool output is accepted", async () => {
    const response = await post(
      multipartBody({
        fields: { source: "tool:crop", parentArtifactId: PARENT_ID },
        contentType: "image/png",
        filename: "cropped.png",
        content: Buffer.from([1, 2, 3]),
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(toolOutputCalls).toEqual([
      {
        parentArtifactId: PARENT_ID,
        source: "tool:crop",
        workspaceId: TEAM_ID,
      },
    ]);
  });

  it("ED-00i: user_upload as a source is refused", async () => {
    const response = await post(
      multipartBody({
        fields: { source: "user_upload", parentArtifactId: PARENT_ID },
        contentType: "image/png",
        filename: "adjusted.png",
        content: Buffer.from([1, 2, 3]),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upload_failed");
    expect(response.json().error.message).toBe("不支持的工具来源");
    expect(toolOutputCalls.length).toBe(0);
  });

  it("ED-00i: a missing parent is refused", async () => {
    const response = await post(
      multipartBody({
        fields: { source: "tool:adjust" },
        contentType: "image/png",
        filename: "adjusted.png",
        content: Buffer.from([1, 2, 3]),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upload_failed");
    expect(response.json().error.message).toBe("缺少源图");
    expect(toolOutputCalls.length).toBe(0);
  });

  // T6: `packages/shared/src/upload-constraints.test.ts` is outside this
  // workorder's file whitelist, so the shared predicate is pinned here instead.
  it("ED-00i: only whitelisted tool sources pass the shared predicate", () => {
    expect(isToolOutputSource("tool:adjust")).toBe(true);
    expect(isToolOutputSource("tool:anything")).toBe(false);
    expect(isToolOutputSource("user_upload")).toBe(false);
  });
});
