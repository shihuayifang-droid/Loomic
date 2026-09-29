"use client";

import { useCallback, useEffect, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Circle,
  Hand,
  ImageUp,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
} from "lucide-react";

import type { WebSocketHandle } from "../hooks/use-websocket";
import {
  GENERATOR_SPECS,
  findGeneratorSpec,
  isGeneratingElement,
  type GeneratorSpec,
  type PanelBounds,
} from "./canvas/generator-registry";

type ToolType =
  | "hand"
  | "selection"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "line"
  | "freedraw"
  | "text"
  | "image";

const TOOL_GROUPS: (ToolType | null)[] = [
  "hand",
  "selection",
  null,
  "rectangle",
  "ellipse",
  "arrow",
  "line",
  "freedraw",
  null,
  "text",
  "image",
];

const TOOL_ICONS: Record<ToolType, React.ComponentType<{ className?: string }>> = {
  hand: Hand,
  selection: MousePointer2,
  rectangle: Square,
  ellipse: Circle,
  arrow: ArrowUpRight,
  line: Minus,
  freedraw: Pencil,
  text: Type,
  image: ImageUp,
};

const TOOL_LABELS: Record<ToolType, string> = {
  hand: "拖拽画布 (H)",
  selection: "选择 (V)",
  rectangle: "矩形 (R)",
  ellipse: "椭圆 (O)",
  arrow: "箭头 (A)",
  line: "直线 (L)",
  freedraw: "画笔 (P)",
  text: "文字 (T)",
  image: "图片 (9)",
};

type CanvasToolMenuProps = {
  accessToken: string;
  excalidrawApi: any;
  leftPanelOpen?: boolean;
  /** Passed down so the video panel can receive job.progress. */
  ws?: WebSocketHandle;
};

/** Memoized shimmer overlay for a single generating element */
const GeneratingOverlay = memo(function GeneratingOverlay({
  id,
  screenX,
  screenY,
  screenW,
  screenH,
  model,
}: {
  id: string;
  screenX: number;
  screenY: number;
  screenW: number;
  screenH: number;
  model?: string;
}) {
  return (
    <div
      key={id}
      className="pointer-events-none fixed overflow-hidden rounded-lg"
      style={{
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        zIndex: 99,
      }}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted">
        <svg
          className="h-12 w-12 text-muted-foreground/40"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
        </svg>
        {model && (
          <span className="mt-2 rounded-full bg-foreground/5 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {model.split("/").pop()?.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}
          </span>
        )}
        <span className="mt-1 text-[11px] text-muted-foreground">
          Generating...
        </span>
      </div>
      <div className="absolute inset-0 animate-shimmer-scan">
        <div
          className="h-full w-1/2"
          style={{
            background:
              "linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)",
          }}
        />
      </div>
    </div>
  );
});

export function CanvasToolMenu({ accessToken, excalidrawApi, leftPanelOpen, ws }: CanvasToolMenuProps) {
  const [activeTool, setActiveTool] = useState<string>("selection");

  // The one open panel, or none. Single value on purpose: with a trio of state
  // per panel kind, mutual exclusion had to be re-implemented in every branch of
  // the selection handler, and one forgotten line meant two panels on screen.
  // See canvas/generator-registry.tsx.
  const [active, setActive] = useState<{
    kind: string;
    id: string;
    data: unknown;
    bounds: PanelBounds;
  } | null>(null);

  const [canvasScrollZoom, setCanvasScrollZoom] = useState({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });

  // Track generating elements for shimmer overlay
  const [generatingElements, setGeneratingElements] = useState<
    Array<{
      id: string;
      screenX: number;
      screenY: number;
      screenW: number;
      screenH: number;
      model?: string;
    }>
  >([]);

  // Track previous generating element IDs to avoid re-renders when nothing changed
  const prevGeneratingKeyRef = useRef("");

  const closePanel = useCallback(() => setActive(null), []);

  // Subscribe to Excalidraw changes.
  // This fires on every frame during drag / drawing, so we must be very
  // careful to avoid unnecessary state updates that trigger re-renders.
  useEffect(() => {
    if (!excalidrawApi) return;

    const unsubscribe = excalidrawApi.onChange(
      (elements: any[], appState: any) => {
        // --- Tool sync (cheap string comparison, skip if unchanged) ---
        const tool = appState?.activeTool?.type;
        if (tool) setActiveTool((prev: string) => prev === tool ? prev : tool);

        const scrollX = appState?.scrollX ?? 0;
        const scrollY = appState?.scrollY ?? 0;
        const zoom = appState?.zoom?.value ?? 1;
        // Only update scroll/zoom state if values actually changed
        setCanvasScrollZoom((prev) => {
          if (prev.scrollX === scrollX && prev.scrollY === scrollY && prev.zoom === zoom) return prev;
          return { scrollX, scrollY, zoom };
        });

        // --- Selection-based panel management ---
        const selectedIds = appState?.selectedElementIds ?? {};
        const selectedElements = elements.filter(
          (el: any) => selectedIds[el.id] && !el.isDeleted,
        );

        // Exactly one element with a registered panel opens that panel; anything
        // else closes whatever was open. Nothing here knows how many panel kinds
        // exist, so a new entry in GENERATOR_SPECS needs no change in this file.
        const sel = selectedElements.length === 1 ? selectedElements[0] : undefined;
        const spec = sel ? findGeneratorSpec(sel) : undefined;

        setActive((prev) => {
          if (!sel || !spec) return prev === null ? prev : null;

          const bounds: PanelBounds = {
            x: sel.x as number,
            y: sel.y as number,
            width: sel.width as number,
            height: sel.height as number,
          };

          // Same element still selected: it may have been dragged or resized, but
          // its data has not changed, so it is not re-read (getData can be
          // non-trivial and this runs on every frame of a drag).
          if (prev && prev.kind === spec.kind && prev.id === sel.id) {
            const b = prev.bounds;
            if (
              b.x === bounds.x &&
              b.y === bounds.y &&
              b.width === bounds.width &&
              b.height === bounds.height
            ) {
              return prev;
            }
            return { ...prev, bounds };
          }

          return {
            kind: spec.kind,
            id: sel.id as string,
            data: spec.getData(sel),
            bounds,
          };
        });

        // --- Generating elements shimmer overlay ---
        // Build a stable key so we skip setState when the generating set is unchanged.
        const generatingRaw = elements.filter(
          (el: any) => !el.isDeleted && isGeneratingElement(el),
        );

        // Quick identity check: IDs + positions as a serialized key
        const genKey = generatingRaw.map((el: any) =>
          `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}`
        ).join("|");

        if (genKey !== prevGeneratingKeyRef.current) {
          prevGeneratingKeyRef.current = genKey;
          const generating = generatingRaw.map((el: any) => ({
            id: el.id as string,
            screenX: ((el.x as number) + scrollX) * zoom,
            screenY: ((el.y as number) + scrollY) * zoom,
            screenW: (el.width as number) * zoom,
            screenH: (el.height as number) * zoom,
            ...(el.customData?.model ? { model: el.customData.model as string } : {}),
          }));
          setGeneratingElements(generating);
        }
      },
    );

    return unsubscribe;
  }, [excalidrawApi]);

  const handleToolChange = useCallback(
    (tool: ToolType) => {
      excalidrawApi?.setActiveTool({ type: tool });
    },
    [excalidrawApi],
  );

  const handleCreate = useCallback(
    (spec: GeneratorSpec) => {
      if (!excalidrawApi || !spec.toolbar) return;
      const elementId = spec.toolbar.create(excalidrawApi);
      // Select it so the onChange handler recognises it as the active panel.
      excalidrawApi.updateScene({
        appState: { selectedElementIds: { [elementId]: true } },
      });
      // Opening the panel here rather than waiting for onChange: the element was
      // just created, so its data and bounds are known and the panel appears in
      // the same frame as the placeholder.
      const el = excalidrawApi
        .getSceneElements()
        .find((e: any) => e.id === elementId);
      if (!el) return;
      setActive({
        kind: spec.kind,
        id: elementId,
        data: spec.getData(el),
        bounds: {
          x: el.x as number,
          y: el.y as number,
          width: el.width as number,
          height: el.height as number,
        },
      });
    },
    [excalidrawApi],
  );

  return (
    <>
      <div
        className="absolute bottom-5 z-30 flex items-center gap-0.5 rounded-xl p-1 bg-card/75 backdrop-blur-lg border border-border shadow-card transition-[left,transform] duration-200"
        style={{
          left: leftPanelOpen ? "calc(140px + 50%)" : "50%",
          transform: "translateX(-50%)",
        }}
      >
        {/* Standard Excalidraw tools */}
        {TOOL_GROUPS.map((tool, i) => {
          if (tool === null) {
            return (
              <div
                key={`sep-${i}`}
                className="mx-0.5 h-6 w-px bg-border"
              />
            );
          }

          const Icon = TOOL_ICONS[tool];
          const isActive = activeTool === tool;

          return (
            <button
              key={tool}
              type="button"
              title={TOOL_LABELS[tool]}
              aria-label={TOOL_LABELS[tool]}
              onMouseDown={(e) => {
                e.preventDefault();
                handleToolChange(tool);
              }}
              className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 outline-none ${
                isActive
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-[16px]" />
            </button>
          );
        })}

        {/* Separator before AI tools */}
        <div className="mx-0.5 h-6 w-px bg-border" />

        {/* AI tools -- each creates its placeholder on the canvas */}
        {GENERATOR_SPECS.filter((spec) => spec.toolbar).map((spec) => {
          const { icon: Icon, label } = spec.toolbar!;
          const isActive = active?.kind === spec.kind;
          return (
            <button
              key={spec.kind}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => handleCreate(spec)}
              className={`flex items-center justify-center h-8 w-8 rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 outline-none ${
                isActive
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/60 hover:bg-foreground/[0.04] hover:text-foreground"
              }`}
            >
              <Icon className="size-[16px]" />
            </button>
          );
        })}
      </div>

      {/*
        The one open panel. Each spec maps its own data onto its own panel, so
        the panels keep their differing prop shapes and this stays one line.
      */}
      {active &&
        GENERATOR_SPECS.find((spec) => spec.kind === active.kind)?.render({
          id: active.id,
          data: active.data,
          bounds: active.bounds,
          ctx: {
            excalidrawApi,
            accessToken,
            canvasScrollZoom,
            ws,
            onClose: closePanel,
          },
        })}

      {/* Shimmer overlays for generating elements */}
      {generatingElements.length > 0 &&
        createPortal(
          <>
            {generatingElements.map((el) => (
              <GeneratingOverlay key={el.id} {...el} />
            ))}
          </>,
          document.body,
        )}

    </>
  );
}
