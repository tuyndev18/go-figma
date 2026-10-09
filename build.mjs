// Builds the two halves of a Figma plugin:
//   dist/code.js  – sandbox (main thread) code, has access to the `figma` global
//   dist/ui.html  – iframe UI; Figma only accepts a single HTML file, so JS + CSS are inlined
// and the MCP server AI agents run next to it:
//   dist/mcp.mjs  – self-contained Node script (no node_modules needed at runtime)
import * as esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");

// Figma evaluates code.js with SES, which rejects source text that merely looks
// like a dynamic import or an HTML comment, even inside strings. Fail the build
// instead of shipping a plugin that won't load.
const FORBIDDEN_IN_SANDBOX = [
  { pattern: /\bimport\s*(?:\(|\/[/*])/, label: "dynamic import expression" },
  { pattern: /<!--|-->/, label: "HTML comment" },
];

const sandboxGuard = {
  name: "sandbox-guard",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const code = await readFile("dist/code.js", "utf8");
      for (const { pattern, label } of FORBIDDEN_IN_SANDBOX) {
        const match = code.match(pattern);
        if (match) {
          const at = match.index ?? 0;
          const message = `dist/code.js contains a ${label} that Figma will reject: ${JSON.stringify(code.slice(at - 40, at + 30))}`;
          if (!watch) throw new Error(message);
          console.error(`✘ ${message}`);
        }
      }
    });
  },
};

const sandboxOptions = {
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  outfile: "dist/code.js",
  target: "es2017",
  logLevel: "info",
  plugins: [sandboxGuard],
};

const uiOptions = {
  entryPoints: ["src/ui/main.tsx"],
  bundle: true,
  write: false,
  outdir: "dist/ui-tmp",
  target: "es2017",
  jsx: "automatic",
  minify: !watch,
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
  plugins: [
    {
      name: "inline-html",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length > 0) return;
          const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
          const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
          const template = await readFile("src/ui/index.html", "utf8");
          // Function replacers: bundled code may contain `$&`-style sequences.
          const html = template
            .replace("<!-- STYLE -->", () => `<style>${css}</style>`)
            .replace("<!-- SCRIPT -->", () => `<script>${js.replace(/<\/script/gi, "<\\/script")}</script>`);
          await mkdir("dist", { recursive: true });
          await writeFile("dist/ui.html", html);
        });
      },
    },
  ],
};

const mcpOptions = {
  entryPoints: ["mcp/server.ts"],
  bundle: true,
  outfile: "dist/mcp.mjs",
  platform: "node",
  format: "esm",
  target: "node20",
  // ws loads these native speedups only if installed.
  external: ["bufferutil", "utf-8-validate"],
  // A running hub hands the port to a server from a newer build (mcp/hub.ts).
  define: { __GO_FIGMA_BUILD__: String(Date.now()) },
  // Bundled CommonJS dependencies (ws) call require() for Node built-ins.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  logLevel: "info",
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(sandboxOptions), esbuild.context(uiOptions), esbuild.context(mcpOptions)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([esbuild.build({ ...sandboxOptions, minify: true }), esbuild.build(uiOptions), esbuild.build(mcpOptions)]);
}
