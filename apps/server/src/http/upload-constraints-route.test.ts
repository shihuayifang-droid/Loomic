// AS-02: the upload route refuses by media type + size using the shared table,
// and refuses *before* anything reaches the upload service. The stubs below are
// the ones team-gate.test.ts uses for the same route.
import type { ViewerResponse } from "@loomic/shared";
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
const BOUNDARY = "----loomicuploadconstraint";

const MEMBER: AuthenticatedUser = {
  accessToken: MEMBER_TOKEN,
  email: "member@hahart.test",
  id: USER_ID,
  userMetadata: {},
};

let uploadCalls: Array<{ mimeType: string; byteSize: number }> = [];

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
  async uploadFile(
    _user: AuthenticatedUser,
    input: { mimeType: string; fileBuffer: Buffer; workspaceId: string },
  ) {
    uploadCalls.push({ mimeType: input.mimeType, byteSize: input.fileBuffer.length });
    return {
      asset: {
        id: "asset-1",
        bucket: "project-assets",
        objectPath: `${input.workspaceId}/file.png`,
        mimeType: input.mimeType,
        byteSize: input.fileBuffer.length,
        workspaceId: input.workspaceId,
        projectId: null,
        createdAt: new Date().toISOString(),
      },
      url: "https://example.invalid/signed",
    };
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

function multipartBody(input: {
  contentType: string;
  filename: string;
  content: Buffer;
}): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
    ),
    input.content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

function post(body: Buffer) {
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      authorization: `Bearer ${MEMBER_TOKEN}`,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: body,
  });
}

beforeEach(() => {
  uploadCalls = [];
  app = buildTestApp();
});

afterEach(async () => {
  await app.close();
});

describe("AS-02 upload constraints on POST /api/uploads", () => {
  it("AS-02: a small PNG still uploads (201)", async () => {
    const response = await post(
      multipartBody({
        contentType: "image/png",
        filename: "a.png",
        content: Buffer.from([1, 2, 3]),
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(uploadCalls.length).toBe(1);
  });

  it("AS-02: an unsupported type is a 400 with the Chinese reason and never reaches the service", async () => {
    const response = await post(
      multipartBody({
        contentType: "application/zip",
        filename: "a.zip",
        content: Buffer.from([1, 2, 3]),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upload_failed");
    expect(response.json().error.message).toBe("不支持的文件类型");
    expect(uploadCalls.length).toBe(0);
  });

  it("AS-02: an MP3 just over 15MB is a 400 音频最大 15MB", async () => {
    const response = await post(
      multipartBody({
        contentType: "audio/mpeg",
        filename: "a.mp3",
        content: Buffer.alloc(15 * 1024 * 1024 + 1),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("upload_failed");
    expect(response.json().error.message).toBe("音频最大 15MB");
    expect(uploadCalls.length).toBe(0);
  });
});
