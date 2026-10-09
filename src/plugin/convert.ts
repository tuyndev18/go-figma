// Shared by the plugin window, Dev Mode codegen and the MCP bridge.
import type { ImageAsset, IRNode } from "../core/ir";
import { normalizeSelection, type NormalizeOptions } from "../core/normalize";
import { takeRemoteWarnings } from "../core/remote";
import { Warnings } from "../core/warnings";
import { generate } from "../generators";
import type { GenerateResult } from "../shared/messages";
import { sanitizeSettings, type Settings } from "../shared/settings";

export { CancelledError, countNodes } from "../core/normalize";

const STORAGE_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  return sanitizeSettings(await figma.clientStorage.getAsync(STORAGE_KEY));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY, settings);
}

// Base64-encoding large images is slow; keep them across selection changes.
const imageCache = new Map<string, ImageAsset>();
const IMAGE_CACHE_LIMIT = 100;

export async function normalize(
  nodes: readonly SceneNode[],
  settings: Settings,
  warnings: Warnings,
  options?: NormalizeOptions,
): Promise<{ roots: IRNode[]; images: ImageAsset[] }> {
  // Drop the least recently used images, not all of them: a selection with
  // more images than the limit would otherwise download everything every run.
  for (const hash of imageCache.keys()) {
    if (imageCache.size <= IMAGE_CACHE_LIMIT) break;
    imageCache.delete(hash);
  }
  takeRemoteWarnings();
  const result = await normalizeSelection(nodes, settings, warnings, imageCache, options);
  takeRemoteWarnings().forEach((w) => warnings.add(w));
  return result;
}

export async function convert(nodes: readonly SceneNode[], settings: Settings): Promise<GenerateResult> {
  const warnings = new Warnings();
  const { roots, images } = await normalize(nodes, settings, warnings);
  return generate(roots, images, settings, warnings);
}
