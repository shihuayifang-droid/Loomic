// One entry per floating canvas panel.
//
// WHY A REGISTRY
// canvas-tool-menu used to keep a separate trio of state (id / data / bounds) per
// panel kind, and every branch of the selection handler had to remember to clear
// the other two. Adding a fourth panel meant three more useState, another ref,
// another branch, and three more lines inside every existing branch — the kind of
// change where forgetting one line shows up as two panels open at once rather
// than as an error.
//
// With the panels described here, canvas-tool-menu holds ONE `active` value, so
// mutual exclusion is a property of the data model instead of something each
// branch has to maintain.
//
// WHY `render` AND NOT A SHARED `PanelComponent`
// These panels are not interchangeable: the generator panels take
// `{data, excalidrawApi, accessToken}`, the video player takes
// `{videoUrl, mimeType, durationSeconds?, title?}` and no api at all. A single
// component signature would mean either inventing a lowest common denominator
// prop bag or editing all three panels to match. `render` lets each entry map its
// own data onto its own panel, so adding an entry never touches the others.

import type { ComponentType, ReactNode } from "react";
import { Sparkles, Video } from "lucide-react";

import {
  createImageGeneratorElement,
  isImageGeneratorElement,
  getImageGeneratorData,
} from "../../lib/canvas-image-generator";
import {
  createVideoGeneratorElement,
  isVideoGeneratorElement,
  getVideoGeneratorData,
} from "../../lib/canvas-video-generator";
import { getVideoElementSrc, isVideoUrl } from "../../lib/canvas-elements";
import type { WebSocketHandle } from "../../hooks/use-websocket";
import { ImageGeneratorPanel } from "./image-generator-panel";
import { VideoGeneratorPanel } from "./video-generator-panel";
import { VideoPlayerPanel } from "./video-player-panel";

export type PanelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CanvasScrollZoom = {
  scrollX: number;
  scrollY: number;
  zoom: number;
};

/** Everything a panel might need that does not come from the element itself. */
export type GeneratorContext = {
  excalidrawApi: any;
  accessToken: string;
  canvasScrollZoom: CanvasScrollZoom;
  ws?: WebSocketHandle | undefined;
  onClose: () => void;
};

export type GeneratorSpec = {
  /** Stable identity, also the discriminator on the single `active` state. */
  kind: string;
  /** Does this selected element open this panel? */
  isMatch: (element: any) => boolean;
  /**
   * Panel state derived from the element. Read once when the selection changes,
   * not on every frame — only bounds are refreshed while dragging.
   */
  getData: (element: any) => unknown;
  render: (args: {
    id: string;
    data: any;
    bounds: PanelBounds;
    ctx: GeneratorContext;
  }) => ReactNode;
  /**
   * Present only for panels the user can create from the toolbar. The video
   * player has no entry: it appears by selecting a video that already exists.
   */
  toolbar?: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    /** Creates the element and returns its id. */
    create: (excalidrawApi: any) => string;
  };
};

export const GENERATOR_SPECS: GeneratorSpec[] = [
  {
    kind: "image",
    isMatch: (el) => isImageGeneratorElement(el),
    getData: (el) => getImageGeneratorData(el),
    render: ({ id, data, bounds, ctx }) => (
      <ImageGeneratorPanel
        elementId={id}
        elementBounds={bounds}
        data={data}
        excalidrawApi={ctx.excalidrawApi}
        accessToken={ctx.accessToken}
        canvasScrollZoom={ctx.canvasScrollZoom}
        onClose={ctx.onClose}
        {...(ctx.ws ? { ws: ctx.ws } : {})}
      />
    ),
    toolbar: {
      icon: Sparkles,
      label: "AI 生成图片",
      create: (api) => createImageGeneratorElement(api),
    },
  },
  {
    kind: "video",
    isMatch: (el) => isVideoGeneratorElement(el),
    getData: (el) => getVideoGeneratorData(el),
    render: ({ id, data, bounds, ctx }) => (
      <VideoGeneratorPanel
        elementId={id}
        elementBounds={bounds}
        data={data}
        excalidrawApi={ctx.excalidrawApi}
        accessToken={ctx.accessToken}
        canvasScrollZoom={ctx.canvasScrollZoom}
        onClose={ctx.onClose}
        {...(ctx.ws ? { ws: ctx.ws } : {})}
      />
    ),
    toolbar: {
      icon: Video,
      label: "AI 生成视频",
      create: (api) => createVideoGeneratorElement(api, { aspectRatio: "16:9" }),
    },
  },
  {
    // A finished video sitting on the canvas, not a generator.
    kind: "videoPlayer",
    isMatch: (el) =>
      el?.type === "embeddable" &&
      (isVideoUrl(el.link as string) || el.customData?.isVideo === true),
    getData: (el) => ({
      // CV-01: the playable URL lives on the read-time projection. `link` is
      // still the fallback for elements written before object keys, and an
      // unresolved marker deliberately resolves to nothing (see the helper).
      videoUrl: getVideoElementSrc(el) ?? "",
      mimeType: (el.customData?.mimeType as string) ?? "video/mp4",
      ...(el.customData?.durationSeconds != null
        ? { durationSeconds: el.customData.durationSeconds as number }
        : {}),
      ...(el.customData?.title != null
        ? { title: el.customData.title as string }
        : {}),
    }),
    render: ({ id, data, bounds, ctx }) => (
      <VideoPlayerPanel
        elementId={id}
        elementBounds={bounds}
        videoUrl={data.videoUrl}
        mimeType={data.mimeType}
        {...(data.durationSeconds != null
          ? { durationSeconds: data.durationSeconds }
          : {})}
        {...(data.title != null ? { title: data.title } : {})}
        canvasScrollZoom={ctx.canvasScrollZoom}
        onClose={ctx.onClose}
      />
    ),
  },
];

/** The spec whose element is currently selected, or undefined. */
export function findGeneratorSpec(element: any): GeneratorSpec | undefined {
  return GENERATOR_SPECS.find((spec) => spec.isMatch(element));
}

/**
 * Elements showing the "generating" shimmer. Driven by the same specs so a new
 * generator kind is covered without touching the overlay code — the video player
 * is skipped because it has no generating state.
 */
export function isGeneratingElement(element: any): boolean {
  if (element?.customData?.status !== "generating") return false;
  return GENERATOR_SPECS.some(
    (spec) => spec.toolbar !== undefined && spec.isMatch(element),
  );
}
