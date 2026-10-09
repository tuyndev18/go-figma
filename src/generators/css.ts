// IR → CSS declarations. This is the single place that encodes how Figma
// layout and styling map to CSS; the Tailwind generator translates these
// declarations into classes instead of re-deriving the rules.
import { cssColor, cssGradientStops, fmt } from "../core/color";
import type { Constraint, Fill, FrameNode, IRNode, Sides, Stroke, SvgNode, TextSegment } from "../core/ir";
import type { Warnings } from "../core/warnings";

export type Decl = [property: string, value: string];

export interface StyleContext {
  warnings: Warnings;
  /** How an image fill is referenced: a relative file path or an embedded data URI. */
  imageUrl(hash: string): string;
  /** Tag elements with their Figma layer (data-node-id, data-component, …) for AI agents. */
  annotate?: boolean;
  /** Render vector layers as <img src={svgUrl(node)}> instead of inline SVG. */
  svgUrl?(node: SvgNode): string;
}

const px = (n: number) => (n === 0 ? "0" : `${fmt(n)}px`);

/** Declarations for an IR node's own element. Text font styles come from `segmentStyle`. */
export function nodeStyle(node: IRNode, parent: FrameNode | null, ctx: StyleContext): Decl[] {
  const { warnings } = ctx;
  const decls: Decl[] = [];
  const push = (property: string, value: string) => decls.push([property, value]);

  // --- How this element lays out its children -----------------------------
  if (node.kind === "frame" && node.layout) {
    const { layout } = node;
    push("display", "flex");
    if (layout.direction === "column") push("flex-direction", "column");
    if (layout.wrap) push("flex-wrap", "wrap");
    if (layout.justify !== "start") push("justify-content", JUSTIFY[layout.justify]);
    // CSS defaults to `stretch`, Figma to `start`, so always emit it.
    push("align-items", ALIGN[layout.align]);
    if (layout.wrap && layout.alignContent) push("align-content", ALIGN_CONTENT[layout.alignContent]);

    if (layout.wrap) {
      const [rowGap, columnGap] =
        layout.direction === "row" ? [layout.crossGap, layout.gap] : [layout.gap, layout.crossGap];
      if (rowGap > 0) push("row-gap", px(rowGap));
      if (columnGap > 0 && layout.justify !== "space-between") push("column-gap", px(columnGap));
    } else if (layout.gap > 0 && layout.justify !== "space-between") {
      push("gap", px(layout.gap));
    }

    // Figma draws inside strokes over the padding unless "strokes included in
    // layout" is on; a CSS border always pushes content in, so compensate.
    const border = node.strokesIncludedInLayout ? null : insideBorder(node);
    const pad = (side: keyof Sides) => Math.max(0, layout.padding[side] - (border?.[side] ?? 0));
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (pad(side) > 0) push(`padding-${side}`, px(pad(side)));
    }
  } else if (node.kind === "text") {
    if (node.text.alignVertical !== "top" && node.sizing.vertical === "fixed") {
      push("display", "flex");
      push("flex-direction", "column");
      push("justify-content", node.text.alignVertical === "center" ? "center" : "flex-end");
    }
  }

  // --- Where this element sits in its parent --------------------------------
  const isAbsolute = parent !== null && node.positioning === "absolute";
  const overlap = isAbsolute ? null : overlapStyle(node, parent);
  if (isAbsolute) {
    push("position", "absolute");
    decls.push(...pinStyle(node, parent));
  } else if (overlap?.zIndex !== undefined || (node.kind === "frame" && node.children.some((c) => c.positioning === "absolute"))) {
    push("position", "relative");
  }
  if (overlap?.zIndex !== undefined) push("z-index", String(overlap.zIndex));
  if (!isAbsolute) {
    const top = (node.margin?.top ?? 0) + (overlap?.margin.top ?? 0);
    const left = (node.margin?.left ?? 0) + (overlap?.margin.left ?? 0);
    if (top !== 0) push("margin-top", px(top));
    if (left !== 0) push("margin-left", px(left));
  }

  const size = sizeStyle(node, parent);
  const { horizontal, vertical } = (isAbsolute && node.constraints) || {};
  for (const [property, value] of size) {
    // Pinned to both edges, the size follows from the offsets; scaled, it is a share of the parent.
    if (property === "width" && horizontal === "stretch") continue;
    if (property === "height" && vertical === "stretch") continue;
    if (property === "width" && horizontal === "scale") push(property, percent(node.box.width, innerSize(parent!).width));
    else if (property === "height" && vertical === "scale") push(property, percent(node.box.height, innerSize(parent!).height));
    else push(property, value);
  }

  const transforms = [
    ...(node.box.rotation !== 0 ? [`rotate(${fmt(node.box.rotation)}deg)`] : []),
    ...(node.box.flip ? ["scaleX(-1)"] : []),
  ];
  if (transforms.length > 0) push("transform", transforms.join(" "));

  // --- Visuals --------------------------------------------------------------
  // Exported SVG already contains fills, strokes and effects.
  if (node.kind !== "svg") {
    if (node.kind !== "text") decls.push(...fillStyle(node.fills, ctx));
    decls.push(...radiusStyle(node));
    decls.push(...strokeStyle(node, warnings));
    decls.push(...effectStyle(node));
  }

  if (node.opacity < 1) push("opacity", fmt(node.opacity));
  if (node.kind === "frame" && node.clipsContent && node.children.length > 0) push("overflow", "hidden");

  if (node.kind === "text") {
    const { text } = node;
    if (text.alignHorizontal !== "left") push("text-align", text.alignHorizontal);
    if (text.truncate) {
      push("overflow", "hidden");
      push("text-overflow", "ellipsis");
      push("white-space", "nowrap");
    } else if (node.sizing.horizontal === "hug") {
      // Figma "auto width" text never wraps.
      push("white-space", "nowrap");
    }
  }

  return decls;
}

const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
} as const;
const ALIGN = { start: "flex-start", center: "center", end: "flex-end", baseline: "baseline" } as const;
const ALIGN_CONTENT = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" } as const;

function sizeStyle(node: IRNode, parent: FrameNode | null): Decl[] {
  const decls: Decl[] = [];
  const direction = parent?.layout && node.positioning === "flow" ? parent.layout.direction : null;
  const { horizontal, vertical } = node.sizing;

  // "fill" grows along the parent's main axis and stretches across the cross axis.
  const fill = (axis: "row" | "column"): Decl | null =>
    direction === null ? null : direction === axis ? ["flex", "1 1 0"] : ["align-self", "stretch"];

  if (horizontal === "fixed") decls.push(["width", px(node.box.width)]);
  else if (horizontal === "hug" && parent === null) decls.push(["width", "fit-content"]);
  else if (horizontal === "fill") decls.push(...nonNull(fill("row")));

  if (vertical === "fixed") decls.push(["height", px(node.box.height)]);
  else if (vertical === "fill") decls.push(...nonNull(fill("column")));

  // Figma lets "fill" items shrink below their content (which then overflows);
  // flex items default to `min-width: auto`, which would force a wrap instead.
  if (direction === "row" && horizontal === "fill" && node.minWidth === undefined) decls.push(["min-width", "0"]);
  if (direction === "column" && vertical === "fill" && node.minHeight === undefined) decls.push(["min-height", "0"]);

  // Fixed-size flex items must not shrink, Figma never squeezes them.
  const mainAxisSizing = direction === "row" ? horizontal : direction === "column" ? vertical : null;
  if (mainAxisSizing === "fixed") decls.push(["flex-shrink", "0"]);

  if (node.minWidth !== undefined) decls.push(["min-width", px(node.minWidth)]);
  if (node.maxWidth !== undefined) decls.push(["max-width", px(node.maxWidth)]);
  if (node.minHeight !== undefined) decls.push(["min-height", px(node.minHeight)]);
  if (node.maxHeight !== undefined) decls.push(["max-height", px(node.maxHeight)]);
  return decls;
}

const nonNull = <T>(value: T | null): T[] => (value === null ? [] : [value]);

const percent = (part: number, whole: number) => (whole === 0 ? "0" : `${fmt((part / whole) * 100)}%`);

/** The parent's padding box, which absolute offsets are measured from (inside its border). */
function innerSize(parent: FrameNode): { width: number; height: number } {
  const border = insideBorder(parent);
  return {
    width: parent.box.width - (border?.left ?? 0) - (border?.right ?? 0),
    height: parent.box.height - (border?.top ?? 0) - (border?.bottom ?? 0),
  };
}

/** Offsets of an absolute layer, anchored to the parent edges its constraints pin it to. */
function pinStyle(node: IRNode, parent: FrameNode): Decl[] {
  const border = insideBorder(parent);
  const inner = innerSize(parent);
  const { horizontal = "start", vertical = "start" } = node.constraints ?? {};
  return [
    ...pin(["left", "right"], node.box.x - (border?.left ?? 0), node.box.width, inner.width, horizontal),
    ...pin(["top", "bottom"], node.box.y - (border?.top ?? 0), node.box.height, inner.height, vertical),
  ];
}

function pin(
  [start, end]: [string, string],
  offset: number,
  size: number,
  parentSize: number,
  constraint: Constraint,
): Decl[] {
  const after = parentSize - offset - size;
  switch (constraint) {
    case "start":
      return [[start, px(offset)]];
    case "end":
      return [[end, px(after)]];
    case "stretch":
      return [
        [start, px(offset)],
        [end, px(after)],
      ];
    case "scale":
      return [[start, percent(offset, parentSize)]];
    case "center": {
      // Keep the layer's distance from the parent's center line.
      const shift = offset - parentSize / 2;
      return [[start, shift === 0 ? "50%" : `calc(50% ${shift < 0 ? "-" : "+"} ${px(Math.abs(shift))})`]];
    }
  }
}

/**
 * Negative auto layout spacing overlaps items, which `gap` can't express: each
 * item after the first is pulled back by a negative margin instead. With
 * "first on top" stacking, earlier items are raised above later ones.
 */
function overlapStyle(node: IRNode, parent: FrameNode | null): { margin: { top: number; left: number }; zIndex?: number } | null {
  const layout = parent?.layout;
  if (!layout || layout.gap >= 0 || layout.wrap || layout.justify === "space-between") return null;
  const flow = parent.children.filter((c) => c.positioning === "flow");
  const index = flow.indexOf(node);
  if (index === -1) return null;
  const pull = index === 0 ? 0 : layout.gap;
  return {
    margin: layout.direction === "row" ? { top: 0, left: pull } : { top: pull, left: 0 },
    ...(layout.reverseZIndex ? { zIndex: flow.length - index } : {}),
  };
}

function backgroundLayer(fill: Fill, ctx: StyleContext): string {
  switch (fill.type) {
    case "solid":
      return `linear-gradient(${cssColor(fill.color)}, ${cssColor(fill.color)})`;
    case "linear":
      return `linear-gradient(${fmt(fill.angle)}deg, ${cssGradientStops(fill.stops)})`;
    case "radial":
      return `radial-gradient(${cssGradientStops(fill.stops)})`;
    case "image":
      return `url('${ctx.imageUrl(fill.hash)}')`;
  }
}

/** background-size / -position / -repeat for one layer; gradients keep CSS defaults. */
function layerPlacement(fill: Fill): [size: string, position: string, repeat: string] {
  if (fill.type !== "image") return ["auto", "0 0", "repeat"];
  switch (fill.scaleMode) {
    case "fit":
      return ["contain", "center", "no-repeat"];
    case "crop": {
      if (!fill.crop) return ["cover", "center", "no-repeat"];
      // Scale the image so the crop window spans the element, then shift the
      // window into view. A percentage position p offsets by p × (element − image).
      const { x, y, width, height } = fill.crop;
      const pos = (offset: number, size: number) => (Math.abs(1 - size) < 1e-6 ? "0%" : `${fmt((offset / (1 - size)) * 100)}%`);
      return [`${fmt(100 / width)}% ${fmt(100 / height)}%`, `${pos(x, width)} ${pos(y, height)}`, "no-repeat"];
    }
    case "tile":
      return fill.tileSize ? [`${px(fill.tileSize.width)} ${px(fill.tileSize.height)}`, "0 0", "repeat"] : ["auto", "0 0", "repeat"];
    default:
      return ["cover", "center", "no-repeat"];
  }
}

/** Figma stacks fills bottom→top; CSS background layers go top→bottom. */
export function fillStyle(fills: Fill[], ctx: StyleContext): Decl[] {
  if (fills.length === 0) return [];

  const topFirst = [...fills].reverse();
  const bottom = topFirst[topFirst.length - 1];
  const bottomColor = bottom.type === "solid" ? cssColor(bottom.color) : null;
  const layers = bottomColor ? topFirst.slice(0, -1) : topFirst;

  const decls: Decl[] = [];
  if (layers.length > 0) decls.push(["background-image", layers.map((l) => backgroundLayer(l, ctx)).join(", ")]);
  if (layers.some((l) => l.type === "image")) {
    const placements = layers.map(layerPlacement);
    decls.push(["background-size", placements.map((p) => p[0]).join(", ")]);
    decls.push(["background-position", placements.map((p) => p[1]).join(", ")]);
    decls.push(["background-repeat", placements.map((p) => p[2]).join(", ")]);
  }
  if (bottomColor) decls.push(["background-color", bottomColor]);
  return decls;
}

function radiusStyle(node: IRNode): Decl[] {
  if (node.kind === "text") return [];
  if (node.radius === "full") return [["border-radius", "50%"]];
  const [tl, tr, br, bl] = node.radius;
  if (tl === tr && tr === br && br === bl) return tl > 0 ? [["border-radius", px(tl)]] : [];
  return [
    ["border-top-left-radius", px(tl)],
    ["border-top-right-radius", px(tr)],
    ["border-bottom-right-radius", px(br)],
    ["border-bottom-left-radius", px(bl)],
  ];
}

const isUniform = (s: Sides) => s.top === s.right && s.right === s.bottom && s.bottom === s.left;

/** The stroke drawn as a CSS border (inside strokes, or any non-uniform stroke). */
function borderStroke(node: IRNode): Stroke | null {
  const stroke = node.strokes[node.strokes.length - 1];
  if (!stroke || node.kind === "text" || node.kind === "svg") return null;
  return stroke.align === "inside" || !isUniform(stroke.weights) ? stroke : null;
}

function insideBorder(node: IRNode): Sides | null {
  return borderStroke(node)?.weights ?? null;
}

function strokeStyle(node: IRNode, warnings: Warnings): Decl[] {
  if (node.strokes.length === 0) return [];
  if (node.kind === "text") {
    warnings.add("Text strokes are not supported and were skipped.");
    return [];
  }
  if (node.strokes.length > 1) warnings.add("Only the top stroke of a layer is exported.");

  const stroke = node.strokes[node.strokes.length - 1];
  const color = cssColor(stroke.color);
  const style = stroke.dashed ? "dashed" : "solid";

  if (borderStroke(node)) {
    if (stroke.align !== "inside") warnings.add("Non-uniform center/outside strokes are exported as inside borders.");
    const w = stroke.weights;
    const decls: Decl[] = isUniform(w)
      ? [["border-width", px(w.top)]]
      : (["top", "right", "bottom", "left"] as const)
          .filter((side) => w[side] > 0)
          .map((side): Decl => [`border-${side}-width`, px(w[side])]);
    return [...decls, ["border-style", style], ["border-color", color]];
  }

  // Center/outside strokes don't take space in Figma; an outline doesn't either.
  const weight = stroke.weights.top;
  const decls: Decl[] = [
    ["outline-width", px(weight)],
    ["outline-style", style],
    ["outline-color", color],
  ];
  if (stroke.align === "center") decls.push(["outline-offset", px(-weight / 2)]);
  return decls;
}

function effectStyle(node: IRNode): Decl[] {
  const decls: Decl[] = [];
  const shadows = node.effects.filter((e) => e.type === "shadow");
  if (shadows.length > 0) {
    if (node.kind === "text") {
      const drop = shadows.filter((s) => !s.inset);
      if (drop.length > 0) {
        decls.push(["text-shadow", drop.map((s) => `${px(s.x)} ${px(s.y)} ${px(s.blur)} ${cssColor(s.color)}`).join(", ")]);
      }
    } else {
      decls.push([
        "box-shadow",
        shadows
          .map((s) => `${s.inset ? "inset " : ""}${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${cssColor(s.color)}`)
          .join(", "),
      ]);
    }
  }
  for (const e of node.effects) {
    // Figma blur radius ≈ 2σ, CSS blur() takes σ.
    if (e.type === "layer-blur") decls.push(["filter", `blur(${px(e.radius / 2)})`]);
    if (e.type === "background-blur") decls.push(["backdrop-filter", `blur(${px(e.radius / 2)})`]);
  }
  return decls;
}

/** Typography for one run of text. */
export function segmentStyle(segment: TextSegment, warnings: Warnings): Decl[] {
  const decls: Decl[] = [];
  const push = (property: string, value: string) => decls.push([property, value]);

  if (segment.color) push("color", cssColor(segment.color));
  push("font-family", `'${segment.fontFamily.replace(/'/g, "\\'")}', ${genericFamily(segment.fontFamily)}`);
  push("font-size", px(segment.fontSize));
  if (segment.fontWeight !== 400) push("font-weight", String(segment.fontWeight));
  if (segment.italic) push("font-style", "italic");
  if (segment.lineHeight) {
    const { value, unit } = segment.lineHeight;
    push("line-height", unit === "px" ? px(value) : fmt(value));
  }
  if (segment.letterSpacing !== 0) push("letter-spacing", `${fmt(segment.letterSpacing)}em`);

  switch (segment.textCase) {
    case "upper":
      push("text-transform", "uppercase");
      break;
    case "lower":
      push("text-transform", "lowercase");
      break;
    case "title":
      push("text-transform", "capitalize");
      break;
    case "small-caps":
      push("font-variant", "small-caps");
      break;
  }
  if (segment.decoration === "underline") push("text-decoration-line", "underline");
  if (segment.decoration === "strikethrough") push("text-decoration-line", "line-through");
  if (segment.fontFamily === "") warnings.add("A text layer has no font family.");
  return decls;
}

/** CSS generic family to fall back on while (or if) the design font isn't available. */
function genericFamily(family: string): string {
  if (/mono|code|courier|consol/i.test(family)) return "monospace";
  if (/serif|times|georgia|garamond|playfair|merriweather|lora|baskerville|bodoni|didot/i.test(family) && !/sans/i.test(family)) {
    return "serif";
  }
  return "sans-serif";
}

/** Declarations shared (same property and value) by every list. */
export function commonDecls(lists: Decl[][]): Decl[] {
  if (lists.length === 0) return [];
  return lists[0].filter(([p, v]) => lists.every((l) => l.some(([p2, v2]) => p2 === p && v2 === v)));
}

export function withoutDecls(decls: Decl[], remove: Decl[]): Decl[] {
  return decls.filter(([p, v]) => !remove.some(([p2, v2]) => p2 === p && v2 === v));
}
