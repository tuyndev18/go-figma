import type { ProjectFile } from "../generators/project";
import type { BridgeRequest, BridgeResponse } from "./bridge";
import type { ImageFit } from "../core/imageFit";
import type { Breakpoint } from "../core/ir";
import type { Settings } from "./settings";

/**
 * Image URLs in `previewHtml` are `goapp-figma-image:<hash>`; the plugin window
 * swaps in downscaled copies, so multi-megabyte originals don't travel with
 * every result or get decoded at full size by the preview.
 */
export const PREVIEW_IMAGE_PREFIX = "goapp-figma-image:";

export interface CodeSection {
  title: string;
  language: "HTML" | "CSS" | "JAVASCRIPT" | "TYPESCRIPT";
  code: string;
}

export interface GenerateResult {
  sections: CodeSection[];
  /** Self-contained HTML document used for the live preview. */
  previewHtml: string;
  previewSize: { width: number; height: number };
  /** Set for a merged page: one viewport per tagged frame (smallest first, or the default state first). */
  previewSizes?: PreviewSize[];
  warnings: string[];
  /** Image files referenced by the code as `images/<fileName>`; `fit` is the size to scale them to. */
  images: { hash: string; fileName: string; bytes: Uint8Array; fit?: ImageFit }[];
  /** Hashes of the images `previewHtml` refers to as `goapp-figma-image:<hash>`. */
  previewImages: string[];
}

/** Image bytes for the plugin window; each image is sent once per session. */
export interface PreviewImage {
  hash: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** A result as the plugin window gets it: image bytes travel separately (see PreviewImage). */
export type UIResult = Omit<GenerateResult, "images"> & { images: { hash: string; fileName: string; fit?: ImageFit }[] };

export interface PreviewSize {
  label: string;
  width: number;
  height: number;
  /** Page with states: the `data-state` to show. */
  state?: string;
}

/** Where a result came from, so the UI can point an AI agent at the same layers. */
export interface SelectionSource {
  fileName: string;
  /** Only exposed to some plugins; used to build a Figma link. */
  fileKey?: string;
  nodes: { id: string; name: string; width: number; breakpoint?: Breakpoint; state?: string }[];
}

/** Messages sent from the plugin sandbox to the UI iframe. */
export type ToUIMessage =
  | { type: "settings"; settings: Settings }
  | { type: "loading" }
  | { type: "empty" }
  | { type: "images"; images: PreviewImage[] }
  | { type: "result"; result: UIResult; source: SelectionSource }
  | { type: "error"; message: string }
  | { type: "project"; name: string; files: ProjectFile[] }
  | { type: "project-failed" }
  | { type: "bridge-response"; response: BridgeResponse }
  /** Server script the MCP hub last reported, to show how to start it while none runs. */
  | { type: "mcp-server-path"; path: string };

/** Messages sent from the UI iframe to the plugin sandbox. */
export type ToPluginMessage =
  /** `screen`: available screen size, for the default window size. */
  | { type: "ui-ready"; screen?: { width: number; height: number } }
  | { type: "update-settings"; settings: Partial<Settings> }
  | { type: "export-project" }
  /** Replaces each frame's tags: a breakpoint, a state, or neither (its own page). */
  | { type: "tag-frames"; tags: { nodeId: string; breakpoint?: Breakpoint; state?: string }[] }
  | { type: "resize"; width: number; height: number }
  | { type: "notify"; message: string }
  | { type: "bridge-request"; request: BridgeRequest }
  | { type: "remember-mcp-server-path"; path: string };
