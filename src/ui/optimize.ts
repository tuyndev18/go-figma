// Scales exported image files down to the size the design shows them at
// (core/imageFit) and re-compresses them in the same format, so file names and
// the code referencing them don't change. The plugin window does this because
// it has a canvas; neither the sandbox nor the MCP server can decode images.
import type { ImageFit } from "../core/imageFit";
import { sniffImageType } from "../core/image";

/** Re-encode quality for JPEG and WebP. */
const QUALITY = 0.85;
/** Same file asked for again (agents call get_design_context repeatedly): reuse the result. */
const cache = new Map<string, Promise<Uint8Array | null>>();
const CACHE_LIMIT = 50;

/** The smaller file, or null when the original is as small as it gets. */
export function optimizeImage(bytes: Uint8Array, fit: ImageFit): Promise<Uint8Array | null> {
  const key = `${bytes.length}:${fingerprint(bytes)}:${fit.width}x${fit.height}`;
  let result = cache.get(key);
  if (!result) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    result = encode(bytes, fit).catch(() => null);
    cache.set(key, result);
  }
  return result;
}

/**
 * Optimizes, in place, every `{ bytes, fit }` file in a message (export
 * results, MCP responses) and drops the `fit` hints.
 */
export async function optimizeFiles<T>(value: T, enabled: boolean): Promise<T> {
  const jobs: Promise<void>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object" || node instanceof Uint8Array) return;
    const file = node as Record<string, unknown>;
    if (file.bytes instanceof Uint8Array && "fit" in file) {
      const fit = file.fit as ImageFit | undefined;
      delete file.fit;
      const bytes = file.bytes;
      if (enabled && fit) {
        jobs.push(
          optimizeImage(bytes, fit).then((smaller) => {
            if (!smaller) return;
            file.bytes = smaller;
            // Design-context assets report their pixel size to the agent.
            if (typeof file.width === "number") file.width = fit.width;
            if (typeof file.height === "number") file.height = fit.height;
          }),
        );
      }
      return;
    }
    Object.values(file).forEach(visit);
  };
  visit(value);
  await Promise.all(jobs);
  return value;
}

async function encode(bytes: Uint8Array, fit: ImageFit): Promise<Uint8Array | null> {
  const { mimeType } = sniffImageType(bytes);
  // GIFs would lose their animation; unknown formats can't be re-encoded.
  if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") return null;
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }), {
    resizeWidth: fit.width,
    resizeHeight: fit.height,
    resizeQuality: "high",
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, QUALITY));
  if (!blob) return null;
  const smaller = new Uint8Array(await blob.arrayBuffer());
  // Re-encoding a small or already compressed file can make it bigger.
  return smaller.length < bytes.length ? smaller : null;
}

/** Cheap content check for the cache key: a few samples across the file. */
function fingerprint(bytes: Uint8Array): number {
  let hash = 0;
  const step = Math.max(1, Math.floor(bytes.length / 64));
  for (let i = 0; i < bytes.length; i += step) hash = (hash * 31 + bytes[i]) | 0;
  return hash;
}
