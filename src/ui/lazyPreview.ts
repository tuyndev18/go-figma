// A large frame makes a preview of thousands of elements, and the iframe lays
// them all out before it shows anything. Larger documents start with their
// first sections only; the rest are appended as the preview scrolls toward
// them, and in the background until the page is whole.

/** Smaller documents render as they are. */
const LAZY_ABOVE_ELEMENTS = 2000;
/** Elements in the first render, and roughly in each batch appended after it. */
const BATCH_ELEMENTS = 600;

export interface LazyPreview {
  /** The document to load first. */
  html: string;
  /** Child indexes from <body> to the element the batches are appended to. */
  path: number[];
  /** HTML of each batch still to append, in order. */
  batches: string[];
}

export function splitPreview(html: string): LazyPreview {
  const whole = { html, path: [], batches: [] };
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.body.getElementsByTagName("*").length <= LAZY_ABOVE_ELEMENTS) return whole;

  // Wrappers with a single child lead to the element holding the page's sections.
  let container: Element = doc.body;
  const path: number[] = [];
  while (container.children.length === 1 && container.children[0].namespaceURI === container.namespaceURI) {
    container = container.children[0];
    path.push(0);
  }
  const children = [...container.children];
  if (children.length < 2) return whole;

  const sizes = children.map((child) => 1 + child.getElementsByTagName("*").length);
  let kept = 0;
  for (let total = 0; kept < children.length && (kept === 0 || total + sizes[kept] <= BATCH_ELEMENTS); kept++) total += sizes[kept];
  if (kept === children.length) return whole;

  const batches: string[] = [];
  let batch = "";
  let size = 0;
  for (let i = kept; i < children.length; i++) {
    batch += children[i].outerHTML;
    size += sizes[i];
    if (size >= BATCH_ELEMENTS || i === children.length - 1) {
      batches.push(batch);
      batch = "";
      size = 0;
    }
    children[i].remove();
  }
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, path, batches };
}

export function containerAt(doc: Document, path: number[]): Element | null {
  let el: Element | null = doc.body;
  for (const index of path) el = el?.children[index] ?? null;
  return el;
}

/** Lowest edge of the container's children, in document coordinates. */
export function contentBottom(container: Element): number {
  let bottom = 0;
  for (const child of container.children) bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
  return bottom;
}
