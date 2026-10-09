import { describe, expect, it } from "vitest";
import { imageFits } from "../src/core/imageFit";
import type { Fill, ImageAsset } from "../src/core/ir";
import { frame, shape } from "./fixtures";

const photo: ImageAsset = {
  hash: "p",
  fileName: "photo-p.jpg",
  mimeType: "image/jpeg",
  bytes: new Uint8Array(),
  width: 4000,
  height: 3000,
};
const box = (width: number, height: number) => ({ x: 0, y: 0, width, height, rotation: 0 });
const fill = (extra: Partial<Extract<Fill, { type: "image" }>> = {}): Fill => ({ type: "image", hash: "p", scaleMode: "fill", ...extra });

describe("imageFits", () => {
  it("scales a photo down to twice the size it covers", () => {
    // Cover 400×200 → the 4:3 image shows at 400×300 → ×2 = 800×600.
    const fits = imageFits([shape({ box: box(400, 200), fills: [fill()] })], [photo]);
    expect(fits.get("p")).toEqual({ width: 800, height: 600 });
  });

  it("uses the largest use across the selection, including nested layers", () => {
    const small = shape({ box: box(100, 75), fills: [fill()] });
    const large = shape({ box: box(1000, 750), fills: [fill()] });
    const fits = imageFits([frame({ children: [small, frame({ children: [large] })] })], [photo]);
    expect(fits.get("p")).toEqual({ width: 2000, height: 1500 });
  });

  it("never upscales past the original", () => {
    const fits = imageFits([shape({ box: box(3000, 3000), fills: [fill()] })], [photo]);
    expect(fits.get("p")).toEqual({ width: 4000, height: 3000 });
  });

  it("accounts for fit, crop and tile modes", () => {
    const fit = imageFits([shape({ box: box(400, 400), fills: [fill({ scaleMode: "fit" })] })], [photo]);
    expect(fit.get("p")).toEqual({ width: 800, height: 600 });
    // Showing the middle half of the image in 400×300 means the whole image is 800×600 on screen.
    const crop = imageFits(
      [shape({ box: box(400, 300), fills: [fill({ scaleMode: "crop", crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } })] })],
      [photo],
    );
    expect(crop.get("p")).toEqual({ width: 1600, height: 1200 });
    const tile = imageFits([shape({ box: box(1000, 1000), fills: [fill({ scaleMode: "tile", tileSize: { width: 40, height: 30 } })] })], [photo]);
    expect(tile.get("p")).toEqual({ width: 80, height: 60 });
  });

  it("skips images whose size is unknown", () => {
    const unknown = { ...photo, width: 0, height: 0 };
    expect(imageFits([shape({ box: box(100, 100), fills: [fill()] })], [unknown]).size).toBe(0);
  });
});
