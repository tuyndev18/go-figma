// Reference code plus hints for AI agents, modeled on Figma's own MCP server
// (get_design_context): markup tagged with the Figma layers and components it
// came from, and the components, annotations and asset files it uses. Agents
// adapt it to their codebase rather than paste it.
import { imageFits, type ImageFit } from "../core/imageFit";
import type { ImageAsset, IRNode, SvgNode } from "../core/ir";
import { toKebab } from "../core/naming";
import type { Warnings } from "../core/warnings";
import type { CodeSection } from "../shared/messages";
import type { Target } from "../shared/settings";
import { generateHtmlCss } from "./htmlCss";
import { generateTailwind } from "./tailwind";
import { buildTree } from "./tree";

/** Folder the reference code points images and icons at. */
export const ASSET_DIR = "assets";
const MAX_LISTED = 8;

export interface ComponentUsage {
  name: string;
  instances: number;
  /** Distinct property combinations in use, e.g. "Variant=Primary, Size=L". */
  variants: string[];
  /** A few layer ids, to look instances up. */
  nodeIds: string[];
  definition?: boolean;
  remote?: boolean;
  description?: string;
  documentationLinks?: string[];
}

export interface AnnotationNote {
  nodeId: string;
  name: string;
  text: string;
}

export interface DesignAsset {
  fileName: string;
  kind: "image" | "icon";
  width: number;
  height: number;
  /** Image bytes; icons carry SVG `text` instead. */
  bytes?: Uint8Array;
  text?: string;
  /** Images: the size to scale the file to (see core/imageFit). */
  fit?: ImageFit;
}

export interface DesignContext {
  sections: CodeSection[];
  components: ComponentUsage[];
  annotations: AnnotationNote[];
  assets: DesignAsset[];
}

export function designContext(roots: IRNode[], images: ImageAsset[], format: Target, warnings: Warnings): DesignContext {
  const icons = new Map<string, DesignAsset>();
  const fits = imageFits(roots, images);
  const svgUrl = (node: SvgNode) => {
    let asset = icons.get(node.svg);
    if (!asset) {
      const base = toKebab(node.component?.name ?? node.name) || "icon";
      let fileName = `${base}.svg`;
      const taken = new Set([...icons.values()].map((a) => a.fileName));
      for (let n = 2; taken.has(fileName); n++) fileName = `${base}-${n}.svg`;
      asset = { fileName, kind: "icon", width: Math.round(node.box.width), height: Math.round(node.box.height), text: node.svg };
      icons.set(node.svg, asset);
    }
    return `${ASSET_DIR}/${asset.fileName}`;
  };
  const byHash = new Map(images.map((i) => [i.hash, i]));
  const imageUrl = (hash: string) => `${ASSET_DIR}/${byHash.get(hash)?.fileName ?? hash}`;
  const tree = buildTree(roots, { warnings, imageUrl, svgUrl, annotate: true });

  let sections: CodeSection[];
  switch (format) {
    case "html-css": {
      const { html, css } = generateHtmlCss(tree);
      sections = [
        { title: "HTML", language: "HTML", code: html },
        { title: "CSS", language: "CSS", code: css },
      ];
      break;
    }
    case "react-tailwind":
      sections = [{ title: "React", language: "JAVASCRIPT", code: generateTailwind(tree, "jsx") }];
      break;
    case "html-tailwind":
      sections = [{ title: "HTML", language: "HTML", code: generateTailwind(tree, "html") }];
      break;
  }

  return {
    sections,
    components: collectComponents(roots),
    annotations: collectAnnotations(roots),
    assets: [
      ...images.map(
        (i): DesignAsset => ({ fileName: i.fileName, kind: "image", width: i.width, height: i.height, bytes: i.bytes, fit: fits.get(i.hash) }),
      ),
      ...icons.values(),
    ],
  };
}

function walk(roots: IRNode[], visit: (node: IRNode) => void): void {
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    if (node.kind === "frame") stack.push(...[...node.children].reverse());
  }
}

export function collectComponents(roots: IRNode[]): ComponentUsage[] {
  const byName = new Map<string, ComponentUsage>();
  walk(roots, (node) => {
    const ref = node.component;
    if (!ref) return;
    let usage = byName.get(ref.name);
    if (!usage) {
      usage = { name: ref.name, instances: 0, variants: [], nodeIds: [] };
      if (ref.definition) usage.definition = true;
      if (ref.remote) usage.remote = true;
      if (ref.description) usage.description = ref.description;
      if (ref.documentationLinks) usage.documentationLinks = ref.documentationLinks;
      byName.set(ref.name, usage);
    }
    usage.instances++;
    const variant = Object.entries(ref.properties)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    if (variant && !usage.variants.includes(variant) && usage.variants.length < MAX_LISTED) usage.variants.push(variant);
    if (usage.nodeIds.length < MAX_LISTED) usage.nodeIds.push(node.id);
  });
  return [...byName.values()];
}

export function collectAnnotations(roots: IRNode[]): AnnotationNote[] {
  const notes: AnnotationNote[] = [];
  walk(roots, (node) => {
    for (const text of node.annotations ?? []) notes.push({ nodeId: node.id, name: node.name, text });
  });
  return notes;
}
