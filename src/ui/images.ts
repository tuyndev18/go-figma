// Images the sandbox has sent to the plugin window, once each per session.
// The preview gets downscaled copies: design files often hold photos of many
// megabytes, which made every preview render decode them at full size.
import { useEffect, useState } from "react";
import { PREVIEW_IMAGE_PREFIX, type PreviewImage } from "../shared/messages";

/** Longest side of a preview image; previews are scaled to fit the window anyway. */
const PREVIEW_MAX_SIDE = 1600;
/** Smaller files go in as they are. */
const DOWNSCALE_ABOVE_BYTES = 256 * 1024;

const store = new Map<string, PreviewImage>();
const previewUrls = new Map<string, Promise<string>>();

export function addImages(images: PreviewImage[]): void {
  for (const image of images) store.set(image.hash, image);
}

export function imageBytes(hash: string): Uint8Array | undefined {
  return store.get(hash)?.bytes;
}

/** `previewHtml` with its image placeholders swapped for (downscaled) data URIs; null until they're ready. */
export function usePreviewHtml(html: string, hashes: string[]): string | null {
  const [resolved, setResolved] = useState<{ source: string; html: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all(hashes.map((hash) => previewUrl(hash).then((url) => [hash, url] as const))).then((urls) => {
      if (cancelled) return;
      const byHash = new Map(urls);
      const pattern = new RegExp(`${PREVIEW_IMAGE_PREFIX}([\\w-]+)`, "g");
      setResolved({ source: html, html: html.replace(pattern, (_, hash: string) => byHash.get(hash) ?? "") });
    });
    return () => {
      cancelled = true;
    };
  }, [html, hashes.join(",")]);
  // Keep showing the last preview while a new one resolves.
  return resolved?.html ?? null;
}

function previewUrl(hash: string): Promise<string> {
  let url = previewUrls.get(hash);
  if (!url) {
    const image = store.get(hash);
    url = image ? downscale(image).catch(() => dataUrl(blobOf(image))) : Promise.resolve("");
    previewUrls.set(hash, url);
  }
  return url;
}

async function downscale(image: PreviewImage): Promise<string> {
  const blob = blobOf(image);
  const longest = Math.max(image.width, image.height);
  // GIFs would lose their animation; tiny files aren't worth re-encoding.
  if (image.mimeType === "image/gif" || image.bytes.length <= DOWNSCALE_ABOVE_BYTES) return dataUrl(blob);
  const scale = longest > 0 ? Math.min(1, PREVIEW_MAX_SIDE / longest) : 1;
  const options: ImageBitmapOptions =
    scale < 1
      ? { resizeWidth: Math.max(1, Math.round(image.width * scale)), resizeHeight: Math.max(1, Math.round(image.height * scale)), resizeQuality: "high" }
      : {};
  const bitmap = await createImageBitmap(blob, options);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  // JPEG for photos; WebP keeps transparency for everything else.
  return canvas.toDataURL(image.mimeType === "image/jpeg" ? "image/jpeg" : "image/webp", 0.85);
}

function blobOf(image: PreviewImage): Blob {
  return new Blob([image.bytes as BlobPart], { type: image.mimeType });
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
