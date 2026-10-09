export type Target = "html-css" | "react-tailwind" | "html-tailwind";

export const TARGETS: { value: Target; label: string }[] = [
  { value: "html-css", label: "HTML + CSS" },
  { value: "react-tailwind", label: "React + Tailwind" },
  { value: "html-tailwind", label: "HTML + Tailwind" },
];

export interface Settings {
  target: Target;
  /** Emit `var(--name, #fallback)` for colors bound to Figma variables. */
  useColorVariables: boolean;
  /** Export vector layers and small icon frames as inline SVG. */
  inlineSvg: boolean;
  /** Scale exported image files down to the size the design shows them at (×2), re-compressed. */
  optimizeImages: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  target: "react-tailwind",
  useColorVariables: true,
  inlineSvg: true,
  optimizeImages: true,
};

export function isTarget(value: unknown): value is Target {
  return TARGETS.some((t) => t.value === value);
}

/** Merge stored settings over defaults, dropping keys with the wrong type. */
export function sanitizeSettings(raw: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return result;
  const r = raw as Record<string, unknown>;
  if (isTarget(r.target)) result.target = r.target;
  if (typeof r.useColorVariables === "boolean") result.useColorVariables = r.useColorVariables;
  if (typeof r.inlineSvg === "boolean") result.inlineSvg = r.inlineSvg;
  if (typeof r.optimizeImages === "boolean") result.optimizeImages = r.optimizeImages;
  return result;
}
