"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, Suspense } from "react";

import type { ImageArtifact, VideoArtifact } from "@loomic/shared";
import type { CanvasImageItem } from "../../components/canvas-image-picker";
import type { CanvasSelectedElement } from "../../components/canvas-editor";
import { LoadingScreen } from "../../components/loading-screen";
import { useAuth } from "../../lib/auth-context";
import { useWebSocket } from "../../hooks/use-websocket";
import { useJobFallbackPolling } from "../../hooks/use-job-fallback-polling";
import { CanvasEditor } from "../../components/canvas-editor";
import { ChatSidebar } from "../../components/chat-sidebar";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { EditableProjectName } from "../../components/editable-project-name";
import {
  insertImageOnCanvas,
  insertVideoOnCanvas,
  focusGeneratingSlots,
} from "../../lib/canvas-elements";
import { syncCanvasFilesIntoScene } from "../../lib/canvas-files";
import {
  createCanvasMediaRefresh,
  isStorageMediaUrl,
  type CanvasMediaRefresh,
} from "../../lib/canvas-media-refresh";
import {
  fetchCanvas,
  fetchProject,
  ApiAuthError,
  ApiApplicationError,
} from "../../lib/server-api";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import { CanvasBottomBar } from "../../components/canvas-bottom-bar";
import { CanvasFilesPanel } from "../../components/canvas-files-panel";
import { CanvasLayersPanel } from "../../components/canvas-layers-panel";
import { CreditHeaderButton } from "../../components/credits/credit-header-button";

function CanvasPageContent() {
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const initialSessionId = searchParams.get("session") ?? undefined;
  // Capture prompt once — router.replace will strip it from URL, but the
  // value must survive for the auto-send effect in ChatSidebar.
  const [initialPrompt] = useState(() => searchParams.get("prompt") ?? undefined);
  const { user, session, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
    /**
     * Server's optimistic concurrency counter, handed to CanvasEditor as
     * initialVersion. Declared here because this local shape is what the reads
     * below are checked against — leaving it out made `canvasData.version` a type
     * error while the value was in fact present at runtime.
     */
    version?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the failure above is worth another attempt (5xx / no response). */
  const [errorRetryable, setErrorRetryable] = useState(false);
  /** Bumped by the retry button to re-run the load effect. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pageLoading, setPageLoading] = useState(true);
  // Default chat open on desktop, closed on mobile/tablet to avoid blocking canvas
  const [chatOpen, setChatOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1024;
  });
  const [layersOpen, setLayersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("Untitled");
  const [selectedCanvasElements, setSelectedCanvasElements] = useState<CanvasSelectedElement[]>([]);

  const excalidrawApiRef = useRef<any>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<any>(null);
  // X-52: one dedupe instance for the whole page, so the same expired URL cannot
  // ask for a refresh twice (each ask is a full canvas read). A ref, not state:
  // a re-render must not hand the editor a brand new instance, which would let
  // an element that keeps erroring refresh over and over. The budget that bounds
  // the loop (5 real refreshes per page load) lives inside this instance and is
  // charged only when a refresh actually starts — the page must NOT pre-deduct
  // it, or repeating an already-known-bad URL would spend refreshes it never
  // asked for.
  const mediaRefreshRef = useRef<CanvasMediaRefresh | null>(null);
  if (mediaRefreshRef.current === null) {
    mediaRefreshRef.current = createCanvasMediaRefresh();
  }
  // X-52: the canvas.sync path (WebSocket, job fallback, Chat) resolves the same
  // storage URLs the first editor load does, so it has to reach the SAME refresh
  // callback. handleCanvasSync is declared first and handleStorageMediaError is
  // built on top of it, so the two would otherwise be circular; the ref breaks
  // the cycle exactly the way canvas-editor does it, and keeps the callback
  // current across re-renders.
  const storageMediaErrorRef = useRef<((url: string) => void) | null>(null);
  // Generation slots we have already auto-focused. Keeps a batch of images from
  // repeatedly dragging the viewport back on every canvas.sync.
  const focusedSlotsRef = useRef<Set<string>>(new Set());

  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable callbacks for panel toggles to prevent re-renders of child components
  const handleOpenChat = useCallback(() => setChatOpen(true), []);
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const handleToggleLayers = useCallback(() => { setLayersOpen((v) => !v); setFilesOpen(false); }, []);
  const handleToggleFiles = useCallback(() => { setFilesOpen((v) => !v); setLayersOpen(false); }, []);
  const handleCloseLayers = useCallback(() => setLayersOpen(false), []);
  const handleCloseFiles = useCallback(() => setFilesOpen(false), []);

  const accessToken = session?.access_token;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const getToken = useCallback(() => accessTokenRef.current ?? null, []);
  const ws = useWebSocket(getToken);

  const handleApiReady = useCallback((api: any) => {
    excalidrawApiRef.current = api;
    setExcalidrawApi(api);
  }, []);

  const handleImageGenerated = useCallback((artifact: ImageArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertImageOnCanvas(api, artifact).catch((err) => {
      console.warn("Failed to insert image on canvas:", err);
    });
  }, []);

  const handleVideoGenerated = useCallback((artifact: VideoArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertVideoOnCanvas(api, artifact).catch((err) => {
      // CV-01: warn only — never fall back to inserting the URL. A video that
      // cannot be keyed on a stored object is dropped rather than persisted as a
      // public URL, and the two causes are worth telling apart in the console:
      // a missing objectPath means the server never recorded the stored object.
      console.warn(
        typeof artifact.objectPath === "string" && artifact.objectPath.length > 0
          ? "Failed to insert video on canvas:"
          : "Video artifact has no objectPath — refusing to insert a URL-backed element:",
        err,
      );
    });
  }, []);

  // Must be defined BEFORE useJobFallbackPolling which references it
  const handleCanvasSync = useCallback(async () => {
    const api = excalidrawApiRef.current;
    const token = accessTokenRef.current;
    if (!api || !token || !canvasData) return;
    try {
      const { canvas } = await fetchCanvas(token, canvasData.id);
      const elements = canvas.content.elements ?? [];
      const files = (canvas.content as Record<string, unknown>).files as
        Record<string, { id: string; dataURL: string; mimeType: string; created: number }> | undefined;

      // Files arrive as storage URLs, not bytes — they must be fetched before
      // Excalidraw can draw them. Awaiting this BEFORE updateScene means the
      // element and its pixels land together, instead of flashing a
      // broken-image box.
      //
      // The failure callback goes with it: a sync that hands over a file whose
      // signature has expired must be able to ask for a re-read, exactly like
      // the first editor load does. Both paths share the one callback below.
      if (files && Object.keys(files).length > 0) {
        await syncCanvasFilesIntoScene(api, files, elements, canvasData.id, (url) => {
          storageMediaErrorRef.current?.(url);
        });
      }

      api.updateScene({ elements, captureUpdate: "IMMEDIATELY" });

      // Move the viewport onto whatever is being generated, so the user does not
      // have to hunt for it. Runs after updateScene because scrollToContent
      // resolves element bounds from the live scene.
      focusGeneratingSlots(api, elements, focusedSlotsRef.current);
    } catch (err) {
      console.warn("Failed to sync canvas:", err);
    }
  }, [canvasData]);

  // X-52: a canvas media element reports a load failure here — from the first
  // editor load and from every canvas.sync alike. The refresh IS the existing
  // sync above — re-reading the canvas through the API and pushing the resolved
  // files back into the scene is the only flow that turns stored `oss://` markers
  // into freshly signed URLs. Deliberately nothing else: no page reload, no retry
  // of the dead URL, no public-URL fallback.
  const handleStorageMediaError = useCallback(
    (url: string) => {
      // A provider CDN link that failed (pre-CV-01 video elements carry one) is
      // not something a re-read of the canvas can repair.
      if (!isStorageMediaUrl(url)) return;

      // No budget check here on purpose. The refresher dedupes the URL first and
      // only then charges its 5-refresh bound, so an element that keeps reporting
      // the same dead URL costs nothing; once the bound is reached it stops
      // issuing requests by itself. Pre-deducting here is what let five reports of
      // one broken image exhaust every future refresh.
      void mediaRefreshRef.current
        ?.reportFailure(url, handleCanvasSync)
        .then((outcome) => {
          // Only the call that actually started a refresh warns, so an element
          // that keeps erroring cannot flood the console; the module already
          // ignores every repeat of the same failed URL. The URL is never logged
          // — while its signature is valid it is a bearer token.
          if (outcome === "refreshed") {
            console.warn(
              "[canvas] canvas media failed to load; re-reading the canvas for fresh URLs",
            );
          }
        });
    },
    [handleCanvasSync],
  );
  // Keep the ref current for the sync path declared above.
  storageMediaErrorRef.current = handleStorageMediaError;

  // Fallback polling for timed-out generation jobs.
  // When the agent's tool times out but the worker eventually succeeds,
  // the backend will have already inserted the element into the canvas.
  // This hook detects completion and triggers a canvas re-fetch.
  const { checkForTimedOutJobs } = useJobFallbackPolling({
    accessTokenRef,
    onJobSucceeded: useCallback((_jobId: string, _jobType: string) => {
      // Element was inserted by backend — just refresh the canvas
      handleCanvasSync();
    }, [handleCanvasSync]),
  });

  const handleSessionChange = useCallback(
    (sessionId: string) => {
      if (!canvasId) return;
      // Update URL: set session param, remove prompt param to prevent re-send on refresh
      routerRef.current.replace(`/canvas?id=${canvasId}&session=${sessionId}`);
    },
    [canvasId],
  );

  // Clicking a thumbnail in the chat input pans the canvas to that element, so
  // the user can confirm which of several similar images they are referencing.
  const handleFocusCanvasElement = useCallback((elementId: string) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    const target = (api.getSceneElements() ?? []).find(
      (el: any) => el.id === elementId && !el.isDeleted,
    );
    if (!target) return;
    api.scrollToContent([target], {
      fitToViewport: true,
      viewportZoomFactor: 0.6,
      maxZoom: 1,
      animate: true,
      duration: 400,
    });
  }, []);

  /**
   * The canvas images the user may reference in a prompt (X-52 T3).
   *
   * `assetId` comes from the SERVER's file projection, which resolved it from
   * the object's `asset_objects` row. It used to be `el.id` — the Excalidraw
   * element's own id, which says nothing about the stored object — and that made
   * every canvas attachment an un-authorisable reference: the runtime would look
   * up an asset that does not exist and refuse the run.
   *
   * A file with no `assetId` is a pre-X-52 object whose owner cannot be
   * established. It is left out of the picker rather than offered and then
   * rejected: the ticket's rule is that such a file is NOT a valid persistent
   * Agent attachment, and inventing an id from the element or the marker path
   * would authorise it against a guess.
   */
  const handleRequestCanvasImages = useCallback((): CanvasImageItem[] => {
    const api = excalidrawApiRef.current;
    if (!api) return [];
    const elements: any[] = api.getSceneElements() ?? [];
    const files: Record<string, any> = api.getFiles() ?? {};
    let idx = 0;
    const items: CanvasImageItem[] = [];
    for (const el of elements) {
      if (el.type !== "image" || el.isDeleted || !el.fileId) continue;
      const file = files[el.fileId];
      // The stable identity, and nothing else. `storageUrlOriginal` is the
      // undownscaled object — the full-resolution URL is what the model gets.
      const assetId = typeof file?.assetId === "string" ? file.assetId : undefined;
      if (!assetId) continue;
      const url =
        (typeof file?.storageUrlOriginal === "string" && file.storageUrlOriginal) ||
        (typeof file?.storageUrl === "string" && file.storageUrl) ||
        (typeof file?.dataURL === "string" && !file.dataURL.startsWith("oss://")
          ? file.dataURL
          : "");
      if (!url) continue;

      idx++;
      const title = el.customData?.title || el.customData?.label || `Image ${idx}`;
      items.push({
        kind: "canvas-image",
        id: el.id,
        name: title,
        thumbnailUrl: url,
        assetId,
        url,
        mimeType: file?.mimeType ?? "image/png",
      });
    }
    return items;
  }, []);

  // Only re-fetch when canvasId changes or on initial auth resolution.
  // Token refreshes (e.g. tab switch back) should NOT trigger a reload —
  // we depend on user.id (stable string) instead of the user object ref.
  const userId = user?.id;

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      routerRef.current.replace("/login");
      return;
    }
    const token = accessTokenRef.current;
    if (!canvasId || !token) return;

    setPageLoading(true);
    setError(null);
    fetchCanvas(token, canvasId)
      .then((data) => {
        const c = data.canvas;
        setCanvasData({
          id: c.id,
          name: c.name,
          projectId: c.projectId,
          content: {
            elements: c.content.elements ?? [],
            appState: c.content.appState ?? {},
            files: (c.content as any).files ?? {},
          },
          // Seeds CanvasEditor's versionRef. Omitting this left it undefined until
          // the first save response came back, so THE FIRST SAVE AFTER EVERY LOAD
          // went out with no baseVersion — which replaceCanvasContent handles by
          // writing unconditionally. That is the exact lost-update the optimistic
          // concurrency work exists to prevent, and it was open during the riskiest
          // window: right after load, when the agent may be mid-insert.
          ...(c.version !== undefined ? { version: c.version } : {}),
        });
        setPageLoading(false);
        // Fetch project to get brand_kit_id and name
        fetchProject(token, c.projectId)
          .then((projectData) => {
            setBrandKitId(projectData.project.brand_kit_id);
            setProjectName(projectData.project.name ?? "Untitled");
          })
          .catch((err) => console.warn("Failed to fetch project for brand kit:", err));
      })
      .catch((err) => {
        if (err instanceof ApiAuthError) {
          signOutRef.current().then(() => routerRef.current.replace("/login"));
          return;
        }
        // A 5xx (or a fetch that never got a response) says the store could not
        // answer, not that the canvas is gone. Those are worth another try, and
        // saying "Failed to load canvas." to someone whose board is intact is how
        // a proxy blip gets mistaken for data loss. 4xx stays terminal: repeating
        // an unauthorised or genuinely-missing lookup changes nothing.
        const status =
          err instanceof ApiApplicationError ? err.status : undefined;
        const retryable = status === undefined || status >= 500;
        setError(
          retryable
            ? "Canvas store did not respond. Your work is not lost — retry."
            : "Canvas not found, or you do not have access to it.",
        );
        setErrorRetryable(retryable);
        setPageLoading(false);
      });
    // Intentionally omitting accessTokenRef (stable ref) and signOutRef/routerRef
    // (ref wrappers) from deps — only re-run when auth resolves, user changes, or
    // canvasId changes. Token refresh (e.g. tab switch) must NOT trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, userId, canvasId, reloadNonce]);

  if (!canvasId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">No canvas ID specified.</p>
      </div>
    );
  }

  if (authLoading || pageLoading) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">{error}</p>
        {errorRetryable && (
          <button data-testid="canvas-load-retry"
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!canvasData || !accessToken) return null;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Top-left navigation bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          accessToken={accessToken}
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          excalidrawApi={excalidrawApi}
        />
        <EditableProjectName
          accessToken={accessToken}
          projectId={canvasData.projectId}
          initialName={projectName}
        />
        <BrandKitSelector
          accessToken={accessToken}
          projectId={canvasData.projectId}
          currentBrandKitId={brandKitId}
          onBrandKitChange={(kitId) => setBrandKitId(kitId)}
        />
      </div>
      {/* Canvas always takes full width; on mobile/tablet, ChatSidebar overlays instead of side-by-side */}
      <div className="flex-1 relative min-w-0 overflow-hidden">
        {/* Credits button — canvas area top-right, NOT chatbar */}
        <div className="absolute top-3 right-3 z-20">
          <CreditHeaderButton />
        </div>
        <CanvasEditor
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          accessToken={accessToken}
          initialContent={canvasData.content}
          {...(canvasData.version !== undefined
            ? { initialVersion: canvasData.version }
            : {})}
          onApiReady={handleApiReady}
          onStorageMediaError={handleStorageMediaError}
          ws={ws}
          leftPanelOpen={layersOpen || filesOpen}
          onSelectionChange={setSelectedCanvasElements}
        />
        <CanvasEmptyHint
          excalidrawApi={excalidrawApi}
          onOpenChat={handleOpenChat}
        />
        <CanvasBottomBar
          excalidrawApi={excalidrawApi}
          layersOpen={layersOpen}
          onToggleLayers={handleToggleLayers}
          filesOpen={filesOpen}
          onToggleFiles={handleToggleFiles}
          leftPanelOpen={layersOpen || filesOpen}
        />
        <CanvasLayersPanel
          excalidrawApi={excalidrawApi}
          open={layersOpen}
          onClose={handleCloseLayers}
        />
        <CanvasFilesPanel
          excalidrawApi={excalidrawApi}
          open={filesOpen}
          onClose={handleCloseFiles}
        />
      </div>
      <ChatSidebar
        accessToken={accessToken}
        canvasId={canvasData.id}
        open={chatOpen}
        onToggle={handleToggleChat}
        onImageGenerated={handleImageGenerated}
        onVideoGenerated={handleVideoGenerated}
        onCanvasSync={handleCanvasSync}
        onStreamEvent={checkForTimedOutJobs}
        initialPrompt={initialPrompt}
        initialSessionId={initialSessionId}
        onSessionChange={handleSessionChange}
        onRequestCanvasImages={handleRequestCanvasImages}
        currentBrandKitId={brandKitId}
        ws={ws}
        selectedCanvasElements={selectedCanvasElements}
      />
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasPageContent />
    </Suspense>
  );
}
