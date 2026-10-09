// Merges several selected frames of one page into one element tree, so the
// markup is written once:
// - frames tagged mobile / tablet / desktop: mobile-first, the smallest frame's
//   styles are the base and each larger frame adds only what changes from the
//   tier below it (media queries);
// - frames tagged with a state ("default", "loading", "step-2"): the first frame
//   is the base and every other state overrides only what differs from it, keyed
//   on the root's `data-state`.
// Layers are paired across frames by tag and layer name (plus content for text
// and icons); a layer missing from a frame is hidden there, and children whose
// order differs get `order`.
import { BREAKPOINTS, type Breakpoint, type IRNode } from "../core/ir";
import type { Warnings } from "../core/warnings";
import type { Decl } from "./css";
import type { ResponsiveStyle, StateStyle, StyledChild, StyledElement } from "./tree";

type Tier = (typeof BREAKPOINTS)[number];

const tierIndex = (breakpoint: Breakpoint) => BREAKPOINTS.findIndex((t) => t.name === breakpoint);
const tierOf = (breakpoint: Breakpoint): Tier => BREAKPOINTS[tierIndex(breakpoint)];

/**
 * Selection roots → pages. Roots tagged with distinct breakpoints form one page
 * (smallest first) where the first of them was, and so do roots tagged with
 * distinct states (in selection order, the first is the default); every other
 * root is its own page.
 */
export function pageGroups(roots: IRNode[], warnings?: Warnings): IRNode[][] {
  const groups: IRNode[][] = [];
  let responsive: IRNode[] | null = null;
  let stateful: IRNode[] | null = null;
  for (const root of roots) {
    if (!root.breakpoint && !root.state) {
      groups.push([root]);
      continue;
    }
    const tag = (r: IRNode) => r.breakpoint ?? r.state;
    let group: IRNode[] | null = root.breakpoint ? responsive : stateful;
    if (!group) {
      group = [];
      groups.push(group);
      if (root.breakpoint) responsive = group;
      else stateful = group;
    }
    if (group.some((r) => tag(r) === tag(root))) {
      warnings?.add(
        root.breakpoint
          ? `More than one selected frame is tagged ${tierOf(root.breakpoint).label}; "${root.name}" is exported as a separate page.`
          : `More than one selected frame has the state "${root.state}"; "${root.name}" is exported as a separate page.`,
      );
      groups.push([root]);
      continue;
    }
    group.push(root);
  }
  responsive?.sort((a, b) => tierIndex(a.breakpoint!) - tierIndex(b.breakpoint!));
  return groups;
}

const SEPARATORS = /^[\s\-–—/|:]+|[\s\-–—/|:]+$/g;

/**
 * Page title: "Desktop Shipping & Payment" → "Shipping & Payment" for a responsive
 * page; the words every frame name shares ("Login Default" / "Login Error" → "Login") for states.
 */
export function pageName(group: IRNode[]): string {
  const name = group[0].name;
  if (group.length < 2) return name;
  if (!group[0].breakpoint) return sharedWords(group.map((r) => r.name)) || name;
  const stripped = name
    .replace(/\b(mobile|tablet|desktop)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(SEPARATORS, "");
  return stripped || name;
}

/** Leading words all names share, else trailing ones. */
function sharedWords(names: string[]): string {
  const words = names.map((n) => n.trim().split(/\s+/));
  const shared = (pick: (w: string[], i: number) => string | undefined) => {
    const out: string[] = [];
    for (let i = 0; words.every((w) => i < w.length - 1 && pick(w, i) === pick(words[0], i)); i++) out.push(pick(words[0], i)!);
    return out;
  };
  const leading = shared((w, i) => w[i]).join(" ").replace(SEPARATORS, "");
  return leading || shared((w, i) => w[w.length - 1 - i]).reverse().join(" ").replace(SEPARATORS, "");
}

/** Viewport width to preview a tagged frame at: its own width, kept inside its tier's range. */
export function previewWidth(root: IRNode): number {
  const i = tierIndex(root.breakpoint!);
  const next = BREAKPOINTS[i + 1];
  const width = Math.round(root.box.width);
  return Math.max(BREAKPOINTS[i].minWidth, next ? Math.min(width, next.minWidth - 1) : width);
}

export const breakpointLabel = (breakpoint: Breakpoint) => tierOf(breakpoint).label;

// ---------------------------------------------------------------------------

/** Per tier: the layer there, `null` when its parent shows there but it doesn't, `undefined` when the parent is hidden too. */
type Variants = (StyledElement | null | undefined)[];

/** Per frame, the declarations wanted there: null when hidden, undefined when its parent is hidden too. */
type Targets = (Decl[] | null | undefined)[];

interface MergeState {
  /** Targets → the element's base style plus its overrides. */
  cascade: (targets: Targets) => Pick<StyledElement, "style" | "responsive" | "states">;
  /** Layers present in only some frames. */
  partial: number;
}

/** One built tree per tagged frame, smallest first. */
export function mergeScreens(screens: StyledElement[], breakpoints: Breakpoint[], name: string, warnings: Warnings): StyledElement {
  const tiers = breakpoints.map(tierOf);
  return { ...merge(screens.map(fluid), (targets) => cascade(targets, tiers), warnings), name };
}

/** One built tree per tagged frame, the default state first. */
export function mergeStates(screens: StyledElement[], states: string[], name: string, warnings: Warnings): StyledElement {
  return { ...merge(screens, (targets) => overrides(targets, states), warnings), name, stateNames: states };
}

function merge(screens: StyledElement[], cascade: MergeState["cascade"], warnings: Warnings): StyledElement {
  const state: MergeState = { cascade, partial: 0 };
  const merged = mergeElement(
    screens,
    screens.map(() => []),
    state,
  );
  if (state.partial > 0) {
    warnings.add(
      `${state.partial} layer(s) exist in only some of the merged frames and are hidden elsewhere with display: none. ` +
        "Give layers the same names in every frame so they share markup.",
    );
  }
  return merged;
}

/** Frames have a fixed width; the page fills the viewport instead, and each frame's height becomes a minimum. */
function fluid(root: StyledElement): StyledElement {
  const style = root.style.flatMap(([p, v]): Decl[] => (p === "width" ? [] : p === "height" ? [["min-height", v]] : [[p, v]]));
  return { ...root, style: [...style, ["width", "100%"]] };
}

function mergeElement(variants: Variants, extras: Decl[][], state: MergeState): StyledElement {
  const template = variants.find((v): v is StyledElement => !!v)!;
  const targets = variants.map((v, i) => (v ? [...v.style, ...extras[i]] : v));
  const children = isLeaf(template) ? mergeLeafChildren(variants, state) : mergeChildren(variants, state);
  return { ...template, ...state.cascade(targets), children };
}

/** Text and icons only pair up when their content matches, so their children line up one to one. */
function mergeLeafChildren(variants: Variants, state: MergeState): StyledChild[] {
  const template = variants.find((v): v is StyledElement => !!v)!;
  return template.children.map((child, i) => {
    if (child.kind !== "element") return child;
    const items = variants.map((v) => {
      const c = v?.children[i];
      return c?.kind === "element" ? c : v ? null : undefined;
    });
    return mergeElement(
      items,
      items.map(() => []),
      state,
    );
  });
}

interface Slot {
  key: string;
  items: Variants;
}

function mergeChildren(variants: Variants, state: MergeState): StyledChild[] {
  const lists = variants.map((v) => v?.children.filter((c): c is StyledElement => c.kind === "element"));
  const slots: Slot[] = [];

  // Walk each frame's children, pairing each with the first free slot of the
  // same key after the previous match (else anywhere); unpaired ones get a new slot there.
  lists.forEach((list, i) => {
    if (!list) return;
    let cursor = -1;
    for (const child of list) {
      const key = matchKey(child);
      const free = (s: Slot) => s.key === key && s.items[i] === undefined;
      let j = slots.findIndex((s, k) => k > cursor && free(s));
      if (j < 0) j = slots.findIndex(free);
      if (j < 0) {
        j = cursor + 1;
        slots.splice(j, 0, { key, items: variants.map(() => undefined) });
      }
      slots[j].items[i] = child;
      cursor = j;
    }
  });

  for (const slot of slots) {
    lists.forEach((list, i) => {
      if (list && slot.items[i] === undefined) slot.items[i] = null;
    });
  }
  state.partial += slots.filter((s) => s.items.includes(null)).length;

  // Markup follows the slot order; a flex parent whose frame orders them differently gets `order`.
  const extras = slots.map(() => variants.map((): Decl[] => []));
  lists.forEach((list, i) => {
    if (!list || !isFlex(variants[i]!)) return;
    const positions = list.map((child) => slots.findIndex((s) => s.items[i] === child));
    if (positions.every((p, k) => k === 0 || p > positions[k - 1])) return;
    positions.forEach((p, k) => extras[p][i].push(["order", String(k)]));
  });

  return slots.map((slot, k) => mergeElement(slot.items, extras[k], state));
}

const isFlex = (el: StyledElement) => el.style.some(([p, v]) => p === "display" && v === "flex");

function isLeaf(el: StyledElement): boolean {
  return el.role === "text" || el.role === "icon" || el.children.some((c) => c.kind !== "element");
}

function matchKey(el: StyledElement): string {
  const key = `${el.tag}|${el.role}|${el.name}|${attrsKey(el)}`;
  return isLeaf(el) ? `${key}|${content(el.children)}` : key;
}

/** Attributes that matter for pairing; data-* only points back at the Figma layer, which differs per frame. */
const attrsKey = (el: StyledElement) =>
  (el.attrs ?? [])
    .filter(([name]) => !name.startsWith("data-"))
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");

function content(children: StyledChild[]): string {
  return children
    .map((c) => (c.kind === "text" ? c.text : c.kind === "raw" ? c.markup : `<${c.tag} ${attrsKey(c)}>${content(c.children)}</${c.tag}>`))
    .join("");
}

// ---------------------------------------------------------------------------

/** Per tier, smallest first: each tier overrides what changes from the one below it. */
function cascade(targets: Targets, tiers: Tier[]): Pick<StyledElement, "style" | "responsive"> {
  let current = new Map<string, string>();
  let base: Decl[] = [];
  const responsive: ResponsiveStyle[] = [];
  targets.forEach((target, i) => {
    if (target === undefined) return;
    const wanted = target === null ? new Map([...current, ["display", "none"]]) : new Map(target);
    if (i === 0) base = [...wanted];
    else {
      const style = diff(current, wanted);
      if (style.length > 0) responsive.push({ minWidth: tiers[i].minWidth, prefix: tiers[i].prefix, style });
    }
    current = wanted;
  });
  return { style: base, ...(responsive.length > 0 ? { responsive } : {}) };
}

/** Per state: the first is the base and every other state overrides only what differs from it, not from each other. */
function overrides(targets: Targets, names: string[]): Pick<StyledElement, "style" | "states"> {
  // Absent from the default state: take the look of the first state that has it, hidden.
  const base = new Map(targets[0] ?? targets.find((t) => t)!);
  if (targets[0] === null) base.set("display", "none");
  const states: StateStyle[] = [];
  targets.forEach((target, i) => {
    if (target === undefined) return;
    const style = diff(base, target === null ? new Map([...base, ["display", "none"]]) : new Map(target));
    if (style.length > 0) states.push({ state: names[i], style });
  });
  return { style: [...base], ...(states.length > 0 ? { states } : {}) };
}

const PADDING = ["padding-top", "padding-right", "padding-bottom", "padding-left"];

function diff(current: Map<string, string>, wanted: Map<string, string>): Decl[] {
  const changed = new Set<string>();
  for (const [p, v] of wanted) if (current.get(p) !== v) changed.add(p);
  for (const p of current.keys()) if (!wanted.has(p)) changed.add(p);
  // Padding is printed as one shorthand (missing sides as 0), so restate every side.
  if (PADDING.some((p) => changed.has(p))) PADDING.forEach((p) => changed.add(p));

  const decls: Decl[] = [];
  for (const [p, v] of wanted) if (changed.has(p)) decls.push([p, v]);
  for (const p of changed) if (!wanted.has(p)) decls.push([p, RESET[p] ?? "unset"]);
  return decls;
}

/** What a declaration dropped at a larger tier goes back to: the value an element has without it. */
const RESET: Record<string, string> = {
  display: "block",
  "flex-direction": "row",
  "flex-wrap": "nowrap",
  "justify-content": "flex-start",
  "align-items": "stretch",
  "align-content": "stretch",
  "align-self": "auto",
  flex: "0 1 auto",
  "flex-shrink": "1",
  order: "0",
  gap: "0",
  "row-gap": "0",
  "column-gap": "0",
  "padding-top": "0",
  "padding-right": "0",
  "padding-bottom": "0",
  "padding-left": "0",
  "margin-top": "0",
  "margin-left": "0",
  position: "static",
  left: "auto",
  right: "auto",
  top: "auto",
  bottom: "auto",
  "z-index": "auto",
  width: "auto",
  height: "auto",
  "min-width": "auto",
  "min-height": "auto",
  "max-width": "none",
  "max-height": "none",
  transform: "none",
  opacity: "1",
  overflow: "visible",
  "background-color": "transparent",
  "background-image": "none",
  "box-shadow": "none",
  filter: "none",
  "backdrop-filter": "none",
  "border-width": "0",
  "border-top-width": "0",
  "border-right-width": "0",
  "border-bottom-width": "0",
  "border-left-width": "0",
  "border-radius": "0",
  "border-top-left-radius": "0",
  "border-top-right-radius": "0",
  "border-bottom-right-radius": "0",
  "border-bottom-left-radius": "0",
  "outline-width": "0",
  "outline-offset": "0",
  "text-align": "left",
  "text-overflow": "clip",
  "white-space": "normal",
  "text-decoration-line": "none",
};
