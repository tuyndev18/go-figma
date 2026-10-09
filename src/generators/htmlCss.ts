import { el, print, type Child } from "../core/markup";
import { ClassNamer } from "../core/naming";
import type { Decl } from "./css";
import type { StyledChild, StyledElement } from "./tree";

export const BASE_CSS = "*,\n*::before,\n*::after {\n  box-sizing: border-box;\n}";

/**
 * Styled tree → semantic class names plus one CSS rule per element.
 * `pages` holds each root's markup separately; class names are unique across all of them.
 */
export function generateHtmlCss(tree: StyledElement[]): { html: string; css: string; pages: string[] } {
  const namer = new ClassNamer();
  const rules: string[] = [];
  /** min-width → rules; printed after the base rules so they win the cascade. */
  const media = new Map<number, string[]>();
  /** State → rules, scoped to the page root's `data-state`; more specific than the base rules. */
  const states = new Map<string, string[]>();

  /** `scope`: class of the enclosing page root with states. */
  const convert = (node: StyledChild, scope: string | null): Child => {
    if (node.kind !== "element") return node.kind === "text" ? { kind: "text", text: node.text } : node;
    const attrs: [string, string][] = [];
    if (node.style.length > 0 || node.responsive || node.states || node.stateNames) {
      const className = namer.name(node.name, node.role);
      attrs.push(["class", className]);
      if (node.style.length > 0) rules.push(printRule(`.${className}`, node.style));
      for (const { minWidth, style } of node.responsive ?? []) {
        if (!media.has(minWidth)) media.set(minWidth, []);
        media.get(minWidth)!.push(printRule(`.${className}`, style));
      }
      if (node.stateNames) {
        scope = className;
        attrs.push(["data-state", node.stateNames[0]]);
        node.stateNames.forEach((s) => states.set(s, states.get(s) ?? []));
      }
      for (const { state, style } of node.states ?? []) {
        const root = `.${scope}[data-state="${state}"]`;
        states.get(state)?.push(printRule(scope === className ? root : `${root} .${className}`, style));
      }
    }
    return el(
      node.tag,
      [...attrs, ...(node.attrs ?? [])],
      node.children.map((child) => convert(child, scope)),
    );
  };

  const pages = tree.map((root) => print([convert(root, null)], "html"));
  const mediaBlocks = [...media]
    .sort(([a], [b]) => a - b)
    .map(([minWidth, rs]) => `@media (min-width: ${minWidth}px) {\n${indent(rs.join("\n\n"))}\n}`);
  const stateBlocks = [...states]
    .filter(([, rs]) => rs.length > 0)
    .map(([state, rs]) => [`/* State: ${state} */`, ...rs].join("\n\n"));
  return { html: pages.join("\n"), css: [BASE_CSS, ...rules, ...mediaBlocks, ...stateBlocks].join("\n\n"), pages };
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");

export function printRule(selector: string, decls: Decl[]): string {
  const body = compact(decls)
    .map(([p, v]) => `  ${p}: ${v};`)
    .join("\n");
  return `${selector} {\n${body}\n}`;
}

const SIDES = ["top", "right", "bottom", "left"] as const;
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

/** Fold longhands back into shorthands where that's lossless and more readable. */
export function compact(decls: Decl[]): Decl[] {
  const map = new Map(decls);
  const result: Decl[] = [];
  const consumed = new Set<string>();

  const shorthand = (name: string, longhands: string[], values: string[]) => {
    const [t, r, b, l] = values;
    let value: string;
    if (t === r && r === b && b === l) value = t;
    else if (t === b && r === l) value = `${t} ${r}`;
    else if (r === l) value = `${t} ${r} ${b}`;
    else value = `${t} ${r} ${b} ${l}`;
    longhands.forEach((p) => consumed.add(p));
    return [name, value] as Decl;
  };

  for (const [prop, value] of decls) {
    if (consumed.has(prop)) continue;

    if (prop.startsWith("padding-")) {
      const longhands = SIDES.map((s) => `padding-${s}`);
      result.push(shorthand("padding", longhands, longhands.map((p) => map.get(p) ?? "0")));
      continue;
    }

    if (prop.startsWith("border-") && prop.endsWith("-radius")) {
      const longhands = CORNERS.map((c) => `border-${c}-radius`);
      if (longhands.every((p) => map.has(p))) {
        result.push(shorthand("border-radius", longhands, longhands.map((p) => map.get(p)!)));
        continue;
      }
    }

    if (prop === "border-width" && map.has("border-style") && map.has("border-color")) {
      result.push(["border", `${value} ${map.get("border-style")} ${map.get("border-color")}`]);
      ["border-style", "border-color"].forEach((p) => consumed.add(p));
      continue;
    }

    if (prop === "outline-width" && map.has("outline-style") && map.has("outline-color")) {
      result.push(["outline", `${value} ${map.get("outline-style")} ${map.get("outline-color")}`]);
      ["outline-style", "outline-color"].forEach((p) => consumed.add(p));
      continue;
    }

    result.push([prop, value]);
  }
  return result;
}
