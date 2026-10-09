import { describe, expect, it } from "vitest";
import type { ImageAsset } from "../src/core/ir";
import { toKebab } from "../src/core/naming";
import { Warnings } from "../src/core/warnings";
import { buildProject, type Project } from "../src/generators/project";
import { BLACK, frame, segment, shape, text } from "./fixtures";

const hero: ImageAsset = {
  hash: "abc123",
  fileName: "hero-abc123.png",
  mimeType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
  width: 10,
  height: 10,
};

const home = frame({
  name: "Mời đấu - Trang chủ",
  children: [shape({ name: "Hero", fills: [{ type: "image", hash: "abc123", scaleMode: "fill" }] })],
});
const lobby = frame({ name: "Lobby", children: [text([segment({ color: BLACK })])] });
const lobbyAgain = frame({ name: "Lobby" });

const file = (project: Project, path: string) => project.files.find((f) => f.path === path);
const paths = (project: Project) => project.files.map((f) => f.path).sort();

describe("project export", () => {
  it("builds a static HTML + CSS site with one page per frame", () => {
    const project = buildProject([home, lobby, lobbyAgain], [hero], "html-css", new Warnings());
    expect(project.name).toBe("moi-dau-trang-chu");
    expect(paths(project)).toEqual(["README.md", "images/hero-abc123.png", "index.html", "lobby-2.html", "lobby.html", "styles.css"]);
    expect(file(project, "index.html")?.text).toContain('<link rel="stylesheet" href="styles.css">');
    expect(file(project, "index.html")?.text).toContain("<title>Mời đấu - Trang chủ</title>");
    expect(file(project, "styles.css")?.text).toContain("url('images/hero-abc123.png')");
    expect(file(project, "images/hero-abc123.png")?.bytes).toBe(hero.bytes);
  });

  it("keeps class names unique across pages sharing one stylesheet", () => {
    const project = buildProject([lobby, lobbyAgain], [], "html-css", new Warnings());
    expect(file(project, "index.html")?.text).toContain('class="lobby"');
    expect(file(project, "lobby.html")?.text).toContain('class="lobby-2"');
  });

  it("builds a static Tailwind site using the browser build", () => {
    const project = buildProject([home], [hero], "html-tailwind", new Warnings());
    const index = file(project, "index.html")?.text ?? "";
    expect(index).toContain("@tailwindcss/browser@4");
    expect(index).toContain("bg-[url('images/hero-abc123.png')]");
  });

  it("builds a Next.js App Router project with absolute image paths", () => {
    const project = buildProject([home, lobby], [hero], "react-tailwind", new Warnings());
    expect(paths(project)).toEqual([
      ".gitignore",
      "README.md",
      "app/globals.css",
      "app/layout.jsx",
      "app/lobby/page.jsx",
      "app/page.jsx",
      "next.config.mjs",
      "package.json",
      "postcss.config.mjs",
      "public/images/hero-abc123.png",
    ]);
    expect(file(project, "app/page.jsx")?.text).toContain("export default function MoiDauTrangChu()");
    expect(file(project, "app/page.jsx")?.text).toContain("bg-[url('/images/hero-abc123.png')]");
    expect(JSON.parse(file(project, "package.json")?.text ?? "{}").scripts.dev).toBe("next dev");
    expect(file(project, "app/globals.css")?.text).toBe('@import "tailwindcss";\n');
  });

  it("rejects an empty selection", () => {
    expect(() => buildProject([], [], "html-css", new Warnings())).toThrow("Select at least one frame");
  });

  it("strips Vietnamese diacritics from slugs", () => {
    expect(toKebab("Lời mời thi đấu")).toBe("loi-moi-thi-dau");
  });
});
