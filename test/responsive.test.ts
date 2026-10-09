import { describe, expect, it } from "vitest";
import type { AutoLayout, Breakpoint, FrameNode, IRNode } from "../src/core/ir";
import { Warnings } from "../src/core/warnings";
import { generate } from "../src/generators";
import { buildProject } from "../src/generators/project";
import { pageGroups, pageName } from "../src/generators/responsive";
import { frame, segment, shape, text } from "./fixtures";

const layout = (direction: "row" | "column", padding = 0): AutoLayout => ({
  direction,
  gap: 0,
  crossGap: 0,
  wrap: false,
  justify: "start",
  align: "start",
  padding: { top: padding, right: padding, bottom: padding, left: padding },
});

const screen = (breakpoint: Breakpoint, width: number, overrides: Partial<FrameNode>): FrameNode =>
  frame({ name: `${breakpoint[0].toUpperCase()}${breakpoint.slice(1)} Product`, breakpoint, box: { x: 0, y: 0, width, height: 900, rotation: 0 }, ...overrides });

const gallery = (direction: "row" | "column") => frame({ name: "Gallery", layout: layout(direction) });
const title = (fontSize: number) => text([segment({ text: "Short printed dress", fontSize })], { name: "Title" });
const nav = shape({ name: "Nav" });

const css = (roots: IRNode[]) => generate(roots, [], { target: "html-css" }, new Warnings()).sections[1].code;
const tailwind = (roots: IRNode[]) => generate(roots, [], { target: "react-tailwind" }, new Warnings()).sections[0].code;

describe("responsive pages", () => {
  const mobile = screen("mobile", 375, { layout: layout("column", 16), children: [gallery("column"), title(24)] });
  const desktop = screen("desktop", 1440, { layout: layout("row", 32), children: [nav, gallery("row"), title(48)] });

  it("writes the markup once, with the smallest frame as the base and media queries above it", () => {
    const out = css([desktop, mobile]);
    expect(out).toContain(".product {\n  display: flex;\n  flex-direction: column;");
    expect(out).toContain("width: 100%;");
    expect(out).toContain("min-height: 900px;");
    expect(out).toContain("@media (min-width: 1024px) {\n  .product {\n    padding: 32px;\n    flex-direction: row;\n  }");
    expect(out).toContain("  .title {\n    font-size: 48px;");

    const html = generate([desktop, mobile], [], { target: "html-css" }, new Warnings()).sections[0].code;
    expect(html.match(/Short printed dress/g)).toHaveLength(1);
  });

  it("hides layers missing from a frame and shows them where they exist", () => {
    const out = css([mobile, desktop]);
    expect(out).toMatch(/\.nav \{\n {2}display: none;/);
    expect(out).toMatch(/@media \(min-width: 1024px\) \{[\s\S]*\.nav \{[^}]*width: 40px;[^}]*display: block;/);
  });

  it("prefixes Tailwind classes with the breakpoint", () => {
    const out = tailwind([mobile, desktop]);
    expect(out).toContain("export default function Product()");
    expect(out).toContain('className="flex flex-col items-start p-4 min-h-225 w-full lg:p-8 lg:flex-row"');
    expect(out).toContain('className="hidden lg:w-10 lg:h-10 lg:shrink-0 lg:block"');
    expect(out).toMatch(/className="[^"]*text-2xl[^"]*lg:text-5xl"/);
  });

  it("reorders children whose order differs with `order`", () => {
    const a = shape({ name: "A" });
    const b = shape({ name: "B" });
    const out = css([
      screen("mobile", 375, { layout: layout("column"), children: [a, b] }),
      screen("tablet", 768, { layout: layout("column"), children: [b, a] }),
    ]);
    expect(out).toContain("@media (min-width: 768px) {\n  .a {\n    order: 1;\n  }\n\n  .b {\n    order: 0;\n  }\n}");
  });

  it("restates every padding side when one changes", () => {
    const out = css([
      screen("mobile", 375, { layout: { ...layout("column", 16), padding: { top: 16, right: 16, bottom: 16, left: 16 } } }),
      screen("desktop", 1440, { layout: { ...layout("column", 16), padding: { top: 40, right: 16, bottom: 16, left: 16 } } }),
    ]);
    expect(out).toContain("@media (min-width: 1024px) {\n  .product {\n    padding: 40px 16px 16px;");
  });

  it("previews each tagged frame at a width inside its breakpoint", () => {
    const tablet = screen("tablet", 1024, {});
    const result = generate([mobile, tablet, desktop], [], { target: "html-css" }, new Warnings());
    expect(result.previewSizes?.map((s) => [s.label, s.width])).toEqual([
      ["Mobile", 375],
      ["Tablet", 1023],
      ["Desktop", 1440],
    ]);
    expect(result.previewSize.width).toBe(1440);
  });

  it("groups tagged frames into one page and keeps the rest separate", () => {
    const warnings = new Warnings();
    const other = frame({ name: "Checkout" });
    const extraMobile = screen("mobile", 375, { name: "Mobile Copy" });
    const groups = pageGroups([other, desktop, mobile, extraMobile], warnings);
    expect(groups.map((g) => g.map((r) => r.name))).toEqual([["Checkout"], ["Mobile Product", "Desktop Product"], ["Mobile Copy"]]);
    expect(pageName(groups[1])).toBe("Product");
    expect(warnings.list()[0]).toContain('"Mobile Copy" is exported as a separate page');
  });

  it("exports a responsive page as one route", () => {
    const project = buildProject([desktop, mobile, frame({ name: "Checkout" })], [], "react-tailwind", new Warnings());
    const pages = project.files.filter((f) => f.path.endsWith("page.jsx")).map((f) => f.path);
    expect(project.name).toBe("product");
    expect(pages).toEqual(["app/page.jsx", "app/checkout/page.jsx"]);
    expect(project.files.find((f) => f.path === "app/page.jsx")?.text).toContain("lg:flex-row");
  });

  it("leaves untagged selections unchanged", () => {
    const plain = frame({ name: "Card", layout: layout("row") });
    expect(css([plain])).not.toContain("@media");
    expect(generate([plain], [], { target: "html-css" }, new Warnings()).previewSizes).toBeUndefined();
  });
});
