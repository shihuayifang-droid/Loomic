import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  type Database,
  assetBucketSchema,
  contentBlockSchema,
  errorCodeValues,
  healthResponseSchema,
  imageBlockSchema,
  messageCreateResponseSchema,
  messageListResponseSchema,
  runCancelResponseSchema,
  runCreateRequestSchema,
  runCreateResponseSchema,
  streamEventSchema,
} from "./index.js";
import * as sharedExports from "./index.js";

const databaseTypeSource = readFileSync(
  new URL("./supabase/database.ts", import.meta.url),
  "utf8",
);

describe("@loomic/shared contracts", () => {
  it("shares the health response schema for server and web", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      service: "loomic-server",
      version: "0.1.0",
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe("loomic-server");
  });

  it("accepts canvasId as optional field", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
      canvasId: "canvas-1",
    });
    expect(result.canvasId).toBe("canvas-1");
  });

  it("succeeds without canvasId (backward compat)", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Hello",
    });
    expect(result.canvasId).toBeUndefined();
  });

  it("accepts optional attachments in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Analyze this image",
      attachments: [
        {
          assetId: "asset-123",
          url: "https://example.com/image.png",
          mimeType: "image/png",
        },
      ],
    });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0].assetId).toBe("asset-123");
  });

  it("accepts optional image generation preference in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "Generate a campaign key visual",
      imageGenerationPreference: {
        mode: "manual",
        models: [
          "google/nano-banana-2",
          "black-forest-labs/flux-kontext-pro",
        ],
      },
    });

    expect(result.imageGenerationPreference?.mode).toBe("manual");
    expect(result.imageGenerationPreference?.models).toEqual([
      "google/nano-banana-2",
      "black-forest-labs/flux-kontext-pro",
    ]);
  });

  it("accepts optional mentions in run creation", () => {
    const result = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "参考品牌资产生成一张海报",
      mentions: [
        {
          mentionType: "image-model",
          id: "google/nano-banana-2",
          label: "Nano Banana 2",
        },
        {
          mentionType: "brand-kit-asset",
          id: "brand-logo-1",
          label: "Loomic 主 Logo",
          assetType: "logo",
          fileUrl: "https://example.com/logo.png",
        },
      ],
    });

    expect(result.mentions).toHaveLength(2);
    expect(result.mentions?.[0]?.mentionType).toBe("image-model");
    expect(result.mentions?.[1]).toMatchObject({
      mentionType: "brand-kit-asset",
      assetType: "logo",
      fileUrl: "https://example.com/logo.png",
    });
  });

  it("accepts sessionId and conversationId for run creation", () => {
    const request = runCreateRequestSchema.parse({
      sessionId: "session_123",
      conversationId: "conversation_123",
      prompt: "Create a new storyboard outline",
    });

    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      status: "accepted",
    });

    expect(request.sessionId).toBe("session_123");
    expect(response.status).toBe("accepted");
  });

  it("rejects run creation without a real sessionId", () => {
    expect(() =>
      runCreateRequestSchema.parse({
        conversationId: "conversation_123",
        prompt: "Create a new storyboard outline",
      }),
    ).toThrow();
  });

  it("shares a stable cancel response schema", () => {
    const parsed = runCancelResponseSchema.parse({
      runId: "run_123",
      status: "canceling",
    });

    expect(parsed.status).toBe("canceling");
  });

  it("shares the viewer bootstrap contract for GET /api/viewer", () => {
    const viewerResponseSchema = getExportedSchema("viewerResponseSchema");

    const parsed = viewerResponseSchema.parse({
      profile: {
        id: "user_123",
        email: "maker@loomic.test",
        displayName: "Loomic Maker",
        avatarUrl: "https://example.com/avatar.png",
      },
      workspace: {
        id: "workspace_123",
        name: "Loomic Maker",
        type: "personal",
        ownerUserId: "user_123",
      },
      membership: {
        workspaceId: "workspace_123",
        userId: "user_123",
        role: "owner",
      },
    });

    expect(parsed.profile.id).toBe("user_123");
    expect(parsed.workspace.ownerUserId).toBe("user_123");
    expect(parsed.membership.workspaceId).toBe("workspace_123");
  });

  it("shares project list and create contracts for GET/POST /api/projects", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );
    const projectCreateResponseSchema = getExportedSchema(
      "projectCreateResponseSchema",
    );

    const createRequest = projectCreateRequestSchema.parse({
      name: "Brand System",
      description: "Primary workspace project",
    });

    const parsedList = projectListResponseSchema.parse({
      projects: [
        {
          id: "project_123",
          name: createRequest.name,
          slug: "brand-system",
          description: createRequest.description,
          workspace: {
            id: "workspace_123",
            name: "Loomic Maker",
            type: "personal",
            ownerUserId: "user_123",
          },
          primaryCanvas: {
            id: "canvas_123",
            name: "Main Canvas",
            isPrimary: true,
          },
          createdAt: "2026-03-23T12:00:00.000Z",
          updatedAt: "2026-03-23T12:00:00.000Z",
        },
      ],
    });
    const createdProject = projectCreateResponseSchema.parse({
      project: parsedList.projects[0],
    });

    expect(parsedList.projects[0].id).toBe("project_123");
    expect(parsedList.projects[0].workspace.ownerUserId).toBe("user_123");
    expect(parsedList.projects[0].primaryCanvas.id).toBe("canvas_123");
    expect(createdProject.project.primaryCanvas.isPrimary).toBe(true);
  });

  it("shares stable unauthenticated and application error payloads", () => {
    const unauthenticatedErrorResponseSchema = getExportedSchema(
      "unauthenticatedErrorResponseSchema",
    );
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    const unauthenticated = unauthenticatedErrorResponseSchema.parse({
      error: {
        code: "unauthorized",
        message: "Authentication is required.",
      },
    });
    const applicationError = applicationErrorResponseSchema.parse({
      error: {
        code: "project_create_failed",
        message: "Unable to create project.",
      },
    });

    expect(unauthenticated.error.code).toBe("unauthorized");
    expect(JSON.parse(JSON.stringify(applicationError))).toEqual(
      applicationError,
    );
  });

  it("rejects an empty project name in project create requests", () => {
    const projectCreateRequestSchema = getExportedSchema(
      "projectCreateRequestSchema",
    );

    expect(() =>
      projectCreateRequestSchema.parse({
        name: "",
      }),
    ).toThrow();
  });

  it("rejects a whitespace-only project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "   " });
    expect(result.success).toBe(false);
  });

  it("trims a valid project name", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({ name: "  My Project  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("My Project");
    }
  });

  it("trims a valid project description", () => {
    const schema = getExportedSchema("projectCreateRequestSchema");
    const result = schema.safeParse({
      name: "Test",
      description: "  Some desc  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Some desc");
    }
  });

  it("rejects a project response without primary canvas metadata", () => {
    const projectListResponseSchema = getExportedSchema(
      "projectListResponseSchema",
    );

    expect(() =>
      projectListResponseSchema.parse({
        projects: [
          {
            id: "project_123",
            name: "Brand System",
            slug: "brand-system",
            description: "Primary workspace project",
            workspace: {
              id: "workspace_123",
              name: "Loomic Maker",
              type: "personal",
              ownerUserId: "user_123",
            },
            createdAt: "2026-03-23T12:00:00.000Z",
            updatedAt: "2026-03-23T12:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid application error codes", () => {
    const applicationErrorResponseSchema = getExportedSchema(
      "applicationErrorResponseSchema",
    );

    expect(() =>
      applicationErrorResponseSchema.parse({
        error: {
          code: "database_exploded",
          message: "Unexpected failure.",
        },
      }),
    ).toThrow();
  });

  it("includes the required minimum stream event union", () => {
    const eventTypes = [
      "run.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "run.canceled",
      "run.completed",
      "run.failed",
    ];

    for (const type of eventTypes) {
      expect(() => {
        switch (type) {
          case "run.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              sessionId: "session_123",
              conversationId: "conversation_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "message.delta":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              messageId: "message_123",
              delta: "hello",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.started":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "tool.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              toolCallId: "tool_123",
              toolName: "example_tool",
              outputSummary: "done",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.completed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.canceled":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          case "run.failed":
            streamEventSchema.parse({
              type,
              runId: "run_123",
              error: {
                code: "run_failed",
                message: "The run failed.",
              },
              timestamp: "2026-03-23T12:00:00.000Z",
            });
            break;
          default:
            throw new Error(`Unexpected event type: ${type}`);
        }
      }).not.toThrow();
    }
  });

  it("keeps stable messageId and toolCallId correlation fields", () => {
    const messageEvent = streamEventSchema.parse({
      type: "message.delta",
      runId: "run_123",
      messageId: "message_123",
      delta: "hello",
      timestamp: "2026-03-23T12:00:00.000Z",
    });

    const toolEvent = streamEventSchema.parse({
      type: "tool.completed",
      runId: "run_123",
      toolCallId: "tool_123",
      toolName: "project_search",
      outputSummary: "Matched 2 files",
      timestamp: "2026-03-23T12:00:01.000Z",
    });

    if (messageEvent.type !== "message.delta") {
      throw new Error("Expected message.delta event.");
    }

    if (toolEvent.type !== "tool.completed") {
      throw new Error("Expected tool.completed event.");
    }

    expect(messageEvent.messageId).toBe("message_123");
    expect(toolEvent.toolCallId).toBe("tool_123");
  });

  it("requires correlation fields for message and tool lifecycle events", () => {
    expect(() =>
      streamEventSchema.parse({
        type: "message.delta",
        runId: "run_123",
        delta: "hello",
        timestamp: "2026-03-23T12:00:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      streamEventSchema.parse({
        type: "tool.completed",
        runId: "run_123",
        toolName: "project_search",
        outputSummary: "Matched 2 files",
        timestamp: "2026-03-23T12:00:01.000Z",
      }),
    ).toThrow();
  });

  it("exports stable error codes that serialize as plain JSON", () => {
    expect(errorCodeValues).toEqual([
      "invalid_request",
      "run_not_found",
      "run_conflict",
      "run_failed",
      "tool_failed",
    ]);
    expect(JSON.parse(JSON.stringify(errorCodeValues))).toEqual(
      errorCodeValues,
    );
  });

  it("keeps run creation response stable for clients while hiding checkpoint internals", () => {
    const response = runCreateResponseSchema.parse({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
      checkpointId: "checkpoint_123",
      checkpointNamespace: "root",
    });

    expect(response).toEqual({
      runId: "run_123",
      sessionId: "session_123",
      conversationId: "conversation_123",
      status: "accepted",
    });
  });

  it("tracks server-owned thread_id in shared Supabase typings", () => {
    expect(databaseTypeSource).toMatch(/thread_id:\s*string \| null/);
  });

  it("declares shared agent_runs persistence typings", () => {
    expect(databaseTypeSource).toMatch(/agent_runs:\s*{/);
    expect(databaseTypeSource).toMatch(/session_id:\s*string/);
    expect(databaseTypeSource).toMatch(/thread_id:\s*string/);
  });

  it("tracks official langgraph persistence schema typings", () => {
    expect(databaseTypeSource).toMatch(/langgraph:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_migrations:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoints:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_blobs:\s*{/);
    expect(databaseTypeSource).toMatch(/checkpoint_writes:\s*{/);
    expect(databaseTypeSource).toMatch(/store:\s*{/);
  });
});

type AssertTrue<T extends true> = T;
type Extends<T, U> = [T] extends [U] ? true : false;

const chatSessionRowSupportsServerOwnedThreadId: AssertTrue<
  Extends<
    Database["public"]["Tables"]["chat_sessions"]["Row"],
    { thread_id: string | null }
  >
> = true;

const agentRunsRowTracksSessionAndThread: AssertTrue<
  Extends<
    Database["public"]["Tables"]["agent_runs"]["Row"],
    {
      session_id: string;
      thread_id: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      error_code: string | null;
      error_message: string | null;
    }
  >
> = true;

void chatSessionRowSupportsServerOwnedThreadId;
void agentRunsRowTracksSessionAndThread;

const langgraphCheckpointsRowMatchesOfficialSchema: AssertTrue<
  Extends<
    Database["langgraph"]["Tables"]["checkpoints"]["Row"],
    {
      thread_id: string;
      checkpoint_ns: string;
      checkpoint_id: string;
      checkpoint: unknown;
      metadata: unknown;
    }
  >
> = true;

void langgraphCheckpointsRowMatchesOfficialSchema;

function getExportedSchema(name: string): ZodType {
  const candidate = (sharedExports as Record<string, unknown>)[name];

  expect(candidate, `${name} export is missing`).toBeDefined();

  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("parse" in candidate) ||
    typeof candidate.parse !== "function"
  ) {
    throw new Error(`${name} is not a Zod schema export.`);
  }

  return candidate as ZodType;
}

// ---------------------------------------------------------------------------
// X-52 (工单14 fixup T2): a media block with an identity but no url is a LEGAL
// response, and the HTTP contracts have to say so.
//
// `chat-service` strips the read-time url before writing and re-signs on every
// read. When signing fails — invisible under RLS, object gone, storage refusing
// — the honest answer is the block WITHOUT a url: the url already in the row is
// a token that used to work, and re-serving it is the forbidden "回退旧URL".
// With `url` required, that safe answer failed `messageListResponseSchema.parse`
// and `messageCreateResponseSchema.parse`, so the route 500'd on a state it had
// deliberately produced.
//
// These cases pin all three shapes the ticket names, plus the boundary that must
// NOT move: optional is not the same as unvalidated.
// ---------------------------------------------------------------------------
describe("X-52 media block contracts (工单14 fixup T2)", () => {
  const SIGNED =
    "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/a.png?token=fresh";

  it("shape 1: an image block WITH a url still parses (a live projection)", () => {
    const parsed = imageBlockSchema.parse({
      type: "image",
      assetId: "asset-1",
      url: SIGNED,
      thumbnailUrl: SIGNED,
      mimeType: "image/png",
      source: "upload",
      name: "a.png",
    });

    expect(parsed.url).toBe(SIGNED);
    expect(parsed.thumbnailUrl).toBe(SIGNED);
  });

  it("shape 2: a stable image block with NO url parses — 'not projectable' is not malformed", () => {
    const parsed = imageBlockSchema.parse({
      type: "image",
      assetId: "asset-1",
      objectPath: "ws-team/p/a.png",
      mimeType: "image/png",
      source: "upload",
    });

    expect(parsed.url).toBeUndefined();
    expect(parsed.thumbnailUrl).toBeUndefined();
    // The identity survives the parse, so a client can still tell WHICH asset it
    // could not project — and can retry once a signature is available.
    expect(parsed.assetId).toBe("asset-1");
    expect(parsed.objectPath).toBe("ws-team/p/a.png");
    expect(parsed.source).toBe("upload");
  });

  it("shape 3: a historical URL-only image artifact still parses (pre-X-52 media)", () => {
    // Tool artifacts are the one media shape that predates `assetId`: their
    // schema declares the identity optional precisely so a row written before
    // the cutover is still readable. Dropping the url there would blank every
    // old generated image, so the compatibility strategy is "read it as stored".
    const parsed = contentBlockSchema.parse({
      type: "tool",
      toolCallId: "call-1",
      toolName: "generate_image",
      status: "completed",
      artifacts: [
        {
          type: "image",
          url: "https://cdn.test/legacy.png",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
        },
      ],
    });

    expect(parsed.type).toBe("tool");
    if (parsed.type !== "tool") throw new Error("expected a tool block");
    expect(parsed.artifacts?.[0]).toMatchObject({
      type: "image",
      url: "https://cdn.test/legacy.png",
    });
  });

  it("boundary: url became OPTIONAL, not unvalidated — an empty string is still rejected", () => {
    // The browser hook used to stand in for a missing url with "", which is not
    // a url at all. That is exactly the fabricated projection this ticket
    // removes, so the field must not quietly start accepting it.
    expect(
      imageBlockSchema.safeParse({
        type: "image",
        assetId: "asset-1",
        url: "",
        mimeType: "image/png",
        source: "upload",
      }).success,
    ).toBe(false);

    expect(
      imageBlockSchema.safeParse({
        type: "image",
        assetId: "asset-1",
        url: "not-a-url",
        mimeType: "image/png",
        source: "upload",
      }).success,
    ).toBe(false);
  });

  it("both message response contracts parse a url-less stable block", () => {
    const message = {
      id: "message-1",
      role: "user" as const,
      content: "look",
      contentBlocks: [
        {
          type: "image" as const,
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          source: "upload" as const,
        },
      ],
      createdAt: "2026-10-12T00:00:00.000Z",
    };

    // The two parses that used to turn a safe server-side outcome into a 500,
    // on GET /api/sessions/:id/messages and on message creation respectively.
    const list = messageListResponseSchema.parse({ messages: [message] });
    const created = messageCreateResponseSchema.parse({ message });

    const listBlock = list.messages[0]?.contentBlocks?.[0] as Record<string, unknown>;
    const createdBlock = created.message.contentBlocks?.[0] as Record<string, unknown>;
    expect(listBlock.url).toBeUndefined();
    expect(listBlock.assetId).toBe("asset-1");
    expect(createdBlock.url).toBeUndefined();
    expect(createdBlock.assetId).toBe("asset-1");
  });

  it("the attachment contract no longer demands a url the server ignores", () => {
    // 工单14 fixup T1: `assetId` is the authority, so a client that has an
    // identity but no live projection must still be able to submit — and an
    // absent url must not be confused with a mismatched one.
    const parsed = runCreateRequestSchema.parse({
      sessionId: "session-1",
      conversationId: "conv-1",
      prompt: "继续这个构图",
      attachments: [
        { assetId: "asset-1", mimeType: "image/png" },
        { assetId: "asset-2", url: SIGNED, mimeType: "image/png", name: "b.png" },
      ],
    });

    expect(parsed.attachments?.[0]?.assetId).toBe("asset-1");
    expect(parsed.attachments?.[0]?.url).toBeUndefined();
    // A url that IS present is still checked, so an older client is not silently
    // accepted with a malformed one.
    expect(parsed.attachments?.[1]?.url).toBe(SIGNED);
    expect(
      runCreateRequestSchema.safeParse({
        sessionId: "session-1",
        conversationId: "conv-1",
        prompt: "x",
        attachments: [{ assetId: "asset-1", url: "not-a-url", mimeType: "image/png" }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// X-52 (工单14 fixup2): a TOOL block's artifacts close the same hole the image
// block closed in fixup T2.
//
// `chat-service.projectBlockUrls()` strips the url from an artifact that names
// an asset and re-signs it on every read; when the caller may not read the asset
// or the signer refuses, the artifact it returns deliberately has NO url. With
// `url` required, `toolArtifactSchema` rejected that answer, so the block that
// `listMessages` had just built failed the response parse — a 500 produced by
// the very code path that exists to answer safely. These cases pin the three
// shapes through `toolBlockSchema` and both message response contracts, plus
// the boundary that must NOT move: no url is only legal with an identity.
// ---------------------------------------------------------------------------
describe("X-52 tool artifact contracts (工单14 fixup2)", () => {
  const SIGNED =
    "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/a.png?token=fresh";
  const STALE =
    "https://proj.test/storage/v1/object/sign/project-assets/ws-team/p/a.png?token=stale";

  const toolBlock = (artifacts: unknown[]) => ({
    type: "tool" as const,
    toolCallId: "call-1",
    toolName: "generate_image",
    status: "completed" as const,
    artifacts,
  });

  const message = (block: unknown) => ({
    id: "message-1",
    role: "assistant" as const,
    content: "look",
    contentBlocks: [block],
    createdAt: "2026-10-12T00:00:00.000Z",
  });

  it("shape 1: an image tool artifact with a url still parses (a live projection)", () => {
    const parsed = contentBlockSchema.parse(
      toolBlock([
        {
          type: "image",
          url: SIGNED,
          assetId: "asset-1",
          objectPath: "ws-team/p/a.png",
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
      ]),
    );

    expect(parsed.type).toBe("tool");
    if (parsed.type !== "tool") throw new Error("expected a tool block");
    expect(parsed.artifacts?.[0]).toMatchObject({
      type: "image",
      url: SIGNED,
      assetId: "asset-1",
    });
  });

  it("shape 2: a stable image artifact with NO url parses — and the stale url is not re-served", () => {
    // Exactly what `projectBlockUrls` returns for an un-signable asset: the
    // stored url is dropped rather than re-served.
    const parsed = contentBlockSchema.parse(
      toolBlock([
        {
          type: "image",
          assetId: "asset-locked",
          objectPath: "ws-team/p/secret.png",
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
      ]),
    );

    if (parsed.type !== "tool") throw new Error("expected a tool block");
    const artifact = parsed.artifacts?.[0] as Record<string, unknown>;
    expect(artifact.url).toBeUndefined();
    expect(artifact.assetId).toBe("asset-locked");
    expect(artifact.objectPath).toBe("ws-team/p/secret.png");
    expect(JSON.stringify(parsed)).not.toContain("token=stale");
  });

  it("shape 3: a stable VIDEO tool artifact with NO url parses", () => {
    const parsed = contentBlockSchema.parse({
      type: "tool",
      toolCallId: "call-2",
      toolName: "generate_video",
      status: "completed",
      artifacts: [
        {
          type: "video",
          assetId: "asset-locked-video",
          objectPath: "ws-team/p/secret.mp4",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
          durationSeconds: 5,
        },
      ],
    });

    if (parsed.type !== "tool") throw new Error("expected a tool block");
    const artifact = parsed.artifacts?.[0] as Record<string, unknown>;
    expect(artifact.type).toBe("video");
    expect(artifact.url).toBeUndefined();
    expect(artifact.assetId).toBe("asset-locked-video");
  });

  it("shape 4: a historical URL-only tool artifact still parses (pre-X-52 media)", () => {
    const parsed = contentBlockSchema.parse(
      toolBlock([
        {
          type: "image",
          url: STALE,
          mimeType: "image/png",
          width: 1024,
          height: 1024,
        },
      ]),
    );

    if (parsed.type !== "tool") throw new Error("expected a tool block");
    expect(parsed.artifacts?.[0]).toMatchObject({ type: "image", url: STALE });
  });

  it("boundary: no url AND no assetId is still refused, on every artifact type", () => {
    // "Optional url" must not become "anything goes": without an assetId there
    // is no identity left to re-derive a projection from on a later read.
    expect(
      contentBlockSchema.safeParse(
        toolBlock([
          { type: "image", mimeType: "image/png", width: 512, height: 512 },
        ]),
      ).success,
    ).toBe(false);

    expect(
      contentBlockSchema.safeParse(
        toolBlock([
          { type: "video", mimeType: "video/mp4", width: 1280, height: 720 },
        ]),
      ).success,
    ).toBe(false);

    // And an empty string is not a url, with or without an identity.
    expect(
      contentBlockSchema.safeParse(
        toolBlock([
          {
            type: "image",
            url: "",
            assetId: "asset-1",
            mimeType: "image/png",
            width: 512,
            height: 512,
          },
        ]),
      ).success,
    ).toBe(false);
  });

  it("both message response contracts parse a url-less stable TOOL artifact", () => {
    // The two parses that used to turn the safe server-side outcome into a 500,
    // on GET /api/sessions/:id/messages and on message creation respectively —
    // this time for artifacts rather than image blocks.
    const block = message(
      toolBlock([
        {
          type: "image",
          assetId: "asset-locked",
          objectPath: "ws-team/p/secret.png",
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
        {
          type: "video",
          assetId: "asset-locked-video",
          objectPath: "ws-team/p/secret.mp4",
          mimeType: "video/mp4",
          width: 1280,
          height: 720,
        },
      ]),
    );

    const list = messageListResponseSchema.parse({ messages: [block] });
    const created = messageCreateResponseSchema.parse({ message: block });

    const listArtifacts = (
      list.messages[0]?.contentBlocks?.[0] as { artifacts?: Array<Record<string, unknown>> }
    ).artifacts;
    const createdArtifacts = (
      created.message.contentBlocks?.[0] as { artifacts?: Array<Record<string, unknown>> }
    ).artifacts;

    expect(listArtifacts?.[0]?.url).toBeUndefined();
    expect(listArtifacts?.[0]?.assetId).toBe("asset-locked");
    expect(listArtifacts?.[1]?.url).toBeUndefined();
    expect(listArtifacts?.[1]?.assetId).toBe("asset-locked-video");
    expect(createdArtifacts?.[0]?.url).toBeUndefined();
    expect(createdArtifacts?.[0]?.assetId).toBe("asset-locked");
    expect(createdArtifacts?.[1]?.assetId).toBe("asset-locked-video");
  });
});

// ---------------------------------------------------------------------------
// X-52 stage 1C (工单18 T2): the legacy `canvases` bucket joins the asset bucket
// contract.
//
// WHY: after the cutover migration, a historical screenshot object may carry a
// precise `asset_objects` row with `bucket = 'canvases'`, and the read path signs
// exactly what that row says. If the contract refused the value, `assetObjectSchema`
// would reject the very rows the cutover creates — the signature path would be
// unreachable through the shared types.
//
// THE BOUNDARY THAT MUST NOT MOVE: `canvases` is readable, not writable. The bucket
// keeps no client INSERT policy after the cutover, so widening this enum cannot
// reopen an upload entry point — and an unknown bucket is still rejected, so this
// is an enumerated list, not a free-text field.
// ---------------------------------------------------------------------------
describe("X-52 asset bucket contract (工单18 T2)", () => {
  it("accepts the legacy canvases bucket for reads while the two write buckets are unchanged", () => {
    // The two pre-existing values must keep parsing (no silent rename).
    expect(assetBucketSchema.parse("project-assets")).toBe("project-assets");
    expect(assetBucketSchema.parse("user-avatars")).toBe("user-avatars");
    // The added value, as the cutover migration records it.
    expect(assetBucketSchema.parse("canvases")).toBe("canvases");
    // And the enum stays closed: an unmapped bucket is not a valid asset row.
    expect(assetBucketSchema.safeParse("home-seeds").success).toBe(false);
    expect(assetBucketSchema.options).toEqual([
      "project-assets",
      "user-avatars",
      "canvases",
    ]);
  });
});
