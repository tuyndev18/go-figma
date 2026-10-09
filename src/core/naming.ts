const GENERIC_NAME = /^(frame|group|rectangle|ellipse|vector|line|text|instance|component|union|subtract|polygon|star)(\s*\d+)?$/i;

export function toKebab(name: string): string {
  // Strip diacritics so "Mời đấu" becomes "moi-dau" rather than "m-i-u".
  const decomposed = typeof name.normalize === "function" ? name.normalize("NFD") : name;
  return decomposed
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toPascal(name: string): string {
  const pascal = toKebab(name)
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  if (!pascal) return "Component";
  return /^[0-9]/.test(pascal) ? `Component${pascal}` : pascal;
}

/** Hands out unique, readable CSS class names derived from layer names. */
export class ClassNamer {
  /** Next suffix to try per base name. */
  private next = new Map<string, number>();
  /** Every name handed out: a layer called "Card 2" must not reuse the second "Card"'s name. */
  private taken = new Set<string>();

  /** `fallback` is used for Figma's auto-generated names like "Frame 12". */
  name(layerName: string, fallback: string): string {
    let base = GENERIC_NAME.test(layerName.trim()) ? fallback : toKebab(layerName);
    if (!base) base = fallback;
    if (/^[0-9]/.test(base)) base = `${fallback}-${base}`;
    let n = this.next.get(base) ?? 1;
    let name = n === 1 ? base : `${base}-${n}`;
    while (this.taken.has(name)) name = `${base}-${++n}`;
    this.next.set(base, n + 1);
    this.taken.add(name);
    return name;
  }
}
