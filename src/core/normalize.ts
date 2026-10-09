// Figma SceneNode → IR. The only core module that touches the plugin API.
import { linearGradientFromTransform, variableToCssName } from "./color";
import { boxFromTransform, invert, multiply, scaleOf, withoutScale, type Matrix } from "./geometry";
import { sniffImageSize, sniffImageType } from "./image";
import { isBreakpoint } from "./ir";
import { toKebab } from "./naming";
import { toStateName } from "./pageTags";
import { remote } from "./remote";
import type {
  AutoLayout,
  Box,
  Breakpoint,
  Color,
  ComponentRef,
  Corners,
  Effect,
  Fill,
  FrameNode as IRFrame,
  GradientStop,
  ImageAsset,
  IRNode,
  Sides,
  Sizing,
  Stroke,
  TextContent,
  TextSegment,
} from "./ir";
import type { Warnings } from "./warnings";
import type { Settings } from "../shared/settings";

interface Context {
  settings: Settings;
  warnings: Warnings;
  /** Variable id → CSS name (null when the variable can't be resolved); shared by concurrent lookups. */
  variables: Map<string, Promise<string | null>>;
  /** Images used by this run. */
  images: Map<string, ImageAsset>;
  /** Image downloads in flight, so layers sharing an image fetch it once. */
  loadingImages: Map<string, Promise<ImageAsset | null>>;
  /** Caller-owned cache that outlives a single run. */
  imageCache: Map<string, ImageAsset>;
  /** Current root's absolute transform without scale; IR coordinates are relative to it. */
  rootFrame: Matrix;
  progress: Progress;
}

export interface NormalizeOptions {
  /** Called now and then with the layers read so far. */
  onProgress?: (done: number) => void;
  /** Checked at the same points; true stops the run with a CancelledError. */
  shouldStop?: () => boolean;
}

interface Progress extends NormalizeOptions {
  done: number;
  lastYield: number;
  /** Set while the thread is handed back; every branch of the tree waits on it. */
  pause?: Promise<void>;
  /** Once a stop is asked for, sibling branches still running stop too. */
  stopped?: boolean;
}

/** Thrown when `shouldStop` asks a run to end early. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/**
 * The plugin sandbox shares Figma's main thread: a large selection would freeze
 * the editor until the whole tree is read. Hand the thread back this often, which
 * also lets progress messages reach the plugin window.
 */
const YIELD_EVERY_MS = 40;

const VECTOR_TYPES = new Set<NodeType>(["VECTOR", "STAR", "POLYGON", "BOOLEAN_OPERATION"]);
const ICON_PART_TYPES = new Set<NodeType>([...VECTOR_TYPES, "ELLIPSE", "LINE", "RECTANGLE", "GROUP", "FRAME", "INSTANCE"]);
const ICON_MAX_SIZE = 64;
const CONTAINER_TYPES = new Set<NodeType>(["GROUP", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION"]);

export async function normalizeSelection(
  nodes: readonly SceneNode[],
  settings: Settings,
  warnings: Warnings,
  imageCache: Map<string, ImageAsset> = new Map(),
  options: NormalizeOptions = {},
): Promise<{ roots: IRNode[]; images: ImageAsset[] }> {
  const identity: Matrix = [
    [1, 0, 0],
    [0, 1, 0],
  ];
  const ctx: Context = {
    settings,
    warnings,
    variables: new Map(),
    images: new Map(),
    loadingImages: new Map(),
    imageCache,
    rootFrame: identity,
    progress: { ...options, done: 0, lastYield: Date.now() },
  };
  const roots: IRNode[] = [];
  for (const node of nodes) {
    ctx.rootFrame = withoutScale(node.absoluteTransform);
    const converted = await convert(node, null, null, ctx);
    const breakpoint = readBreakpoint(node);
    const state = breakpoint ? undefined : readState(node);
    if (breakpoint) converted.forEach((root) => (root.breakpoint = breakpoint));
    if (state) converted.forEach((root) => (root.state = state));
    roots.push(...converted);
  }
  ctx.progress.onProgress?.(ctx.progress.done);
  return { roots, images: [...ctx.images.values()] };
}

/** Every layer in the given trees, hidden ones included. */
export function countNodes(nodes: readonly SceneNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count++;
    if ("children" in node) stack.push(...node.children);
  }
  return count;
}

/**
 * Counts a layer (with its descendants when they won't be visited one by one)
 * and, once in a while, yields the thread, reports progress and checks for a stop.
 */
async function step(node: SceneNode, ctx: Context, withDescendants: boolean): Promise<void> {
  const progress = ctx.progress;
  if (progress.stopped) throw new CancelledError();
  progress.done += withDescendants ? countNodes([node]) : 1;
  if (!progress.pause && Date.now() - progress.lastYield < YIELD_EVERY_MS) return;
  // Children convert concurrently: one shared pause parks them all, so the thread is really free.
  progress.pause ??= new Promise<void>((resolve) =>
    setTimeout(() => {
      progress.pause = undefined;
      progress.lastYield = Date.now();
      progress.stopped = progress.shouldStop?.() ?? false;
      if (!progress.stopped) progress.onProgress?.(progress.done);
      resolve();
    }, 0),
  );
  await progress.pause;
  if (progress.stopped) throw new CancelledError();
}

/** Plugin data key holding the breakpoint a frame was assigned in the plugin window. */
export const BREAKPOINT_KEY = "breakpoint";

export function readBreakpoint(node: BaseNode): Breakpoint | undefined {
  const value = node.getPluginData(BREAKPOINT_KEY);
  return isBreakpoint(value) ? value : undefined;
}

/** Plugin data key holding the page state a frame was assigned in the plugin window. */
export const STATE_KEY = "state";

export function readState(node: BaseNode): string | undefined {
  return toStateName(node.getPluginData(STATE_KEY)) || undefined;
}

/**
 * @param container the Figma node whose IR element will contain this one
 *                  (null for selection roots); positions are relative to it.
 * @param parentLayout the container's auto layout, if any.
 */
async function convert(
  node: SceneNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<IRNode[]> {
  if (!node.visible) {
    await step(node, ctx, true);
    return [];
  }
  if ("isMask" in node && node.isMask) {
    ctx.warnings.add("Masks are not supported; mask layers were skipped.");
    await step(node, ctx, true);
    return [];
  }

  if (ctx.settings.inlineSvg && (VECTOR_TYPES.has(node.type) || isIcon(node) || isPartialEllipse(node))) {
    const svg = await convertSvg(node, container, parentLayout, ctx);
    if (svg) {
      await step(node, ctx, true);
      return [svg];
    }
    // Nothing to export (e.g. clipped out in Dev Mode): fall back to plain layers below.
    ctx.warnings.add("Some vectors could not be exported as SVG and were exported as boxes.");
  }
  // Containers convert their children one by one, and those count themselves.
  await step(node, ctx, !CONTAINER_TYPES.has(node.type));

  switch (node.type) {
    case "GROUP":
      // A group is only a selection helper in Figma. Outside auto layout its
      // children can be lifted into the parent; inside auto layout it is a
      // single flex item, so it becomes a wrapper element instead.
      if (container && !parentLayout) {
        const children = await Promise.all(node.children.map((c) => convert(c, container, null, ctx)));
        return children.flat();
      }
      return [await convertFrame(node, container, parentLayout, ctx)];
    case "FRAME":
    case "COMPONENT":
    case "COMPONENT_SET":
    case "INSTANCE":
    case "SECTION":
      return [await convertFrame(node, container, parentLayout, ctx)];
    case "TEXT":
      return [await convertText(node, container, parentLayout, ctx)];
    case "RECTANGLE":
    case "ELLIPSE":
      return [{ ...straighten(await base(node, container, parentLayout, ctx)), kind: "shape" }];
    case "LINE":
      return [await convertLine(node, container, parentLayout, ctx)];
    case "VECTOR":
    case "STAR":
    case "POLYGON":
    case "BOOLEAN_OPERATION":
      if (!ctx.settings.inlineSvg) ctx.warnings.add("Vector layers are exported as boxes; enable inline SVG for real shapes.");
      return [{ ...(await base(node, container, parentLayout, ctx)), kind: "shape" }];
    default:
      ctx.warnings.add(`${node.type} layers are not supported and were skipped.`);
      return [];
  }
}

// ---------------------------------------------------------------------------
// Node kinds

async function convertFrame(
  node: FrameNode | ComponentNode | ComponentSetNode | InstanceNode | SectionNode | GroupNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<IRFrame> {
  const layout = "layoutMode" in node ? autoLayout(node, ctx) : null;
  // Siblings convert concurrently: each one waits on plugin API round trips
  // (components, variables, SVG exports), which add up when run one by one.
  const [own, children] = await Promise.all([
    base(node, container, parentLayout, ctx),
    Promise.all(node.children.map((child) => convert(child, node, layout, ctx))),
  ]);

  return {
    ...own,
    children: children.flat(),
    kind: "frame",
    layout,
    strokesIncludedInLayout: "strokesIncludedInLayout" in node ? node.strokesIncludedInLayout : false,
    clipsContent: "clipsContent" in node ? node.clipsContent : false,
  };
}

async function convertText(
  node: TextNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<IRNode> {
  const baseIR = base(node, container, parentLayout, ctx);
  const raw = node.getStyledTextSegments([
    "fontName",
    "fontSize",
    "fontWeight",
    "fills",
    "lineHeight",
    "letterSpacing",
    "textCase",
    "textDecoration",
  ]);

  const segmentFills = await Promise.all(raw.map((s) => convertPaints(s.fills, node, ctx)));
  const segments: TextSegment[] = raw.map((s, i) => {
    const fills = segmentFills[i];
    const top = fills[fills.length - 1];
    let color: Color | undefined;
    if (top?.type === "solid") color = top.color;
    else if (top && top.type !== "image") {
      ctx.warnings.add("Gradient text is exported with its first gradient color.");
      color = top.stops[0]?.color;
    }

    return {
      text: s.characters,
      fontFamily: s.fontName.family,
      fontWeight: s.fontWeight,
      fontSize: s.fontSize,
      italic: /italic|oblique/i.test(s.fontName.style),
      color,
      lineHeight:
        s.lineHeight.unit === "PIXELS"
          ? { value: s.lineHeight.value, unit: "px" }
          : s.lineHeight.unit === "PERCENT"
            ? { value: s.lineHeight.value / 100, unit: "ratio" }
            : undefined,
      letterSpacing:
        s.letterSpacing.unit === "PIXELS" ? s.letterSpacing.value / s.fontSize : s.letterSpacing.value / 100,
      textCase: TEXT_CASE[s.textCase],
      decoration: s.textDecoration === "UNDERLINE" ? "underline" : s.textDecoration === "STRIKETHROUGH" ? "strikethrough" : "none",
    };
  });

  const text: TextContent = {
    segments,
    alignHorizontal: TEXT_ALIGN[node.textAlignHorizontal],
    alignVertical: node.textAlignVertical === "CENTER" ? "center" : node.textAlignVertical === "BOTTOM" ? "bottom" : "top",
    truncate: node.textTruncation === "ENDING",
  };

  const ir = await baseIR;
  // Text colors live on the segments.
  return { ...ir, kind: "text", fills: [], text };
}

const TEXT_CASE: Record<TextCase, TextSegment["textCase"]> = {
  ORIGINAL: "none",
  UPPER: "upper",
  LOWER: "lower",
  TITLE: "title",
  SMALL_CAPS: "small-caps",
  SMALL_CAPS_FORCED: "small-caps",
};

const TEXT_ALIGN = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" } as const;

/** Lines have zero height in Figma; render them as a box as thick as the stroke. */
async function convertLine(
  node: LineNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<IRNode> {
  const ir = await base(node, container, parentLayout, ctx);
  const weight = typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
  const fills = await convertPaints(node.strokes, { name: node.name, width: node.width, height: weight }, ctx);
  const line: BaseIR = {
    ...ir,
    box: { ...ir.box, y: ir.box.y - weight / 2, height: weight },
    sizing: { horizontal: ir.sizing.horizontal, vertical: "fixed" },
    fills,
    strokes: [],
  };
  return { ...straighten(line), kind: "shape" };
}

/**
 * Turn a quarter-turn rotation of a symmetric box (vertical dividers are
 * usually horizontal lines rotated 90°) into a plain box with swapped sides.
 * A CSS rotation doesn't affect flex layout, and Figma sizes rotated layers
 * along their own axes, so a rotated "fill" line would grow the wrong way.
 */
function straighten(ir: BaseIR): BaseIR {
  const turns = (((ir.box.rotation % 360) + 360) % 360) / 90;
  const quarter = Math.round(turns);
  if (Math.abs(turns - quarter) > 0.001 || (ir.box.rotation === 0 && !ir.box.flip) || !isSymmetric(ir)) return ir;

  const { x, y, width, height } = ir.box;
  if (quarter % 2 === 0) return { ...ir, box: { x, y, width, height, rotation: 0 } };
  const cx = x + width / 2;
  const cy = y + height / 2;
  return {
    ...ir,
    box: { x: cx - height / 2, y: cy - width / 2, width: height, height: width, rotation: 0 },
    sizing: { horizontal: ir.sizing.vertical, vertical: ir.sizing.horizontal },
    minWidth: ir.minHeight,
    maxWidth: ir.maxHeight,
    minHeight: ir.minWidth,
    maxHeight: ir.maxWidth,
  };
}

/** Looks the same rotated by 90° steps or mirrored (around its center). */
function isSymmetric(ir: BaseIR): boolean {
  const uniform = (s: Sides) => s.top === s.right && s.right === s.bottom && s.bottom === s.left;
  return (
    ir.fills.every((f) => f.type === "solid") &&
    ir.strokes.every((s) => uniform(s.weights)) &&
    ir.effects.every((e) => e.type !== "shadow" || (e.x === 0 && e.y === 0)) &&
    (ir.radius === "full" || ir.radius.every((r) => r === (ir.radius as Corners)[0]))
  );
}

async function convertSvg(
  node: SceneNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<IRNode | null> {
  const [ir, svg] = await Promise.all([base(node, container, parentLayout, ctx), exportSvg(node)]);
  if (svg === null) return null;
  // The export is axis-aligned and may grow to fit strokes/effects: keep the
  // node's center and use the SVG's own size, with rotation baked in.
  const width = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1] ?? node.width);
  const height = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1] ?? node.height);
  const cx = ir.box.x + ir.box.width / 2;
  const cy = ir.box.y + ir.box.height / 2;
  return {
    ...ir,
    kind: "svg",
    svg,
    box: { x: cx - width / 2, y: cy - height / 2, width, height, rotation: 0 },
    sizing: { horizontal: "fixed", vertical: "fixed" },
  };
}

/** Ids of temporary layers created by exportSvg, so edit watchers can ignore them. */
export const scratchNodeIds = new Set<string>();

/**
 * Figma exports only what is visible on the canvas, so a layer clipped out by
 * an ancestor (e.g. a carousel item past the frame's edge) fails to export.
 * Retry on a detached copy, then (Dev Mode is read-only, so no copies there)
 * with absolute bounds. Null when nothing can be exported.
 */
async function exportSvg(node: SceneNode): Promise<string | null> {
  try {
    return await node.exportAsync({ format: "SVG_STRING" });
  } catch {
    // Clipped out or empty; try the fallbacks below.
  }

  let copy: SceneNode | undefined;
  try {
    copy = node.clone();
    scratchNodeIds.add(copy.id);
    figma.currentPage.appendChild(copy);
    copy.x = -1e6;
    copy.y = -1e6;
    return await copy.exportAsync({ format: "SVG_STRING" });
  } catch {
    // Read-only document, or the copy has nothing visible either.
  } finally {
    if (copy && !copy.removed) copy.remove();
  }

  try {
    return await node.exportAsync({ format: "SVG_STRING", useAbsoluteBounds: true });
  } catch {
    return null;
  }
}

function isIcon(node: SceneNode): boolean {
  if (!(node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "GROUP")) return false;
  if (node.width > ICON_MAX_SIZE || node.height > ICON_MAX_SIZE || node.children.length === 0) return false;

  let hasVector = false;
  const walk = (n: SceneNode): boolean => {
    if (!n.visible) return true;
    if (!ICON_PART_TYPES.has(n.type)) return false;
    if (VECTOR_TYPES.has(n.type)) hasVector = true;
    return "children" in n ? n.children.every(walk) : true;
  };
  return node.children.every(walk) && hasVector;
}

function isPartialEllipse(node: SceneNode): boolean {
  if (node.type !== "ELLIPSE") return false;
  const { startingAngle, endingAngle, innerRadius } = node.arcData;
  return innerRadius > 0 || Math.abs(endingAngle - startingAngle - 2 * Math.PI) > 0.001;
}

// ---------------------------------------------------------------------------
// Shared properties

type BaseIR = Omit<IRNode, "kind" | "children" | "layout" | "clipsContent" | "text" | "svg" | "strokesIncludedInLayout">;

async function base(
  node: SceneNode,
  container: SceneNode | null,
  parentLayout: AutoLayout | null,
  ctx: Context,
): Promise<BaseIR> {
  const positioning =
    parentLayout && !("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") ? "flow" : "absolute";

  if ("blendMode" in node && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL") {
    ctx.warnings.add("Blend modes are not supported.");
  }

  // Lengths below are in the node's local units; instances resized with the
  // scale tool (K) render them `s` times larger.
  const s = nodeScale(node, ctx);
  const radius = node.type === "ELLIPSE" ? "full" : (corners(node).map((r) => r * s) as Corners);
  const [fills, nodeStrokes, nodeEffects, component] = await Promise.all([
    "fills" in node ? convertPaints(node.fills, node, ctx) : [],
    strokes(node, ctx),
    effects(node, ctx),
    componentRef(node),
  ]);
  const ir: BaseIR = {
    id: node.id,
    name: node.name,
    box: box(node, container, ctx),
    sizing: sizing(node, positioning === "flow" && parentLayout !== null),
    positioning,
    opacity: "opacity" in node ? node.opacity : 1,
    fills,
    strokes: nodeStrokes.map((st) => ({ ...st, weights: scaleSides(st.weights, s) })),
    effects: nodeEffects.map((e) =>
      e.type === "shadow"
        ? { ...e, x: e.x * s, y: e.y * s, blur: e.blur * s, spread: e.spread * s }
        : { ...e, radius: e.radius * s },
    ),
    radius,
  };

  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const) {
    const value = key in node ? (node as FrameNode)[key] : null;
    if (typeof value === "number") ir[key] = value * s;
  }

  const pinned = positioning === "absolute" ? constraints(node, container) : null;
  if (pinned) ir.constraints = pinned;

  if (component) ir.component = component;
  const notes = annotations(node);
  if (notes.length > 0) ir.annotations = notes;
  return ir;
}

const CONSTRAINT = { MIN: "start", MAX: "end", CENTER: "center", STRETCH: "stretch", SCALE: "scale" } as const;

/**
 * Figma constraints of an absolute layer, when they differ from top-left and
 * apply to the IR parent. Constraints of layers inside a flattened group refer
 * to the group, and rotated layers' boxes aren't their bounds, so both stay pinned top-left.
 */
function constraints(node: SceneNode, container: SceneNode | null): IRNode["constraints"] | null {
  if (!container || node.parent !== container || !("constraints" in node) || node.rotation !== 0) return null;
  const horizontal = CONSTRAINT[node.constraints.horizontal];
  const vertical = CONSTRAINT[node.constraints.vertical];
  return horizontal === "start" && vertical === "start" ? null : { horizontal, vertical };
}

/**
 * Which design-system component an instance comes from, with its variant /
 * property values. Properties are read from the instance itself, so the name
 * and props survive when the main component (often in a library) can't load.
 */
export async function componentRef(node: SceneNode): Promise<ComponentRef | undefined> {
  if (node.type !== "INSTANCE" && node.type !== "COMPONENT") return undefined;

  const properties: Record<string, string | boolean> = {};
  try {
    if (node.type === "INSTANCE") {
      for (const [key, prop] of Object.entries(node.componentProperties)) {
        if (prop.type === "SLOT") continue;
        let value = prop.value;
        // Instance swaps hold the swapped-in component's id; its name means more.
        if (prop.type === "INSTANCE_SWAP" && typeof value === "string") {
          const id = value;
          value = (await remote(() => figma.getNodeByIdAsync(id), null))?.name ?? value;
        }
        // "Label#12:3" → "Label"
        properties[key.replace(/#[^#]*$/, "")] = value;
      }
    } else {
      Object.assign(properties, node.variantProperties ?? {});
    }
  } catch {
    // Broken instances can throw on property access; keep what we have.
  }

  // A variant's own name ("Size=L, State=Default") says nothing; the instance
  // layer is named after its component by default.
  const ref: ComponentRef = { name: node.name, properties };
  if (node.type === "COMPONENT") ref.definition = true;
  const main = node.type === "COMPONENT" ? node : await remote(() => node.getMainComponentAsync(), null);
  if (!main) return ref;

  try {
    // Remote main components may have no parent.
    const set = main.parent?.type === "COMPONENT_SET" ? main.parent : null;
    const owner = set ?? main;
    ref.name = set?.name ?? (main.name.includes("=") ? node.name : main.name);
    if (main.remote) ref.remote = true;
    const description = (owner.description || main.description).trim();
    if (description) ref.description = description;
    const links = [...owner.documentationLinks, ...(owner === main ? [] : main.documentationLinks)].map((l) => l.uri);
    if (links.length > 0) ref.documentationLinks = links;
  } catch {
    // Details of an unloaded library component; the name and props are enough.
  }
  return ref;
}

function annotations(node: SceneNode): string[] {
  if (!("annotations" in node)) return [];
  try {
    return node.annotations
      .map((a) => {
        const label = (a.label ?? a.labelMarkdown ?? "").trim();
        const props = (a.properties ?? []).map((p) => p.type);
        return [label, props.length > 0 ? `(see: ${props.join(", ")})` : ""].filter(Boolean).join(" ");
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const scaleSides = (sides: Sides, s: number): Sides => ({
  top: sides.top * s,
  right: sides.right * s,
  bottom: sides.bottom * s,
  left: sides.left * s,
});

/** A node's transform in the current root's coordinates (root rotation and offset removed, scale kept). */
function rootSpace(node: SceneNode, ctx: Context): Matrix {
  return multiply(invert(ctx.rootFrame), node.absoluteTransform);
}

function nodeScale(node: SceneNode, ctx: Context): number {
  return scaleOf(rootSpace(node, ctx));
}

function box(node: SceneNode, container: SceneNode | null, ctx: Context): Box {
  const m = rootSpace(node, ctx);
  if (!container) {
    const s = scaleOf(m);
    return { x: 0, y: 0, width: node.width * s, height: node.height * s, rotation: 0 };
  }
  // Relative to the IR parent (even when groups were flattened in between),
  // measured in root units: the parent's own scale is already in its CSS size.
  const relative = multiply(invert(withoutScale(rootSpace(container, ctx))), m);
  return boxFromTransform(relative, node.width, node.height);
}

function sizing(node: SceneNode, inAutoLayout: boolean): { horizontal: Sizing; vertical: Sizing } {
  const read = (axis: "layoutSizingHorizontal" | "layoutSizingVertical"): Sizing => {
    let value: string = "FIXED";
    try {
      if (axis in node) value = (node as FrameNode)[axis];
    } catch {
      // Not applicable to this node.
    }
    if (value === "FILL") return inAutoLayout ? "fill" : "fixed";
    if (value === "HUG") return "hug";
    return "fixed";
  };

  let horizontal = read("layoutSizingHorizontal");
  let vertical = read("layoutSizingVertical");

  if (node.type === "TEXT") {
    // Outside auto layout, text sizing comes from its resize mode.
    if (horizontal !== "fill") horizontal = node.textAutoResize === "WIDTH_AND_HEIGHT" ? "hug" : "fixed";
    if (vertical !== "fill") {
      vertical = node.textAutoResize === "WIDTH_AND_HEIGHT" || node.textAutoResize === "HEIGHT" ? "hug" : "fixed";
    }
  } else if (!("children" in node) || node.children.length === 0) {
    // Nothing to hug.
    if (horizontal === "hug") horizontal = "fixed";
    if (vertical === "hug") vertical = "fixed";
  }
  return { horizontal, vertical };
}

function autoLayout(node: FrameNode | ComponentNode | ComponentSetNode | InstanceNode, ctx: Context): AutoLayout | null {
  if (node.layoutMode === "GRID") {
    ctx.warnings.add("Grid auto layout is exported with absolute positions.");
    return null;
  }
  if (node.layoutMode === "NONE") return null;

  const s = nodeScale(node, ctx);
  return {
    direction: node.layoutMode === "HORIZONTAL" ? "row" : "column",
    // Negative spacing (overlapping items) is turned into margins by the CSS generator.
    gap: node.itemSpacing * s,
    crossGap: Math.max(0, node.counterAxisSpacing ?? node.itemSpacing) * s,
    wrap: node.layoutWrap === "WRAP",
    justify: JUSTIFY[node.primaryAxisAlignItems],
    align: ({ MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" } as const)[node.counterAxisAlignItems],
    padding: scaleSides(
      { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft },
      s,
    ),
    // Figma packs wrapped rows by the cross-axis alignment (overflowing evenly
    // when centered); CSS would stretch them from the top.
    alignContent:
      node.counterAxisAlignContent === "SPACE_BETWEEN"
        ? "space-between"
        : node.counterAxisAlignItems === "CENTER"
          ? "center"
          : node.counterAxisAlignItems === "MAX"
            ? "end"
            : "start",
    reverseZIndex: node.itemReverseZIndex,
  };
}

const JUSTIFY: Record<FrameNode["primaryAxisAlignItems"], AutoLayout["justify"]> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
  SPACE_AROUND: "space-around",
  SPACE_EVENLY: "space-evenly",
};

function corners(node: SceneNode): Corners {
  if (!("cornerRadius" in node)) return [0, 0, 0, 0];
  const r = node.cornerRadius;
  if (typeof r === "number") return [r, r, r, r];
  if ("topLeftRadius" in node) {
    return [node.topLeftRadius ?? 0, node.topRightRadius ?? 0, node.bottomRightRadius ?? 0, node.bottomLeftRadius ?? 0];
  }
  return [0, 0, 0, 0];
}

async function strokes(node: SceneNode, ctx: Context): Promise<Stroke[]> {
  if (!("strokes" in node) || node.strokes.length === 0 || node.type === "LINE") return [];

  const weights =
    "strokeTopWeight" in node
      ? { top: node.strokeTopWeight, right: node.strokeRightWeight, bottom: node.strokeBottomWeight, left: node.strokeLeftWeight }
      : (() => {
          const w = typeof node.strokeWeight === "number" ? node.strokeWeight : 1;
          return { top: w, right: w, bottom: w, left: w };
        })();
  if (weights.top + weights.right + weights.bottom + weights.left === 0) return [];

  const result: Stroke[] = [];
  for (const paint of await convertPaints(node.strokes, node, ctx)) {
    let color: Color | undefined;
    if (paint.type === "solid") color = paint.color;
    else if (paint.type !== "image") {
      ctx.warnings.add("Gradient strokes are exported with their first gradient color.");
      color = paint.stops[0]?.color;
    }
    if (!color) continue;
    result.push({
      color,
      weights,
      align: node.strokeAlign === "INSIDE" ? "inside" : node.strokeAlign === "OUTSIDE" ? "outside" : "center",
      dashed: "dashPattern" in node && node.dashPattern.length > 0,
    });
  }
  return result;
}

async function effects(node: SceneNode, ctx: Context): Promise<Effect[]> {
  if (!("effects" in node)) return [];
  const result: Effect[] = [];
  for (const e of node.effects) {
    if (!e.visible) continue;
    switch (e.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW":
        result.push({
          type: "shadow",
          inset: e.type === "INNER_SHADOW",
          x: e.offset.x,
          y: e.offset.y,
          blur: e.radius,
          spread: e.spread ?? 0,
          color: await color(e.color, 1, e.boundVariables?.color?.id, ctx),
        });
        break;
      case "LAYER_BLUR":
        result.push({ type: "layer-blur", radius: e.radius });
        break;
      case "BACKGROUND_BLUR":
        result.push({ type: "background-blur", radius: e.radius });
        break;
      default:
        ctx.warnings.add(`${e.type} effects are not supported.`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Paints & colors

async function convertPaints(
  paints: readonly Paint[] | PluginAPI["mixed"],
  owner: { name: string; width: number; height: number },
  ctx: Context,
): Promise<Fill[]> {
  if (paints === figma.mixed) return [];
  const { width, height } = owner;
  const result: Fill[] = [];

  for (const paint of paints) {
    if (paint.visible === false) continue;
    const opacity = paint.opacity ?? 1;

    switch (paint.type) {
      case "SOLID":
        result.push({ type: "solid", color: await color(paint.color, opacity, paint.boundVariables?.color?.id, ctx) });
        break;
      case "GRADIENT_LINEAR":
      case "GRADIENT_RADIAL":
      case "GRADIENT_ANGULAR":
      case "GRADIENT_DIAMOND": {
        const stops: GradientStop[] = [];
        for (const s of paint.gradientStops) {
          stops.push({ position: s.position, color: await color(s.color, opacity, s.boundVariables?.color?.id, ctx) });
        }
        if (paint.type === "GRADIENT_LINEAR") {
          result.push({ type: "linear", ...linearGradientFromTransform(paint.gradientTransform, stops, width, height) });
        } else {
          if (paint.type !== "GRADIENT_RADIAL") ctx.warnings.add("Angular and diamond gradients are exported as radial gradients.");
          result.push({ type: "radial", stops });
        }
        break;
      }
      case "IMAGE": {
        const asset = paint.imageHash ? await loadImage(paint.imageHash, owner.name, ctx) : null;
        if (!asset) {
          ctx.warnings.add("Some image fills could not be loaded and were skipped.");
          break;
        }
        if (opacity < 1) ctx.warnings.add("Image fill opacity is not supported.");
        // A crop's imageTransform maps the layer's unit square into the image's;
        // only axis-aligned crops can be expressed with background-size/position.
        const t = paint.scaleMode === "CROP" ? paint.imageTransform : undefined;
        const crop =
          t && Math.abs(t[0][1]) < 1e-6 && Math.abs(t[1][0]) < 1e-6 && t[0][0] > 0 && t[1][1] > 0
            ? { x: t[0][2], y: t[1][2], width: t[0][0], height: t[1][1] }
            : undefined;
        if (paint.scaleMode === "CROP" && !crop) ctx.warnings.add("Rotated image crops are exported as cover.");
        const scale = paint.scalingFactor ?? 1;
        result.push({
          type: "image",
          hash: asset.hash,
          scaleMode: SCALE_MODE[paint.scaleMode],
          tileSize: paint.scaleMode === "TILE" && asset.width > 0 ? { width: asset.width * scale, height: asset.height * scale } : undefined,
          crop,
        });
        break;
      }
      case "VIDEO":
        ctx.warnings.add("Video fills are not supported.");
        break;
      default:
        ctx.warnings.add(`${paint.type} paints are not supported.`);
    }
  }
  return result;
}

const SCALE_MODE = { FILL: "fill", FIT: "fit", TILE: "tile", CROP: "crop" } as const;

/** Original image bytes for a fill; cached by hash across runs, since encoding is costly. */
async function loadImage(hash: string, layerName: string, ctx: Context): Promise<ImageAsset | null> {
  let loading = ctx.loadingImages.get(hash);
  if (!loading) {
    const cached = ctx.imageCache.get(hash);
    if (cached) {
      // Most recently used last, so the cache drops the oldest first.
      ctx.imageCache.delete(hash);
      ctx.imageCache.set(hash, cached);
    }
    loading = cached ? Promise.resolve(cached) : downloadImage(hash, layerName, ctx);
    ctx.loadingImages.set(hash, loading);
  }
  const asset = await loading;
  if (asset) ctx.images.set(hash, asset);
  return asset;
}

async function downloadImage(hash: string, layerName: string, ctx: Context): Promise<ImageAsset | null> {
  const image = figma.getImageByHash(hash);
  if (!image) return null;
  // Images not cached locally download from Figma's servers.
  const bytes = await remote(() => image.getBytesAsync(), null, "image");
  if (!bytes) return null;
  // getSizeAsync throws "Image dimensions not available" for images Figma hasn't decoded yet,
  // so prefer the size encoded in the file header and only fall back to the API.
  const size = sniffImageSize(bytes) ?? (await remote(() => image.getSizeAsync(), { width: 0, height: 0 }, "image"));
  const { mimeType, extension } = sniffImageType(bytes);
  const asset: ImageAsset = {
    hash,
    fileName: `${toKebab(layerName) || "image"}-${hash.slice(0, 8)}.${extension}`,
    mimeType,
    bytes,
    width: size.width,
    height: size.height,
  };
  ctx.imageCache.set(hash, asset);
  return asset;
}

async function color(rgba: RGB | RGBA, opacity: number, variableId: string | undefined, ctx: Context): Promise<Color> {
  const a = ("a" in rgba ? rgba.a : 1) * opacity;
  const result: Color = { r: rgba.r, g: rgba.g, b: rgba.b, a };
  if (variableId && ctx.settings.useColorVariables) {
    const name = await variableName(variableId, ctx);
    if (name) result.variable = name;
  }
  return result;
}

function variableName(id: string, ctx: Context): Promise<string | null> {
  let name = ctx.variables.get(id);
  if (!name) {
    name = remote(() => figma.variables.getVariableByIdAsync(id), null).then((v) => (v ? variableToCssName(v.name) : null));
    ctx.variables.set(id, name);
  }
  return name;
}
