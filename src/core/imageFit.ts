// The largest size each image is shown at in the design. Exports scale photos
// down to it (times the screen density) instead of shipping multi-megabyte
// originals that render a few hundred pixels wide.
import type { Box, Fill, ImageAsset, IRNode } from "./ir";

/** Target pixel size of an exported image; never larger than the original. */
export interface ImageFit {
  width: number;
  height: number;
}

/** Device pixels per CSS pixel kept in exported images, for retina screens. */
export const IMAGE_DENSITY = 2;

export function imageFits(roots: IRNode[], images: ImageAsset[]): Map<string, ImageFit> {
  const byHash = new Map(images.map((i) => [i.hash, i]));
  /** Hash → largest scale (shown size / original size) over every use. */
  const scales = new Map<string, number>();

  const visit = (node: IRNode) => {
    for (const fill of node.fills) {
      if (fill.type !== "image") continue;
      const image = byHash.get(fill.hash);
      if (!image || image.width <= 0 || image.height <= 0) continue;
      const shown = shownSize(fill, node.box, image);
      const scale = Math.max(shown.width / image.width, shown.height / image.height) * IMAGE_DENSITY;
      scales.set(fill.hash, Math.max(scales.get(fill.hash) ?? 0, scale));
    }
    if (node.kind === "frame") node.children.forEach(visit);
  };
  roots.forEach(visit);

  const fits = new Map<string, ImageFit>();
  for (const [hash, scale] of scales) {
    const image = byHash.get(hash)!;
    const s = Math.min(1, scale);
    fits.set(hash, { width: Math.max(1, Math.round(image.width * s)), height: Math.max(1, Math.round(image.height * s)) });
  }
  return fits;
}

/** CSS size of the whole image (not just its visible part) in a layer of size `box`. */
function shownSize(fill: Extract<Fill, { type: "image" }>, box: Box, image: ImageAsset): ImageFit {
  const cover = Math.max(box.width / image.width, box.height / image.height);
  switch (fill.scaleMode) {
    case "fit": {
      const contain = Math.min(box.width / image.width, box.height / image.height);
      return { width: image.width * contain, height: image.height * contain };
    }
    case "tile":
      if (fill.tileSize) return fill.tileSize;
      break;
    case "crop":
      // The visible part fills the box, so the whole image is box / visible share.
      if (fill.crop && fill.crop.width > 0 && fill.crop.height > 0) {
        return { width: box.width / fill.crop.width, height: box.height / fill.crop.height };
      }
      break;
  }
  return { width: image.width * cover, height: image.height * cover };
}
