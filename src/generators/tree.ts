// IR → styled element tree. Target-agnostic: each element carries its CSS
// declarations; the HTML+CSS and Tailwind generators decide how to attach them.
import type { FrameNode, IRNode, TextNode } from "../core/ir";
import { commonDecls, nodeStyle, segmentStyle, withoutDecls, type Decl, type StyleContext } from "./css";
import { mergeScreens, mergeStates, pageGroups, pageName } from "./responsive";

export interface StyledElement {
  kind: "element";
  tag: string;
  /** Layer name, used for class / component names. */
  name: string;
  /** Fallback name when the layer name is Figma's default ("Frame 12"). */
  role: string;
  style: Decl[];
  /** Overrides from larger breakpoints, smallest first (responsive pages only). */
  responsive?: ResponsiveStyle[];
  /** Overrides while the page is in another state (pages with states only). */
  states?: StateStyle[];
  /** Root of a page with states: every state, the default first. Printed as `data-state` on the root. */
  stateNames?: string[];
  /** Attributes other than the class, printed after it. */
  attrs?: [name: string, value: string][];
  children: StyledChild[];
}

export interface ResponsiveStyle {
  /** Applies from this viewport width up: `@media (min-width: …)`. */
  minWidth: number;
  /** Tailwind variant for the same width ("md", "lg"). */
  prefix: string;
  style: Decl[];
}

export interface StateStyle {
  /** Applies while the page root has `data-state="…"`. */
  state: string;
  style: Decl[];
}

export type StyledChild = StyledElement | { kind: "text"; text: string } | { kind: "raw"; markup: string };

/** One element per page (see `pageGroups`): frames tagged with breakpoints, or with states, merge into one. */
export function buildTree(roots: IRNode[], ctx: StyleContext): StyledElement[] {
  return pageGroups(roots, ctx.warnings).map((group) => {
    if (group.length === 1) return buildNode(group[0], null, ctx);
    const screens = group.map((root) => buildNode(root, null, ctx));
    return group[0].breakpoint
      ? mergeScreens(
          screens,
          group.map((root) => root.breakpoint!),
          pageName(group),
          ctx.warnings,
        )
      : mergeStates(
          screens,
          group.map((root) => root.state!),
          pageName(group),
          ctx.warnings,
        );
  });
}

function buildNode(node: IRNode, parent: FrameNode | null, ctx: StyleContext): StyledElement {
  const style = nodeStyle(node, parent, ctx);
  const attrs = ctx.annotate ? sourceAttrs(node) : [];
  const element = (role: string, children: StyledChild[], extra: Decl[] = []): StyledElement => ({
    kind: "element",
    tag: "div",
    name: node.name,
    role,
    style: [...style, ...extra],
    ...(attrs.length > 0 ? { attrs } : {}),
    children,
  });

  switch (node.kind) {
    case "frame":
      return element(
        "frame",
        node.children.map((child) => buildNode(child, node, ctx)),
      );
    case "shape":
      return element("shape", []);
    case "svg":
      if (ctx.svgUrl) {
        return { ...element("icon", []), tag: "img", attrs: [["src", ctx.svgUrl(node)], ["alt", node.name], ...attrs] };
      }
      return element("icon", [{ kind: "raw", markup: node.svg }]);
    case "text":
      return { ...buildText(node, style, ctx), ...(attrs.length > 0 ? { attrs } : {}) };
  }
}

/** Where an element came from in Figma, so an agent can map it back to layers and components. */
function sourceAttrs(node: IRNode): [string, string][] {
  const attrs: [string, string][] = [
    ["data-node-id", node.id],
    ["data-name", node.name],
  ];
  if (node.component) {
    attrs.push([node.component.definition ? "data-component-definition" : "data-component", node.component.name]);
    const props = Object.entries(node.component.properties).map(([key, value]) => `${key}=${value}`);
    if (props.length > 0) attrs.push(["data-props", props.join(", ")]);
  }
  if (node.annotations) attrs.push(["data-annotation", node.annotations.join(" | ")]);
  return attrs;
}

function buildText(node: TextNode, style: Decl[], ctx: StyleContext): StyledElement {
  const { segments } = node.text;
  const segmentDecls = segments.map((s) => segmentStyle(s, ctx.warnings));
  // Hoist typography shared by every segment onto the element itself.
  const shared = commonDecls(segmentDecls);

  let children: StyledChild[] = segments.map((segment, i) => {
    const own = withoutDecls(segmentDecls[i], shared);
    const content: StyledChild = { kind: "text", text: segment.text };
    return own.length === 0
      ? content
      : { kind: "element", tag: "span", name: `${node.name} span`, role: "span", style: own, children: [content] };
  });

  // A flex column (vertical alignment) would split runs into separate flex items.
  const isFlex = style.some(([p, v]) => p === "display" && v === "flex");
  if (isFlex) {
    children = [{ kind: "element", tag: "span", name: "", role: "span", style: [], children }];
  }

  return { kind: "element", tag: "div", name: node.name, role: "text", style: [...style, ...shared], children };
}
