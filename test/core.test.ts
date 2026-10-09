import { describe, expect, it } from "vitest";
import { cssColor, fmt, linearGradientFromTransform, toHex, variableToCssName } from "../src/core/color";
import { boxFromTransform, invert, multiply, type Matrix } from "../src/core/geometry";
import { el, print, raw, svgToJsx, text } from "../src/core/markup";
import { ClassNamer, toPascal } from "../src/core/naming";
import { BLACK, WHITE } from "./fixtures";

describe("color", () => {
  it("formats numbers compactly", () => {
    expect(fmt(1.5)).toBe("1.5");
    expect(fmt(2.0001)).toBe("2");
    expect(fmt(-0.001)).toBe("0");
  });

  it("emits hex, rgba and variable references", () => {
    expect(toHex({ r: 1, g: 0.5, b: 0, a: 1 })).toBe("#ff8000");
    expect(cssColor({ ...BLACK, a: 0.25 })).toBe("rgba(0, 0, 0, 0.25)");
    expect(cssColor({ ...WHITE, variable: "surface" })).toBe("var(--surface, #ffffff)");
    expect(variableToCssName("Brand/Primary 500")).toBe("brand-primary-500");
  });

  const stops = [
    { position: 0, color: BLACK },
    { position: 1, color: WHITE },
  ];

  it("maps Figma's default left→right gradient to 90deg", () => {
    const identity: Matrix = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const g = linearGradientFromTransform(identity, stops, 200, 100);
    expect(g.angle).toBeCloseTo(90);
    expect(g.stops[0].position).toBeCloseTo(0);
    expect(g.stops[1].position).toBeCloseTo(1);
  });

  it("maps a top→bottom gradient to 180deg", () => {
    const topToBottom: Matrix = [
      [0, 1, 0],
      [-1, 0, 1],
    ];
    const g = linearGradientFromTransform(topToBottom, stops, 200, 100);
    expect(g.angle).toBeCloseTo(180);
    expect(g.stops[1].position).toBeCloseTo(1);
  });
});

describe("geometry", () => {
  it("inverts and multiplies back to identity", () => {
    const m: Matrix = [
      [0, -1, 10],
      [1, 0, 20],
    ];
    const id = multiply(invert(m), m);
    expect(id[0][0]).toBeCloseTo(1);
    expect(id[0][2]).toBeCloseTo(0);
    expect(id[1][1]).toBeCloseTo(1);
  });

  it("places a rotated node by its center", () => {
    // 100×20 node rotated 90° clockwise around its origin at (50, 50).
    const m: Matrix = [
      [0, -1, 50],
      [1, 0, 50],
    ];
    const box = boxFromTransform(m, 100, 20);
    expect(box.rotation).toBeCloseTo(90);
    // Center: (50 - 10, 50 + 50) = (40, 100)
    expect(box.x).toBeCloseTo(40 - 50);
    expect(box.y).toBeCloseTo(100 - 10);
  });

  it("reads a horizontal flip as a mirror, not a 180° rotation", () => {
    const flipped = boxFromTransform([[-1, 0, 40], [0, 1, 0]], 40, 20);
    expect(flipped).toMatchObject({ x: 0, y: 0, rotation: 0, flip: true });
    // Vertical flip = 180° rotation of a horizontal flip.
    expect(boxFromTransform([[1, 0, 0], [0, -1, 20]], 40, 20)).toMatchObject({ rotation: 180, flip: true });
    expect(boxFromTransform([[1, 0, 0], [0, 1, 0]], 40, 20).flip).toBeUndefined();
  });
});

describe("markup", () => {
  const tree = el("div", [["class", "card"]], [el("div", [["class", "title"]], [text("a < b {x}\nnext")]), el("div", [["class", "empty"]])]);

  it("prints HTML", () => {
    expect(print([tree], "html")).toBe(
      ['<div class="card">', '  <div class="title">a &lt; b {x}<br>next</div>', '  <div class="empty"></div>', "</div>"].join("\n"),
    );
  });

  it("prints JSX with className, escaped braces and self-closing tags", () => {
    expect(print([tree], "jsx")).toBe(
      [
        '<div className="card">',
        '  <div className="title">a &lt; b &#123;x&#125;<br />next</div>',
        '  <div className="empty" />',
        "</div>",
      ].join("\n"),
    );
  });

  it("converts SVG attributes for JSX", () => {
    const svg = '<svg xmlns:xlink="x"><path fill-rule="evenodd" stroke-width="2" style="mask-type:luminance" data-x-y="1"/></svg>';
    expect(svgToJsx(svg)).toBe(
      '<svg xmlnsXlink="x"><path fillRule="evenodd" strokeWidth="2" style={{ maskType: "luminance" }} data-x-y="1"/></svg>',
    );
    expect(print([el("div", [], [raw("<svg></svg>")])], "html")).toBe("<div>\n  <svg></svg>\n</div>");
  });
});

describe("naming", () => {
  it("derives unique class names and falls back for Figma defaults", () => {
    const namer = new ClassNamer();
    expect(namer.name("Primary Button", "frame")).toBe("primary-button");
    expect(namer.name("Primary Button", "frame")).toBe("primary-button-2");
    expect(namer.name("Frame 42", "frame")).toBe("frame");
    expect(namer.name("123", "text")).toBe("text-123");
    // "Primary Button 2" must not collide with the second "Primary Button".
    expect(namer.name("Primary Button 2", "frame")).toBe("primary-button-2-2");
    expect(namer.name("Primary Button", "frame")).toBe("primary-button-3");
    expect(toPascal("product card / large")).toBe("ProductCardLarge");
  });
});
