import { BREAKPOINT_KEY, readBreakpoint, readState, scratchNodeIds, STATE_KEY } from "../core/normalize";
import { toStateName } from "../core/pageTags";
import { Warnings } from "../core/warnings";
import { generate } from "../generators";
import { buildProject } from "../generators/project";
import type { ToPluginMessage, ToUIMessage } from "../shared/messages";
import { isTarget, sanitizeSettings, type Settings } from "../shared/settings";
import { handleBridgeRequest } from "./bridge";
import { CancelledError, convert, countNodes, loadSettings, normalize, saveSettings } from "./convert";

/** v2: sizes saved before the screen-relative default are dropped once, so the new default shows. */
const SIZE_KEY = "window-size-v2";
const MCP_SERVER_PATH_KEY = "mcp-server-path";
/** Until the window reports the screen size. */
const DEFAULT_SIZE = { width: 480, height: 680 };
const MIN_SIZE = { width: 360, height: 400 };
/** Default window size as a share of the screen: a third of its width, two thirds of its height. */
const SCREEN_SHARE = { width: 1 / 3, height: 2 / 3 };

// ---------------------------------------------------------------------------
// Design mode: plugin window with live preview

/** The size the user last dragged the window to, if any. */
async function loadSize(): Promise<{ width: number; height: number } | null> {
  const stored = await figma.clientStorage.getAsync(SIZE_KEY);
  if (typeof stored?.width === "number" && typeof stored?.height === "number") {
    return { width: Math.max(MIN_SIZE.width, stored.width), height: Math.max(MIN_SIZE.height, stored.height) };
  }
  return null;
}

/** The plugin sandbox can't see the screen; the window reports it when it loads. */
function screenSize(screen: { width: number; height: number }): { width: number; height: number } {
  const fit = (share: number, total: number, min: number) => Math.round(Math.min(total, Math.max(min, total * share)));
  return {
    width: fit(SCREEN_SHARE.width, screen.width, MIN_SIZE.width),
    height: fit(SCREEN_SHARE.height, screen.height, MIN_SIZE.height),
  };
}

async function runWithUI() {
  const savedSize = await loadSize();
  figma.showUI(__html__, { ...(savedSize ?? DEFAULT_SIZE), themeColors: true });
  const post = (message: ToUIMessage) => figma.ui.postMessage(message);

  let settings = await loadSettings();
  /** Hashes of the images the window already has. */
  const sentImages = new Set<string>();
  let running = false;
  /** Something changed while a run was busy: its result is stale, so run once more after it. */
  let rerun = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let saveSize: ReturnType<typeof setTimeout> | undefined;

  // Runs never overlap: concurrent runs on a large frame compete for the same
  // plugin API and all finish late.
  const run = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    const selection = figma.currentPage.selection;
    if (selection.length === 0) return post({ type: "empty" });

    running = true;
    const total = countNodes(selection);
    post({ type: "loading", layers: total });
    try {
      const warnings = new Warnings();
      const started = Date.now();
      const { roots, images } = await normalize(selection, settings, warnings, {
        onProgress: (done) => post({ type: "progress", progress: { phase: "read", done: Math.min(done, total), total } }),
        // A newer selection or edit is waiting: this result would be thrown away anyway.
        shouldStop: () => rerun,
      });
      const read = Date.now();
      post({ type: "progress", progress: { phase: "generate", done: total, total } });
      // Let the message out before the generator holds the thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (rerun) throw new CancelledError();
      const result = generate(roots, images, settings, warnings);
      const stats = { layers: total, readMs: read - started, generateMs: Date.now() - read };
      const source = {
        fileName: figma.root.name,
        fileKey: figma.fileKey,
        nodes: selection.map((n) => ({
          id: n.id,
          name: n.name,
          width: Math.round(n.width),
          breakpoint: readBreakpoint(n),
          state: readBreakpoint(n) ? undefined : readState(n),
        })),
      };
      if (!rerun) {
        // Images can be many megabytes; the window keeps each one it has been sent.
        const unsent = images.filter((i) => !sentImages.has(i.hash));
        if (unsent.length > 0) {
          post({
            type: "images",
            images: unsent.map(({ hash, fileName, mimeType, width, height, bytes }) => ({ hash, fileName, mimeType, width, height, bytes })),
          });
          unsent.forEach((i) => sentImages.add(i.hash));
        }
        post({ type: "result", result: { ...result, images: result.images.map(({ hash, fileName }) => ({ hash, fileName })) }, source, stats });
      }
    } catch (error) {
      if (!rerun) post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
      if (rerun) {
        rerun = false;
        run();
      }
    }
  };

  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 150);
  };

  /** Only edits to the selected layers (or inside them) change the output. */
  const onNodeChange = (event: NodeChangeEvent) => {
    const selected = new Set(figma.currentPage.selection.map((n) => n.id));
    if (selected.size === 0) return;
    const relevant = event.nodeChanges.some(({ node }) => {
      // Copies made (and removed) while exporting must not trigger another run.
      if (scratchNodeIds.has(node.id)) return false;
      // A deleted layer has no parent left to check.
      if (node.removed) return true;
      for (let n: BaseNode | null = node; n; n = n.parent) if (selected.has(n.id)) return true;
      return false;
    });
    if (relevant) schedule();
  };

  figma.on("selectionchange", schedule);
  // Re-run when the selected layers are edited. Only the current page is
  // watched, so "dynamic-page" document access doesn't need to load all pages.
  let watched = figma.currentPage;
  watched.on("nodechange", onNodeChange);
  figma.on("currentpagechange", () => {
    watched.off("nodechange", onNodeChange);
    watched = figma.currentPage;
    watched.on("nodechange", onNodeChange);
    schedule();
  });

  figma.ui.onmessage = async (message: ToPluginMessage) => {
    switch (message.type) {
      case "ui-ready": {
        if (!savedSize && message.screen && message.screen.width > 0 && message.screen.height > 0) {
          const size = screenSize(message.screen);
          figma.ui.resize(size.width, size.height);
        }
        post({ type: "settings", settings });
        const serverPath = await figma.clientStorage.getAsync(MCP_SERVER_PATH_KEY);
        if (typeof serverPath === "string") post({ type: "mcp-server-path", path: serverPath });
        run();
        break;
      }
      case "remember-mcp-server-path":
        await figma.clientStorage.setAsync(MCP_SERVER_PATH_KEY, message.path);
        break;
      case "update-settings":
        settings = sanitizeSettings({ ...settings, ...message.settings });
        await saveSettings(settings);
        post({ type: "settings", settings });
        run();
        break;
      case "tag-frames": {
        // Stored on the frame itself, so the tag survives reloads and the MCP server sees it too.
        for (const tag of message.tags) {
          const node = await figma.getNodeByIdAsync(tag.nodeId);
          if (!node || node.type === "DOCUMENT" || node.type === "PAGE") continue;
          node.setPluginData(BREAKPOINT_KEY, tag.breakpoint ?? "");
          node.setPluginData(STATE_KEY, tag.breakpoint || !tag.state ? "" : toStateName(tag.state));
        }
        run();
        break;
      }
      case "export-project":
        try {
          const warnings = new Warnings();
          // Projects always reference image files, never embedded data URIs.
          const { roots, images } = await normalize(figma.currentPage.selection, settings, warnings);
          const project = buildProject(roots, images, settings.target, warnings);
          post({ type: "project", name: project.name, files: project.files });
        } catch (error) {
          figma.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, { error: true });
          post({ type: "project-failed" });
        }
        break;
      case "resize": {
        const size = {
          width: Math.max(MIN_SIZE.width, Math.round(message.width)),
          height: Math.max(MIN_SIZE.height, Math.round(message.height)),
        };
        figma.ui.resize(size.width, size.height);
        // Resizes arrive on every pointer move; only persist the final size.
        clearTimeout(saveSize);
        saveSize = setTimeout(() => figma.clientStorage.setAsync(SIZE_KEY, size), 300);
        break;
      }
      case "notify":
        figma.notify(message.message, { timeout: 1500 });
        break;
      case "bridge-request":
        post({ type: "bridge-response", response: await handleBridgeRequest(message.request) });
        break;
    }
  };
}

// ---------------------------------------------------------------------------
// Dev Mode: native code panel ("codegenLanguages" in manifest.json)

function runCodegen() {
  figma.codegen.on("generate", async ({ node, language }): Promise<CodegenResult[]> => {
    const stored = await loadSettings();
    const settings: Settings = { ...stored, target: isTarget(language) ? language : stored.target };
    const result = await convert([node], settings);

    const blocks: CodegenResult[] = result.sections.map((s) => ({ title: s.title, code: s.code, language: s.language }));
    if (result.images.length > 0) {
      blocks.push({
        title: "Images",
        code: `Referenced image files (export them from the Assets panel):\n${result.images.map((i) => `images/${i.fileName}`).join("\n")}`,
        language: "PLAINTEXT",
      });
    }
    if (result.warnings.length > 0) {
      blocks.push({ title: "Warnings", code: result.warnings.map((w) => `- ${w}`).join("\n"), language: "PLAINTEXT" });
    }
    return blocks;
  });
}

if (figma.mode === "codegen") runCodegen();
else runWithUI();
