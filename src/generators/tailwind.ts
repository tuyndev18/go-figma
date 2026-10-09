// CSS declarations → Tailwind v4 classes. Anything without a utility falls back
// to an arbitrary property (`[prop:value]`), so output is always faithful.
import { fmt } from "../core/color";
import { el, print, type Child, type Dialect } from "../core/markup";
import { toPascal } from "../core/naming";
import type { Decl } from "./css";
import type { StyledChild, StyledElement } from "./tree";

export function generateTailwind(tree: StyledElement[], dialect: Dialect): string {
  const convert = (node: StyledChild): Child => {
    if (node.kind !== "element") return node.kind === "text" ? { kind: "text", text: node.text } : node;
    const classes = [
      ...toTailwind(node.style),
      ...(node.responsive ?? []).flatMap((r) => toTailwind(r.style).map((c) => `${r.prefix}:${c}`)),
    ];
    const attrs: [string, string][] = classes.length > 0 ? [["class", classes.join(" ")]] : [];
    return el(node.tag, [...attrs, ...(node.attrs ?? [])], node.children.map(convert));
  };

  const children = tree.map(convert);
  if (dialect === "html") return print(children, "html");

  const body = children.length === 1 ? print(children, "jsx", 2) : `    <>\n${print(children, "jsx", 3)}\n    </>`;
  const name = toPascal(tree[0]?.name ?? "Component");
  return `export default function ${name}() {\n  return (\n${body}\n  );\n}`;
}

// ---------------------------------------------------------------------------
// Scales (Tailwind v4 defaults)

const PX = /^(-?\d+(?:\.\d+)?)px$/;
const parsePx = (value: string): number | null => (value === "0" ? 0 : PX.test(value) ? Number(value.match(PX)![1]) : null);

/** Arbitrary values can't contain spaces; Tailwind reads `_` as a space. */
const arbitrary = (value: string) => `[${value.replace(/,\s+/g, ",").replace(/\s+/g, "_")}]`;

/** v4 spacing is `calc(var(--spacing) * n)` with --spacing = 4px. */
function spacing(value: string): string {
  const n = parsePx(value);
  if (n === null) return arbitrary(value);
  if (n === 0) return "0";
  if (n === 1) return "px";
  if (Number.isInteger(n) && n % 2 === 0) return fmt(n / 4);
  return arbitrary(value);
}

/** `left-4`, `-left-4`, `-left-[13px]` */
function signed(prefix: string, value: string): string {
  const n = parsePx(value);
  if (n !== null && n < 0) return `-${prefix}-${spacing(`${fmt(-n)}px`)}`;
  return `${prefix}-${spacing(value)}`;
}

const FONT_SIZE: Record<number, string> = {
  12: "xs", 14: "sm", 16: "base", 18: "lg", 20: "xl", 24: "2xl", 30: "3xl",
  36: "4xl", 48: "5xl", 60: "6xl", 72: "7xl", 96: "8xl", 128: "9xl",
};
const FONT_WEIGHT: Record<string, string> = {
  "100": "thin", "200": "extralight", "300": "light", "400": "normal", "500": "medium",
  "600": "semibold", "700": "bold", "800": "extrabold", "900": "black",
};
const RADIUS: Record<number, string> = { 2: "xs", 4: "sm", 6: "md", 8: "lg", 12: "xl", 16: "2xl", 24: "3xl", 32: "4xl" };
const ROTATIONS = [0, 1, 2, 3, 6, 12, 45, 90, 180];

const HEX = /^#[0-9a-f]{6}$/;
const RGBA = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/;

function color(prefix: string, value: string): string {
  if (value === "#ffffff") return `${prefix}-white`;
  if (value === "#000000") return `${prefix}-black`;
  if (HEX.test(value)) return `${prefix}-[${value}]`;
  const m = value.match(RGBA);
  if (m) {
    const hex = "#" + m.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, "0")).join("");
    const base = hex === "#ffffff" ? "white" : hex === "#000000" ? "black" : `[${hex}]`;
    const pct = Number(m[4]) * 100;
    const alpha = Number.isInteger(pct) ? String(pct) : `[${m[4]}]`;
    return `${prefix}-${base}/${alpha}`;
  }
  // var(--x, fallback): the `color:` hint stops Tailwind guessing it is a size.
  return `${prefix}-[color:${value.replace(/,\s+/g, ",").replace(/\s+/g, "_")}]`;
}

function radius(value: string): string {
  if (value === "50%") return "full";
  const n = parsePx(value);
  if (n !== null && n >= 9999) return "full";
  if (n !== null && RADIUS[n]) return RADIUS[n];
  return arbitrary(value);
}

function borderWidth(value: string): string {
  const n = parsePx(value);
  if (n === 1) return "";
  if (n === 0 || n === 2 || n === 4 || n === 8) return `-${n}`;
  return `-${arbitrary(value)}`;
}

// ---------------------------------------------------------------------------

const SIMPLE: Record<string, Record<string, string>> = {
  display: { flex: "flex", "inline-flex": "inline-flex", block: "block", none: "hidden" },
  "flex-direction": { column: "flex-col", row: "flex-row" },
  "flex-wrap": { wrap: "flex-wrap", nowrap: "flex-nowrap" },
  "justify-content": { "flex-start": "justify-start", center: "justify-center", "flex-end": "justify-end", "space-between": "justify-between", "space-around": "justify-around", "space-evenly": "justify-evenly" },
  "align-items": { "flex-start": "items-start", center: "items-center", "flex-end": "items-end", baseline: "items-baseline", stretch: "items-stretch" },
  "align-content": { "flex-start": "content-start", center: "content-center", "flex-end": "content-end", "space-between": "content-between", stretch: "content-stretch" },
  "align-self": { stretch: "self-stretch", auto: "self-auto" },
  flex: { "1 1 0": "flex-1", "0 1 auto": "flex-initial" },
  "flex-shrink": { "0": "shrink-0", "1": "shrink" },
  position: { absolute: "absolute", relative: "relative", static: "static" },
  overflow: { hidden: "overflow-hidden", visible: "overflow-visible" },
  "font-style": { italic: "italic" },
  "text-transform": { uppercase: "uppercase", lowercase: "lowercase", capitalize: "capitalize" },
  "text-align": { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" },
  "white-space": { nowrap: "whitespace-nowrap", normal: "whitespace-normal" },
  "text-overflow": { ellipsis: "text-ellipsis", clip: "text-clip" },
  "text-decoration-line": { underline: "underline", "line-through": "line-through", none: "no-underline" },
  "background-size": { cover: "bg-cover", contain: "bg-contain", auto: "bg-auto" },
  "background-position": { center: "bg-center", "0 0": "bg-top-left" },
  "background-repeat": { "no-repeat": "bg-no-repeat", repeat: "bg-repeat" },
  "border-style": { solid: "", dashed: "border-dashed" },
  "outline-style": { solid: "outline-solid", dashed: "outline-dashed" },
};

const SIDE_PREFIX = { top: "t", right: "r", bottom: "b", left: "l" } as const;
const CORNER_PREFIX = { "top-left": "tl", "top-right": "tr", "bottom-right": "br", "bottom-left": "bl" } as const;

export function toTailwind(decls: Decl[]): string[] {
  const map = new Map(decls);
  const classes: string[] = [];
  const add = (...cls: string[]) => classes.push(...cls.filter(Boolean));

  let paddingDone = false;
  for (const [prop, value] of decls) {
    const simple = SIMPLE[prop]?.[value];
    if (simple !== undefined) {
      add(simple);
      continue;
    }

    if (prop.startsWith("padding-")) {
      if (!paddingDone) add(...padding(map));
      paddingDone = true;
      continue;
    }

    const side = prop.match(/^border-(top|right|bottom|left)-width$/);
    if (side) {
      add(`border-${SIDE_PREFIX[side[1] as keyof typeof SIDE_PREFIX]}${borderWidth(value)}`);
      continue;
    }
    const corner = prop.match(/^border-(top-left|top-right|bottom-right|bottom-left)-radius$/);
    if (corner) {
      add(`rounded-${CORNER_PREFIX[corner[1] as keyof typeof CORNER_PREFIX]}-${radius(value)}`);
      continue;
    }

    switch (prop) {
      case "width":
      case "height": {
        const p = prop === "width" ? "w" : "h";
        const keyword = { "fit-content": "fit", "100%": "full", auto: "auto" }[value];
        add(keyword ? `${p}-${keyword}` : `${p}-${spacing(value)}`);
        continue;
      }
      case "min-width":
      case "max-width":
      case "min-height":
      case "max-height": {
        const [kind, axis] = prop.split("-");
        const keyword = value === "auto" || value === "none" ? value : null;
        add(`${kind}-${axis === "width" ? "w" : "h"}-${keyword ?? spacing(value)}`);
        continue;
      }
      case "gap":
        add(`gap-${spacing(value)}`);
        continue;
      case "row-gap":
        add(`gap-y-${spacing(value)}`);
        continue;
      case "column-gap":
        add(`gap-x-${spacing(value)}`);
        continue;
      case "left":
      case "top":
        add(value === "auto" ? `${prop}-auto` : signed(prop, value));
        continue;
      case "order":
        add(`order-${value}`);
        continue;
      case "margin-top":
        add(signed("mt", value));
        continue;
      case "margin-left":
        add(signed("ml", value));
        continue;
      case "transform": {
        // v4 applies `rotate` before `scale`, matching `rotate(…) scaleX(-1)`.
        const m = value.match(/^(?:rotate\((-?[\d.]+)deg\))?\s*(scaleX\(-1\))?$/);
        if (m && (m[1] || m[2])) {
          if (m[1]) {
            const deg = Number(m[1]);
            const abs = Math.abs(deg);
            add(`${deg < 0 ? "-" : ""}rotate-${ROTATIONS.includes(abs) ? abs : `[${fmt(abs)}deg]`}`);
          }
          if (m[2]) add("-scale-x-100");
          continue;
        }
        break;
      }
      case "background-color":
        add(color("bg", value));
        continue;
      case "background-image":
        add(`bg-${arbitrary(value)}`);
        continue;
      case "color":
        add(color("text", value));
        continue;
      case "border-radius":
        add(`rounded-${radius(value)}`);
        continue;
      case "border-width":
        add(`border${borderWidth(value)}`);
        continue;
      case "border-color":
        add(color("border", value));
        continue;
      case "outline-width": {
        const n = parsePx(value);
        add(n !== null && Number.isInteger(n) ? `outline-${n}` : `outline-${arbitrary(value)}`);
        continue;
      }
      case "outline-color":
        add(color("outline", value));
        continue;
      case "outline-offset": {
        const n = parsePx(value);
        if (n !== null && Number.isInteger(n)) add(`${n < 0 ? "-" : ""}outline-offset-${Math.abs(n)}`);
        else add(`outline-offset-${arbitrary(value)}`);
        continue;
      }
      case "box-shadow":
        add(`shadow-${arbitrary(value)}`);
        continue;
      case "opacity": {
        const pct = Number(value) * 100;
        add(Number.isInteger(pct) ? `opacity-${pct}` : `opacity-${arbitrary(value)}`);
        continue;
      }
      case "filter":
      case "backdrop-filter": {
        const m = value.match(/^blur\((.+)\)$/);
        if (m) {
          add(`${prop === "filter" ? "" : "backdrop-"}blur-${arbitrary(m[1])}`);
          continue;
        }
        break;
      }
      case "font-family":
        add(`font-${arbitrary(value)}`);
        continue;
      case "font-size": {
        const n = parsePx(value);
        add(n !== null && FONT_SIZE[n] ? `text-${FONT_SIZE[n]}` : `text-${arbitrary(value)}`);
        continue;
      }
      case "font-weight":
        add(FONT_WEIGHT[value] ? `font-${FONT_WEIGHT[value]}` : `font-${arbitrary(value)}`);
        continue;
      case "line-height":
        add(`leading-${arbitrary(value)}`);
        continue;
      case "letter-spacing":
        add(`tracking-${arbitrary(value)}`);
        continue;
    }

    add(`[${prop}:${value.replace(/,\s+/g, ",").replace(/\s+/g, "_")}]`);
  }
  return classes;
}

function padding(map: Map<string, string>): string[] {
  const get = (side: string) => map.get(`padding-${side}`) ?? "0";
  const [t, r, b, l] = ["top", "right", "bottom", "left"].map(get);
  const cls = (prefix: string, v: string) => (v === "0" ? "" : `${prefix}-${spacing(v)}`);
  if (t === r && r === b && b === l) return [cls("p", t)];
  if (t === b && l === r) return [cls("px", l), cls("py", t)];
  return [cls("pt", t), cls("pr", r), cls("pb", b), cls("pl", l)];
}
