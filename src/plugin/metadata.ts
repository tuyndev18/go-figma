// Sparse XML outline of layers, like Figma's own MCP get_metadata: ids, names,
// types, positions and sizes, no styling. Cheap enough to send for a whole
// page, so agents can orient themselves and pick sections to zoom into.
import { componentRef, readBreakpoint, readState } from "../core/normalize";

const MAX_TEXT = 80;

export async function metadataXml(nodes: readonly SceneNode[], depth: number): Promise<string> {
  const body = await Promise.all(nodes.map((node) => nodeXml(node, depth, 1)));
  const attrs = attributes({ file: figma.root.name, page: figma.currentPage.name });
  return `<selection${attrs}>\n${body.filter(Boolean).join("\n")}\n</selection>`;
}

/** Nothing selected: the pages of the file and the top-level layers of the current one. */
export async function documentXml(): Promise<string> {
  const pages: string[] = [];
  for (const page of figma.root.children) {
    const attrs = attributes({ id: page.id, name: page.name });
    if (page !== figma.currentPage) {
      pages.push(`  <page${attrs} />`);
      continue;
    }
    const children = await Promise.all(page.children.map((child) => nodeXml(child, 0, 2)));
    pages.push(`  <page${attrs} current="true">\n${children.filter(Boolean).join("\n")}\n  </page>`);
  }
  return `<document${attributes({ file: figma.root.name })}>\n${pages.join("\n")}\n</document>`;
}

async function nodeXml(node: SceneNode, depth: number, indent: number): Promise<string> {
  if (!node.visible) return "";
  const pad = "  ".repeat(indent);
  const tag = node.type.toLowerCase().replace(/_/g, "-");
  const attrs: Record<string, string | number | undefined> = {
    id: node.id,
    name: node.name,
    x: round(node.x),
    y: round(node.y),
    width: round(node.width),
    height: round(node.height),
    breakpoint: readBreakpoint(node),
    state: readBreakpoint(node) ? undefined : readState(node),
  };

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    attrs.layout = node.layoutMode === "HORIZONTAL" ? "row" : node.layoutMode === "VERTICAL" ? "column" : "grid";
  }
  if (node.type === "TEXT") {
    const text = node.characters.replace(/\s+/g, " ").trim();
    attrs.text = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  const component = await componentRef(node);
  if (component && !component.definition) {
    attrs.component = component.name;
    const props = Object.entries(component.properties).map(([key, value]) => `${key}=${value}`);
    if (props.length > 0) attrs.props = props.join(", ");
  }

  const children = "children" in node ? node.children.filter((c) => c.visible) : [];
  if (children.length === 0) return `${pad}<${tag}${attributes(attrs)} />`;
  if (depth <= 0) return `${pad}<${tag}${attributes({ ...attrs, children: children.length })} />`;

  const inner = await Promise.all(children.map((child) => nodeXml(child, depth - 1, indent + 1)));
  return `${pad}<${tag}${attributes(attrs)}>\n${inner.filter(Boolean).join("\n")}\n${pad}</${tag}>`;
}

function attributes(attrs: Record<string, string | number | undefined>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join("");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const round = (n: number) => Math.round(n * 100) / 100;
