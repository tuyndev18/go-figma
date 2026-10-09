import { apply, invert, type Matrix } from "./geometry";
import type { Color, GradientStop, RGBA } from "./ir";

/** Round to at most 2 decimals and drop trailing zeros: 1.50 → "1.5", -0 → "0". */
export function fmt(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

const channel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

export function toHex(c: RGBA): string {
  return "#" + [c.r, c.g, c.b].map((v) => channel(v).toString(16).padStart(2, "0")).join("");
}

/** Plain CSS color without variable references. */
export function rawCssColor(c: RGBA): string {
  if (c.a >= 1) return toHex(c);
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${fmt(c.a)})`;
}

/** CSS color, referencing the bound Figma variable (with fallback) when present. */
export function cssColor(c: Color): string {
  const raw = rawCssColor(c);
  return c.variable ? `var(--${c.variable}, ${raw})` : raw;
}

export function withAlpha<T extends RGBA>(c: T, alpha: number): T {
  return { ...c, a: c.a * alpha };
}

/** Make a Figma variable name safe for a CSS custom property: "Brand/Primary 500" → "brand-primary-500". */
export function variableToCssName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "color"
  );
}

/**
 * Convert a Figma linear gradient to CSS.
 *
 * Figma's `gradientTransform` maps normalized node space (0..1) into gradient
 * space, where the gradient runs from (0, 0.5) to (1, 0.5). Inverting it gives
 * the handle positions in the node. CSS instead defines a gradient line through
 * the box center whose length depends on the angle, so stop positions are
 * re-projected onto that line.
 */
export function linearGradientFromTransform(
  transform: Matrix,
  stops: GradientStop[],
  width: number,
  height: number,
): { angle: number; stops: GradientStop[] } {
  const inv = invert(transform);
  const toPx = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height });
  const start = toPx(apply(inv, { x: 0, y: 0.5 }));
  const end = toPx(apply(inv, { x: 1, y: 0.5 }));

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // CSS: 0deg points up, 90deg points right (y grows downward).
  const angleRad = Math.atan2(dx, -dy);
  const dir = { x: Math.sin(angleRad), y: -Math.cos(angleRad) };
  const lineLength = Math.abs(width * dir.x) + Math.abs(height * dir.y);
  const center = { x: width / 2, y: height / 2 };
  const project = (p: { x: number; y: number }) =>
    lineLength === 0 ? 0 : ((p.x - center.x) * dir.x + (p.y - center.y) * dir.y) / lineLength + 0.5;

  const t0 = project(start);
  const t1 = project(end);
  const angle = ((angleRad * 180) / Math.PI + 360) % 360;
  return {
    angle,
    stops: stops.map((s) => ({ ...s, position: t0 + s.position * (t1 - t0) })),
  };
}

export function cssGradientStops(stops: GradientStop[]): string {
  return stops.map((s) => `${cssColor(s.color)} ${fmt(s.position * 100)}%`).join(", ");
}
