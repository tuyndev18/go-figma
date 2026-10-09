import { imageFits } from "../core/imageFit";
import type { ImageAsset, IRNode } from "../core/ir";
import type { Warnings } from "../core/warnings";
import { PREVIEW_IMAGE_PREFIX, type CodeSection, type GenerateResult, type PreviewSize } from "../shared/messages";
import type { Settings } from "../shared/settings";
import type { StyleContext } from "./css";
import { googleFontLinks } from "./fonts";
import { generateHtmlCss } from "./htmlCss";
import { breakpointLabel, pageGroups, previewWidth } from "./responsive";
import { generateTailwind } from "./tailwind";
import { buildTree } from "./tree";

export const IMAGE_DIR = "images";

export function generate(
  roots: IRNode[],
  images: ImageAsset[],
  settings: Pick<Settings, "target">,
  warnings: Warnings,
): GenerateResult {
  const byHash = new Map(images.map((i) => [i.hash, i]));
  const filePath = (hash: string) => `${IMAGE_DIR}/${byHash.get(hash)?.fileName ?? hash}`;

  const codeCtx: StyleContext = { warnings, imageUrl: filePath };
  const tree = buildTree(roots, codeCtx);
  // The preview always renders plain HTML + CSS; the plugin iframe has no
  // network access and can't read local files, so images are placeholders.
  const previewTree = images.length === 0 ? tree : buildTree(roots, { warnings, imageUrl: (hash) => PREVIEW_IMAGE_PREFIX + hash });
  const preview = generateHtmlCss(previewTree);

  let sections: CodeSection[];
  switch (settings.target) {
    case "html-css": {
      const code = previewTree === tree ? preview : generateHtmlCss(tree);
      sections = [
        { title: "HTML", language: "HTML", code: code.html },
        { title: "CSS", language: "CSS", code: code.css },
      ];
      break;
    }
    case "react-tailwind":
      sections = [{ title: "React", language: "JAVASCRIPT", code: generateTailwind(tree, "jsx") }];
      break;
    case "html-tailwind":
      sections = [{ title: "HTML", language: "HTML", code: generateTailwind(tree, "html") }];
      break;
  }

  const previewSizes = mergedPreviews(roots);
  const fits = imageFits(roots, images);
  return {
    sections,
    previewHtml: previewDocument(preview.html, preview.css, googleFontLinks(roots)),
    previewSize: previewSizes?.[previewSizes.length - 1] ?? {
      width: Math.max(0, ...roots.map((r) => r.box.width)),
      height: roots.reduce((sum, r) => sum + r.box.height, 0),
    },
    ...(previewSizes ? { previewSizes } : {}),
    warnings: warnings.list(),
    images: images.map((i) => ({ hash: i.hash, fileName: i.fileName, bytes: i.bytes, fit: fits.get(i.hash) })),
    previewImages: images.map((i) => i.hash),
  };
}

/**
 * One preview per tagged frame of a merged page: a responsive page at a width
 * inside each frame's breakpoint, a page with states in each state.
 */
function mergedPreviews(roots: IRNode[]): PreviewSize[] | undefined {
  const groups = pageGroups(roots);
  const merged = groups.find((g) => g.length > 1);
  if (!merged) return undefined;
  return merged.map((screen) => ({
    ...(screen.breakpoint
      ? { label: breakpointLabel(screen.breakpoint), width: previewWidth(screen) }
      : { label: screen.state!, width: Math.round(screen.box.width), state: screen.state }),
    height: groups.reduce((sum, g) => sum + (g === merged ? screen.box.height : g[0].box.height), 0),
  }));
}

function previewDocument(html: string, css: string, fontLinks: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${fontLinks}
<style>
body { margin: 0; font-family: sans-serif; }
${css}
</style>
</head>
<body>
${html}
</body>
</html>`;
}
