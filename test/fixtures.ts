import type { Color, FrameNode, ShapeNode, TextNode, TextSegment } from "../src/core/ir";

export const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };
export const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
export const BLUE: Color = { r: 0.05, g: 0.6, b: 1, a: 1 };

const baseProps = {
  id: "1:1",
  positioning: "flow" as const,
  opacity: 1,
  fills: [],
  strokes: [],
  effects: [],
  radius: [0, 0, 0, 0] as [number, number, number, number],
};

export function frame(overrides: Partial<FrameNode> = {}): FrameNode {
  return {
    ...baseProps,
    kind: "frame",
    name: "Card",
    box: { x: 0, y: 0, width: 320, height: 200, rotation: 0 },
    sizing: { horizontal: "fixed", vertical: "fixed" },
    layout: null,
    strokesIncludedInLayout: false,
    clipsContent: false,
    children: [],
    ...overrides,
  };
}

export function shape(overrides: Partial<ShapeNode> = {}): ShapeNode {
  return {
    ...baseProps,
    kind: "shape",
    name: "Rectangle 1",
    box: { x: 0, y: 0, width: 40, height: 40, rotation: 0 },
    sizing: { horizontal: "fixed", vertical: "fixed" },
    ...overrides,
  };
}

export function segment(overrides: Partial<TextSegment> = {}): TextSegment {
  return {
    text: "Hello",
    fontFamily: "Inter",
    fontWeight: 400,
    fontSize: 16,
    italic: false,
    color: BLACK,
    letterSpacing: 0,
    textCase: "none",
    decoration: "none",
    ...overrides,
  };
}

export function text(segments: TextSegment[], overrides: Partial<TextNode> = {}): TextNode {
  return {
    ...baseProps,
    kind: "text",
    name: "Title",
    box: { x: 0, y: 0, width: 100, height: 24, rotation: 0 },
    sizing: { horizontal: "hug", vertical: "hug" },
    text: { segments, alignHorizontal: "left", alignVertical: "top", truncate: false },
    ...overrides,
  };
}
