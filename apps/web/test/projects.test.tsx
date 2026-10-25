// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRouter = { push: mockPush, replace: mockReplace };
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => mockRouter),
}));

const mockSignOut = vi.fn();
const mockUser = { id: "u1", email: "test@test.com" };
const mockSession = { access_token: "token_123" };
const mockAuthValue = {
  user: mockUser,
  session: mockSession,
  loading: false,
  signOut: mockSignOut,
};
vi.mock("../src/lib/auth-context", () => ({
  useAuth: vi.fn(() => mockAuthValue),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

import ProjectsPage from "../src/app/(workspace)/projects/page";
import { ToastProvider } from "../src/components/toast";

const viewerResponse = {
  profile: { id: "u1", email: "test@test.com", displayName: "Test", avatarUrl: null },
  workspace: { id: "w1", name: "My Workspace", type: "personal", ownerUserId: "u1" },
  membership: { workspaceId: "w1", userId: "u1", role: "owner" },
};

const workspace = { id: "w1", name: "My Workspace", type: "personal", ownerUserId: "u1" };

const projectsResponse = {
  projects: [
    {
      id: "p1", name: "Brand System", slug: "brand-system",
      description: "Primary brand project",
      workspace, primaryCanvas: { id: "c1", name: "Main Canvas", isPrimary: true },
      createdAt: "2026-03-23T00:00:00Z", updatedAt: "2026-03-23T10:00:00Z",
    },
    {
      id: "p2", name: "App Redesign", slug: "app-redesign",
      description: null,
      workspace, primaryCanvas: { id: "c2", name: "Main Canvas", isPrimary: true },
      createdAt: "2026-03-22T00:00:00Z", updatedAt: "2026-03-22T00:00:00Z",
    },
  ],
};

/** Body shape `createProject` expects (see the POST branch of `createProject`). */
const createdProjectResponse = {
  project: {
    id: "p-new",
    name: "Untitled",
    slug: "untitled",
    description: null,
    workspace,
    primaryCanvas: { id: "c-new", name: "Main Canvas", isPrimary: true },
    createdAt: "2026-03-24T00:00:00Z",
    updatedAt: "2026-03-24T00:00:00Z",
  },
};

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonOk(body: unknown, status = 200): MockResponse {
  return { ok: true, status, json: async () => body };
}

function jsonFail(status: number, code: string, message: string): MockResponse {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message } }),
  };
}

/**
 * URL + method aware mock: GET /api/viewer and GET /api/projects succeed,
 * POST /api/projects answers `onCreate()` (defaults to a created project).
 * Handles React 19 double-effect invocation in tests.
 */
function mockApi(opts?: {
  projects?: unknown;
  onCreate?: () => MockResponse;
}) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/api/projects") && init?.method === "POST") {
      return Promise.resolve(opts?.onCreate?.() ?? jsonOk(createdProjectResponse, 201));
    }
    if (url.includes("/api/viewer")) {
      return Promise.resolve(jsonOk(viewerResponse));
    }
    if (url.includes("/api/projects")) {
      return Promise.resolve(jsonOk(opts?.projects ?? projectsResponse));
    }
    return Promise.resolve(jsonFail(404, "not_found", "Not found"));
  });
}

/**
 * The page is mounted inside `Providers` in production, which supplies
 * `ToastProvider`. Render it the same way here instead of bare.
 */
function renderProjectsPage() {
  return render(
    <ToastProvider>
      <ProjectsPage />
    </ToastProvider>,
  );
}

/**
 * `useCreateProject` opens a preview tab with `window.open`; jsdom implements
 * it as "not implemented" and returns null. Null forces the in-page
 * `router.push` fallback, which is what these tests assert on.
 */
function stubWindowOpen() {
  return vi.spyOn(window, "open").mockReturnValue(null);
}

describe("Projects page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  /**
   * The page renders only `<ProjectList>` — there is no sidebar and no
   * component in apps/web renders `workspace.name` (checked with a repo-wide
   * search for `workspace.name` / `workspaceName` / `工作区` in src/**\/*.tsx:
   * no match), so the old "My Workspace" assertion has no implementation left
   * to cover. The list itself is asserted instead: one card per project.
   */
  it("renders one project card per project returned by the API", async () => {
    mockApi();
    renderProjectsPage();

    // One delete affordance per card — apps/web/src/components/project-list.tsx:81
    await waitFor(() => {
      expect(screen.getAllByTestId("projects-card-delete")).toHaveLength(
        projectsResponse.projects.length,
      );
    });

    // Card title — apps/web/src/components/project-list.tsx:111
    expect(screen.getByText("Brand System")).toBeInTheDocument();
    expect(screen.getByText("App Redesign")).toBeInTheDocument();

    // Each card links to its own primary canvas — project-list.tsx:75
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/canvas?id=c1");
    expect(hrefs).toContain("/canvas?id=c2");
  });

  /**
   * `ProjectList` has no dedicated empty-state element: with an empty array it
   * renders the "+ 新建项目" card and zero project cards. That is the current
   * behaviour, so it is what is asserted.
   */
  it("renders no project cards when the API returns none", async () => {
    mockApi({ projects: { projects: [] } });
    renderProjectsPage();

    // Heading — apps/web/src/components/project-list.tsx:32
    expect(
      await screen.findByRole("heading", { name: "项目" }),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("projects-card-delete")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  /**
   * There is no create dialog any more: the create card calls
   * `useCreateProject().create()` straight away, which POSTs an "Untitled"
   * project and then navigates to the new canvas.
   */
  it("creates an Untitled project and navigates to its canvas on create-card click", async () => {
    mockApi();
    const openSpy = stubWindowOpen();
    renderProjectsPage();

    // Create card — apps/web/src/components/project-list.tsx:39
    const createCard = await screen.findByRole("button", { name: /新建项目/ });
    await userEvent.click(createCard);

    // apps/web/src/hooks/use-create-project.ts:105
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/projects"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Untitled" }),
        }),
      );
    });

    // apps/web/src/hooks/use-create-project.ts:108-116
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/canvas?id=c-new");
    });
    openSpy.mockRestore();
  });

  /**
   * 401 from fetchViewer: `ApiAuthError` -> signOut + replace("/login").
   *
   * GET /api/projects must not fail in this case. The page loads both with
   * `Promise.all` (app/(workspace)/projects/page.tsx:50-55); a non-401 failure
   * from the parallel projects call rejects first and the catch sees an
   * `ApiApplicationError` instead of the `ApiAuthError` under test.
   */
  it("calls signOut and redirects on 401 from fetchViewer", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve(
          jsonFail(401, "unauthorized", "Bad token"),
        );
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve(jsonOk(projectsResponse));
      }
      return Promise.resolve(jsonFail(404, "not_found", "Not found"));
    });

    renderProjectsPage();
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("shows error banner with retry on 500 from fetchViewer — does NOT redirect", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve({
          ok: false, status: 500,
          json: async () => ({ error: { code: "bootstrap_failed", message: "Server error" } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });

    renderProjectsPage();
    // Banner text — app/(workspace)/projects/page.tsx:79
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
    // Retry button — app/(workspace)/projects/page.tsx:80
    expect(screen.getByTestId("projects-list-retry")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("calls signOut and redirects on 401 from fetchProjects", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/viewer")) {
        return Promise.resolve(jsonOk(viewerResponse));
      }
      if (url.includes("/api/projects")) {
        return Promise.resolve(
          jsonFail(401, "unauthorized", "Bad token"),
        );
      }
      return Promise.resolve(jsonFail(404, "not_found", "Not found"));
    });

    renderProjectsPage();
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith("/login");
    });
  });

  /**
   * A failed create keeps the user on the page and surfaces `toastError`
   * instead of an inline field error — apps/web/src/hooks/use-create-project.ts:127.
   */
  it("surfaces a toast on 409 project_slug_taken during create", async () => {
    mockApi({
      onCreate: () => jsonFail(409, "project_slug_taken", "Slug taken."),
    });
    const openSpy = stubWindowOpen();
    renderProjectsPage();

    const createCard = await screen.findByRole("button", { name: /新建项目/ });
    await userEvent.click(createCard);

    const toast = await screen.findByTestId("toast-item");
    // 文案来源：apps/web/src/hooks/use-create-project.ts:127
    expect(toast).toHaveTextContent("项目创建失败");
    expect(mockReplace).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("surfaces a toast on 500 project_create_failed during create", async () => {
    mockApi({
      onCreate: () => jsonFail(500, "project_create_failed", "Create failed."),
    });
    const openSpy = stubWindowOpen();
    renderProjectsPage();

    const createCard = await screen.findByRole("button", { name: /新建项目/ });
    await userEvent.click(createCard);

    const toast = await screen.findByTestId("toast-item");
    // 文案来源：apps/web/src/hooks/use-create-project.ts:127
    expect(toast).toHaveTextContent("项目创建失败");
    expect(mockReplace).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
