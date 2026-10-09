// GoApp Figma MCP server: lets AI coding agents (Claude Code, Codex, Cursor, …)
// read the design open in Figma through the GoApp Figma plugin. The tools follow
// Figma's own MCP server: an outline to orient (get_metadata), reference code
// with hints to implement from (get_design_context), tokens and screenshots.
//
//   claude mcp add goapp-figma -- node /path/to/go-figma/dist/mcp.mjs
//
// `node dist/mcp.mjs --hub` runs only the hub, with no agent attached, so the
// plugin's MCP panel can set agents up before any of them uses GoApp Figma.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ASSET_DIR } from "../src/generators/designContext";
import { BRIDGE_PORT, type NodeQuery, type Screenshot } from "../src/shared/bridge";
import { parseFigmaUrl, type FigmaLink } from "../src/shared/figmaUrl";
import { codeBlock, designContextText, fence, rootCss, tokensText, tooLargeText } from "./format";
import { Hub, log } from "./hub";

const VERSION = "0.2.0";

const INSTRUCTIONS = `GoApp Figma reads the design open in Figma desktop through the GoApp Figma plugin, which must be running with its window open. Tools work on the current selection, on nodeIds, or on a Figma link passed as url.

To implement a design:
1. get_design_context on the selection or section to build. It returns reference code tagged with Figma layers and components, the components and design tokens used, asset files and a screenshot, plus instructions on how to use them.
   For a large frame or a whole page, call get_metadata first (a cheap outline) and then get_design_context on one section at a time.
2. Convert the reference code to the project's stack and conventions; reuse its components and tokens.
3. Compare with get_screenshot.
generate_code and export_project return plain generated files instead, for when the user wants the plugin's code as-is.`;

/** Agents cap tool results (Claude Code: ~25k tokens); larger output goes to files they can read in parts. */
const MAX_INLINE_CHARS = 60_000;
/** Reference code budget for get_design_context, leaving room for hints and tokens. */
const MAX_CONTEXT_CODE_CHARS = 40_000;
const OUTPUT_DIR = join(tmpdir(), "goapp-figma");

const STANDALONE = process.argv.includes("--hub");

/** Set by build.mjs; a newer build takes the hub over from an older one still running. */
declare const __GO_FIGMA_BUILD__: number | undefined;
const BUILD = typeof __GO_FIGMA_BUILD__ === "number" ? __GO_FIGMA_BUILD__ : 0;

const hub = new Hub(BRIDGE_PORT, {
  version: VERSION,
  build: BUILD,
  serverPath: fileURLToPath(import.meta.url),
  standalone: STANDALONE,
});
const server = new McpServer({ name: "goapp-figma", version: VERSION }, { instructions: INSTRUCTIONS });
// The plugin's MCP panel shows which agent each session belongs to.
server.server.oninitialized = () => hub.setClient(server.server.getClientVersion());

const nodeIds = z
  .array(z.string())
  .optional()
  .describe('Figma layer ids, e.g. "12:34" (the node-id of a Figma URL, "12-34", works too). Omit to use the current selection.');
const url = z
  .string()
  .optional()
  .describe(
    "A Figma link (https://www.figma.com/design/<key>/<name>?node-id=12-34), as an alternative to nodeIds. " +
      "The file must be open in Figma desktop with the GoApp Figma plugin running.",
  );
const format = z.enum(["react-tailwind", "html-css", "html-tailwind"]);

/** nodeIds and/or a Figma link → the plugin query. Links pasted into nodeIds work too. */
function query(nodeIds: string[] | undefined, url: string | undefined): NodeQuery {
  const ids: string[] = [];
  const links: FigmaLink[] = [];
  for (const value of [...(nodeIds ?? []), ...(url ? [url] : [])]) {
    if (!/^https?:\/\//i.test(value.trim())) {
      ids.push(value);
      continue;
    }
    const link = parseFigmaUrl(value);
    if (!link) throw new Error(`Not a Figma file link: ${value}`);
    links.push(link);
    if (link.nodeId) ids.push(link.nodeId);
  }
  if (links.some((l) => l.fileKey !== links[0].fileKey)) throw new Error("The links point to different Figma files; use one file at a time.");
  const result: NodeQuery = {};
  if (ids.length > 0) result.nodeIds = ids;
  if (links[0]) result.file = { key: links[0].fileKey, slug: links[0].slug };
  return result;
}
const useColorVariables = z
  .boolean()
  .optional()
  .describe("Emit var(--name, #fallback) for colors bound to Figma variables.");

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

server.registerTool(
  "get_metadata",
  {
    title: "Get Figma layer outline",
    description:
      "Sparse XML outline of the selection or nodeIds: layer ids, names, types, positions and sizes, auto layout direction, " +
      "component names and text, no styling. Cheap; use it to orient in large designs and pick sections for get_design_context. " +
      "With nothing selected it lists the file's pages and the current page's top-level layers.",
    inputSchema: {
      nodeIds,
      url,
      depth: z.number().int().min(0).optional().describe("Levels of children to include; deeper layers are summarized as children=\"N\". Default: all."),
    },
    annotations: readOnly,
  },
  async ({ nodeIds, url, depth }) => {
    const { xml } = await hub.request("get_metadata", { ...query(nodeIds, url), depth });
    if (xml.length <= MAX_INLINE_CHARS) return { content: [text(xml)] };
    const path = await saveOutput("metadata.xml", xml);
    return { content: [text(tooLargeText(xml.length, [`- ${path}`], "Pass depth (e.g. 2) for a shorter outline, or nodeIds of a section."))] };
  },
);

server.registerTool(
  "get_design_context",
  {
    title: "Get Figma design context",
    description:
      "Primary tool for implementing a Figma design. Returns reference code (React + Tailwind by default) whose elements carry " +
      "data-node-id / data-name and, for design-system instances, data-component / data-props; the components, design tokens " +
      "and designer annotations it uses; image and icon files written to disk; a screenshot; and instructions for adapting it. " +
      "Treat the code as a reference and convert it to the project's stack. Call it on sections rather than whole pages; " +
      "for oversized selections it returns an outline to split by.",
    inputSchema: {
      nodeIds,
      url,
      format: format.optional().describe("Reference code flavor. Default react-tailwind."),
      assetsDir: z
        .string()
        .optional()
        .describe("Folder to write images and icons into, e.g. <project>/public/assets. Default: a temp folder. Absolute paths are safest."),
      screenshot: z.boolean().optional().describe("Attach a screenshot. Default true."),
      useColorVariables,
    },
    annotations: { openWorldHint: false },
  },
  async ({ nodeIds, url, format, assetsDir, screenshot, useColorVariables }) => {
    const result = await hub.request("get_design_context", {
      ...query(nodeIds, url),
      format,
      screenshot,
      useColorVariables,
      maxCodeChars: MAX_CONTEXT_CODE_CHARS,
    });

    const dir = resolve(assetsDir ?? join(OUTPUT_DIR, ASSET_DIR));
    await writeFiles(
      dir,
      result.assets.map((a) => ({ path: a.fileName, bytes: a.bytes, text: a.text })),
      true,
    );
    const assets = result.assets.map((a) => ({
      ref: `${ASSET_DIR}/${a.fileName}`,
      path: join(dir, a.fileName),
      detail: `${a.kind}, ${a.width}×${a.height}`,
    }));

    const saved: string[] = [];
    if (result.tooLarge) {
      for (const section of result.sections) {
        saved.push(await saveOutput(`context-${section.title.toLowerCase()}.${fence(section, result.format)}`, section.code));
      }
    }

    return { content: [text(designContextText(result, assets, saved)), ...images(result.screenshots)] };
  },
);

server.registerTool(
  "get_screenshot",
  {
    title: "Screenshot Figma layers",
    description: "Render layers to images to see the design or check an implementation against it. The longest side is capped at 2048 px.",
    inputSchema: {
      nodeIds,
      url,
      scale: z.number().min(0.1).max(4).optional().describe("Export scale, default 1."),
      format: z.enum(["PNG", "JPG"]).optional().describe("Default PNG."),
    },
    annotations: readOnly,
  },
  async ({ nodeIds, url, scale, format }) => {
    const { screenshots } = await hub.request("get_screenshot", { ...query(nodeIds, url), scale, format });
    return { content: images(screenshots, true) };
  },
);

server.registerTool(
  "get_variable_defs",
  {
    title: "Get Figma design tokens",
    description:
      "Design tokens. scope \"selection\" (default): the variables bound in the selection or nodeIds, resolved in the layers' modes, " +
      "and the color / text / effect styles applied. scope \"file\": every local variable of the file per collection and mode, " +
      "plus a CSS :root block. cssName matches the var(--name) references in reference code.",
    inputSchema: {
      nodeIds,
      url,
      scope: z.enum(["selection", "file"]).optional(),
    },
    annotations: readOnly,
  },
  async ({ nodeIds, url, scope }) => {
    if (scope === "file") {
      const { collections } = await hub.request("get_variables", {});
      if (collections.length === 0) return { content: [text("This file has no local variables.")] };
      const body = `${JSON.stringify({ collections }, null, 2)}\n\n\`\`\`css\n${rootCss(collections)}\n\`\`\``;
      if (body.length <= MAX_INLINE_CHARS) return { content: [text(body)] };
      const path = await saveOutput("variables.md", body);
      return { content: [text(tooLargeText(body.length, [`- ${path}`], 'Use scope "selection" for the tokens a design actually uses.'))] };
    }
    const { variables, styles } = await hub.request("get_variable_defs", query(nodeIds, url));
    if (variables.length === 0 && styles.length === 0) {
      return { content: [text("No variables or styles are used here; colors and sizes are raw values.")] };
    }
    return { content: [text(tokensText(variables, styles))] };
  },
);

server.registerTool(
  "generate_code",
  {
    title: "Generate plain code from Figma",
    description:
      "The plugin's generated code as-is (what its Copy button gives), without Figma hints. Use it when the user wants the " +
      "generated files themselves; to implement a design in a codebase, prefer get_design_context. " +
      "Images are referenced as images/<file>; pass imagesDir to write them to disk.",
    inputSchema: {
      nodeIds,
      url,
      target: format.optional().describe("Output stack. Defaults to the one picked in the plugin window."),
      useColorVariables,
      inlineSvg: z.boolean().optional().describe("Export vector layers and small icon frames as inline SVG."),
      imagesDir: z.string().optional().describe("Directory to write referenced images into. Absolute paths are safest."),
    },
    annotations: { openWorldHint: false },
  },
  async ({ imagesDir, nodeIds, url, ...params }) => {
    const result = await hub.request("generate_code", { ...params, ...query(nodeIds, url) });
    const size = result.sections.reduce((sum, s) => sum + s.code.length, 0);
    let content;
    if (size <= MAX_INLINE_CHARS) {
      content = result.sections.map((section) => text(`## ${section.title}\n\n${codeBlock(section, result.target)}`));
    } else {
      const saved = [];
      for (const section of result.sections) {
        const path = await saveOutput(`${section.title.toLowerCase()}.${fence(section, result.target)}`, section.code);
        saved.push(`- ${section.title}: ${path} (${section.code.split("\n").length} lines)`);
      }
      content = [text(tooLargeText(size, saved, "Read the files in parts, or pass nodeIds of smaller sections (see get_metadata)."))];
    }

    if (result.images.length > 0) {
      if (imagesDir) {
        const written = await writeFiles(imagesDir, result.images.map((i) => ({ path: i.fileName, bytes: i.bytes })), true);
        content.push(text(`Saved ${written.length} image(s) to ${resolve(imagesDir)}:\n${written.map((p) => `- ${p}`).join("\n")}`));
      } else {
        const list = result.images.map((i) => `- images/${i.fileName}`).join("\n");
        content.push(text(`Referenced images (call again with imagesDir to save them):\n${list}`));
      }
    }
    if (result.warnings.length > 0) content.push(text(`Warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`));
    return { content };
  },
);

server.registerTool(
  "export_project",
  {
    title: "Export Figma frames as a project",
    description:
      "Write a runnable project to outputDir, one page per frame: a Next.js App Router app for react-tailwind, " +
      "a static site for html-css / html-tailwind. Refuses to overwrite existing files unless overwrite is true.",
    inputSchema: {
      outputDir: z.string().describe("Folder to write the project into. Absolute paths are safest."),
      nodeIds,
      url,
      target: format.optional().describe("Output stack. Defaults to the one picked in the plugin window."),
      useColorVariables,
      inlineSvg: z.boolean().optional(),
      overwrite: z.boolean().optional().describe("Replace files that already exist. Default false."),
    },
    annotations: { destructiveHint: true, openWorldHint: false },
  },
  async ({ outputDir, overwrite, nodeIds, url, ...params }) => {
    const project = await hub.request("export_project", { ...params, ...query(nodeIds, url) });
    const written = await writeFiles(outputDir, project.files, overwrite ?? false);
    const lines = [`Exported ${project.target} project "${project.name}" to ${resolve(outputDir)}:`, ...written.map((p) => `- ${p}`)];
    if (project.warnings.length > 0) lines.push("", "Warnings:", ...project.warnings.map((w) => `- ${w}`));
    return { content: [text(lines.join("\n"))] };
  },
);

server.registerPrompt(
  "implement_design",
  {
    title: "Implement the Figma selection",
    description: "Build the layers selected in Figma inside this codebase.",
    argsSchema: { notes: z.string().optional().describe("Extra requirements, e.g. target file or component library.") },
  },
  ({ notes }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Implement the design currently selected in Figma in this codebase.\n\n" +
            "1. Look at the project's stack, components, styling and where static assets live.\n" +
            "2. Call get_design_context (assetsDir = the project's static assets folder). If the selection is large, " +
            "call get_metadata first and work section by section.\n" +
            "3. Follow its instructions: convert the reference code to this codebase, reuse existing components and tokens.\n" +
            "4. Compare the result with the screenshot and fix differences." +
            (notes ? `\n\nAdditional requirements: ${notes}` : ""),
        },
      },
    ],
  }),
);

// ---------------------------------------------------------------------------

function text(value: string) {
  return { type: "text" as const, text: value };
}

function images(screenshots: Screenshot[], labeled = false) {
  return screenshots.flatMap((shot) => [
    ...(labeled ? [text(`${shot.name} (${shot.nodeId})`)] : []),
    { type: "image" as const, data: Buffer.from(shot.bytes).toString("base64"), mimeType: shot.mimeType },
  ]);
}

async function saveOutput(name: string, body: string): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
  await writeFile(path, body);
  return path;
}

async function writeFiles(
  dir: string,
  files: { path: string; text?: string; bytes?: Uint8Array }[],
  overwrite: boolean,
): Promise<string[]> {
  const root = resolve(dir);
  const targets = files.map((file) => {
    const path = resolve(root, file.path);
    if (path !== root && !path.startsWith(root + sep)) throw new Error(`Refusing to write outside ${root}: ${file.path}`);
    return { file, path };
  });

  if (!overwrite) {
    const existing = targets.filter((t) => existsSync(t.path)).map((t) => relative(root, t.path));
    if (existing.length > 0) {
      const sample = existing.slice(0, 5).join(", ") + (existing.length > 5 ? ", …" : "");
      throw new Error(`${existing.length} file(s) already exist in ${root} (${sample}). Pass overwrite: true to replace them.`);
    }
  }

  for (const { file, path } of targets) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes ?? file.text ?? "");
  }
  return targets.map((t) => t.path);
}

// ---------------------------------------------------------------------------

const shutdown = () => {
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (STANDALONE) {
  // Stays up as a peer when an agent's server holds the port, to take over when it exits.
  await hub.join();
  log(
    hub.isHub
      ? `Hub ${VERSION} running on port ${BRIDGE_PORT}. Open the MCP panel in the GoApp Figma plugin to set up agents. Ctrl+C to stop.`
      : `Another GoApp Figma server holds port ${BRIDGE_PORT}; the plugin manages agents through it. Standing by to take over.`,
  );
} else {
  // Start listening right away so an open plugin window connects before the first call.
  hub.join().catch((error: Error) => log(error.message));
  process.stdin.on("close", shutdown);
  await server.connect(new StdioServerTransport());
  log(`MCP server ${VERSION} ready.`);
}
