// Tiny markup AST with an HTML and a JSX printer, so generators never
// concatenate tags by hand and escaping lives in one place.

export type Dialect = "html" | "jsx";

export interface Element {
  kind: "element";
  tag: string;
  /** Use HTML attribute names ("class"); the JSX printer renames them. */
  attrs: [name: string, value: string][];
  children: Child[];
}

export type Child = Element | { kind: "text"; text: string } | { kind: "raw"; markup: string };

export const el = (tag: string, attrs: Element["attrs"] = [], children: Child[] = []): Element => ({
  kind: "element",
  tag,
  attrs,
  children,
});

export const text = (value: string): Child => ({ kind: "text", text: value });
export const raw = (markup: string): Child => ({ kind: "raw", markup });

const VOID_TAGS = new Set(["br", "img", "hr", "input"]);
const INLINE_TAGS = new Set(["span", "br", "sub", "sup"]);
const JSX_ATTR_NAMES: Record<string, string> = { class: "className", for: "htmlFor" };
const INDENT = "  ";

export function print(nodes: Child[], dialect: Dialect, depth = 0): string {
  return nodes.map((n) => printChild(n, dialect, depth)).join("\n");
}

function printChild(node: Child, dialect: Dialect, depth: number): string {
  const pad = INDENT.repeat(depth);
  switch (node.kind) {
    case "text":
      return pad + printText(node.text, dialect);
    case "raw": {
      const markup = dialect === "jsx" ? svgToJsx(node.markup) : node.markup;
      return markup
        .trim()
        .split("\n")
        .map((line) => pad + line)
        .join("\n");
    }
    case "element":
      return printElement(node, dialect, depth);
  }
}

function printElement(node: Element, dialect: Dialect, depth: number): string {
  const pad = INDENT.repeat(depth);
  const attrs = node.attrs.map(([name, value]) => " " + printAttr(name, value, dialect)).join("");
  const open = `<${node.tag}${attrs}`;

  if (VOID_TAGS.has(node.tag)) return `${pad}${open}${dialect === "jsx" ? " />" : ">"}`;
  if (node.children.length === 0) {
    return dialect === "jsx" ? `${pad}${open} />` : `${pad}${open}></${node.tag}>`;
  }
  if (isInlineContent(node.children)) {
    const inner = node.children.map((c) => printInline(c, dialect)).join("");
    return `${pad}${open}>${inner}</${node.tag}>`;
  }
  return `${pad}${open}>\n${print(node.children, dialect, depth + 1)}\n${pad}</${node.tag}>`;
}

function isInlineContent(children: Child[]): boolean {
  return children.every(
    (c) => c.kind === "text" || (c.kind === "element" && INLINE_TAGS.has(c.tag) && isInlineContent(c.children)),
  );
}

function printInline(node: Child, dialect: Dialect): string {
  if (node.kind === "text") return printText(node.text, dialect);
  if (node.kind === "element") return printElement(node, dialect, 0);
  return node.markup;
}

function printAttr(name: string, value: string, dialect: Dialect): string {
  if (dialect === "html") return `${name}="${escapeHtml(value).replace(/"/g, "&quot;")}"`;
  const jsxName = JSX_ATTR_NAMES[name] ?? name;
  // JSX string attributes can't escape quotes; fall back to an expression.
  return value.includes('"') ? `${jsxName}={${JSON.stringify(value)}}` : `${jsxName}="${value}"`;
}

function printText(value: string, dialect: Dialect): string {
  const br = dialect === "jsx" ? "<br />" : "<br>";
  return value
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      return dialect === "jsx" ? escaped.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;") : escaped;
    })
    .join(br);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Make Figma's exported SVG valid JSX: camelCase attributes and object styles. */
export function svgToJsx(svg: string): string {
  return svg
    .replace(/\s(xlink|xmlns|xml):([a-z]+)=/g, (_, ns: string, attr: string) => ` ${ns}${attr[0].toUpperCase()}${attr.slice(1)}=`)
    .replace(/\s([a-z]+(?:-[a-z]+)+)=/g, (match, attr: string) =>
      attr.startsWith("data-") || attr.startsWith("aria-") ? match : ` ${attr.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())}=`,
    )
    .replace(/\sclass=/g, " className=")
    .replace(/\sstyle="([^"]*)"/g, (_, css: string) => ` style={${styleStringToObject(css)}}`);
}

function styleStringToObject(css: string): string {
  const entries = css
    .split(";")
    .map((rule) => rule.trim())
    .filter(Boolean)
    .map((rule) => {
      const [prop, ...rest] = rule.split(":");
      const key = prop.trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
      return `${key}: ${JSON.stringify(rest.join(":").trim())}`;
    });
  return `{ ${entries.join(", ")} }`;
}
