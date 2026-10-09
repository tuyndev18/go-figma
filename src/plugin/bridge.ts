// Answers MCP bridge requests (see shared/bridge.ts) with the same pipeline as
// the plugin window, so AI agents get exactly what the plugin sees.
import { takeRemoteWarnings } from "../core/remote";
import { Warnings } from "../core/warnings";
import { generate } from "../generators";
import { designContext } from "../generators/designContext";
import { buildProject } from "../generators/project";
import type { BridgeMethods, BridgeRequest, BridgeResponse, ConvertParams, NodeQuery, Screenshot } from "../shared/bridge";
import { slugMatchesName } from "../shared/figmaUrl";
import { sanitizeSettings, type Settings } from "../shared/settings";
import { loadSettings, normalize } from "./convert";
import { documentXml, metadataXml } from "./metadata";
import { localVariables, usedTokens } from "./variables";

/** Longest side of a screenshot, in pixels; larger images only waste agent context. */
const MAX_SCREENSHOT = 2048;
/** Outline depth sent along when a design context is too large to return. */
const SPLIT_DEPTH = 2;

type Handlers = {
  [M in keyof BridgeMethods]: (params: BridgeMethods[M]["params"]) => Promise<BridgeMethods[M]["result"]>;
};

export async function handleBridgeRequest(request: BridgeRequest): Promise<BridgeResponse> {
  const started = Date.now();
  const timing = () => ({ sandbox: Date.now() - started });
  try {
    const handler = handlers[request.method] as ((params: unknown) => Promise<unknown>) | undefined;
    if (!handler) throw new Error(`Unknown method "${request.method}".`);
    const result = await handler(request.params ?? {});
    return { type: "response", id: request.id, ok: true, result, timing: timing() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { type: "response", id: request.id, ok: false, error: message, timing: timing() };
  }
}

const handlers: Handlers = {
  async get_metadata({ depth = Infinity, nodeIds, file }) {
    checkFile(file);
    if (!nodeIds?.length && figma.currentPage.selection.length === 0) return { xml: await documentXml() };
    return { xml: await metadataXml(await resolveNodes({ nodeIds, file }), depth) };
  },

  async get_design_context({ format = "react-tailwind", screenshot = true, maxCodeChars, useColorVariables, nodeIds, file }) {
    const nodes = await resolveNodes({ nodeIds, file });
    // Icons always become asset files here, and token references are the point.
    const settings = await settingsFor({ useColorVariables: useColorVariables ?? true, inlineSvg: true });
    const warnings = new Warnings();
    const { roots, images } = await normalize(nodes, settings, warnings);
    const context = designContext(roots, images, format, warnings);
    const codeChars = context.sections.reduce((sum, s) => sum + s.code.length, 0);
    const tooLarge = maxCodeChars !== undefined && codeChars > maxCodeChars;
    const { variables, styles } = await usedTokens(nodes);
    takeRemoteWarnings().forEach((w) => warnings.add(w));

    return {
      format,
      nodes: nodes.map((n) => ({ id: n.id, name: n.name })),
      ...context,
      codeChars,
      tooLarge,
      metadata: tooLarge ? await metadataXml(nodes, SPLIT_DEPTH) : undefined,
      variables,
      styles,
      screenshots: screenshot ? await Promise.all(nodes.map((n) => capture(n, 1, "PNG"))) : [],
      warnings: warnings.list(),
    };
  },

  async get_variable_defs(query) {
    return usedTokens(await resolveNodes(query));
  },

  async get_variables() {
    return { collections: await localVariables() };
  },

  async get_screenshot({ scale = 1, format = "PNG", ...query }) {
    const screenshots: Screenshot[] = [];
    for (const node of await resolveNodes(query)) screenshots.push(await capture(node, scale, format));
    return { screenshots };
  },

  async generate_code(params) {
    const settings = await settingsFor(params);
    const warnings = new Warnings();
    const { roots, images } = await normalize(await resolveNodes(params), settings, warnings);
    const { sections, images: files } = generate(roots, images, settings, warnings);
    return { target: settings.target, sections, warnings: warnings.list(), images: files };
  },

  async export_project(params) {
    const settings = await settingsFor(params);
    const warnings = new Warnings();
    const { roots, images } = await normalize(await resolveNodes(params), settings, warnings);
    const project = buildProject(roots, images, settings.target, warnings);
    return { target: settings.target, name: project.name, files: project.files, warnings: warnings.list() };
  },
};

async function capture(node: SceneNode, scale: number, format: "PNG" | "JPG"): Promise<Screenshot> {
  const longest = Math.max(node.width, node.height) * scale;
  const value = longest > MAX_SCREENSHOT ? (scale * MAX_SCREENSHOT) / longest : scale;
  const bytes = await node.exportAsync({ format, constraint: { type: "SCALE", value } });
  return { nodeId: node.id, name: node.name, mimeType: format === "PNG" ? "image/png" : "image/jpeg", bytes };
}

async function settingsFor(params: ConvertParams): Promise<Settings> {
  const overrides = Object.entries(params).filter(([key, value]) => key !== "nodeIds" && key !== "file" && value !== undefined);
  return sanitizeSettings({ ...(await loadSettings()), ...Object.fromEntries(overrides) });
}

/**
 * Node ids repeat across files ("1:2" exists almost everywhere), so a link to
 * another file must fail instead of answering with the open file's layers.
 * figma.fileKey isn't exposed to every plugin; then compare the URL's file name.
 */
function checkFile(file: NodeQuery["file"]): void {
  if (!file) return;
  const same = figma.fileKey ? figma.fileKey === file.key : !file.slug || slugMatchesName(file.slug, figma.root.name);
  if (!same) {
    const linked = file.slug ? `"${file.slug.replace(/-+/g, " ").trim()}"` : `file ${file.key}`;
    throw new Error(
      `The link is for ${linked}, but Figma has "${figma.root.name}" open. ` +
        "Open the linked file in Figma desktop and run the GoApp Figma plugin there.",
    );
  }
}

async function resolveNodes({ nodeIds, file }: NodeQuery): Promise<SceneNode[]> {
  checkFile(file);
  let nodes: SceneNode[];
  if (nodeIds && nodeIds.length > 0) {
    nodes = [];
    for (const raw of nodeIds) {
      // Figma URLs spell ids with a dash: ?node-id=12-34 → "12:34".
      const id = /^\d+-\d+$/.test(raw) ? raw.replace("-", ":") : raw;
      const node = await figma.getNodeByIdAsync(id);
      if (!node || node.type === "DOCUMENT") throw new Error(`No layer with id "${raw}" in "${figma.root.name}".`);
      if (node.type === "PAGE") {
        // A link to a page: its top-level layers.
        await node.loadAsync();
        nodes.push(...node.children);
      } else {
        nodes.push(node as SceneNode);
      }
    }
  } else {
    nodes = [...figma.currentPage.selection];
    if (nodes.length === 0) throw new Error("Nothing is selected in Figma. Select a frame, or pass nodeIds.");
  }
  return nodes;
}
