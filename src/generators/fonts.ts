import type { IRNode } from "../core/ir";

// Fonts that ship with operating systems and aren't on Google Fonts.
const SYSTEM_FONT = /^(arial|helvetica|times|georgia|verdana|tahoma|trebuchet|courier|segoe|sf |sf-|san francisco|apple|system-ui|menlo|consolas|calibri|cambria)/i;

/**
 * Google Fonts stylesheet URLs for the fonts used in the design. One URL per
 * family and style: the API rejects the whole request if any family or weight
 * is unknown (Lato has no 500 or 800), so a missing style only fails on its
 * own and the browser falls back to the nearest weight that did load.
 */
export function googleFontUrls(roots: IRNode[]): string[] {
  const usage = new Map<string, Set<string>>();
  const walk = (node: IRNode) => {
    if (node.kind === "text") {
      for (const s of node.text.segments) {
        if (s.fontFamily === "" || SYSTEM_FONT.test(s.fontFamily)) continue;
        const styles = usage.get(s.fontFamily) ?? new Set<string>();
        styles.add(`${s.italic ? 1 : 0},${Math.round(s.fontWeight)}`);
        usage.set(s.fontFamily, styles);
      }
    }
    if (node.kind === "frame") node.children.forEach(walk);
  };
  roots.forEach(walk);

  return [...usage].flatMap(([family, styles]) => {
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    const sorted = [...styles].sort((a, b) => {
      const [ia, wa] = a.split(",").map(Number);
      const [ib, wb] = b.split(",").map(Number);
      return ia - ib || wa - wb;
    });
    return sorted.map((tuple) => `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${tuple}&display=swap`);
  });
}

export function googleFontLinks(roots: IRNode[]): string {
  return googleFontUrls(roots)
    .map((url) => `<link rel="stylesheet" href="${url.replace(/&/g, "&amp;")}">`)
    .join("\n");
}
