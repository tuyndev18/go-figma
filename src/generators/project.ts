// Packages a selection as a runnable project, one page per selected frame
// (frames tagged with breakpoints share one responsive page, frames tagged with
// states one page that switches state with `?state=…`):
//   html-css       → static site: index.html, <page>.html, styles.css, images/
//   html-tailwind  → static site using the Tailwind browser build
//   react-tailwind → Next.js App Router: app/page.jsx, app/<page>/page.jsx, public/images/
import { imageFits, type ImageFit } from "../core/imageFit";
import type { ImageAsset, IRNode } from "../core/ir";
import { toKebab } from "../core/naming";
import type { Warnings } from "../core/warnings";
import type { Target } from "../shared/settings";
import { googleFontLinks, googleFontUrls } from "./fonts";
import { IMAGE_DIR } from "./index";
import { generateHtmlCss } from "./htmlCss";
import { pageGroups, pageName } from "./responsive";
import { generateTailwind } from "./tailwind";
import { buildTree } from "./tree";

export interface ProjectFile {
  path: string;
  /** Text files are encoded by the UI; the plugin sandbox has no TextEncoder. */
  text?: string;
  bytes?: Uint8Array;
  /** Images: the size to scale the file to (see core/imageFit). */
  fit?: ImageFit;
}

export interface Project {
  /** Folder name inside the zip. */
  name: string;
  files: ProjectFile[];
}

interface Page {
  /** One frame, or the tagged frames of a merged page. */
  roots: IRNode[];
  title: string;
  /** URL segment; "" for the home page. */
  slug: string;
}

export function buildProject(roots: IRNode[], images: ImageAsset[], target: Target, warnings: Warnings): Project {
  if (roots.length === 0) throw new Error("Select at least one frame to export.");

  const pages = assignPages(pageGroups(roots, warnings));
  const name = toKebab(pages[0].title) || "figma-export";
  const byHash = new Map(images.map((i) => [i.hash, i]));
  const fileName = (hash: string) => byHash.get(hash)?.fileName ?? hash;

  const files =
    target === "react-tailwind"
      ? nextApp(name, pages, (hash) => `/${IMAGE_DIR}/${fileName(hash)}`, warnings)
      : staticSite(name, pages, target, (hash) => `${IMAGE_DIR}/${fileName(hash)}`, warnings);

  const imageRoot = target === "react-tailwind" ? `public/${IMAGE_DIR}` : IMAGE_DIR;
  const fits = imageFits(roots, images);
  files.push(...images.map((i) => ({ path: `${imageRoot}/${i.fileName}`, bytes: i.bytes, fit: fits.get(i.hash) })));
  return { name, files };
}

/** States of a page with states, the default first. */
const pageStates = (page: Page) => (page.roots.length > 1 && !page.roots[0].breakpoint ? page.roots.map((r) => r.state!) : []);

/** README note: "states: default, `index.html?state=loading`". */
function statesNote(page: Page, url: string): string {
  const states = pageStates(page);
  if (states.length === 0) return "";
  return ` — states: ${states.map((s, i) => (i === 0 ? s : `\`${url}?state=${s}\``)).join(", ")}`;
}

function assignPages(groups: IRNode[][]): Page[] {
  const used = new Set<string>();
  return groups.map((roots, i) => {
    const title = pageName(roots);
    if (i === 0) return { roots, title, slug: "" };
    const base = toKebab(title) || `page-${i + 1}`;
    let slug = base;
    for (let n = 2; used.has(slug) || slug === "index"; n++) slug = `${base}-${n}`;
    used.add(slug);
    return { roots, title, slug };
  });
}

// ---------------------------------------------------------------------------
// Static site

function staticSite(
  name: string,
  pages: Page[],
  target: Target,
  imageUrl: (hash: string) => string,
  warnings: Warnings,
): ProjectFile[] {
  const tree = buildTree(
    pages.flatMap((p) => p.roots),
    { warnings, imageUrl },
  );
  const htmlFile = (page: Page) => (page.slug === "" ? "index.html" : `${page.slug}.html`);
  const files: ProjectFile[] = [];

  if (target === "html-css") {
    const { css, pages: bodies } = generateHtmlCss(tree);
    pages.forEach((page, i) => {
      files.push({
        path: htmlFile(page),
        text: htmlDocument(page.title, [googleFontLinks(page.roots), '<link rel="stylesheet" href="styles.css">'], withStateScript(page, bodies[i])),
      });
    });
    files.push({ path: "styles.css", text: `${css}\n\nbody {\n  margin: 0;\n}\n` });
  } else {
    pages.forEach((page, i) => {
      files.push({
        path: htmlFile(page),
        text: htmlDocument(
          page.title,
          [googleFontLinks(page.roots), '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>'],
          withStateScript(page, generateTailwind([tree[i]], "html")),
        ),
      });
    });
  }

  files.push({
    path: "README.md",
    text: readme(name, [
      "Open `index.html` in a browser, or serve the folder:",
      "",
      "```bash",
      "npx serve .",
      "```",
      "",
      "Pages:",
      "",
      ...pages.map((p) => `- \`${htmlFile(p)}\` — ${p.title}${statesNote(p, htmlFile(p))}`),
    ]),
  });
  return files;
}

/** Static pages have no framework to pass a state in, so `?state=…` sets it. */
const STATE_SCRIPT = `<script>
  // Show another state with ?state=<name>.
  const state = new URLSearchParams(location.search).get("state");
  if (state) document.querySelector("[data-state]").dataset.state = state;
</script>`;

const withStateScript = (page: Page, body: string) => (pageStates(page).length > 0 ? `${body}\n${STATE_SCRIPT}` : body);

function htmlDocument(title: string, head: string[], body: string): string {
  const headLines = head
    .flatMap((h) => h.split("\n"))
    .filter((line) => line !== "")
    .join("\n    ");
  const indented = body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    ${headLines}
  </head>
  <body>
${indented}
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Next.js App Router

const NEXT_VERSIONS = {
  next: "^16.4.0",
  react: "^19.3.0",
  "react-dom": "^19.3.0",
  tailwindcss: "^4.3.3",
  "@tailwindcss/postcss": "^4.3.3",
};

function nextApp(name: string, pages: Page[], imageUrl: (hash: string) => string, warnings: Warnings): ProjectFile[] {
  const tree = buildTree(
    pages.flatMap((p) => p.roots),
    { warnings, imageUrl },
  );
  const files: ProjectFile[] = pages.map((page, i) => ({
    path: page.slug === "" ? "app/page.jsx" : `app/${page.slug}/page.jsx`,
    text: `${generateTailwind([tree[i]], "jsx", { stateFrom: "searchParams" })}\n`,
  }));

  const fontHead = googleFontUrls(pages.flatMap((p) => p.roots))
    .map((url) => `\n        <link rel="stylesheet" href={${JSON.stringify(url)}} />`)
    .join("");
  const { next, react, "react-dom": reactDom, tailwindcss, "@tailwindcss/postcss": postcss } = NEXT_VERSIONS;
  const packageJson = {
    name,
    version: "0.1.0",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next, react, "react-dom": reactDom },
    devDependencies: { "@tailwindcss/postcss": postcss, tailwindcss },
  };

  files.push(
    { path: "package.json", text: `${JSON.stringify(packageJson, null, 2)}\n` },
    // No `@type` JSDoc here: it needs a dynamic-import expression, which
    // Figma's sandbox rejects anywhere in plugin code, even inside a string.
    { path: "next.config.mjs", text: "const nextConfig = {};\n\nexport default nextConfig;\n" },
    { path: "postcss.config.mjs", text: 'export default {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n' },
    { path: "app/globals.css", text: '@import "tailwindcss";\n' },
    {
      path: "app/layout.jsx",
      text: `import "./globals.css";

export const metadata = {
  title: ${JSON.stringify(pages[0].title)},
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">${fontHead ? `\n      <head>${fontHead}\n      </head>` : ""}
      <body>{children}</body>
    </html>
  );
}
`,
    },
    { path: ".gitignore", text: "node_modules/\n.next/\nout/\n" },
    {
      path: "README.md",
      text: readme(name, [
        "```bash",
        "npm install",
        "npm run dev",
        "```",
        "",
        "Routes:",
        "",
        ...pages.map((p) => `- \`/${p.slug}\` — ${p.title} (\`app/${p.slug ? `${p.slug}/` : ""}page.jsx\`)${statesNote(p, `/${p.slug}`)}`),
        "",
        "Fonts are loaded from Google Fonts in `app/layout.jsx`; fonts Google doesn't host fall back to a generic family.",
      ]),
    },
  );
  return files;
}

// ---------------------------------------------------------------------------

function readme(name: string, body: string[]): string {
  return [`# ${name}`, "", "Generated by GoApp Figma.", "", ...body, ""].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
