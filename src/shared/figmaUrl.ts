// Figma share links: https://www.figma.com/design/<fileKey>/<File-Name>?node-id=12-34
// (also /file/, /proto/, /board/, /slides/, and /branch/<branchKey>/ links).

export interface FigmaLink {
  /** The branch key for branch links, which is what an open branch reports as its file key. */
  fileKey: string;
  /** File name part of the URL ("Ecommerce-UI-Kit--Community-"), if present. */
  slug?: string;
  /** Layer id in plugin form ("12:34"). */
  nodeId?: string;
}

const PATH = /^\/(?:design|file|proto|board|slides|make)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/([^/]+))?/;

export function parseFigmaUrl(input: string): FigmaLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const match = url.pathname.match(PATH);
  if (!match) return null;

  const link: FigmaLink = { fileKey: match[2] ?? match[1] };
  if (match[3]) link.slug = safeDecode(match[3]);
  // URLs write "12:34" as "12-34" (or percent-encoded); ids never contain dashes.
  const nodeId = url.searchParams.get("node-id");
  if (nodeId) link.nodeId = nodeId.replace(/-/g, ":");
  return link;
}

/** Whether a URL slug plausibly names a file: Figma derives slugs from names by replacing punctuation with dashes. */
export function slugMatchesName(slug: string, name: string): boolean {
  const a = comparable(slug);
  const b = comparable(name);
  // Names without Latin letters or digits can't be compared this way.
  return a === "" || b === "" || a === b;
}

function comparable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
