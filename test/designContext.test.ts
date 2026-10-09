import { describe, expect, it } from "vitest";
import type { ImageAsset, SvgNode } from "../src/core/ir";
import { Warnings } from "../src/core/warnings";
import { generate } from "../src/generators";
import { designContext } from "../src/generators/designContext";
import { frame, segment, shape, text } from "./fixtures";

const ICON = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" stroke-width="2"/></svg>';

const icon = (id: string): SvgNode => ({
  ...shape({ id, name: "Vector" }),
  kind: "svg",
  svg: ICON,
  component: { name: "Icon/Arrow Left", properties: {} },
});

const photo: ImageAsset = {
  hash: "abc123",
  fileName: "hero-abc123.png",
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
  width: 640,
  height: 480,
};

const button = (id: string, variant: string, label: string) =>
  frame({
    id,
    name: "Button",
    component: {
      name: "Button",
      properties: { Variant: variant, Disabled: false },
      remote: true,
      description: "Primary call to action",
      documentationLinks: ["https://example.com/button"],
    },
    children: [text([segment({ text: label })], { id: `${id}-label` })],
  });

const screen = frame({
  id: "1:1",
  name: "Login",
  annotations: ["Max width 480px on desktop"],
  children: [
    shape({ id: "1:2", name: "Hero", fills: [{ type: "image", hash: "abc123", scaleMode: "fill" }] }),
    icon("1:3"),
    icon("1:4"),
    button("1:5", "Primary", "Sign in"),
    button("1:6", "Ghost", "Sign up"),
  ],
});

describe("design context", () => {
  const context = designContext([screen], [photo], "react-tailwind", new Warnings());
  const code = context.sections[0].code;

  it("tags elements with their Figma layer, component and annotations", () => {
    expect(code).toContain('data-node-id="1:1" data-name="Login" data-annotation="Max width 480px on desktop"');
    expect(code).toContain('data-node-id="1:5" data-name="Button" data-component="Button" data-props="Variant=Primary, Disabled=false"');
    expect(code).toContain('data-node-id="1:5-label" data-name="Title"');
  });

  it("references images and icons as asset files instead of inlining them", () => {
    expect(code).toContain("bg-[url('assets/hero-abc123.png')]");
    expect(code).toContain('<img className="');
    expect(code).toContain('src="assets/icon-arrow-left.svg" alt="Vector" data-node-id="1:3"');
    expect(code).not.toContain("<svg");
    // The same icon twice is one file.
    expect(context.assets.map((a) => [a.fileName, a.kind])).toEqual([
      ["hero-abc123.png", "image"],
      ["icon-arrow-left.svg", "icon"],
    ]);
    expect(context.assets[1].text).toBe(ICON);
  });

  it("summarizes the components in use", () => {
    expect(context.components).toEqual([
      { name: "Icon/Arrow Left", instances: 2, variants: [], nodeIds: ["1:3", "1:4"] },
      {
        name: "Button",
        instances: 2,
        variants: ["Variant=Primary, Disabled=false", "Variant=Ghost, Disabled=false"],
        nodeIds: ["1:5", "1:6"],
        remote: true,
        description: "Primary call to action",
        documentationLinks: ["https://example.com/button"],
      },
    ]);
    expect(context.annotations).toEqual([{ nodeId: "1:1", name: "Login", text: "Max width 480px on desktop" }]);
  });

  it("supports HTML + CSS reference code", () => {
    const html = designContext([screen], [photo], "html-css", new Warnings()).sections;
    expect(html.map((s) => s.title)).toEqual(["HTML", "CSS"]);
    expect(html[0].code).toContain('<div class="button" data-node-id="1:5"');
  });

  it("leaves plain generated code untouched", () => {
    const plain = generate([screen], [photo], { target: "react-tailwind" }, new Warnings());
    expect(plain.sections[0].code).not.toContain("data-node-id");
    expect(plain.sections[0].code).toContain("<svg");
  });
});
