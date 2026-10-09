// Intermediate representation of a Figma selection.
//
// `normalize.ts` is the only module that talks to the Figma API; it turns
// SceneNodes into this IR. Everything downstream (CSS, Tailwind, printers) is
// pure and can be unit-tested without Figma.

export interface RGBA {
  r: number; // 0..1
  g: number;
  b: number;
  a: number;
}

export interface Color extends RGBA {
  /** Name of the bound Figma variable, already sanitized for CSS (`brand-primary`). */
  variable?: string;
}

export interface GradientStop {
  color: Color;
  /** 0..1 along the CSS gradient line. */
  position: number;
}

export type Fill =
  | { type: "solid"; color: Color }
  | { type: "linear"; angle: number; stops: GradientStop[] }
  | { type: "radial"; stops: GradientStop[] }
  | {
      type: "image";
      /** Key into the run's `ImageAsset`s. */
      hash: string;
      scaleMode: "fill" | "fit" | "tile" | "crop";
      /** Rendered size of one tile, for `scaleMode: "tile"`. */
      tileSize?: { width: number; height: number };
      /** Visible part of the image in image-normalized units (0..1), for `scaleMode: "crop"`. */
      crop?: { x: number; y: number; width: number; height: number };
    };

/** Image bytes referenced by image fills, de-duplicated by Figma image hash. */
export interface ImageAsset {
  hash: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export type Sizing = "fixed" | "hug" | "fill";

export interface Box {
  /** Top-left of the *unrotated* box, relative to the parent IR node. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Clockwise degrees, CSS convention. */
  rotation: number;
  /** Mirrored horizontally (applied before the rotation). */
  flip?: boolean;
}

export interface AutoLayout {
  direction: "row" | "column";
  gap: number;
  /** Gap between wrapped rows/columns. Only meaningful when `wrap` is true. */
  crossGap: number;
  wrap: boolean;
  justify: "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
  align: "start" | "center" | "end" | "baseline";
  /** How wrapped rows/columns sit in the container. Only meaningful when `wrap` is true. */
  alignContent?: "start" | "center" | "end" | "space-between";
  padding: Sides;
  /** Figma's "canvas stacking: first on top". */
  reverseZIndex?: boolean;
}

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type Corners = [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number];

export interface Stroke {
  color: Color;
  /** Per-side weights; equal values mean a uniform stroke. */
  weights: Sides;
  align: "inside" | "center" | "outside";
  dashed: boolean;
}

export type Effect =
  | { type: "shadow"; inset: boolean; x: number; y: number; blur: number; spread: number; color: Color }
  | { type: "layer-blur"; radius: number }
  | { type: "background-blur"; radius: number };

export interface TextSegment {
  text: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  italic: boolean;
  color?: Color;
  /** px, or a unitless multiplier when `lineHeightUnit` is "ratio". */
  lineHeight?: { value: number; unit: "px" | "ratio" };
  /** em */
  letterSpacing: number;
  textCase: "none" | "upper" | "lower" | "title" | "small-caps";
  decoration: "none" | "underline" | "strikethrough";
}

export interface TextContent {
  segments: TextSegment[];
  alignHorizontal: "left" | "center" | "right" | "justify";
  alignVertical: "top" | "center" | "bottom";
  truncate: boolean;
}

/** The design-system component a layer is an instance (or the definition) of. */
export interface ComponentRef {
  /** Component set name for variants ("Button"), else the component name. */
  name: string;
  /** Variant and component property values, `#id` suffixes removed: { Size: "L", Disabled: false }. */
  properties: Record<string, string | boolean>;
  /** True for the main component itself rather than an instance. */
  definition?: boolean;
  /** Lives in a team library rather than this file. */
  remote?: boolean;
  description?: string;
  documentationLinks?: string[];
}

/** Screen size a selected frame was designed for; tagged frames merge into one responsive page. */
export type Breakpoint = "mobile" | "tablet" | "desktop";

/**
 * Mobile-first tiers, smallest first: a tier's styles apply from `minWidth` up.
 * The widths are Tailwind's default `md` / `lg` screens, so both targets agree.
 */
export const BREAKPOINTS: { name: Breakpoint; label: string; minWidth: number; prefix: string }[] = [
  { name: "mobile", label: "Mobile", minWidth: 0, prefix: "" },
  { name: "tablet", label: "Tablet", minWidth: 768, prefix: "md" },
  { name: "desktop", label: "Desktop", minWidth: 1024, prefix: "lg" },
];

export function isBreakpoint(value: unknown): value is Breakpoint {
  return BREAKPOINTS.some((b) => b.name === value);
}

/** Figma's MIN / MAX / CENTER / STRETCH / SCALE constraint on one axis. */
export type Constraint = "start" | "end" | "center" | "stretch" | "scale";

interface BaseNode {
  id: string;
  /** Layer name from Figma, used to derive class / component names. */
  name: string;
  /** Only on selection roots: the breakpoint the user assigned to this frame. */
  breakpoint?: Breakpoint;
  /** Only on selection roots: the page state this frame shows ("loading", "step-2"); tagged frames merge into one page. */
  state?: string;
  component?: ComponentRef;
  /** Dev Mode annotations left by designers. */
  annotations?: string[];
  box: Box;
  sizing: { horizontal: Sizing; vertical: Sizing };
  /** "absolute" when the parent has no auto layout or the child opts out of it. */
  positioning: "flow" | "absolute";
  /** Absolute layers only: which parent edges the layer is pinned to (Figma constraints). Missing = top-left. */
  constraints?: { horizontal: Constraint; vertical: Constraint };
  /** Extra offset of a flow child, for spacing that a single gap/alignment can't express. */
  margin?: { top: number; left: number };
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  opacity: number;
  fills: Fill[];
  strokes: Stroke[];
  effects: Effect[];
  /** Corner radii, or "full" for ellipses. */
  radius: Corners | "full";
}

export interface FrameNode extends BaseNode {
  kind: "frame";
  layout: AutoLayout | null;
  /** Figma's "strokes included in layout"; when false, strokes overlap padding. */
  strokesIncludedInLayout: boolean;
  clipsContent: boolean;
  children: IRNode[];
}

export interface TextNode extends BaseNode {
  kind: "text";
  text: TextContent;
}

export interface ShapeNode extends BaseNode {
  kind: "shape";
}

export interface SvgNode extends BaseNode {
  kind: "svg";
  svg: string;
}

export type IRNode = FrameNode | TextNode | ShapeNode | SvgNode;

export const NO_RADIUS: Corners = [0, 0, 0, 0];
