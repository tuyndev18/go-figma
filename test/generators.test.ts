import { describe, expect, it } from "vitest";
import { sniffImageSize, sniffImageType } from "../src/core/image";
import type { AutoLayout, Constraint, ImageAsset } from "../src/core/ir";
import { Warnings } from "../src/core/warnings";
import { generate } from "../src/generators";
import { nodeStyle, type StyleContext } from "../src/generators/css";
import { googleFontUrls } from "../src/generators/fonts";
import { compact } from "../src/generators/htmlCss";
import { toTailwind } from "../src/generators/tailwind";
import { createZip, crc32 } from "../src/ui/zip";
import { BLACK, BLUE, WHITE, frame, segment, shape, text } from "./fixtures";

const ctx = (): StyleContext => ({ warnings: new Warnings(), imageUrl: (hash) => `img/${hash}` });

const column: AutoLayout = {
  direction: "column",
  gap: 12,
  crossGap: 0,
  wrap: false,
  justify: "start",
  align: "start",
  padding: { top: 16, right: 24, bottom: 16, left: 24 },
};

describe("css", () => {
  it("turns auto layout into flexbox", () => {
    const style = nodeStyle(frame({ layout: column }), null, ctx());
    expect(style).toEqual([
      ["display", "flex"],
      ["flex-direction", "column"],
      ["align-items", "flex-start"],
      ["gap", "12px"],
      ["padding-top", "16px"],
      ["padding-right", "24px"],
      ["padding-bottom", "16px"],
      ["padding-left", "24px"],
      ["width", "320px"],
      ["height", "200px"],
    ]);
  });

  it("maps fill sizing along and across the parent axis", () => {
    const parent = frame({ layout: column });
    const child = shape({ sizing: { horizontal: "fill", vertical: "fill" } });
    expect(nodeStyle(child, parent, ctx())).toEqual([
      ["align-self", "stretch"],
      ["flex", "1 1 0"],
      ["min-height", "0"],
    ]);
  });

  it("mirrors flipped layers after rotating them", () => {
    const node = shape({ positioning: "absolute", box: { x: 0, y: 0, width: 40, height: 40, rotation: 90, flip: true } });
    expect(nodeStyle(node, frame({ children: [node] }), ctx())).toContainEqual(["transform", "rotate(90deg) scaleX(-1)"]);
  });

  it("keeps fixed flex items from shrinking", () => {
    const style = nodeStyle(shape(), frame({ layout: column }), ctx());
    expect(style).toContainEqual(["flex-shrink", "0"]);
  });

  it("positions children of non-auto-layout frames absolutely", () => {
    const child = shape({ positioning: "absolute", box: { x: 10, y: 20, width: 40, height: 40, rotation: 45 } });
    const parent = frame({ children: [child] });
    expect(nodeStyle(parent, null, ctx())).toContainEqual(["position", "relative"]);
    expect(nodeStyle(child, parent, ctx())).toEqual(
      expect.arrayContaining([
        ["position", "absolute"],
        ["left", "10px"],
        ["top", "20px"],
        ["transform", "rotate(45deg)"],
      ]),
    );
  });

  it("anchors absolute layers to the edges their constraints pin them to", () => {
    const pinned = (horizontal: Constraint, vertical: Constraint) => {
      const child = shape({ positioning: "absolute", box: { x: 100, y: 20, width: 40, height: 40, rotation: 0 }, constraints: { horizontal, vertical } });
      return nodeStyle(child, frame({ children: [child] }), ctx());
    };
    // Parent is 320 × 200.
    expect(pinned("end", "end")).toEqual(expect.arrayContaining([["right", "180px"], ["bottom", "140px"], ["width", "40px"]]));
    expect(pinned("center", "start")).toContainEqual(["left", "calc(50% - 60px)"]);
    const stretched = pinned("stretch", "scale");
    expect(stretched).toEqual(expect.arrayContaining([["left", "100px"], ["right", "180px"], ["top", "10%"], ["height", "20%"]]));
    expect(stretched.some(([p]) => p === "width")).toBe(false);
  });

  it("turns negative auto layout spacing into overlapping margins", () => {
    const first = shape({ id: "a" });
    const second = shape({ id: "b" });
    const parent = frame({ layout: { ...column, gap: -100, reverseZIndex: true }, children: [first, second] });
    expect(nodeStyle(parent, null, ctx()).some(([p]) => p === "gap")).toBe(false);
    expect(nodeStyle(first, parent, ctx())).toEqual(expect.arrayContaining([["position", "relative"], ["z-index", "2"]]));
    const style = nodeStyle(second, parent, ctx());
    expect(style).toEqual(expect.arrayContaining([["margin-top", "-100px"], ["z-index", "1"]]));
    expect(toTailwind(style)).toEqual(expect.arrayContaining(["-mt-25", "z-1"]));
  });

  it("subtracts inside borders from padding when strokes are outside layout", () => {
    const node = frame({
      layout: column,
      strokes: [{ color: BLACK, weights: { top: 1, right: 1, bottom: 1, left: 1 }, align: "inside", dashed: false }],
    });
    const style = nodeStyle(node, null, ctx());
    expect(style).toContainEqual(["padding-top", "15px"]);
    expect(style).toContainEqual(["border-width", "1px"]);
  });

  it("draws center strokes as an outline that takes no space", () => {
    const node = shape({
      strokes: [{ color: BLACK, weights: { top: 2, right: 2, bottom: 2, left: 2 }, align: "center", dashed: false }],
    });
    expect(nodeStyle(node, null, ctx())).toEqual(
      expect.arrayContaining([
        ["outline-width", "2px"],
        ["outline-offset", "-1px"],
      ]),
    );
  });

  it("stacks multiple fills as background layers", () => {
    const node = shape({
      fills: [
        { type: "solid", color: WHITE },
        { type: "solid", color: { ...BLACK, a: 0.5 } },
      ],
    });
    expect(nodeStyle(node, null, ctx())).toEqual(
      expect.arrayContaining([
        ["background-image", "linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))"],
        ["background-color", "#ffffff"],
      ]),
    );
  });

  it("compacts longhands into shorthands", () => {
    expect(
      compact([
        ["padding-top", "8px"],
        ["padding-bottom", "8px"],
        ["border-width", "1px"],
        ["border-style", "solid"],
        ["border-color", "#000000"],
      ]),
    ).toEqual([
      ["padding", "8px 0"],
      ["border", "1px solid #000000"],
    ]);
  });
});

describe("tailwind", () => {
  it("maps declarations onto the v4 scale with arbitrary fallbacks", () => {
    expect(
      toTailwind([
        ["display", "flex"],
        ["flex-direction", "column"],
        ["align-items", "center"],
        ["gap", "12px"],
        ["padding-top", "16px"],
        ["padding-right", "24px"],
        ["padding-bottom", "16px"],
        ["padding-left", "24px"],
        ["width", "320px"],
        ["height", "37px"],
        ["background-color", "#ffffff"],
        ["border-radius", "8px"],
        ["color", "rgba(0, 0, 0, 0.5)"],
        ["font-family", "'Open Sans'"],
        ["font-size", "14px"],
        ["font-weight", "600"],
        ["left", "-8px"],
        ["mix-blend-mode", "multiply"],
      ]),
    ).toEqual([
      "flex",
      "flex-col",
      "items-center",
      "gap-3",
      "px-6",
      "py-4",
      "w-80",
      "h-[37px]",
      "bg-white",
      "rounded-lg",
      "text-black/50",
      "font-['Open_Sans']",
      "text-sm",
      "font-semibold",
      "-left-2",
      "[mix-blend-mode:multiply]",
    ]);
  });

  it("adds a color type hint for CSS variables", () => {
    expect(toTailwind([["background-color", "var(--surface, #ffffff)"]])).toEqual(["bg-[color:var(--surface,#ffffff)]"]);
  });
});

describe("generate", () => {
  const card = frame({
    name: "Product Card",
    layout: { ...column, align: "center" },
    fills: [{ type: "solid", color: WHITE }],
    radius: [12, 12, 12, 12],
    children: [
      text([segment({ text: "Hello ", fontWeight: 700 }), segment({ text: "world", color: BLUE })], { name: "Title" }),
      shape({ name: "Divider", sizing: { horizontal: "fill", vertical: "fixed" }, box: { x: 0, y: 0, width: 272, height: 1, rotation: 0 }, fills: [{ type: "solid", color: BLACK }] }),
    ],
  });

  it("generates a React + Tailwind component", () => {
    const { sections } = generate([card], [], { target: "react-tailwind" }, new Warnings());
    expect(sections[0].code).toBe(
      [
        "export default function ProductCard() {",
        "  return (",
        '    <div className="flex flex-col items-center gap-3 px-6 py-4 w-80 h-50 bg-white rounded-xl">',
        "      <div className=\"whitespace-nowrap font-['Inter',sans-serif] text-base\"><span className=\"text-black font-bold\">Hello </span><span className=\"text-[#0d99ff]\">world</span></div>",
        '      <div className="self-stretch h-px shrink-0 bg-black" />',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    );
  });

  it("generates HTML + CSS with semantic class names and a preview", () => {
    const result = generate([card], [], { target: "html-css" }, new Warnings());
    const [html, css] = result.sections;
    expect(html.code).toContain('<div class="product-card">');
    expect(html.code).toContain('<span class="title-span">Hello </span>');
    expect(css.code).toContain(".product-card {\n  display: flex;");
    expect(css.code).toContain("  padding: 16px 24px;");
    expect(css.code).toContain("  border-radius: 12px;");
    expect(result.previewHtml).toContain(css.code);
    expect(result.previewSize).toEqual({ width: 320, height: 200 });
  });

  const asset: ImageAsset = {
    hash: "abc123",
    fileName: "hero-abc123.png",
    mimeType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    width: 100,
    height: 50,
  };
  const hero = shape({ name: "Hero", fills: [{ type: "image", hash: "abc123", scaleMode: "fill" }] });

  it("references image files in code and placeholders in the preview, which the window fills in", () => {
    const result = generate([hero], [asset], { target: "html-css" }, new Warnings());
    expect(result.sections[1].code).toContain("background-image: url('images/hero-abc123.png');");
    expect(result.previewHtml).toContain("url('goapp-figma-image:abc123')");
    expect(result.previewHtml).not.toContain("base64");
    expect(result.previewImages).toEqual(["abc123"]);
    expect(result.images).toMatchObject([{ hash: "abc123", fileName: "hero-abc123.png", bytes: asset.bytes }]);
    expect(result.images[0].fit).toBeDefined();
  });

  it("never inlines images as base64", () => {
    const result = generate([hero], [asset], { target: "react-tailwind" }, new Warnings());
    expect(result.sections[0].code).toContain("bg-[url('images/hero-abc123.png')]");
    expect(result.sections[0].code).not.toContain("base64");
  });

  it("collects warnings without global state", () => {
    const textWithStroke = text([segment()], {
      strokes: [{ color: BLACK, weights: { top: 1, right: 1, bottom: 1, left: 1 }, align: "center", dashed: false }],
    });
    const settings = { target: "html-css" } as const;
    expect(generate([textWithStroke], [], settings, new Warnings()).warnings).toEqual([
      "Text strokes are not supported and were skipped.",
    ]);
    expect(generate([shape()], [], settings, new Warnings()).warnings).toEqual([]);
  });
});

describe("images", () => {
  it("stacks image fills under overlays with per-layer placement", () => {
    const node = shape({
      fills: [
        { type: "solid", color: WHITE },
        { type: "image", hash: "a", scaleMode: "tile", tileSize: { width: 20, height: 10 } },
        { type: "linear", angle: 180, stops: [{ position: 0, color: { ...BLACK, a: 0 } }, { position: 1, color: BLACK }] },
      ],
    });
    expect(nodeStyle(node, null, ctx())).toEqual(
      expect.arrayContaining([
        ["background-image", "linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, #000000 100%), url('img/a')"],
        ["background-size", "auto, 20px 10px"],
        ["background-position", "0 0, 0 0"],
        ["background-repeat", "repeat, repeat"],
        ["background-color", "#ffffff"],
      ]),
    );
  });

  it("scales and offsets cropped images to show the crop window", () => {
    // Crop shows the middle half horizontally and the bottom half vertically.
    const node = shape({ fills: [{ type: "image", hash: "a", scaleMode: "crop", crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 } }] });
    expect(nodeStyle(node, null, ctx())).toEqual(
      expect.arrayContaining([
        ["background-size", "200% 200%"],
        ["background-position", "50% 100%"],
        ["background-repeat", "no-repeat"],
      ]),
    );
  });

  it("sniffs image types from magic bytes", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).extension).toBe("jpg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).mimeType).toBe("image/png");
  });

  it("reads image dimensions from file headers", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x2c, 0, 0, 0, 0xc8]);
    expect(sniffImageSize(png)).toEqual({ width: 300, height: 200 });

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
    expect(sniffImageSize(gif)).toEqual({ width: 320, height: 240 });

    // SOI, APP0 (length 4), SOF0 with height 480, width 640.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    expect(sniffImageSize(jpg)).toEqual({ width: 640, height: 480 });

    expect(sniffImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("fonts", () => {
  it("builds one Google Fonts URL per family and style", () => {
    const root = frame({
      children: [
        text([segment({ fontFamily: "Open Sans", fontWeight: 700 }), segment({ fontFamily: "Open Sans", fontWeight: 400 })]),
        text([segment({ fontFamily: "Arial" })]),
      ],
    });
    expect(googleFontUrls([root])).toEqual([
      "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400&display=swap",
      "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,700&display=swap",
    ]);
  });
});

describe("zip", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
  });

  it("writes stored entries with a valid central directory", () => {
    const data = new TextEncoder().encode("hello");
    const zip = createZip([{ path: "images/a.txt", bytes: data }]);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(centralOffset + 16, true)).toBe(0x3610a686);
    // Local header (30 bytes) + name (12 bytes), then the raw data.
    expect(new TextDecoder().decode(zip.slice(42, 47))).toBe("hello");
  });
});
